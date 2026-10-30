import type { DomainCheck } from "@lorenzh/pulse-contract";
import { type Attempt, attemptSignal, DAY_MS, errorCode, isTimeoutError } from "./attempt.ts";

export const RDAP_BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json";

const BOOTSTRAP_TTL_MS = DAY_MS;
const MAX_RDAP_BYTES = 1_048_576;
const MAX_BOOTSTRAP_BYTES = 2_097_152;
const MAX_REDIRECTS = 3;

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface DomainDeps {
  fetch: FetchFn;
  /** Wall clock (epoch ms). */
  now: () => number;
  /** Monotonic clock (ms): ages the bootstrap cache. */
  monotonic: () => number;
  /** Defaults to the IANA bootstrap file. */
  bootstrapUrl?: string;
  signal?: AbortSignal;
}

/** A reason-bearing failure of the RDAP lookup. */
class RdapError extends Error {
  override name = "RdapError";
}

interface BootstrapEntry {
  /** TLD to the first https RDAP service URL. */
  services: Map<string, string>;
  fetchedAt: number;
}

// Keyed by bootstrap URL. Holds the TLD map only, not the raw file.
const bootstrapCache = new Map<string, BootstrapEntry>();

async function readJson(res: Response, maxBytes: number): Promise<unknown> {
  const body = res.body;
  if (body === null) throw new RdapError("empty RDAP answer");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > maxBytes) throw new RdapError("RDAP answer too large");
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    // Best-effort cancel of what is left; failure to cancel is irrelevant.
    await reader.cancel().catch(() => {});
  }
  try {
    return JSON.parse(text + decoder.decode());
  } catch {
    throw new RdapError("invalid RDAP answer");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBootstrap(doc: unknown): Map<string, string> {
  const services = new Map<string, string>();
  const list = isRecord(doc) ? doc["services"] : undefined;
  if (!Array.isArray(list)) throw new RdapError("invalid RDAP bootstrap");
  for (const entry of list) {
    if (!Array.isArray(entry)) continue;
    const [tlds, urls] = entry;
    if (!Array.isArray(tlds) || !Array.isArray(urls)) continue;
    const url = urls.find((u): u is string => typeof u === "string" && u.startsWith("https://"));
    if (url === undefined) continue;
    for (const tld of tlds) if (typeof tld === "string") services.set(tld.toLowerCase(), url);
  }
  return services;
}

// Single flight per bootstrap URL: concurrent checks share one fetch.
const bootstrapInFlight = new Map<string, Promise<Map<string, string>>>();

async function fetchBootstrap(
  url: string,
  deps: DomainDeps,
  signal: AbortSignal,
): Promise<Map<string, string>> {
  const res = await deps.fetch(url, { signal, headers: { accept: "application/json" } });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new RdapError(`RDAP bootstrap ${res.status}`);
  }
  const services = parseBootstrap(await readJson(res, MAX_BOOTSTRAP_BYTES));
  bootstrapCache.set(url, { services, fetchedAt: deps.monotonic() });
  return services;
}

// shortcut: the shared fetch runs under the first caller's signal, so a waiter with a longer
// timeout can fail early on the first load; split the signals if check timeouts diverge widely.
function refreshBootstrap(
  url: string,
  deps: DomainDeps,
  signal: AbortSignal,
): Promise<Map<string, string>> {
  let pending = bootstrapInFlight.get(url);
  if (pending === undefined) {
    pending = fetchBootstrap(url, deps, signal).finally(() => bootstrapInFlight.delete(url));
    bootstrapInFlight.set(url, pending);
  }
  return pending;
}

/** Test hook: settles once the bootstrap fetch in flight for `url`, if any, has ended. */
export async function bootstrapSettled(url: string): Promise<void> {
  await bootstrapInFlight.get(url)?.catch(() => {});
}

async function loadBootstrap(
  deps: DomainDeps,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<Map<string, string>> {
  const url = deps.bootstrapUrl ?? RDAP_BOOTSTRAP_URL;
  const cached = bootstrapCache.get(url);
  if (cached === undefined) return refreshBootstrap(url, deps, signal);
  if (deps.monotonic() - cached.fetchedAt >= BOOTSTRAP_TTL_MS) {
    // A stale map answers now; the refresh runs in the background, bounded by the check
    // timeout and shutdown. On failure the stale map stays and the next check retries.
    refreshBootstrap(url, deps, attemptSignal(timeoutMs, deps.signal)).catch(() => {});
  }
  return cached.services;
}

async function fetchRdap(url: string, deps: DomainDeps, signal: AbortSignal): Promise<unknown> {
  let target = url;
  for (let hops = 0; ; hops++) {
    const res = await deps.fetch(target, {
      signal,
      redirect: "manual",
      headers: { accept: "application/rdap+json" },
    });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location !== null) {
      await res.body?.cancel().catch(() => {});
      if (hops >= MAX_REDIRECTS) throw new RdapError("too many redirects");
      target = new URL(location, target).href;
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new RdapError(`RDAP ${res.status}`);
    }
    return readJson(res, MAX_RDAP_BYTES);
  }
}

/** The expiration date (epoch ms) of an RDAP domain answer, or `undefined`. */
function expiryOf(doc: unknown): number | undefined {
  const events = isRecord(doc) ? doc["events"] : undefined;
  if (!Array.isArray(events)) return undefined;
  for (const event of events) {
    if (!isRecord(event) || event["eventAction"] !== "expiration") continue;
    const date = event["eventDate"];
    const ms = typeof date === "string" ? Date.parse(date) : Number.NaN;
    return Number.isNaN(ms) ? undefined : ms;
  }
  return undefined;
}

async function lookupExpiry(
  check: DomainCheck,
  deps: DomainDeps,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<number | undefined> {
  const services = await loadBootstrap(deps, signal, timeoutMs);
  const tld = check.domain.slice(check.domain.lastIndexOf(".") + 1);
  const service = services.get(tld);
  if (service === undefined) throw new RdapError(`no RDAP service for .${tld}`);
  const base = service.endsWith("/") ? service : `${service}/`;
  return expiryOf(await fetchRdap(`${base}domain/${check.domain}`, deps, signal));
}

export async function attemptDomain(
  check: DomainCheck,
  timeoutMs: number,
  deps: DomainDeps,
): Promise<Attempt> {
  try {
    const expiry = await lookupExpiry(
      check,
      deps,
      attemptSignal(timeoutMs, deps.signal),
      timeoutMs,
    );
    if (expiry === undefined) {
      return { status: "down", reason: "expiry date not found in RDAP answer", certDaysLeft: null };
    }
    const now = deps.now();
    const daysLeft = Math.floor((expiry - now) / DAY_MS);
    if (expiry <= now) return { status: "down", reason: "domain expired", certDaysLeft: daysLeft };
    if (daysLeft <= check.warnDays) {
      return {
        status: "degraded",
        reason: `domain expires in ${daysLeft} days`,
        certDaysLeft: daysLeft,
      };
    }
    return { status: "up", reason: null, certDaysLeft: daysLeft };
  } catch (err) {
    if (isTimeoutError(err)) {
      return { status: "down", reason: `timeout after ${timeoutMs}ms`, certDaysLeft: null };
    }
    const reason = err instanceof RdapError ? err.message : (errorCode(err) ?? "request error");
    return { status: "down", reason, certDaysLeft: null };
  }
}
