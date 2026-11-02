import { setSystemTime, test } from "bun:test";
import assert from "node:assert/strict";
import type { Result } from "@lorenzh/pulse-contract";
import { startCheckScheduler } from "./check-scheduler.ts";
import type { ProbeCheck } from "./client.ts";
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

test("runs after the first delay, then every interval", async () => {
  const f = fakeTimer();
  const results: Result[] = [];
  const s = startScheduler([check], {
    timer: f.timer,
    now: f.now,
    random: () => 0,
    run: async (c) => mk(c),
    onResult: (r) => {
      results.push(r);
    },
  });
  await f.advance(0);
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
    random: () => 0,
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
  await f.advance(0);
  await f.advance(3500);
  assert.equal(calls, 1);
  releases[0]!();
  await f.advance(0);
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
    random: () => 0,
    run: async (c) => (calls++, mk(c)),
    onResult: () => {},
  });
  await f.advance(0);
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
    random: () => 0,
    run: async () => {
      calls++;
      throw new Error("boom");
    },
    onResult: () => {},
    onError: (_c, e) => errors.push(e),
  });
  await f.advance(0);
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
    random: () => 0,
    run: async (c) => {
      calls++;
      // first attempt fails, the fake sleep holds the run open
      await new Promise<void>((r) => waits.push(r));
      return { ...mk(c), attempts: 2 };
    },
    onResult: () => {},
  });
  await f.advance(0);
  assert.equal(calls, 1);
  assert.equal(f.pending.size, 0);
  await f.advance(900);
  assert.equal(calls, 1);
  assert.equal(f.pending.size, 0);
  waits[0]!();
  await f.advance(0);
  assert.equal(f.pending.size, 1);
  s.stop();
});

test("sync adds, removes and changes checks and keeps unchanged timers", async () => {
  const f = fakeTimer();
  const runs: string[] = [];
  const s = startScheduler([check, { ...check, id: "b" }], {
    timer: f.timer,
    now: f.now,
    random: () => 0,
    run: async (c) => {
      runs.push(`${c.id}:${c.intervalMs}`);
      return mk(c);
    },
    onResult: () => {},
  });
  await f.advance(0);
  assert.deepEqual(runs, ["a:1000", "b:1000"]);
  const timersBefore = [...f.pending.keys()];
  s.sync([check, { ...check, id: "c" }]);
  await f.advance(0);
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
  await f.advance(0);
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
    random: () => 0,
    run: (c) =>
      new Promise((resolve) => {
        release = () => resolve(mk(c));
      }),
    onResult: (r) => {
      posted.push(r.checkId);
    },
  });
  await f.advance(0);
  s.sync([]);
  release();
  await f.advance(0);
  assert.deepEqual(posted, []);
  assert.equal(f.pending.size, 0);
});

test("a wall clock step back does not pause the scheduler", async () => {
  // Steps the real Date.now back by an hour on every request. The wiring must not read it.
  setSystemTime(new Date(10_000_000));
  try {
    const f = fakeTimer();
    let runs = 0;
    const s = startCheckScheduler([check], {
      timer: f.timer,
      random: () => 0,
      fetch: async () => {
        runs++;
        const before = Date.now();
        setSystemTime(new Date(before - 3_600_000));
        assert.ok(Date.now() < before);
        return new Response("ok");
      },
      sleep: async () => {},
      location: "default",
      signal: new AbortController().signal,
      track: (work) => work,
      onResult: async () => {},
      onError: (_c, err) => {
        throw err;
      },
    });
    await f.advance(0);
    await f.advance(1000);
    await f.advance(1000);
    assert.equal(runs, 3);
    s.stop();
  } finally {
    setSystemTime();
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
    random: () => 0,
    run: async (c) => {
      runs.push(c.id);
      return mk(c);
    },
    onResult: () => undefined,
  });
  await f.advance(0);
  assert.equal(runs.length, 1);
  assert.deepEqual(delays, [0, 2_147_483_647]);
  await f.advance(1000);
  assert.equal(runs.length, 1);
  s.stop();
});

function samples(...values: number[]): { random: () => number; calls: () => number } {
  let i = 0;
  return {
    random: () => {
      const v = values[i % values.length] ?? 0;
      i++;
      return v;
    },
    calls: () => i,
  };
}

test("each new check starts after floor(random * min(interval, 1000)) ms", async () => {
  const f = fakeTimer();
  const starts: string[] = [];
  const r = samples(0, 0.5, 0.999);
  const s = startScheduler(
    [check, { ...check, id: "b" }, { ...check, id: "c" }].map((c) => ({
      ...c,
      intervalMs: 60_000,
    })),
    {
      timer: f.timer,
      now: f.now,
      random: r.random,
      run: async (c) => {
        starts.push(`${c.id}@${f.now()}`);
        return mk(c);
      },
      onResult: () => {},
    },
  );
  assert.deepEqual(starts, []);
  await f.advance(0);
  assert.deepEqual(starts, ["a@0"]);
  await f.advance(499);
  assert.deepEqual(starts, ["a@0"]);
  await f.advance(1);
  await f.advance(499);
  assert.deepEqual(starts, ["a@0", "b@500", "c@999"]);
  await f.advance(59_001);
  await f.advance(500);
  await f.advance(499);
  assert.deepEqual(starts.slice(3), ["a@60000", "b@60500", "c@60999"]);
  assert.equal(r.calls(), 3);
  s.stop();
});

