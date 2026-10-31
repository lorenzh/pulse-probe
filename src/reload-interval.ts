import { MAX_TIMER_DELAY_MS } from "@lorenzh/pulse-kit";

export const DEFAULT_RELOAD_MS = 60_000;
export const MIN_RELOAD_MS = 5000;
export const MAX_RELOAD_MS = MAX_TIMER_DELAY_MS;

/** Reads PULSE_CHECKS_RELOAD_MS: an integer from 5000 to 2147483647, 60000 when unset or blank. */
export function parseReloadMs(raw: string | undefined): number {
  const text = (raw ?? "").trim();
  if (text === "") return DEFAULT_RELOAD_MS;
  const value = Number(text);
  if (
    !/^\d+$/.test(text) ||
    !Number.isSafeInteger(value) ||
    value < MIN_RELOAD_MS ||
    value > MAX_RELOAD_MS
  ) {
    throw new Error(
      `PULSE_CHECKS_RELOAD_MS must be an integer from ${MIN_RELOAD_MS} to ${MAX_RELOAD_MS}`,
    );
  }
  return value;
}
