import {
  type Env,
  type LogLevel,
  readLogLevel,
  readPort,
  readString,
  StartupError,
} from "@lorenzh/pulse-kit";
import { parseLocation } from "./location.ts";
import { parseReloadMs } from "./reload-interval.ts";
import { parseToken } from "./token.ts";

export const DEFAULT_HEALTH_HOST = "127.0.0.1";

export interface HealthSettings {
  port: number;
  host: string;
}

export interface Settings {
  apiUrl: string;
  location: string;
  token: string;
  reloadMs: number;
  logLevel: LogLevel;
  health: HealthSettings | undefined;
}

function readHealth(env: Env): HealthSettings | undefined {
  const port = readPort(env, "PULSE_HEALTH_PORT");
  if (port === undefined) return undefined;
  return { port, host: readString(env, "PULSE_HEALTH_HOST") ?? DEFAULT_HEALTH_HOST };
}

/** Reads and validates the environment. Throws `StartupError` with a one-line message. */
export function loadSettings(env: Env): Settings {
  try {
    return {
      apiUrl: env.PULSE_API_URL ?? "http://localhost:3000",
      location: parseLocation(env.PULSE_LOCATION),
      token: parseToken(env.PULSE_PROBE_TOKEN),
      reloadMs: parseReloadMs(env.PULSE_CHECKS_RELOAD_MS),
      logLevel: readLogLevel(env),
      health: readHealth(env),
    };
  } catch (err) {
    if (err instanceof StartupError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new StartupError(message.split("\n")[0] ?? message, { cause: err });
  }
}