test("the first delay stays below the bound for short intervals and broken samples", () => {
  const cases: Array<[number, number, number]> = [
    [200, 0.999, 199],
    [1, 0.999, 0],
    [60_000, 1, 999],
    [60_000, 5, 999],
    [60_000, -0.5, 0],
    [60_000, Number.NaN, 0],
    [200, Number.POSITIVE_INFINITY, 0],
  ];
  for (const [intervalMs, sample, want] of cases) {
    const delays: number[] = [];
    const s = startScheduler([{ ...check, intervalMs }], {
      timer: {
        setTimeout: (_fn, ms) => delays.push(ms),
        clearTimeout: () => {},
      },
      now: () => 0,
      random: () => sample,
      run: async (c) => mk(c),
      onResult: () => {},
    });
    assert.deepEqual(delays, [want], `interval ${intervalMs} sample ${sample}`);
    s.stop();
  }
});

test("equal sync keeps the timer, a changed check samples again, removal and stop cancel", async () => {
  const f = fakeTimer();
  const r = samples(0.5);
  let runs = 0;
  const s = startScheduler([check, { ...check, id: "b" }], {
    timer: f.timer,
    now: f.now,
    random: r.random,
    run: async (c) => {
      runs++;
      return mk(c);
    },
    onResult: () => {},
  });
  const before = [...f.pending.keys()];
  s.sync([{ ...check }, { ...check, id: "b" }]);
  assert.deepEqual([...f.pending.keys()], before);
  assert.equal(r.calls(), 2);
  s.sync([
    { ...check, timeoutMs: 5 },
    { ...check, id: "b" },
  ]);
  assert.equal(r.calls(), 3);
  s.sync([{ ...check, timeoutMs: 5 }]);
  assert.equal(f.pending.size, 1);
  s.stop();
  assert.equal(f.pending.size, 0);
  await f.advance(5000);
  assert.equal(runs, 0);
});

test("a changed in-flight check is aborted, dropped and replaced without overlap", async () => {
  const f = fakeTimer();
  const signals: AbortSignal[] = [];
  const runs: string[] = [];
  const posted: string[] = [];
  const errors: unknown[] = [];
  let active = 0;
  let maxActive = 0;
  let finishOld: () => void = () => {};
  const s = startScheduler([check], {
    timer: f.timer,
    now: f.now,
    random: () => 0.5,
    run: (c, signal) => {
      runs.push(`${c.id}:${c.timeoutMs ?? "-"}`);
      signals.push(signal);
      active++;
      maxActive = Math.max(maxActive, active);
      return new Promise((resolve, reject) => {
        // the old run settles only later, after its abort
        signal.addEventListener("abort", () => {
          finishOld = () => {
            active--;
            reject(new Error("aborted"));
          };
        });
        if (c.timeoutMs === 5) {
          active--;
          resolve(mk(c));
        }
      });
    },
    onResult: (r) => {
      posted.push(r.checkId);
    },
    onError: (_c, e) => errors.push(e),
  });
  await f.advance(500);
  assert.deepEqual(runs, ["a:-"]);
  s.sync([{ ...check }]);
  assert.equal(signals[0]?.aborted, false);
  s.sync([{ ...check, timeoutMs: 5 }]);
  assert.equal(signals[0]?.aborted, true);
  await f.advance(500);
  assert.deepEqual(runs, ["a:-"]);
  finishOld();
  await f.advance(0);
  assert.deepEqual(runs, ["a:-", "a:5"]);
  assert.deepEqual(posted, ["a"]);
  assert.deepEqual(errors, []);
  assert.equal(maxActive, 1);
  assert.equal(signals[1]?.aborted, false);
  s.sync([]);
  assert.equal(signals[1]?.aborted, true);
  s.stop();
});

test("stop aborts the running check", async () => {
  const f = fakeTimer();
  let seen: AbortSignal | undefined;
  const s = startScheduler([check], {
    timer: f.timer,
    now: f.now,
    random: () => 0,
    run: (_c, signal) => {
      seen = signal;
      return new Promise(() => {});
    },
    onResult: () => {},
  });
  await f.advance(0);
  assert.equal(seen?.aborted, false);
  s.stop();
  assert.equal(seen?.aborted, true);
});

test("consecutive replacements all wait for the oldest unsettled run", async () => {
  const f = fakeTimer();
  const starts: string[] = [];
  let release: () => void = () => undefined;
  const s = startScheduler([{ ...check, intervalMs: 60000 }], {
    timer: f.timer,
    now: f.now,
    random: () => 0,
    run: async (c) => {
      starts.push(c.name);
      return mk(c);
    },
    onResult: async () => {
      if (starts.length === 1) await new Promise<void>((r) => (release = r));
    },
  });
  await f.advance(0);
  s.sync([{ ...check, intervalMs: 60000, name: "B" }]);
  await f.advance(5000);
  s.sync([{ ...check, intervalMs: 60000, name: "C" }]);
  await f.advance(5000);
  assert.deepEqual(starts, ["A"]);
  release();
  await flush();
  assert.deepEqual(starts, ["A", "C"]);
  s.stop();
});
