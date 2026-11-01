import { StartupError } from "@lorenzh/pulse-kit";

/** Variable name to the canonical hosts it may be sent to. A missing key binds no host. */
export type HeaderHosts = ReadonlyMap<string, ReadonlySet<string>>;

const SETTING = "PULSE_PROBE_HEADER_HOSTS";
const MAX_BYTES = 65_536;
const MAX_HOSTS = 100;
const MAX_HOST_CHARS = 253;
const KEY_PATTERN = /^PULSE_HEADER_\w{1,115}$/;
const FORBIDDEN = /[\s/?#@\\*%]/;
const IPV6_LITERAL = /^\[[0-9A-Fa-f:.]+\]$/;

function fail(message: string): StartupError {
  // Messages never hold the JSON text, a key or a host: the setting is operator data.
  return new StartupError(message, { setting: SETTING });
}

/** Removes one trailing dot, so `host.` and `host` match. */
function withoutTrailingDot(host: string): string {
  return host.endsWith(".") ? host.slice(0, -1) : host;
}

/** The canonical form of a host entry, or `undefined` when it is not a bare host. */
function canonicalEntry(entry: unknown): string | undefined {
  if (typeof entry !== "string" || entry.length < 1 || entry.length > MAX_HOST_CHARS) {
    return undefined;
  }
  if (FORBIDDEN.test(entry)) return undefined;
  if (entry.includes(":") && !IPV6_LITERAL.test(entry)) return undefined;
  let url: URL;
  try {
    url = new URL(`http://${entry}/`);
  } catch {
    return undefined;
  }
  if (url.port !== "") return undefined;
  const host = withoutTrailingDot(url.hostname);
  return host === "" ? undefined : host;
}

function parseHosts(key: string, value: unknown): ReadonlySet<string> {
  if (!Array.isArray(value) || value.length > MAX_HOSTS) {
    throw fail(`${SETTING}.${key} must be an array of at most ${MAX_HOSTS} hosts`);
  }
  const hosts = new Set<string>();
  for (const [i, entry] of value.entries()) {
    const host = canonicalEntry(entry);
    if (host === undefined) {
      throw fail(
        `${SETTING}.${key}[${i}] must be a host name or IP address without scheme, port or path`,
      );
    }
    hosts.add(host);
  }
  return hosts;
}

/**
 * Parses `PULSE_PROBE_HEADER_HOSTS`: a JSON object of `PULSE_HEADER_*` names to host lists.
 * Unset or empty gives an empty policy. Throws `StartupError` when the text is malformed.
 */
export function parseHeaderHosts(text: string | undefined): HeaderHosts {
  if (text === undefined || text === "") return new Map();
  if (new TextEncoder().encode(text).length > MAX_BYTES) {
    throw fail(`${SETTING} must be at most ${MAX_BYTES} bytes`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = undefined;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw fail(`${SETTING} must be a JSON object of PULSE_HEADER_* names to host lists`);
  }
  const policy = new Map<string, ReadonlySet<string>>();
  // JSON.parse makes plain data objects: no getters run here.
  for (const [i, [key, value]] of Object.entries(raw).entries()) {
    if (!KEY_PATTERN.test(key)) {
      throw fail(`${SETTING}: key ${i + 1} must match ^PULSE_HEADER_[A-Za-z0-9_]{1,115}$`);
    }
    policy.set(key, parseHosts(key, value));
  }
  return policy;
}

/** The host of a check URL as the binding compares it, or `undefined` when the URL does not parse. */
export function canonicalHost(url: string): string | undefined {
  try {
    return withoutTrailingDot(new URL(url).hostname);
  } catch {
    return undefined;
  }
}

/** True when `variable` may be sent to the host of `url`: an exact canonical host match. */
export function isBound(hosts: HeaderHosts, variable: string, url: string): boolean {
  const host = canonicalHost(url);
  return host !== undefined && hosts.get(variable)?.has(host) === true;
}
