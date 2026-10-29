import { type HealthSettings, parseHealthSettings } from "./health.ts";
import { parseLocation } from "./location.ts";
import { type LogLevel, parseLogLevel } from "./log.ts";
import { parseReloadMs } from "./reload-interval.ts";
import { parseToken } from "./token.ts";

export interface Settings {
  apiUrl: string;
  location: string;
  token: string;
  reloadMs: number;
  logLevel: LogLevel;
  health: HealthSettings | undefined;
}

/** A configuration error: one line `pulse-probe: <message>`, exit code 2. */
export class SettingsError extends Error {
  override name = "SettingsError";
  constructor(message: string, options?: ErrorOptions) {
    super(`pulse-probe: ${message}`, options);
  }
}

/** Reads and validates the environment. Throws `SettingsError` with a one-line message. */
export function loadSettings(env: Record<string, string | undefined>): Settings {
  try {
    return {
      apiUrl: env.PULSE_API_URL ?? "http://localhost:3000",
      location: parseLocation(env.PULSE_LOCATION),
      token: parseToken(env.PULSE_PROBE_TOKEN),
      reloadMs: parseReloadMs(env.PULSE_CHECKS_RELOAD_MS),
      logLevel: parseLogLevel(env.PULSE_LOG_LEVEL),
      health: parseHealthSettings(env.PULSE_HEALTH_PORT, env.PULSE_HEALTH_HOST),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new SettingsError(message.split("\n")[0] ?? message, { cause: err });
  }
}
