import {
  type Check,
  checkWireVersion,
  type DnsCheck,
  type DomainCheck,
  type FetchJsonError,
  type FetchJsonOptions,
  type FetchJsonResult,
  fetchJson,
  type HeartbeatCheck,
  headerValueSchema,
  type Result,
  type TcpCheck,
  validateCheck,
  WIRE_VERSION_HEADER,
} from "@lorenzh/pulse-contract";

export interface ClientDeps {
  /** Probe token for `GET /probe/checks`. Without it only the public `GET /checks` is used. */
  token?: string;
  /** Environment that `{ env }` header values resolve from. Defaults to an empty map. */
  env?: Record<string, string | undefined>;
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
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
 * `retry` is a network error, timeout, 429 or 5xx: the result may succeed later.
 * `rejected` never succeeds (400, 401, 403, other 4xx, or a 2xx/3xx that is not 204).
 * `unknown-check` is a 404: the check list is out of date; the result is dropped.
 */
export type PostOutcome = "accepted" | "retry" | "rejected" | "unknown-check";

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
  if (c.type === "tcp" || c.type === "dns" || c.type === "domain") return toProbedCheck(c);
  const check: ProbeCheck = { id: c.id, name: c.name, url: c.url, intervalMs: c.intervalMs };
  if (c.timeoutMs !== undefined) check.timeoutMs = c.timeoutMs;
  if (c.latencyObjectiveMs !== undefined) check.latencyObjectiveMs = c.latencyObjectiveMs;
  if (c.retries !== undefined) check.retries = c.retries;
  if (c.retryDelayMs !== undefined) check.retryDelayMs = c.retryDelayMs;
  if (c.keyword !== undefined) check.keyword = c.keyword;
  if (c.method !== undefined) check.method = c.method;
  if (c.body !== undefined) check.body = c.body;
  if (c.expectedStatus !== undefined) check.expectedStatus = c.expectedStatus;
  if (c.jsonAssert !== undefined) check.jsonAssert = c.jsonAssert;
  return check;
}

/** Copies a tcp, dns or domain check: its own fields, then the shared timers. */
function toProbedCheck(c: TcpCheck | DnsCheck | DomainCheck): ProbeCheck {
  const base = { id: c.id, name: c.name, intervalMs: c.intervalMs };
  let check: ProbeCheck;
  switch (c.type) {
    case "tcp":
      check = { ...base, type: "tcp", host: c.host, port: c.port };
      break;
    case "dns":
      check = { ...base, type: "dns", dnsName: c.dnsName, recordType: c.recordType };
      if (c.expected !== undefined) check.expected = c.expected;
      if (c.resolver !== undefined) check.resolver = c.resolver;
      break;
    case "domain":
      check = { ...base, type: "domain", domain: c.domain, warnDays: c.warnDays };
      break;
    default: {
      const unreachable: never = c;
      throw new Error(`unexpected check ${String(unreachable)}`);
    }
  }
  if (c.timeoutMs !== undefined) check.timeoutMs = c.timeoutMs;
  if (c.retries !== undefined) check.retries = c.retries;
  if (c.retryDelayMs !== undefined) check.retryDelayMs = c.retryDelayMs;
  return check;
}

/** Only variables with this prefix may feed a header value. */
const HEADER_ENV_PREFIX = "PULSE_HEADER_";

/**
 * Resolves `{ env }` header values from `env`. Returns the header name and variable name
 * (never a value) of the first reference that is unset, empty or not a valid header value.
 */
