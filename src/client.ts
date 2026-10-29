import type { Check, ChecksResponse, Result } from "@lorenzh/pulse-contract";

export interface ClientDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
}

export const RETRY_MS = 2000;

function join(baseUrl: string, path: string): string {
  let end = baseUrl.length;
  while (end > 0 && baseUrl[end - 1] === "/") end--;
  return baseUrl.slice(0, end) + path;
}

/** Fetches the checks from the API, retrying until it succeeds. */
export async function fetchChecks(
  baseUrl: string,
  deps: ClientDeps,
  retryMs: number = RETRY_MS,
): Promise<Check[]> {
  for (;;) {
    try {
      const res = await deps.fetch(join(baseUrl, "/checks"));
      if (!res.ok) {
        // Best-effort body cancel after the response is handled; failure to cancel is irrelevant.
        await res.body?.cancel().catch(() => {});
        throw new Error(`HTTP ${res.status}`);
      }
      const body = (await res.json()) as ChecksResponse;
      if (!Array.isArray(body)) throw new Error("unexpected response");
      return body.map((c) => {
        if (c.type === "tls") {
          if (
            typeof c.host !== "string" ||
            c.host === "" ||
            !Number.isInteger(c.port) ||
            !Number.isInteger(c.warnDays)
          ) {
            throw new Error(`invalid tls check ${String(c.id)}`);
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
          return check;
        }
        const check: Check = { id: c.id, name: c.name, url: c.url, intervalMs: c.intervalMs };
        if (c.timeoutMs !== undefined) check.timeoutMs = c.timeoutMs;
        if (c.latencyObjectiveMs !== undefined) check.latencyObjectiveMs = c.latencyObjectiveMs;
        if (c.retries !== undefined) check.retries = c.retries;
        if (c.retryDelayMs !== undefined) check.retryDelayMs = c.retryDelayMs;
        if (c.keyword !== undefined) check.keyword = c.keyword;
        return check;
      });
    } catch (err) {
      deps.log(
        `fetching checks failed: ${err instanceof Error ? err.message : String(err)}; retrying in ${retryMs}ms`,
      );
      await deps.sleep(retryMs);
    }
  }
}

/** Posts a result. Failures are logged and dropped. Returns whether it was accepted. */
export async function postResult(
  baseUrl: string,
  result: Result,
  deps: Pick<ClientDeps, "fetch" | "log"> & { token: string },
): Promise<boolean> {
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
      return false;
    }
    if (res.status !== 204) {
      deps.log(`dropping result for ${result.checkId}: API answered HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    deps.log(
      `dropping result for ${result.checkId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}
