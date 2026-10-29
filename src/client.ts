import {
  type Check,
  checkWireVersion,
  type FetchJsonError,
  type FetchJsonOptions,
  fetchJson,
  type HeartbeatCheck,
  type Result,
  validateCheck,
  WIRE_VERSION_HEADER,
} from "@lorenzh/pulse-contract";

export interface ClientDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
  /** Timer injection for the request timeout; defaults to `setTimeout`. Returns a cancel function. */
  schedule?: (fn: () => void, ms: number) => () => void;
  /** Aborts the request and the retry wait, for shutdown. */
  signal?: AbortSignal;
}

/** Thrown by `fetchChecks` when the shutdown signal aborts it. */
export class StartupAbortedError extends Error {
  override name = "StartupAbortedError";
  constructor() {
    super("startup aborted by a shutdown signal");
  }
}

/** A check the probe runs: every check type except `heartbeat`, which jobs ping the API for. */
export type ProbeCheck = Exclude<Check, HeartbeatCheck>;

export const RETRY_MS = 10_000;

export const FETCH_TIMEOUT_MS = 10_000;

/**
 * `unknown-check` means the API answered 404: the check list is out of date.
 * `dropped` is any other answer than 204; `failed` is a network error or timeout.
 */
export type PostOutcome = "accepted" | "dropped" | "unknown-check" | "failed";

function join(baseUrl: string, path: string): string {
  let end = baseUrl.length;
  while (end > 0 && baseUrl[end - 1] === "/") end--;
  return baseUrl.slice(0, end) + path;
}

/** Copies the fields of a validated check, dropping the state fields the API adds. */
function toCheck(c: ProbeCheck): ProbeCheck {
  if (c.type === "tls") {
    const check: ProbeCheck = {
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
  const check: ProbeCheck = { id: c.id, name: c.name, url: c.url, intervalMs: c.intervalMs };
  if (c.timeoutMs !== undefined) check.timeoutMs = c.timeoutMs;
  if (c.latencyObjectiveMs !== undefined) check.latencyObjectiveMs = c.latencyObjectiveMs;
  if (c.retries !== undefined) check.retries = c.retries;
  if (c.retryDelayMs !== undefined) check.retryDelayMs = c.retryDelayMs;
  if (c.keyword !== undefined) check.keyword = c.keyword;
  return check;
}

// Loggers that already reported a missing version header: the reload loop must not repeat it.
const warnedAbsent = new WeakSet<object>();

/** Maps a typed client error to the error `loadChecks` throws. */
function toError(error: FetchJsonError): Error {
  switch (error.kind) {
    case "timeout":
      return new Error(`timed out after ${error.timeoutMs}ms`);
    case "aborted":
      return new StartupAbortedError();
    case "network":
      return error.cause instanceof Error ? error.cause : new Error(String(error.cause));
    case "http":
      return new Error(`HTTP ${error.status}`);
    case "too-large":
      return new Error(`response is larger than ${error.maxBytes} bytes`);
    case "invalid-json":
      return new Error(`invalid JSON: ${error.message}`);
    case "wire-mismatch":
      return new Error(`contract version mismatch: ${error.message}`);
    case "validation":
      return new Error(error.message);
    default: {
      const unreachable: never = error;
      return new Error(String(unreachable));
    }
  }
}

/** Returns " <id>" when `raw` is an object with a string id, else an empty string. */
function readableId(raw: unknown): string {
  if (typeof raw !== "object" || raw === null) return "";
  const id = (raw as { id?: unknown }).id;
  return typeof id === "string" ? ` ${id}` : "";
}

/**
 * Fetches the checks once. The timeout covers the headers and the body.
 * Invalid checks are skipped and logged. Heartbeat checks are dropped silently. Throws when the request fails.
 */
export async function loadChecks(
  baseUrl: string,
  deps: Pick<ClientDeps, "fetch" | "log" | "schedule" | "signal">,
): Promise<ProbeCheck[]> {
  // The client reports the absent header before it checks the status; the probe logs it for 2xx only.
  let isWireAbsent = false;
  const options: FetchJsonOptions<unknown[]> = {
    fetch: deps.fetch,
    timeoutMs: FETCH_TIMEOUT_MS,
    validate: (raw) =>
      Array.isArray(raw) ? { ok: true, value: raw } : { ok: false, error: "unexpected response" },
    onWireAbsent: () => {
      isWireAbsent = true;
    },
  };
  if (deps.signal !== undefined) options.signal = deps.signal;
  if (deps.schedule !== undefined) options.schedule = deps.schedule;
  const res = await fetchJson(join(baseUrl, "/checks"), options);
  if (!res.ok) throw toError(res.error);
  if (isWireAbsent && !warnedAbsent.has(deps.log)) {
    warnedAbsent.add(deps.log);
    deps.log(`API sent no ${WIRE_VERSION_HEADER} header; cannot check the contract version`);
  }
  const checks: ProbeCheck[] = [];
  for (const [i, raw] of res.value.entries()) {
    const parsed = validateCheck(raw, `checks[${i}]`);
    // Heartbeat checks are evaluated by the API; the probe drops them without a log line.
    if (!parsed.ok) deps.log(`skipping invalid check${readableId(raw)}: ${parsed.error}`);
    else if (parsed.value.type !== "heartbeat") checks.push(toCheck(parsed.value));
  }
  return checks;
}

/** Waits `ms`; turns a wait aborted by shutdown into `StartupAbortedError`. */
async function waitOrAbort(deps: ClientDeps, ms: number): Promise<void> {
  try {
    await deps.sleep(ms);
  } catch (err) {
    if (deps.signal?.aborted) throw new StartupAbortedError();
    throw err;
  }
}

/**
 * Fetches the checks from the API, retrying until it succeeds.
 * Throws `StartupAbortedError` once `deps.signal` aborts.
 */
export async function fetchChecks(
  baseUrl: string,
  deps: ClientDeps,
  retryMs: number = RETRY_MS,
): Promise<ProbeCheck[]> {
  for (;;) {
    if (deps.signal?.aborted) throw new StartupAbortedError();
    try {
      return await loadChecks(baseUrl, deps);
    } catch (err) {
      if (deps.signal?.aborted) throw new StartupAbortedError();
      deps.log(
        `fetching checks failed: ${err instanceof Error ? err.message : String(err)}; retrying in ${retryMs}ms`,
      );
      await waitOrAbort(deps, retryMs);
    }
  }
}

/** Posts a result. Failures are logged and dropped. Returns the outcome. */
export async function postResult(
  baseUrl: string,
  result: Result,
  deps: Pick<ClientDeps, "fetch" | "log" | "signal"> & { token: string },
): Promise<PostOutcome> {
  try {
    const res = await deps.fetch(join(baseUrl, "/results"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${deps.token}` },
      body: JSON.stringify(result),
      signal:
        deps.signal === undefined
          ? AbortSignal.timeout(10_000)
          : AbortSignal.any([AbortSignal.timeout(10_000), deps.signal]),
    });
    // Best-effort body cancel after the response is handled; failure to cancel is irrelevant.
    await res.body?.cancel().catch(() => {});
    const version = checkWireVersion(res.headers.get(WIRE_VERSION_HEADER));
    if (version.status === "mismatch") {
      deps.log(`API answered POST /results with a contract version mismatch: ${version.error}`);
    }
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
    return "failed";
  }
}
