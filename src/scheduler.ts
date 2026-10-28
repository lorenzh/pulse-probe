import type { Check, Result } from "@lorenzh/pulse-contract";

export interface Timer {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SchedulerDeps {
  timer: Timer;
  now: () => number;
  run: (check: Check) => Promise<Result>;
  onResult: (result: Result) => void | Promise<void>;
  onError?: (check: Check, err: unknown) => void;
}

export interface Scheduler {
  stop(): void;
}

/**
 * Runs each check immediately, then once per interval. The next run is only
 * scheduled after the previous one finished, so a check never overlaps itself.
 */
export function startScheduler(checks: Check[], deps: SchedulerDeps): Scheduler {
  let stopped = false;
  const handles = new Map<string, unknown>();

  const tick = async (check: Check): Promise<void> => {
    handles.delete(check.id);
    if (stopped) return;
    const started = deps.now();
    try {
      const result = await deps.run(check);
      if (!stopped) await deps.onResult(result);
    } catch (err) {
      deps.onError?.(check, err);
    }
    if (stopped) return;
    const delay = Math.max(0, check.intervalMs - (deps.now() - started));
    handles.set(check.id, deps.timer.setTimeout(() => void tick(check), delay));
  };

  for (const check of checks) void tick(check);

  return {
    stop() {
      stopped = true;
      for (const h of handles.values()) deps.timer.clearTimeout(h);
      handles.clear();
    },
  };
}
