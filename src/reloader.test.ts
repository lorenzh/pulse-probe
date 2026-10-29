import assert from "node:assert/strict";
import { test } from "node:test";
import type { Check } from "@lorenzh/pulse-contract";
import { startReloader } from "./reloader.ts";
import type { Timer } from "./scheduler.ts";

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function setup(load: () => Promise<Check[]>) {
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
  const applied: Check[][] = [];
  const logs: string[] = [];
  const reloader = startReloader({
    timer,
    now: () => clock,
    load,
    apply: (c) => {
      applied.push(c);
    },
    log: (m) => logs.push(m),
    intervalMs: 60_000,
    retryMs: 10_000,
    minGapMs: 5000,
  });
  return {
    reloader,
    applied,
    logs,
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

// eslint-disable-next-line sonarjs/no-clear-text-protocols -- fake URL, no network
const check: Check = { id: "a", name: "A", url: "http://x", intervalMs: 1000 };

test("reloads every interval and applies the checks", async () => {
  const s = setup(async () => [check]);
  await s.advance(59_999);
  assert.equal(s.applied.length, 0);
  await s.advance(1);
  assert.equal(s.applied.length, 1);
  await s.advance(60_000);
  assert.equal(s.applied.length, 2);
});

test("a failed reload keeps the checks, logs and retries after the retry delay", async () => {
  let fail = true;
  const s = setup(async () => {
    if (fail) throw new Error("HTTP 503");
    return [check];
  });
  await s.advance(60_000);
  assert.equal(s.applied.length, 0);
  assert.match(s.logs[0] ?? "", /HTTP 503/);
  fail = false;
  await s.advance(9999);
  assert.equal(s.applied.length, 0);
  await s.advance(1);
  assert.equal(s.applied.length, 1);
});

test("requests collapse into one debounced reload", async () => {
  const s = setup(async () => [check]);
  await s.advance(1000);
  s.reloader.requestReload();
  s.reloader.requestReload();
  s.reloader.requestReload();
  await s.advance(3999);
  assert.equal(s.applied.length, 0);
  await s.advance(1);
  assert.equal(s.applied.length, 1);
  await s.advance(60_000);
  assert.equal(s.applied.length, 2);
});

test("stop cancels the pending reload", async () => {
  const s = setup(async () => [check]);
  s.reloader.stop();
  await s.advance(120_000);
  assert.equal(s.applied.length, 0);
  assert.equal(s.pending.size, 0);
});
