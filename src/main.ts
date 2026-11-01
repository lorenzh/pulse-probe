import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import type { Result } from "@lorenzh/pulse-contract";
import {
  createLogger,
  type Logger,
  lookupAll,
  type OpsServer,
  type Readiness,
  runService,
  StartupError,
  startOpsServer,
} from "@lorenzh/pulse-kit";
import { createResultBuffer } from "./buffer.ts";
import { tlsConnect } from "./check.ts";
import { resolveRecords } from "./check-dns.ts";
import { createCheckGuard } from "./check-guard.ts";
import { type CheckSchedulerDeps, startCheckScheduler } from "./check-scheduler.ts";
import { tcpConnect } from "./check-tcp.ts";
import type { ProbeCheck } from "./client.ts";
import {
  fetchChecks,
  loadChecks,
  type PostOutcome,
  postResult,
  RETRY_MS,
  StartupAbortedError,
} from "./client.ts";
import { monotonic, now } from "./clock.ts";
import { createMetrics, type Metrics, type PostMetricOutcome } from "./metrics.ts";
import { startReloader } from "./reloader.ts";
import { loadSettings, type Settings } from "./settings.ts";

const SHUTDOWN_TIMEOUT_MS = 5000;

const readTokenFile = (path: string): string => readFileSync(path, "utf8");

const timer = {
  setTimeout: (fn: () => void, ms: number): unknown => setTimeout(fn, ms),
  clearTimeout: (h: unknown): void => clearTimeout(h as ReturnType<typeof setTimeout>),
};

function postMetricOutcome(outcome: PostOutcome): PostMetricOutcome {
  switch (outcome) {
    case "accepted":
      return "ok";
    case "rejected":
      return "rejected";
    case "unknown-check":
      return "unknown-check";
    case "retry":
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
let finishWork: () => Promise<void> = () => Promise.resolve();
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

type CheckTransports = Pick<CheckSchedulerDeps, "fetch" | "tcpConnect" | "tlsConnect" | "resolve">;

/** The transports of the checks. API traffic never goes through them. */
function checkTransports(settings: Settings): CheckTransports {
  if (!settings.blockPrivateRanges) return { fetch };
  logger.info("blocking check connections to private addresses (PULSE_PROBE_BLOCK_PRIVATE_RANGES)");
  return createCheckGuard({
    fetch,
    lookup: lookupAll,
    tcpConnect,
    tlsConnect,
    resolve: resolveRecords,
    monotonic,
  });
}

async function runChecks(settings: Settings, metrics: Metrics, onReady: () => void): Promise<void> {
  logger.info(`header host bindings for ${settings.headerHosts.size} variable(s)`);
  const log = (message: string): void => logger.warn(message);
  const abortableSleep = (ms: number): Promise<void> =>
    sleep(ms, undefined, { signal: shutdown.signal });
  let checks: ProbeCheck[];
  try {
    checks = await fetchChecks(
      settings.apiUrl,
      {
        fetch,
        sleep: abortableSleep,
        log,
        signal: shutdown.signal,
        token: settings.token,
        env: process.env,
        headerHosts: settings.headerHosts,
      },
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
    load: () =>
      loadChecks(settings.apiUrl, {
        fetch,
        log,
        signal: shutdown.signal,
        token: settings.token,
        env: process.env,
        headerHosts: settings.headerHosts,
      }),
    apply: (next) => {
      metrics.setChecks(next);
      scheduler.sync(next);
    },
    log,
    intervalMs: settings.reloadMs,
    retryMs: RETRY_MS,
    minGapMs: 5000,
  });

  const buffer = createResultBuffer({
    post: (result) =>
      postResult(settings.apiUrl, result, {
        fetch,
        log,
        token: settings.token,
        signal: shutdown.signal,
      }),
    now,
    sleep: abortableSleep,
    signal: shutdown.signal,
    log: (message) => logger.warn(message),
    maxResults: settings.bufferMaxResults,
    maxAgeMs: settings.bufferMaxAgeMs,
    onPost: (result, outcome) => {
      metrics.recordPost(result.checkId, postMetricOutcome(outcome));
      if (outcome === "unknown-check") reloader.requestReload();
    },
    onDrop: (reason) => metrics.recordDrop(reason),
    onDeliveredLate: () => metrics.recordDeliveredLate(),
    onSize: (size) => metrics.setBuffered(size),
  });

  const onResult = async (result: Result): Promise<void> => {
    metrics.recordResult(result);
    logger.debug("check result", {
      check: result.checkId,
      status: result.status,
      latencyMs: result.latencyMs,
      location: result.location,
    });
    await buffer.submit(result);
  };

  const scheduler = startCheckScheduler(checks, {
    timer,
    ...checkTransports(settings),
    sleep: abortableSleep,
    location: settings.location,
    signal: shutdown.signal,
    track,
    onResult,
    onError: (check, err) => {
      if (isShuttingDown) return;
      logger.error(`check ${check.id} failed unexpectedly: ${String(err)}`);
    },
  });
  stopWork = (): void => {
    reloader.stop();
    scheduler.stop();
  };
  finishWork = async (): Promise<void> => {
    await buffer.idle();
    buffer.close();
  };
}

async function start(): Promise<void> {
  const settings = loadSettings(process.env, readTokenFile);
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
  await finishWork();
}

await runService({
  service: "probe",
  start,
  stop,
  timeoutMs: SHUTDOWN_TIMEOUT_MS,
  log: startupLogger,
});
