import { setTimeout as sleep } from "node:timers/promises";
import { runCheck } from "./check.ts";
import { fetchChecks, postResult } from "./client.ts";
import { startScheduler } from "./scheduler.ts";

const apiUrl = process.env.PULSE_API_URL ?? "http://localhost:3000";
const log = (message: string): void => console.error(`[probe] ${message}`);
const now = (): number => Date.now();

const checks = await fetchChecks(apiUrl, { fetch, sleep: (ms) => sleep(ms), log });
log(`running ${checks.length} check(s) against ${apiUrl}`);

const scheduler = startScheduler(checks, {
  timer: {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  },
  now,
  run: (check) => runCheck(check, { fetch, now }),
  onResult: async (result) => {
    await postResult(apiUrl, result, { fetch, log });
  },
  onError: (check, err) => log(`check ${check.id} failed unexpectedly: ${String(err)}`),
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    scheduler.stop();
    process.exit(0);
  });
}
