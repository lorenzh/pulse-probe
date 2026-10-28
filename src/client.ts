import type { Check, ChecksResponse, Result } from "@lorenzh/pulse-contract";

export interface ClientDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
}

export const RETRY_MS = 2000;

function join(baseUrl: string, path: string): string {
  return baseUrl.replace(/\/+$/, "") + path;
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
        await res.body?.cancel().catch(() => {});
        throw new Error(`HTTP ${res.status}`);
      }
      const body = (await res.json()) as ChecksResponse;
      if (!Array.isArray(body)) throw new Error("unexpected response");
      return body.map((c) => {
        const check: Check = { id: c.id, name: c.name, url: c.url, intervalMs: c.intervalMs };
        if (c.timeoutMs !== undefined) check.timeoutMs = c.timeoutMs;
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
  deps: Pick<ClientDeps, "fetch" | "log">,
): Promise<boolean> {
  try {
    const res = await deps.fetch(join(baseUrl, "/results"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(result),
      signal: AbortSignal.timeout(10_000),
    });
    await res.body?.cancel().catch(() => {});
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
