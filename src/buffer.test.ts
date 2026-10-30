import { test } from "bun:test";
import assert from "node:assert/strict";
import type { Result } from "@lorenzh/pulse-contract";
import { BACKOFF_MAX_MS, type BufferDeps, createResultBuffer, type DropReason } from "./buffer.ts";
import type { PostOutcome } from "./client.ts";

function result(n: number, timestamp = 1000): Result {
  return {
    checkId: `c${n}`,
    timestamp,
    status: "up",
    statusCode: 200,
    latencyMs: 1,
    reason: null,
    location: "default",
    attempts: 1,
  };
}

/** Fake peers: `outcomes` answers each post in turn, then `fallback`. Sleeps wait for `tick`. */
function setup(over: Partial<BufferDeps> = {}, fallback: PostOutcome = "accepted") {
  const posted: string[] = [];
  const outcomes: PostOutcome[] = [];
  const sleeps: number[] = [];
  const logs: string[] = [];
  const drops: DropReason[] = [];
  const sizes: number[] = [];
  const outcomeLog: PostOutcome[] = [];
  let late = 0;
  let wake: (() => void) | undefined;
  let hold: (() => void) | undefined;
  const controller = new AbortController();
  const state = { now: 2000, fallback, isHeld: false };
  const deps: BufferDeps = {
    post: async (r) => {
      posted.push(r.checkId);
      if (state.isHeld) await new Promise<void>((resolve) => (hold = resolve));
      return outcomes.shift() ?? state.fallback;
    },
    now: () => state.now,
    sleep: (ms) => {
      sleeps.push(ms);
      return new Promise<void>((resolve, reject) => {
        wake = resolve;
        controller.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    },
    signal: controller.signal,
    log: (m) => logs.push(m),
    maxResults: 100,
    maxAgeMs: 10_000,
    onPost: (_r, o) => outcomeLog.push(o),
    onDrop: (reason) => drops.push(reason),
    onDeliveredLate: () => late++,
    onSize: (n) => sizes.push(n),
    ...over,
  };
  const buffer = createResultBuffer(deps);
  const tick = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
    const w = wake;
    wake = undefined;
    w?.();
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  const release = async (): Promise<void> => {
    const h = hold;
    hold = undefined;
    h?.();
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  return {
    buffer,
    posted,
    outcomes,
    sleeps,
    logs,
    drops,
    sizes,
    outcomeLog,
    state,
    controller,
    tick,
    release,
    late: () => late,
  };
}

test("an accepted result posts directly and buffers nothing", async () => {
  const t = setup();
  await t.buffer.submit(result(1));
  assert.deepEqual(t.posted, ["c1"]);
  assert.deepEqual(t.logs, []);
  assert.equal(t.late(), 0);
});

test("a retry outcome buffers the result and delivers it after the API answers", async () => {
  const t = setup();
  t.outcomes.push("retry");
  await t.buffer.submit(result(1));
  assert.deepEqual(t.posted, ["c1"]);
  assert.equal(t.sizes.at(-1), 1);
  await t.tick();
  await t.buffer.idle();
  assert.deepEqual(t.posted, ["c1", "c1"]);
  assert.equal(t.late(), 1);
  assert.equal(t.sizes.at(-1), 0);
});

test("results queue behind a non-empty buffer and are delivered first-in first-out", async () => {
  const t = setup();
  t.outcomes.push("retry");
  await t.buffer.submit(result(1)); // direct post fails, buffered
  await t.buffer.submit(result(2)); // queued, never posted directly
  await t.buffer.submit(result(3));
  assert.deepEqual(t.posted, ["c1"]);
  await t.tick(); // backoff over: c1, c2, c3 in order
  await t.buffer.idle();
  assert.deepEqual(t.posted, ["c1", "c1", "c2", "c3"]);
  assert.equal(t.late(), 3);
});

test("only one request is in flight while the sender runs", async () => {
  const t = setup();
  t.outcomes.push("retry");
  await t.buffer.submit(result(1));
  t.state.isHeld = true;
  await t.tick();
  await t.buffer.submit(result(2));
  await t.buffer.submit(result(3));
  assert.deepEqual(t.posted, ["c1", "c1"]);
  t.state.isHeld = false;
  await t.release();
  await t.buffer.idle();
  assert.deepEqual(t.posted, ["c1", "c1", "c2", "c3"]);
});

test("an evicted in-flight head that is accepted counts as delivered, not dropped", async () => {
  const t = setup({ maxResults: 1 });
  t.outcomes.push("retry");
  await t.buffer.submit(result(1));
  t.state.isHeld = true;
  await t.tick();
  await t.buffer.submit(result(2)); // evicts c1 while its post is in flight
  t.state.isHeld = false;
  await t.release();
  await t.buffer.idle();
  assert.deepEqual(t.drops, []);
  assert.equal(t.late(), 2);
  assert.ok(t.logs.includes("buffer empty again: 2 delivered, 0 dropped"));
});

test("an evicted in-flight head that fails is counted once as buffer_full", async () => {
  const t = setup({ maxResults: 1 });
  t.outcomes.push("retry", "retry");
  await t.buffer.submit(result(1));
  t.state.isHeld = true;
  await t.tick();
  await t.buffer.submit(result(2));
  t.state.isHeld = false;
  await t.release();
  assert.deepEqual(t.drops, ["buffer_full"]);
});

test("backoff doubles from 1 s to the 30 s cap and resets after a success", async () => {
  const t = setup({}, "retry");
  await t.buffer.submit(result(1));
  for (let i = 0; i < 8; i++) await t.tick();
  assert.deepEqual(t.sleeps, [
    1000,
    2000,
    4000,
    8000,
    16_000,
    BACKOFF_MAX_MS,
    BACKOFF_MAX_MS,
    BACKOFF_MAX_MS,
    BACKOFF_MAX_MS,
  ]);
  t.state.fallback = "accepted";
  await t.tick();
  await t.buffer.idle();
  t.outcomes.push("retry");
  await t.buffer.submit(result(2));
  assert.equal(t.sleeps.length, 10);
  assert.equal(t.sleeps.at(-1), 1000);
});

for (const outcome of ["rejected", "unknown-check"] as const) {
  test(`a ${outcome} result is never buffered and counts rejected`, async () => {
    const t = setup({}, outcome);
    await t.buffer.submit(result(1));
    assert.deepEqual(t.drops, ["rejected"]);
    assert.deepEqual(t.logs, []);
    assert.deepEqual(t.outcomeLog, [outcome]);
  });
}

test("a rejected buffered result is removed and does not block the next one", async () => {
  const t = setup();
  t.outcomes.push("retry", "rejected");
  await t.buffer.submit(result(1));
  await t.buffer.submit(result(2));
  await t.tick();
  await t.buffer.idle();
  assert.deepEqual(t.posted, ["c1", "c1", "c2"]);
  assert.deepEqual(t.drops, ["rejected"]);
  assert.equal(t.late(), 1);
});

test("a full buffer drops the oldest result with buffer_full", async () => {
  const t = setup({ maxResults: 2 }, "retry");
  await t.buffer.submit(result(1));
  await t.buffer.submit(result(2));
  await t.buffer.submit(result(3));
  assert.deepEqual(t.drops, ["buffer_full"]);
  t.state.fallback = "accepted";
  t.posted.length = 0;
  await t.tick();
  await t.buffer.idle();
  assert.deepEqual(t.posted, ["c2", "c3"]);
});

test("a result older than the max age is dropped at enqueue", async () => {
  const t = setup({}, "retry");
  await t.buffer.submit(result(1, 2000 - 10_001));
  assert.deepEqual(t.drops, ["too_old"]);
  assert.equal(t.sizes.at(-1), 0);
});

test("a buffered result that grows too old is dropped at send", async () => {
  const t = setup();
  t.outcomes.push("retry");
  await t.buffer.submit(result(1, 1500));
  await t.buffer.submit(result(2, 11_000));
  t.state.now = 11_600; // c1 is now 10100 ms old, c2 is not
  await t.tick();
  await t.buffer.idle();
  assert.deepEqual(t.drops, ["too_old"]);
  assert.deepEqual(t.posted, ["c1", "c2"]);
  assert.equal(t.late(), 1);
});

test("eviction of an expired oldest result counts too_old", async () => {
  const t = setup({ maxResults: 1 }, "retry");
  await t.buffer.submit(result(1, 1500));
  t.state.now = 11_600;
  await t.buffer.submit(result(2, 11_000));
  assert.deepEqual(t.drops, ["too_old"]);
});

test("logs exactly two lines per outage, with the delivered and dropped counts", async () => {
  const t = setup();
  t.outcomes.push("retry", "retry");
  await t.buffer.submit(result(1));
  await t.buffer.submit(result(2));
  await t.buffer.submit(result(3));
  assert.equal(t.logs.length, 1);
  await t.tick();
  await t.tick();
  await t.buffer.idle();
  assert.equal(t.logs.length, 2);
  assert.match(t.logs[1] ?? "", /3 delivered, 0 dropped/);
});

test("shutdown stops the sender and logs the number of lost results", async () => {
  const t = setup({}, "retry");
  await t.buffer.submit(result(1));
  await t.buffer.submit(result(2));
  t.controller.abort();
  await t.buffer.idle();
  assert.equal(t.buffer.close(), 2);
  assert.match(t.logs.at(-1) ?? "", /2 buffered result\(s\) lost/);
  assert.equal(t.sizes.at(-1), 0);
  assert.equal(t.logs.length, 2);
});
