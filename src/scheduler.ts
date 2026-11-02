import { isDeepStrictEqual } from "node:util";
import { MAX_TIMER_MS, type Result } from "@lorenzh/pulse-contract";
import type { ProbeCheck } from "./client.ts";

export interface Timer {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SchedulerDeps {
  timer: Timer;
  /** Monotonic clock in ms. */
  now: () => number;
  /** Returns a number in [0, 1); samples the first-run delay of each new entry. */
  random: () => number;
  /** `signal` aborts when the check is removed, replaced or the scheduler stops. */
  run: (check: ProbeCheck, signal: AbortSignal) => Promise<Result>;
  onResult: (result: Result) => void | Promise<void>;
  onError?: (check: ProbeCheck, err: unknown) => void;
}

export interface Scheduler {
  /** Makes `checks` the running set: starts added, stops removed, restarts changed ones. */
  sync(checks: ProbeCheck[]): void;
  stop(): void;
}

interface Entry {
  check: ProbeCheck;
  controller: AbortController;
  handle?: unknown;
  /** Settles when the entry's current run, including `onResult`, is over. */
  running?: Promise<void> | undefined;
}

const MAX_FIRST_DELAY_MS = 1000;

/** Whole ms in [0, min(intervalMs, 1000) - 1]; a value outside [0, 1) is clamped. */
function firstDelay(intervalMs: number, sample: number): number {
  const bound = Math.max(1, Math.min(intervalMs, MAX_FIRST_DELAY_MS));
  const delay = Math.floor((Number.isFinite(sample) ? sample : 0) * bound);
  return Math.min(bound - 1, Math.max(0, delay));
}

/**
 * Runs each new check after a random delay below min(intervalMs, 1000) ms, then once per
 * interval from the previous start. The next run is only scheduled after the previous one
 * finished, so a check never overlaps itself, also not across a replacement.
 * `deps.now` must be a monotonic clock. A removed or replaced check never posts.
 */
export function startScheduler(checks: ProbeCheck[], deps: SchedulerDeps): Scheduler {
  let stopped = false;
  const entries = new Map<string, Entry>();
  // Unsettled runs of removed or replaced entries by id, so a re-added check still waits.
  const outstanding = new Map<string, Promise<void>>();

  const isCurrent = (entry: Entry): boolean => !stopped && entries.get(entry.check.id) === entry;

  const execute = async (entry: Entry): Promise<void> => {
    const { check, controller } = entry;
    const started = deps.now();
    try {
      const result = await deps.run(check, controller.signal);
      if (isCurrent(entry)) await deps.onResult(result);
    } catch (err) {
      // A run rejected after its entry was aborted is the expected end of a cancelled run.
      if (!controller.signal.aborted) deps.onError?.(check, err);
    }
    if (!isCurrent(entry)) return;
    const delay = Math.min(MAX_TIMER_MS, Math.max(0, check.intervalMs - (deps.now() - started)));
    entry.handle = deps.timer.setTimeout(() => tick(entry), delay);
  };

  const tick = (entry: Entry, previous?: Promise<void>): void => {
    entry.handle = undefined;
    if (!isCurrent(entry)) return;
    if (previous !== undefined) {
      // A replacement waits for the aborted old run so the two never overlap.
      void previous.then(() => tick(entry));
      return;
    }
    const running = execute(entry);
    entry.running = running;
  };

  const remove = (id: string): Entry | undefined => {
    const entry = entries.get(id);
    if (entry === undefined) return undefined;
    if (entry.handle !== undefined) deps.timer.clearTimeout(entry.handle);
    entries.delete(id);
    entry.controller.abort();
    const running = entry.running;
    if (running !== undefined) {
      outstanding.set(id, running);
      void running.then(() => {
        if (outstanding.get(id) === running) outstanding.delete(id);
      });
    }
    return entry;
  };

  const add = (check: ProbeCheck): void => {
    const previous = outstanding.get(check.id);
    // Until its own run starts, the entry carries the old wait, so a further replacement
    // still waits for the oldest run that has not settled.
    const entry: Entry = { check, controller: new AbortController(), running: previous };
    entries.set(check.id, entry);
    const delay = firstDelay(check.intervalMs, deps.random());
    entry.handle = deps.timer.setTimeout(() => tick(entry, previous), delay);
  };

  const sync = (next: ProbeCheck[]): void => {
    if (stopped) return;
    const wanted = new Map(next.map((c) => [c.id, c]));
    for (const id of [...entries.keys()]) if (!wanted.has(id)) remove(id);
    for (const [id, check] of wanted) {
      const existing = entries.get(id);
      if (existing !== undefined && isDeepStrictEqual(existing.check, check)) continue;
      remove(id);
      add(check);
    }
  };

  sync(checks);

  return {
    sync,
    stop() {
      stopped = true;
      for (const id of [...entries.keys()]) remove(id);
    },
  };
}
