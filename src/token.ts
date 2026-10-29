/** Reads the probe token from PULSE_PROBE_TOKEN: trimmed, required. The message never holds the value. */
export function parseToken(raw: string | undefined): string {
  const token = (raw ?? "").trim();
  if (token === "") {
    throw new Error("PULSE_PROBE_TOKEN is missing or empty");
  }
  return token;
}
