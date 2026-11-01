import {
  type Env,
  type LogLevel,
  readBool,
  readInt,
  readLogLevel,
  readMs,
  readPort,
  readString,
  readUrl,
  StartupError,
} from "@lorenzh/pulse-kit";
import { type HeaderHosts, parseHeaderHosts } from "./header-hosts.ts";
import { parseLocation } from "./location.ts";
import { parseReloadMs } from "./reload-interval.ts";
import { readProbeToken } from "./token.ts";

const DEFAULT_API_URL = "http://localhost:3000";
export const DEFAULT_HEALTH_HOST = "127.0.0.1";

export const DEFAULT_BUFFER_MAX_RESULTS = 10_000;
export const DEFAULT_BUFFER_MAX_AGE_MS = 3_600_000;
// A count limit kept for compatibility, not a timer bound.
const MAX_BUFFER_RESULTS = 2_147_483_647;

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
  /** Checks may not connect to private, loopback, link-local or metadata addresses. */
  blockPrivateRanges: boolean;
  /** `PULSE_PROBE_HEADER_HOSTS`, read once at start: hosts each header variable may reach. */
  headerHosts: HeaderHosts;
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

/**
 * Reads and validates the environment. `readFile` reads the token file when
 * PULSE_PROBE_TOKEN_FILE is set. Throws `StartupError` with a one-line message.
 */
export function loadSettings(env: Env, readFile: (path: string) => string): Settings {
  try {
    return {
      apiUrl: readApiUrl(env),
      location: parseLocation(env.PULSE_LOCATION),
      token: readProbeToken(env, readFile),
      reloadMs: parseReloadMs(env.PULSE_CHECKS_RELOAD_MS),
      bufferMaxResults: readInt(env, "PULSE_BUFFER_MAX_RESULTS", {
        fallback: DEFAULT_BUFFER_MAX_RESULTS,
        min: 1,
        max: MAX_BUFFER_RESULTS,
        describe: `must be a positive integer up to ${MAX_BUFFER_RESULTS}`,
      }),
      bufferMaxAgeMs: readMs(env, "PULSE_BUFFER_MAX_AGE_MS", {
        fallback: DEFAULT_BUFFER_MAX_AGE_MS,
        min: 1,
      }),
      logLevel: readLogLevel(env),
      health: readHealth(env),
      blockPrivateRanges: readBool(env, "PULSE_PROBE_BLOCK_PRIVATE_RANGES", false),
      headerHosts: parseHeaderHosts(env.PULSE_PROBE_HEADER_HOSTS),
    };
  } catch (err) {
    if (err instanceof StartupError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new StartupError(message.split("\n")[0] ?? message, { cause: err });
  }
}
