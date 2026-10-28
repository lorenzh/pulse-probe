import assert from "node:assert/strict";
import { test } from "node:test";
import type { Check, Result } from "@lorenzh/pulse-contract";
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

const check: Check = { id: "a", name: "A", url: "http://x", intervalMs: 1000 };
const mk = (c: Check): Result => ({
  checkId: c.id,
  timestamp: 0,
  status: "up",
  statusCode: 200,
  latencyMs: 1,
  reason: null,
});

test("runs immediately, then every interval", async () => {
  const f = fakeTimer();
  const results: Result[] = [];
  const s = startScheduler([check], {
    timer: f.timer,
    now: f.now,
    run: async (c) => mk(c),
    onResult: (r) => void results.push(r),
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
