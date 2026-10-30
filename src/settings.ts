import {
  type Env,
  type LogLevel,
  readLogLevel,
  readMs,
  readPort,
  readString,
  readUrl,
  StartupError,
} from "@lorenzh/pulse-kit";
import { parseLocation } from "./location.ts";
import { parseReloadMs } from "./reload-interval.ts";
import { parseToken } from "./token.ts";

const DEFAULT_API_URL = "http://localhost:3000";
export const DEFAULT_HEALTH_HOST = "127.0.0.1";

export const DEFAULT_BUFFER_MAX_RESULTS = 10_000;
export const DEFAULT_BUFFER_MAX_AGE_MS = 3_600_000;
const MAX_TIMER_MS = 2_147_483_647;

export interface HealthSettings {
  port: number;
  host: string;
}

export interface Settings {
  apiUrl: string;
  location: string;
  token: string;
  reloadMs: number;
  bufferMaxResults: number;
  bufferMaxAgeMs: number;
  logLevel: LogLevel;
  health: HealthSettings | undefined;
}

function readHealth(env: Env): HealthSettings | undefined {
  const port = readPort(env, "PULSE_HEALTH_PORT");
  if (port === undefined) return undefined;
  return { port, host: readString(env, "PULSE_HEALTH_HOST") ?? DEFAULT_HEALTH_HOST };
}

function readApiUrl(env: Env): string {
  const url = readUrl(env, "PULSE_API_URL");
  if (url !== undefined) return url;
  // Set but empty: an error, not the default.
  if (env.PULSE_API_URL !== undefined) {
    throw new StartupError("PULSE_API_URL must be an http(s) URL, not empty");
  }
  return DEFAULT_API_URL;
}

/** Reads and validates the environment. Throws `StartupError` with a one-line message. */
export function loadSettings(env: Env): Settings {
  try {
    return {
      apiUrl: readApiUrl(env),
      location: parseLocation(env.PULSE_LOCATION),
      token: parseToken(env.PULSE_PROBE_TOKEN),
      reloadMs: parseReloadMs(env.PULSE_CHECKS_RELOAD_MS),
      bufferMaxResults: readMs(env, "PULSE_BUFFER_MAX_RESULTS", {
        fallback: DEFAULT_BUFFER_MAX_RESULTS,
        min: 1,
        max: MAX_TIMER_MS,
        describe: `must be a positive integer up to ${MAX_TIMER_MS}`,
      }),
      bufferMaxAgeMs: readMs(env, "PULSE_BUFFER_MAX_AGE_MS", {
        fallback: DEFAULT_BUFFER_MAX_AGE_MS,
        min: 1,
        max: MAX_TIMER_MS,
      }),
      logLevel: readLogLevel(env),
      health: readHealth(env),
    };
  } catch (err) {
    if (err instanceof StartupError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new StartupError(message.split("\n")[0] ?? message, { cause: err });
  }
}
