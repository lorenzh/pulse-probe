import type { Check, Result } from "@lorenzh/pulse-contract";

export const DEFAULT_TIMEOUT_MS = 5000;

export interface CheckDeps {
  fetch: typeof fetch;
  now: () => number;
}

function errorReason(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    if (cause && typeof cause === "object") {
      const code = (cause as { code?: unknown }).code;
      if (typeof code === "string" && code !== "") return code;
    }
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && code !== "") return code;
    return err.message;
  }
  return String(err);
}

export async function runCheck(check: Check, deps: CheckDeps): Promise<Result> {
  const timeoutMs = check.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const start = deps.now();
  const finish = (
    status: Result["status"],
    statusCode: number | null,
    reason: string | null,
  ): Result => ({
    checkId: check.id,
    timestamp: start,
    status,
    statusCode,
    latencyMs: Math.max(0, deps.now() - start),
    reason,
  });
  try {
    const res = await deps.fetch(check.url, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.body?.cancel().catch(() => {});
    if (res.status >= 200 && res.status < 300) {
      return finish("up", res.status, null);
    }
    return finish("down", res.status, `HTTP ${res.status}`);
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      return finish("down", null, `timeout after ${timeoutMs}ms`);
    }
    return finish("down", null, errorReason(err));
  }
}