function resolveHeaders(
  headers: Record<string, string | { env: string }>,
  env: Record<string, string | undefined>,
):
  | { ok: true; value: Record<string, string> }
  | { ok: false; name: string; variable: string; problem: string } {
  const value: Record<string, string> = {};
  for (const [name, raw] of Object.entries(headers ?? {})) {
    if (typeof raw === "string") {
      value[name] = raw;
      continue;
    }
    // Checked before the lookup: a forbidden name never reads the environment.
    if (!raw.env.startsWith(HEADER_ENV_PREFIX)) {
      return {
        ok: false,
        name,
        variable: raw.env,
        problem: `must start with ${HEADER_ENV_PREFIX}`,
      };
    }
    const resolved = env[raw.env];
    if (resolved === undefined || resolved === "") {
      return { ok: false, name, variable: raw.env, problem: "is not set" };
    }
    // A CR, LF or TAB would make fetch throw an error that quotes the value.
    if (!headerValueSchema.safeParse(resolved).success) {
      return { ok: false, name, variable: raw.env, problem: "is not a valid header value" };
    }
    value[name] = resolved;
  }
  return { ok: true, value };
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

/** Builds the probe check; `undefined` when a header env reference is unset or invalid (logged, names only). */
function withResolvedHeaders(
  parsed: Exclude<Check, HeartbeatCheck>,
  env: Record<string, string | undefined>,
  log: (message: string) => void,
): ProbeCheck | undefined {
  const check = toCheck(parsed);
  if (parsed.type === "tls" || check.type === "tls" || parsed.headers === undefined) return check;
  const headers = resolveHeaders(parsed.headers, env);
  if (!headers.ok) {
    log(
      `skipping check ${check.id}: header ${headers.name} env ${headers.variable} ${headers.problem}`,
    );
    return undefined;
  }
  check.headers = headers.value;
  return check;
}

/** Asks `GET /probe/checks` when there is a token; an api that answers 404 gets the public `GET /checks`. */
async function requestChecks(
  baseUrl: string,
  token: string | undefined,
  options: FetchJsonOptions<unknown[]>,
): Promise<FetchJsonResult<unknown[]>> {
  if (token === undefined) return fetchJson(join(baseUrl, "/checks"), options);
  const res = await fetchJson(join(baseUrl, "/probe/checks"), {
    ...options,
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok && res.error.kind === "http" && res.error.status === 404) {
    return fetchJson(join(baseUrl, "/checks"), options);
  }
  return res;
}

/**
 * Fetches the checks once. The timeout covers the headers and the body.
 * Invalid checks are skipped and logged. Heartbeat checks are dropped silently. Throws when the request fails.
 */
export async function loadChecks(
  baseUrl: string,
  deps: Pick<ClientDeps, "fetch" | "log" | "schedule" | "signal" | "token" | "env">,
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
  const res = await requestChecks(baseUrl, deps.token, options);
  // Warn before a body or validation error propagates; a non-2xx answer stays quiet.
  const isFailedStatus = !res.ok && res.error.kind === "http";
  if (isWireAbsent && !isFailedStatus && !warnedAbsent.has(deps.log)) {
    warnedAbsent.add(deps.log);
    deps.log(`API sent no ${WIRE_VERSION_HEADER} header; cannot check the contract version`);
  }
  if (!res.ok) throw toError(res.error);
  const checks: ProbeCheck[] = [];
  for (const [i, raw] of res.value.entries()) {
    const parsed = validateCheck(raw, `checks[${i}]`);
    // Heartbeat checks are evaluated by the API; the probe drops them without a log line.
    if (!parsed.ok) deps.log(`skipping invalid check${readableId(raw)}: ${parsed.error}`);
    else if (parsed.value.type !== "heartbeat") {
      const check = withResolvedHeaders(parsed.value, deps.env ?? {}, deps.log);
      if (check !== undefined) checks.push(check);
    }
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

/** Posts a result once. Final drops are logged; retryable failures are not. Returns the outcome. */
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
    if (res.status === 204) return "accepted";
    if (res.status === 429 || res.status >= 500) return "retry";
    if (res.status === 401 || res.status === 403) {
      deps.log(
        `dropping result for ${result.checkId}: token rejected, check PULSE_PROBE_TOKEN and PULSE_LOCATION`,
      );
      return "rejected";
    }
    deps.log(`dropping result for ${result.checkId}: API answered HTTP ${res.status}`);
    return res.status === 404 ? "unknown-check" : "rejected";
  } catch {
    // Network error or timeout: the buffer logs and retries, so no line per failure.
    return "retry";
  }
}
