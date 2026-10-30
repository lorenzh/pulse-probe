import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { Result } from "@lorenzh/pulse-contract";
import type { ProbeCheck } from "./client.ts";
import { monotonic } from "./clock.ts";
import { startScheduler, type Timer } from "./scheduler.ts";

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function fakeTimer() {
  let clock = 0;
  let nextId = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timer: Timer = {
    setTimeout(fn, ms) {
      const id = nextId++;
      pending.set(id, { at: clock + ms, fn });
      return id;
    },
    clearTimeout(h) {
      pending.delete(h as number);
    },
  };
  return {
    timer,
    now: () => clock,
    pending,
    async advance(ms: number) {
      clock += ms;
      for (const [id, p] of [...pending]) {
        if (p.at <= clock) {
          pending.delete(id);
          p.fn();
        }
      }
      await flush();
    },
  };
}

// eslint-disable-next-line sonarjs/no-clear-text-protocols -- fake URL for a stubbed fetch, no network
const check: ProbeCheck = { id: "a", name: "A", url: "http://x", intervalMs: 1000 };
const mk = (c: ProbeCheck): Result => ({
  checkId: c.id,
  timestamp: 0,
  status: "up",
  statusCode: 200,
  latencyMs: 1,
  reason: null,
  location: "default",
  attempts: 1,
});

test("runs immediately, then every interval", async () => {
  const f = fakeTimer();
  const results: Result[] = [];
  const s = startScheduler([check], {
    timer: f.timer,
    now: f.now,
    run: async (c) => mk(c),
    onResult: (r) => {
      results.push(r);
    },
  });
  await flush();
  assert.equal(results.length, 1);
  await f.advance(999);
  assert.equal(results.length, 1);
  await f.advance(1);
  assert.equal(results.length, 2);
  await f.advance(1000);
  assert.equal(results.length, 3);
  s.stop();
});

test("a slow check does not overlap with itself", async () => {
  const f = fakeTimer();
  let active = 0;
  let max = 0;
  let calls = 0;
  const releases: Array<() => void> = [];
  const s = startScheduler([check], {
    timer: f.timer,
    now: f.now,
    run: async (c) => {
      calls++;
      active++;
      max = Math.max(max, active);
      await new Promise<void>((r) => releases.push(r));
      active--;
      return mk(c);
    },
    onResult: () => {},
  });
  await flush();
  await f.advance(3500);
  assert.equal(calls, 1);
  releases[0]!();
  await flush();
  // finished late: next run is due immediately
  await f.advance(0);
  assert.equal(calls, 2);
  assert.equal(max, 1);
  s.stop();
});

test("stop cancels future runs", async () => {
  const f = fakeTimer();
  let calls = 0;
  const s = startScheduler([check], {
    timer: f.timer,
    now: f.now,
    run: async (c) => (calls++, mk(c)),
    onResult: () => {},
  });
  await flush();
  assert.equal(f.pending.size, 1);
  s.stop();
  assert.equal(f.pending.size, 0);
  await f.advance(5000);
  assert.equal(calls, 1);
});

test("errors are reported and scheduling continues", async () => {
  const f = fakeTimer();
  const errors: unknown[] = [];
  let calls = 0;
  const s = startScheduler([check], {
    timer: f.timer,
    now: f.now,
    run: async () => {
      calls++;
      throw new Error("boom");
    },
    onResult: () => {},
    onError: (_c, e) => errors.push(e),
  });
  await flush();
  await f.advance(1000);
  assert.equal(calls, 2);
  assert.equal(errors.length, 2);
  s.stop();
});

