import type { ProbeCheck } from "./client.ts";
import type { Timer } from "./scheduler.ts";

export interface ReloaderDeps {
  timer: Timer;
  /** Monotonic clock in ms. */
  now: () => number;
  load: () => Promise<ProbeCheck[]>;
  apply: (checks: ProbeCheck[]) => void;
  log: (message: string) => void;
  intervalMs: number;
  /** Delay before retrying a failed reload; never later than `intervalMs`. */
  retryMs: number;
  /** Least time between two reloads started by `requestReload`. */
  minGapMs: number;
}

export interface Reloader {
  /** Reloads soon. Calls while a reload is pending or running collapse into one. */
  requestReload(): void;
  stop(): void;
}

/** Reloads the checks every `intervalMs`. A failed reload keeps the running checks. */
export function startReloader(deps: ReloaderDeps): Reloader {
  let stopped = false;
  let isRunning = false;
  let isRequested = false;
  let handle: unknown;
  let lastStart = deps.now();

  const schedule = (delay: number): void => {
    if (handle !== undefined) deps.timer.clearTimeout(handle);
    handle = deps.timer.setTimeout(() => void run(), delay);
  };

  const run = async (): Promise<void> => {
    handle = undefined;
    isRequested = false;
    if (stopped) return;
    isRunning = true;
    lastStart = deps.now();
    let delay = deps.intervalMs;
    try {
      const checks = await deps.load();
      if (!stopped) deps.apply(checks);
    } catch (err) {
      deps.log(
        `reloading checks failed: ${err instanceof Error ? err.message : String(err)}; keeping the current checks`,
      );
      delay = Math.min(deps.retryMs, deps.intervalMs);
    }
    isRunning = false;
    if (stopped || isRequested) return;
    schedule(delay);
  };

  schedule(deps.intervalMs);

  return {
    requestReload() {
      if (stopped || isRunning || isRequested) return;
      isRequested = true;
      schedule(Math.max(0, lastStart + deps.minGapMs - deps.now()));
    },
    stop() {
      stopped = true;
      if (handle !== undefined) deps.timer.clearTimeout(handle);
      handle = undefined;
    },
  };
}
