import { setTimeout as sleep } from "node:timers/promises";
import type { Result } from "@lorenzh/pulse-contract";
import {
  createLogger,
  type Logger,
  type OpsServer,
  type Readiness,
  runService,
  StartupError,
  startOpsServer,
} from "@lorenzh/pulse-kit";
import { runCheck } from "./check.ts";
import type { ProbeCheck } from "./client.ts";
import {
  fetchChecks,
  loadChecks,
  type PostOutcome,
  postResult,
  RETRY_MS,
  StartupAbortedError,
} from "./client.ts";
import { createMetrics, type Metrics, type PostMetricOutcome } from "./metrics.ts";
import { startReloader } from "./reloader.ts";
import { startScheduler } from "./scheduler.ts";
import { loadSettings, type Settings } from "./settings.ts";

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

// Before the settings are read, log lines use the default level.
let logger: Logger = createLogger({ now });
const startupLogger: Logger = {
  debug: (msg, fields) => logger.debug(msg, fields),
  info: (msg, fields) => logger.info(msg, fields),
  warn: (msg, fields) => logger.warn(msg, fields),
  error: (msg, fields) => logger.error(msg, fields),
};

// Aborted on stop: ends the startup retries, the sleeps and the in-flight requests.
const shutdown = new AbortController();
let isShuttingDown = false;
let health: OpsServer | undefined;
let loading: Promise<void> = Promise.resolve();
let stopWork: () => void = () => undefined;
const inFlight = new Set<Promise<unknown>>();

const track = <T>(work: Promise<T>): Promise<T> => {
  inFlight.add(work);
  const forget = (): void => {
    inFlight.delete(work);
  };
  work.then(forget, forget);
  return work;
};

async function startHealth(
  settings: Settings,
  isReady: () => Readiness,
  metrics: Metrics,
): Promise<void> {
  if (settings.health === undefined) return;
  const { port, host } = settings.health;
  try {
    health = await startOpsServer({
      host,
      port,
      setting: "PULSE_HEALTH_PORT",
      methodNotAllowed: "404",
      ready: isReady,
      metrics: () => metrics.render(),
    });
  } catch (err) {
    throw new StartupError(
      `cannot listen on ${host}:${port} (PULSE_HEALTH_HOST/PULSE_HEALTH_PORT): ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  logger.info("health listener started", { host, port: health.port });
}

async function runChecks(settings: Settings, metrics: Metrics, onReady: () => void): Promise<void> {
  const log = (message: string): void => logger.warn(message);
  const abortableSleep = (ms: number): Promise<void> =>
    sleep(ms, undefined, { signal: shutdown.signal });
  let checks: ProbeCheck[];
  try {
    checks = await fetchChecks(
      settings.apiUrl,
      { fetch, sleep: abortableSleep, log, signal: shutdown.signal },
      RETRY_MS,
    );
  } catch (err) {
    if (err instanceof StartupAbortedError) {
      logger.info("stopped during startup");
      return;
    }
    throw err;
  }
  onReady();
  metrics.setChecks(checks);
  logger.info(
    `running ${checks.length} check(s) against ${settings.apiUrl} from location ${settings.location}`,
  );

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
  stopWork = (): void => {
    reloader.stop();
    scheduler.stop();
  };
}

async function start(): Promise<void> {
  const settings = loadSettings(process.env);
  logger = createLogger({ level: settings.logLevel, now });
  const metrics = createMetrics();
  let hasChecks = false;
  await startHealth(
    settings,
    () => {
      if (isShuttingDown) return { ready: false, reason: "shutting down" };
      if (!hasChecks) return { ready: false, reason: "checks not loaded yet" };
      return { ready: true };
    },
    metrics,
  );
  // The checks load in the background so that a signal can stop the startup retries.
  loading = runChecks(settings, metrics, () => {
    hasChecks = true;
  }).catch((err: unknown) => {
    logger.error("unexpected failure", { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });
}

async function stop(): Promise<void> {
  isShuttingDown = true;
  shutdown.abort();
  await loading;
  stopWork();
  await Promise.allSettled([...inFlight, health?.close()]);
}

await runService({
  service: "probe",
  start,
  stop,
  timeoutMs: SHUTDOWN_TIMEOUT_MS,
  log: startupLogger,
});
