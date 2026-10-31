import type { DomainCheck } from "@lorenzh/pulse-contract";
import { isRecord } from "@lorenzh/pulse-kit";
import { type Attempt, attemptSignal, DAY_MS, errorCode, isTimeoutError } from "./attempt.ts";

export const RDAP_BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json";

const BOOTSTRAP_TTL_MS = DAY_MS;
const MAX_RDAP_BYTES = 1_048_576;
const MAX_BOOTSTRAP_BYTES = 2_097_152;
const MAX_REDIRECTS = 3;
/** Lifetime of a shared bootstrap fetch, independent of the checks waiting on it. */
const BOOTSTRAP_TIMEOUT_MS = 30_000;

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

/** The parsed bootstrap file: what a lookup and its redirects need. */
interface Bootstrap {
  /** TLD to the first https RDAP service URL. */
  services: Map<string, string>;
  /** `URL.host` of every https service URL in the file: the only redirect targets. */
  hosts: Set<string>;
}

interface BootstrapEntry {
  bootstrap: Bootstrap;
  fetchedAt: number;
}

// Keyed by bootstrap URL. Holds the parsed map and host set only, not the raw file.
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

/** The host of an https service URL, or `undefined` for any other entry. */
function httpsHost(url: unknown): string | undefined {
  if (typeof url !== "string" || !url.startsWith("https://")) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

function parseBootstrap(doc: unknown): Bootstrap {
  const services = new Map<string, string>();
  const hosts = new Set<string>();
  const list = isRecord(doc) ? doc["services"] : undefined;
  if (!Array.isArray(list)) throw new RdapError("invalid RDAP bootstrap");
  for (const entry of list) addEntry(entry, services, hosts);
  return { services, hosts };
}

/** Adds one `[tlds, urls]` entry of the bootstrap file; other shapes are skipped. */
function addEntry(entry: unknown, services: Map<string, string>, hosts: Set<string>): void {
  if (!Array.isArray(entry)) return;
  const [tlds, urls] = entry;
  if (!Array.isArray(tlds) || !Array.isArray(urls)) return;
  for (const host of urls.map(httpsHost)) if (host !== undefined) hosts.add(host);
  const url = urls.find((u): u is string => typeof u === "string" && u.startsWith("https://"));
  if (url === undefined) return;
  for (const tld of tlds) if (typeof tld === "string") services.set(tld.toLowerCase(), url);
}

// Single flight per bootstrap URL: concurrent checks share one fetch.
const bootstrapInFlight = new Map<string, Promise<Bootstrap>>();

async function fetchBootstrap(
  url: string,
  deps: DomainDeps,
  signal: AbortSignal,
): Promise<Bootstrap> {
  const res = await deps.fetch(url, {
    signal,
    redirect: "manual",
    headers: { accept: "application/json" },
  });
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => {});
    throw new RdapError("RDAP bootstrap redirect not followed");
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new RdapError(`RDAP bootstrap ${res.status}`);
  }
  const bootstrap = parseBootstrap(await readJson(res, MAX_BOOTSTRAP_BYTES));
  bootstrapCache.set(url, { bootstrap, fetchedAt: deps.monotonic() });
  return bootstrap;
}

// Single flight: the fetch has its own lifetime (cap and shutdown), not that of the first caller.
function refreshBootstrap(url: string, deps: DomainDeps): Promise<Bootstrap> {
  let pending = bootstrapInFlight.get(url);
  if (pending === undefined) {
    const signal = attemptSignal(BOOTSTRAP_TIMEOUT_MS, deps.signal);
    pending = fetchBootstrap(url, deps, signal).finally(() => bootstrapInFlight.delete(url));
    bootstrapInFlight.set(url, pending);
  }
  return pending;
}

/** `promise`, or the abort reason of `signal` if that comes first; the promise keeps running. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** Test hook: settles once the bootstrap fetch in flight for `url`, if any, has ended. */
export async function bootstrapSettled(url: string): Promise<void> {
  await bootstrapInFlight.get(url)?.catch(() => {});
}

async function loadBootstrap(deps: DomainDeps, signal: AbortSignal): Promise<Bootstrap> {
  const url = deps.bootstrapUrl ?? RDAP_BOOTSTRAP_URL;
  const cached = bootstrapCache.get(url);
  if (cached === undefined) return untilAborted(refreshBootstrap(url, deps), signal);
  if (deps.monotonic() - cached.fetchedAt >= BOOTSTRAP_TTL_MS) {
    // A stale map answers now; the refresh runs in the background, bounded by its own cap
    // and shutdown. On failure the stale map stays and the next check retries.
    refreshBootstrap(url, deps).catch(() => {});
  }
  return cached.bootstrap;
}

/**
 * The URL of an RDAP redirect, or an `RdapError`: only `https:` targets on a host of the
 * bootstrap file are followed. The reason names the scheme or the host, never the path.
 */
function redirectTarget(location: string, base: string, hosts: Set<string>): string {
  let target: URL;
  try {
    target = new URL(location, base);
  } catch {
    throw new RdapError("RDAP redirect to invalid location");
  }
  if (target.protocol !== "https:") {
    throw new RdapError(`RDAP redirect to ${target.protocol} not followed`);
  }
  if (!hosts.has(target.host)) throw new RdapError(`RDAP redirect to ${target.host} not followed`);
  return target.href;
}

async function fetchRdap(
  url: string,
  hosts: Set<string>,
  deps: DomainDeps,
  signal: AbortSignal,
): Promise<unknown> {
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
      target = redirectTarget(location, target, hosts);
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
): Promise<number | undefined> {
  const { services, hosts } = await loadBootstrap(deps, signal);
  const tld = check.domain.slice(check.domain.lastIndexOf(".") + 1);
  const service = services.get(tld);
  if (service === undefined) throw new RdapError(`no RDAP service for .${tld}`);
  const base = service.endsWith("/") ? service : `${service}/`;
  return expiryOf(await fetchRdap(`${base}domain/${check.domain}`, hosts, deps, signal));
}

export async function attemptDomain(
  check: DomainCheck,
  timeoutMs: number,
  deps: DomainDeps,
): Promise<Attempt> {
  try {
    const expiry = await lookupExpiry(check, deps, attemptSignal(timeoutMs, deps.signal));
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
