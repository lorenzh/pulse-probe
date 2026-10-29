export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export type LogFields = Record<string, string | number | boolean | null>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

export interface LoggerDeps {
  level: LogLevel;
  /** Wall clock in epoch ms. */
  now: () => number;
  /** Receives one finished JSON line, without the newline. */
  write: (level: LogLevel, line: string) => void;
}

/** Reads PULSE_LOG_LEVEL: `info` when unset or blank. */
export function parseLogLevel(raw: string | undefined): LogLevel {
  const text = (raw ?? "").trim();
  if (text === "") return "info";
  const level = LOG_LEVELS.find((l) => l === text);
  if (level === undefined) {
    throw new Error(`PULSE_LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}`);
  }
  return level;
}

/** Writes JSON lines `{"time":<ISO 8601>,"level":...,"msg":...,<fields>}` at or above `deps.level`. */
export function createLogger(deps: LoggerDeps): Logger {
  const min = LOG_LEVELS.indexOf(deps.level);
  const emit = (level: LogLevel, msg: string, fields: LogFields = {}): void => {
    if (LOG_LEVELS.indexOf(level) < min) return;
    const base = { time: new Date(deps.now()).toISOString(), level, msg };
    // Base keys come first and win over a field of the same name.
    deps.write(level, JSON.stringify({ ...base, ...fields, ...base }));
  };
  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
  };
}