test("the next run is armed only after a retrying run finished", async () => {
  const f = fakeTimer();
  let calls = 0;
  const waits: Array<() => void> = [];
  const retrying: ProbeCheck = { ...check, retries: 1, retryDelayMs: 100 };
  const s = startScheduler([retrying], {
    timer: f.timer,
    now: f.now,
    run: async (c) => {
      calls++;
      // first attempt fails, the fake sleep holds the run open
      await new Promise<void>((r) => waits.push(r));
      return { ...mk(c), attempts: 2 };
    },
    onResult: () => {},
  });
  await flush();
  assert.equal(calls, 1);
  assert.equal(f.pending.size, 0);
  await f.advance(900);
  assert.equal(calls, 1);
  assert.equal(f.pending.size, 0);
  waits[0]!();
  await flush();
  assert.equal(f.pending.size, 1);
  s.stop();
});

test("sync adds, removes and changes checks and keeps unchanged timers", async () => {
  const f = fakeTimer();
  const runs: string[] = [];
  const s = startScheduler([check, { ...check, id: "b" }], {
    timer: f.timer,
    now: f.now,
    run: async (c) => {
      runs.push(`${c.id}:${c.intervalMs}`);
      return mk(c);
    },
    onResult: () => {},
  });
  await flush();
  assert.deepEqual(runs, ["a:1000", "b:1000"]);
  const timersBefore = [...f.pending.keys()];
  s.sync([check, { ...check, id: "c" }]);
  await flush();
  assert.deepEqual(runs, ["a:1000", "b:1000", "c:1000"]);
  assert.ok(timersBefore.some((id) => f.pending.has(id)));
  await f.advance(1000);
  assert.deepEqual(
    runs.slice(3).sort((a, b) => a.localeCompare(b)),
    ["a:1000", "c:1000"],
  );
  s.sync([
    { ...check, intervalMs: 500 },
    { ...check, id: "c" },
  ]);
  await flush();
  assert.equal(runs.at(-1), "a:500");
  assert.equal(f.pending.size, 2);
  s.stop();
});

test("a removed check mid-run never posts", async () => {
  const f = fakeTimer();
  let release: () => void = () => {};
  const posted: string[] = [];
  const s = startScheduler([check], {
    timer: f.timer,
    now: f.now,
    run: (c) =>
      new Promise((resolve) => {
        release = () => resolve(mk(c));
      }),
    onResult: (r) => {
      posted.push(r.checkId);
    },
  });
  await flush();
  s.sync([]);
  release();
  await flush();
  assert.deepEqual(posted, []);
  assert.equal(f.pending.size, 0);
});

test("a wall clock step back does not pause the scheduler", async () => {
  // Steps the real Date.now back by an hour on every run. A scheduler that read it would stall.
  mock.timers.enable({ apis: ["Date"], now: 10_000_000 });
  try {
    const f = fakeTimer();
    let runs = 0;
    const s = startScheduler([check], {
      timer: f.timer,
      now: monotonic, // the clock that main.ts wires into the scheduler
      run: async (c) => {
        runs++;
        const before = Date.now();
        mock.timers.setTime(before - 3_600_000);
        assert.ok(Date.now() < before);
        return { ...mk(c), timestamp: Date.now() };
      },
      onResult: () => {},
    });
    await flush();
    await f.advance(1000);
    await f.advance(1000);
    assert.equal(runs, 3);
    s.stop();
  } finally {
    mock.timers.reset();
  }
});

test("never passes a delay above the timer cap", async () => {
  const delays: number[] = [];
  const f = fakeTimer();
  const timer: Timer = {
    setTimeout(fn, ms) {
      delays.push(ms);
      return f.timer.setTimeout(fn, ms);
    },
    clearTimeout: f.timer.clearTimeout,
  };
  const runs: string[] = [];
  const s = startScheduler([{ ...check, intervalMs: 2 ** 31 + 5 }], {
    timer,
    now: f.now,
    run: async (c) => {
      runs.push(c.id);
      return mk(c);
    },
    onResult: () => undefined,
  });
  await flush();
  assert.equal(runs.length, 1);
  assert.deepEqual(delays, [2_147_483_647]);
  await f.advance(1000);
  assert.equal(runs.length, 1);
  s.stop();
});
