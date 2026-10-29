import { setTimeout as sleep } from "node:timers/promises";
import type { Check, Result } from "@lorenzh/pulse-contract";
import { runCheck } from "./check.ts";
import {
  fetchChecks,
  loadChecks,
  type PostOutcome,
  postResult,
  RETRY_MS,
  StartupAbortedError,
} from "./client.ts";
import { type HealthServer, startHealthServer } from "./health.ts";
import { createLogger, type Logger } from "./log.ts";
import { createMetrics, type PostMetricOutcome } from "./metrics.ts";
import { startReloader } from "./reloader.ts";
import { startScheduler } from "./scheduler.ts";
import { loadSettings, SettingsError } from "./settings.ts";

const SHUTDOWN_TIMEOUT_MS = 5000;

// Wall clock for result timestamps and TLS expiry; monotonic clock for scheduling and latency.
const now = (): number => Date.now();
const monotonic = (): number => performance.now();
const timer = {
  setTimeout: (fn: () => void, ms: number): unknown => setTimeout(fn, ms),
  clearTimeout: (h: unknown): void => clearTimeout(h as ReturnType<typeof setTimeout>),
};

function postMetricOutcome(outcome: PostOutcome): PostMetricOutcome {
  switch (outcome) {
    case "accepted":
      return "ok";
    case "dropped":
      return "rejected";
    case "unknown-check":
      return "unknown-check";
    case "failed":
      return "error";
    default: {
      const unreachable: never = outcome;
      return unreachable;
    }
  }
}

// Signal handlers come first: a signal during the settings, the health listener or the
// startup retries must stop the probe at once.
const shutdown = new AbortController();
let isShuttingDown = false;
let stopWork: (() => Promise<void>) | undefined;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    shutdown.abort();
    // Before startup finishes, `main` sees the aborted signal and exits itself.
    void stopWork?.();
  });
}

async function main(): Promise<void> {
  const settings = loadSettings(process.env);
  const logger: Logger = createLogger({
    level: settings.logLevel,
    now,
    write: (level, line) => {
      if (level === "warn" || level === "error") console.error(line);
      else console.log(line);
    },
  });
  const log = (message: string): void => logger.warn(message);
  const abortableSleep = (ms: number): Promise<void> =>
    sleep(ms, undefined, { signal: shutdown.signal });
  const metrics = createMetrics();
  let hasChecks = false;
  let health: HealthServer | undefined;
  if (settings.health !== undefined) {
    const { port, host } = settings.health;
    try {
      health = await startHealthServer(settings.health, {
        readiness: () => {
          if (isShuttingDown) return { ready: false, reason: "shutting down" };
          if (!hasChecks) return { ready: false, reason: "checks not loaded yet" };
          return { ready: true };
        },
        renderMetrics: () => metrics.render(),
      });
    } catch (err) {
      throw new SettingsError(
        `cannot listen on ${host}:${port} (PULSE_HEALTH_HOST/PULSE_HEALTH_PORT): ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    logger.info("health listener started", { host, port: health.port });
  }

  let checks: Check[];
  try {
    checks = await fetchChecks(
      settings.apiUrl,
      { fetch, sleep: abortableSleep, log, signal: shutdown.signal },
      RETRY_MS,
    );
  } catch (err) {
    if (err instanceof StartupAbortedError) {
      await health?.close();
      logger.info("stopped during startup");
      process.exit(0);
    }
    throw err;
  }
  hasChecks = true;
  metrics.setChecks(checks);
  logger.info(
    `running ${checks.length} check(s) against ${settings.apiUrl} from location ${settings.location}`,
  );

  const inFlight = new Set<Promise<unknown>>();
  const track = <T>(work: Promise<T>): Promise<T> => {
    inFlight.add(work);
    const forget = (): void => {
      inFlight.delete(work);
    };
    work.then(forget, forget);
    return work;
  };

  const reloader = startReloader({
    timer,
    now: monotonic,
    load: () => loadChecks(settings.apiUrl, { fetch, log, signal: shutdown.signal }),
    apply: (next) => {
      metrics.setChecks(next);
      scheduler.sync(next);
    },
    log,
    intervalMs: settings.reloadMs,
    retryMs: RETRY_MS,
    minGapMs: 5000,
  });

  const onResult = async (result: Result): Promise<void> => {
    metrics.recordResult(result);
    logger.debug("check result", {
      check: result.checkId,
      status: result.status,
      latencyMs: result.latencyMs,
      location: result.location,
    });
    const outcome = await postResult(settings.apiUrl, result, {
      fetch,
      log,
      token: settings.token,
      signal: shutdown.signal,
    });
    metrics.recordPost(result.checkId, postMetricOutcome(outcome));
    if (outcome === "unknown-check") reloader.requestReload();
  };

  const scheduler = startScheduler(checks, {
    timer,
    now: monotonic,
    run: (check) =>
      track(
        runCheck(check, {
          fetch,
          now,
          monotonic,
          sleep: abortableSleep,
          location: settings.location,
          signal: shutdown.signal,
        }),
      ),
    onResult: (result) => track(onResult(result)),
    onError: (check, err) => {
      if (isShuttingDown) return;
      logger.error(`check ${check.id} failed unexpectedly: ${String(err)}`);
    },
  });

  stopWork = async (): Promise<void> => {
    reloader.stop();
    scheduler.stop();
    let boundTimer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<"timeout">((resolve) => {
      boundTimer = setTimeout(() => resolve("timeout"), SHUTDOWN_TIMEOUT_MS);
    });
    const finished = Promise.allSettled([...inFlight, health?.close()]).then(() => "done" as const);
    if ((await Promise.race([finished, bound])) === "timeout") {
      logger.warn(`shutdown did not finish within ${SHUTDOWN_TIMEOUT_MS}ms; exiting anyway`);
    }
    clearTimeout(boundTimer);
    process.exit(0);
  };
  if (isShuttingDown) void stopWork();
}

try {
  await main();
} catch (err) {
  if (err instanceof SettingsError) {
    console.error(err.message);
    process.exit(2);
  }
  console.error(
    JSON.stringify({
      time: new Date(now()).toISOString(),
      level: "error",
      msg: `unexpected failure: ${err instanceof Error ? err.message : String(err)}`,
    }),
  );
  process.exit(1);
}
