export const DEFAULT_LOCATION = "default";
export const MAX_LOCATION_LENGTH = 64;

/** Reads the probe location from PULSE_LOCATION: trimmed, `default` when unset or empty. */
export function parseLocation(raw: string | undefined): string {
  const location = (raw ?? "").trim();
  if (location === "") return DEFAULT_LOCATION;
  if (location.length > MAX_LOCATION_LENGTH) {
    throw new Error(`PULSE_LOCATION is longer than ${MAX_LOCATION_LENGTH} characters`);
  }
  return location;
}

export function userAgent(location: string): string {
  return `pulse-probe (${location})`;
}
