import type { Result } from "@lorenzh/pulse-contract";

export const DAY_MS = 86_400_000;

/** The outcome of one attempt of a tcp, dns or domain check. */
export interface Attempt {
  status: Result["status"];
  reason: string | null;
  /** Set by domain checks only. */
  certDaysLeft?: number | null;
}

/** Bun names some network errors differently from Node; reasons keep the Node codes. */
const BUN_ERROR_CODES: Record<string, string> = {
  ConnectionRefused: "ECONNREFUSED",
  ConnectionClosed: "ECONNRESET",
};

/** The error code of `err` or its cause, if any. */
export function errorCode(err: unknown): string | undefined {
  const code = rawErrorCode(err);
  return code === undefined ? undefined : (BUN_ERROR_CODES[code] ?? code);
}

function rawErrorCode(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  const cause = (err as { cause?: unknown }).cause;
  if (cause && typeof cause === "object") {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string" && code !== "") return code;
  }
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && code !== "" ? code : undefined;
}

export function errorReason(err: unknown): string {
  return errorCode(err) ?? (err instanceof Error ? err.message : String(err));
}

export function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

/** The signal that ends one attempt: the check's timeout, and the shutdown signal if any. */
export function attemptSignal(timeoutMs: number, shutdown?: AbortSignal): AbortSignal {
  return shutdown === undefined
    ? AbortSignal.timeout(timeoutMs)
    : AbortSignal.any([AbortSignal.timeout(timeoutMs), shutdown]);
}
