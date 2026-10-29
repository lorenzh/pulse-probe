import { isDeepStrictEqual } from "node:util";
import type { Result } from "@lorenzh/pulse-contract";
import type { ProbeCheck } from "./client.ts";

export interface Timer {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SchedulerDeps {
  timer: Timer;
  /** Monotonic clock in ms. */
  now: () => number;
  run: (check: ProbeCheck) => Promise<Result>;
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
  handle?: unknown;
}

/**
 * Runs each check immediately, then once per interval. The next run is only
 * scheduled after the previous one finished, so a check never overlaps itself.
 * `deps.now` must be a monotonic clock. A removed or replaced check never posts.
 */
export function startScheduler(checks: ProbeCheck[], deps: SchedulerDeps): Scheduler {
  let stopped = false;
  const entries = new Map<string, Entry>();

  const tick = async (entry: Entry): Promise<void> => {
    const isCurrent = (): boolean => !stopped && entries.get(entry.check.id) === entry;
    entry.handle = undefined;
    if (!isCurrent()) return;
    const { check } = entry;
    const started = deps.now();
    try {
      const result = await deps.run(check);
      if (isCurrent()) await deps.onResult(result);
    } catch (err) {
      deps.onError?.(check, err);
    }
    if (!isCurrent()) return;
    const delay = Math.max(0, check.intervalMs - (deps.now() - started));
    entry.handle = deps.timer.setTimeout(() => void tick(entry), delay);
  };

  const remove = (id: string): void => {
    const entry = entries.get(id);
    if (entry === undefined) return;
    if (entry.handle !== undefined) deps.timer.clearTimeout(entry.handle);
    entries.delete(id);
  };

  const sync = (next: ProbeCheck[]): void => {
    if (stopped) return;
    const wanted = new Map(next.map((c) => [c.id, c]));
    for (const id of [...entries.keys()]) if (!wanted.has(id)) remove(id);
    for (const [id, check] of wanted) {
      const existing = entries.get(id);
      if (existing !== undefined) {
        if (isDeepStrictEqual(existing.check, check)) continue;
        remove(id);
      }
      const entry: Entry = { check };
      entries.set(id, entry);
      void tick(entry);
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
