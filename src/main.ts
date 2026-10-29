import { setTimeout as sleep } from "node:timers/promises";
import { runCheck } from "./check.ts";
import { fetchChecks, loadChecks, postResult, RETRY_MS } from "./client.ts";
import { parseLocation } from "./location.ts";
import { parseReloadMs } from "./reload-interval.ts";
import { startReloader } from "./reloader.ts";
import { startScheduler } from "./scheduler.ts";
import { parseToken } from "./token.ts";

const apiUrl = process.env.PULSE_API_URL ?? "http://localhost:3000";
const location = parseLocation(process.env.PULSE_LOCATION);
const log = (message: string): void => console.error(`[probe] ${message}`);
let token: string;
let reloadMs: number;
try {
  token = parseToken(process.env.PULSE_PROBE_TOKEN);
  reloadMs = parseReloadMs(process.env.PULSE_CHECKS_RELOAD_MS);
} catch (err) {
  log(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
// Wall clock for result timestamps and TLS expiry; monotonic clock for scheduling and latency.
const now = (): number => Date.now();
const monotonic = (): number => performance.now();
const timer = {
  setTimeout: (fn: () => void, ms: number): unknown => setTimeout(fn, ms),
  clearTimeout: (h: unknown): void => clearTimeout(h as ReturnType<typeof setTimeout>),
};

const checks = await fetchChecks(apiUrl, { fetch, sleep: (ms) => sleep(ms), log }, RETRY_MS);
log(`running ${checks.length} check(s) against ${apiUrl} from location ${location}`);

const reloader = startReloader({
  timer,
  now: monotonic,
  load: () => loadChecks(apiUrl, { fetch, log }),
  apply: (next) => scheduler.sync(next),
  log,
  intervalMs: reloadMs,
  retryMs: RETRY_MS,
  minGapMs: 5000,
});

const scheduler = startScheduler(checks, {
  timer,
  now: monotonic,
  run: (check) => runCheck(check, { fetch, now, monotonic, sleep: (ms) => sleep(ms), location }),
  onResult: async (result) => {
    const outcome = await postResult(apiUrl, result, { fetch, log, token });
    if (outcome === "unknown-check") reloader.requestReload();
  },
  onError: (check, err) => log(`check ${check.id} failed unexpectedly: ${String(err)}`),
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    reloader.stop();
    scheduler.stop();
    process.exit(0);
  });
}
