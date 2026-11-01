import type { Result } from "@lorenzh/pulse-contract";
import { type CheckDeps, runCheck } from "./check.ts";
import type { ProbeCheck } from "./client.ts";
import { monotonic, now } from "./clock.ts";
import { type Scheduler, startScheduler, type Timer } from "./scheduler.ts";

export interface CheckSchedulerDeps {
  timer: Timer;
  fetch: CheckDeps["fetch"];
  /** Guarded transports when the private-range policy is on; the defaults otherwise. */
  tcpConnect?: CheckDeps["tcpConnect"];
  tlsConnect?: CheckDeps["tlsConnect"];
  resolve?: CheckDeps["resolve"];
  sleep: CheckDeps["sleep"];
  location: string;
  signal: AbortSignal;
  /** Registers a running promise so that shutdown can wait for it. */
  track: <T>(work: Promise<T>) => Promise<T>;
  onResult: (result: Result) => Promise<void>;
  onError: (check: ProbeCheck, err: unknown) => void;
}

/**
 * Runs `checks` on their intervals. The schedule uses the monotonic clock, so a wall clock
 * step does not stall it; the wall clock only stamps the results.
 */
export function startCheckScheduler(checks: ProbeCheck[], deps: CheckSchedulerDeps): Scheduler {
  return startScheduler(checks, {
    timer: deps.timer,
    now: monotonic,
    run: (check) =>
      deps.track(
        runCheck(check, {
          fetch: deps.fetch,
          now,
          monotonic,
          sleep: deps.sleep,
          location: deps.location,
          signal: deps.signal,
          ...(deps.tcpConnect !== undefined ? { tcpConnect: deps.tcpConnect } : {}),
          ...(deps.tlsConnect !== undefined ? { tlsConnect: deps.tlsConnect } : {}),
          ...(deps.resolve !== undefined ? { resolve: deps.resolve } : {}),
        }),
      ),
    onResult: (result) => deps.track(deps.onResult(result)),
    onError: deps.onError,
  });
}
