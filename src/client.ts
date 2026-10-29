import type { Check, ChecksResponse, Result } from "@lorenzh/pulse-contract";

export interface ClientDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
  /** Defaults to `AbortSignal.timeout`. */
  timeoutSignal?: (ms: number) => AbortSignal;
}

export const RETRY_MS = 10_000;

export const FETCH_TIMEOUT_MS = 10_000;

/** `unknown-check` means the API answered 404: the check list is out of date. */
export type PostOutcome = "accepted" | "dropped" | "unknown-check";

function join(baseUrl: string, path: string): string {
  let end = baseUrl.length;
  while (end > 0 && baseUrl[end - 1] === "/") end--;
  return baseUrl.slice(0, end) + path;
}

/** Validates one check from the API. Returns the check, or the reason it is invalid. */
function parseCheck(raw: unknown): { check: Check } | { reason: string } {
  if (typeof raw !== "object" || raw === null) return { reason: "not an object" };
  // Trust boundary: JSON from the API, narrowed by the field checks below.
  const c = raw as ChecksResponse[number];
  if (typeof c.id !== "string" || c.id === "") return { reason: "id missing" };
  if (typeof c.intervalMs !== "number" || !Number.isFinite(c.intervalMs) || c.intervalMs <= 0) {
    return { reason: `invalid intervalMs for check ${c.id}` };
  }
  if (c.type === "tls") {
    if (
      typeof c.host !== "string" ||
      c.host === "" ||
      !Number.isInteger(c.port) ||
      !Number.isInteger(c.warnDays)
    ) {
      return { reason: `invalid tls check ${c.id}` };
    }
    const check: Check = {
      id: c.id,
      name: c.name,
      type: "tls",
      host: c.host,
      port: c.port,
      warnDays: c.warnDays,
      intervalMs: c.intervalMs,
    };
    if (c.timeoutMs !== undefined) check.timeoutMs = c.timeoutMs;
    return { check };
  }
  if (typeof c.url !== "string" || c.url === "") return { reason: `invalid url for check ${c.id}` };
  const check: Check = { id: c.id, name: c.name, url: c.url, intervalMs: c.intervalMs };
  if (c.timeoutMs !== undefined) check.timeoutMs = c.timeoutMs;
  if (c.latencyObjectiveMs !== undefined) check.latencyObjectiveMs = c.latencyObjectiveMs;
  if (c.retries !== undefined) check.retries = c.retries;
  if (c.retryDelayMs !== undefined) check.retryDelayMs = c.retryDelayMs;
  if (c.keyword !== undefined) check.keyword = c.keyword;
  return { check };
}

/** Rejects when `signal` aborts, even if the pending work ignores the signal. */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error(`timed out after ${FETCH_TIMEOUT_MS}ms`));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/**
 * Fetches the checks once. The timeout covers the headers and the body.
 * Invalid checks are skipped and logged. Throws when the request fails.
 */
export async function loadChecks(
  baseUrl: string,
  deps: Pick<ClientDeps, "fetch" | "log" | "timeoutSignal">,
): Promise<Check[]> {
  const signal = (deps.timeoutSignal ?? AbortSignal.timeout)(FETCH_TIMEOUT_MS);
  const body = await abortable(
    (async (): Promise<unknown> => {
      const res = await deps.fetch(join(baseUrl, "/checks"), { signal });
      if (!res.ok) {
        // Best-effort body cancel after the response is handled; failure to cancel is irrelevant.
        await res.body?.cancel().catch(() => {});
        throw new Error(`HTTP ${res.status}`);
      }
      return res.json();
    })(),
    signal,
  );
  if (!Array.isArray(body)) throw new Error("unexpected response");
  const checks: Check[] = [];
  for (const raw of body as unknown[]) {
    const parsed = parseCheck(raw);
    if ("check" in parsed) checks.push(parsed.check);
    else deps.log(`skipping invalid check: ${parsed.reason}`);
  }
  return checks;
}

/** Fetches the checks from the API, retrying until it succeeds. */
export async function fetchChecks(
  baseUrl: string,
  deps: ClientDeps,
  retryMs: number = RETRY_MS,
): Promise<Check[]> {
  for (;;) {
    try {
      return await loadChecks(baseUrl, deps);
    } catch (err) {
      deps.log(
        `fetching checks failed: ${err instanceof Error ? err.message : String(err)}; retrying in ${retryMs}ms`,
      );
      await deps.sleep(retryMs);
    }
  }
}

/** Posts a result. Failures are logged and dropped. Returns the outcome. */
export async function postResult(
  baseUrl: string,
  result: Result,
  deps: Pick<ClientDeps, "fetch" | "log"> & { token: string },
): Promise<PostOutcome> {
  try {
    const res = await deps.fetch(join(baseUrl, "/results"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${deps.token}` },
      body: JSON.stringify(result),
      signal: AbortSignal.timeout(10_000),
    });
    // Best-effort body cancel after the response is handled; failure to cancel is irrelevant.
    await res.body?.cancel().catch(() => {});
    if (res.status === 401 || res.status === 403) {
      deps.log(
        `dropping result for ${result.checkId}: token rejected, check PULSE_PROBE_TOKEN and PULSE_LOCATION`,
      );
      return "dropped";
    }
    if (res.status !== 204) {
      deps.log(`dropping result for ${result.checkId}: API answered HTTP ${res.status}`);
      return res.status === 404 ? "unknown-check" : "dropped";
    }
    return "accepted";
  } catch (err) {
    deps.log(
      `dropping result for ${result.checkId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return "dropped";
  }
}
