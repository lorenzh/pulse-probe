export const DEFAULT_RELOAD_MS = 60_000;
export const MIN_RELOAD_MS = 5000;

/** Reads PULSE_CHECKS_RELOAD_MS: an integer of at least 5000, 60000 when unset or blank. */
export function parseReloadMs(raw: string | undefined): number {
  const text = (raw ?? "").trim();
  if (text === "") return DEFAULT_RELOAD_MS;
  const value = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < MIN_RELOAD_MS) {
    throw new Error(`PULSE_CHECKS_RELOAD_MS must be an integer of at least ${MIN_RELOAD_MS}`);
  }
  return value;
}
