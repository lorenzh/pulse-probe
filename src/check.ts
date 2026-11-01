import { isIP } from "node:net";
import tls from "node:tls";
import {
  type ExpectedStatus,
  type HttpCheck,
  type JsonAssertion,
  MAX_TIMER_MS,
  type Result,
  type TlsCheck,
} from "@lorenzh/pulse-contract";
import { BlockedAddressError, isRecord } from "@lorenzh/pulse-kit";
import { blockedReason } from "./address-policy.ts";
import { type Attempt, DAY_MS, errorCode, errorReason } from "./attempt.ts";
import { attemptDns, type Resolve, resolveRecords } from "./check-dns.ts";
import { attemptDomain } from "./check-domain.ts";
import { attemptTcp, type TcpConnect, tcpConnect } from "./check-tcp.ts";
import type { ProbeCheck } from "./client.ts";

import { userAgent } from "./location.ts";
import { capReason, quote } from "./reason.ts";

export const DEFAULT_TIMEOUT_MS = 5000;

export const DEFAULT_RETRY_DELAY_MS = 1000;

/** Most body bytes read when an HTTP check has a `keyword`. */
export const MAX_KEYWORD_BODY_BYTES = 1_048_576;

export { DAY_MS };

export interface TlsConnectOptions {
  host: string;
  port: number;
  timeoutMs: number;
  /** SNI name. Defaults to `host` when it is not an IP literal. */
  servername?: string;
}

/** Connects, completes the handshake and returns the leaf certificate's `valid_to` (epoch ms). */
export type TlsConnect = (options: TlsConnectOptions) => Promise<{ validTo: number }>;

/**
 * Reads the leaf certificate of a TLS endpoint. The chain and the hostname are not
 * verified (`rejectUnauthorized: false`); `timeoutMs` bounds connect plus handshake.
 */
export const tlsConnect: TlsConnect = ({ host, port, timeoutMs, servername }) =>
  new Promise((resolve, reject) => {
    const signal = AbortSignal.timeout(timeoutMs);
    const socket = tls.connect({
      host,
      port,
      ...tlsServername(host, servername),
      rejectUnauthorized: false,
    });
    const onAbort = (): void => {
      socket.destroy();
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const done = (): void => signal.removeEventListener("abort", onAbort);
    socket.once("secureConnect", () => {
      done();
      const validTo = Date.parse(socket.getPeerCertificate().valid_to ?? "");
      socket.destroy();
      if (Number.isNaN(validTo)) reject(new Error("no certificate"));
      else resolve({ validTo });
    });
    socket.once("error", (err) => {
      done();
      socket.destroy();
      reject(err);
    });
  });

function tlsServername(host: string, servername: string | undefined): { servername?: string } {
  if (servername !== undefined) return { servername };
  return isIP(host) === 0 ? { servername: host } : {};
}

export interface CheckDeps {
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** Defaults to the real TLS connection. */
  tlsConnect?: TlsConnect;
  /** Wall clock (epoch ms): the result `timestamp` and the TLS expiry comparison. */
  now: () => number;
  /** Monotonic clock (ms): latency and the retry budget. It never steps back. */
  monotonic: () => number;
  /** Waits `ms` milliseconds between attempts. */
  sleep: (ms: number) => Promise<void>;
  /** Probe location name, set on every result. */
  location: string;
  /** Defaults to a real TCP connection. */
  tcpConnect?: TcpConnect;
  /** Defaults to `node:dns` `Resolver`. */
  resolve?: Resolve;
  /** RDAP bootstrap file of domain checks. Defaults to the IANA file. */
  rdapBootstrapUrl?: string;
  /** Aborts in-flight requests, connections and lookups, for shutdown. */
  signal?: AbortSignal;
}

/**
 * Runs one check. A check with `headerDenial` gets no request and reports `down`.
 * Every reason is capped at the contract's length here, the single exit.
 */
export async function runCheck(check: ProbeCheck, deps: CheckDeps): Promise<Result> {
  const result =
    check.headerDenial === undefined
      ? await runAttempts(check, deps)
      : {
          checkId: check.id,
          timestamp: deps.now(),
          status: "down" as const,
          statusCode: null,
          latencyMs: 0,
          reason: check.headerDenial,
          location: deps.location,
          attempts: 1,
        };
  return result.reason === null ? result : { ...result, reason: capReason(result.reason) };
}

/** Whole milliseconds between two monotonic readings, within the contract's range. */
function latencyBetween(start: number, end: number): number {
  return Math.min(MAX_TIMER_MS, Math.round(Math.max(0, end - start)));
}

async function runAttempts(check: ProbeCheck, deps: CheckDeps): Promise<Result> {
  const timeoutMs = check.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const start = deps.now();
  const startMono = deps.monotonic();
  const finish = (
    status: Result["status"],
    statusCode: number | null,
    reason: string | null,
    certDaysLeft?: number | null,
    attempts = 1,
    attemptStart = startMono,
  ): Result => ({
    checkId: check.id,
    timestamp: start,
    status,
    statusCode,
    latencyMs: latencyBetween(attemptStart, deps.monotonic()),
    reason,
    location: deps.location,
    attempts,
    ...(certDaysLeft !== undefined ? { certDaysLeft } : {}),
  });
  if (check.type === "tls") return runTlsCheck(check, deps, timeoutMs, finish);
  const retries = check.retries ?? 0;
  const retryDelayMs = check.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  for (let attempt = 1; ; attempt++) {
    const attemptStart = attempt === 1 ? startMono : deps.monotonic();
    const result = await runAttempt(check, deps, timeoutMs, (status, code, reason, certDaysLeft) =>
      finish(status, code, reason, certDaysLeft, attempt, attemptStart),
    );
    if (result.status !== "down" || attempt > retries) return result;
    if (deps.signal?.aborted === true) return result;
    if (deps.monotonic() + retryDelayMs >= startMono + check.intervalMs) return result;
    await deps.sleep(retryDelayMs);
  }
}

type Done = (
  status: Result["status"],
  statusCode: number | null,
  reason: string | null,
  certDaysLeft?: number | null,
) => Result;

function runAttempt(
  check: Exclude<ProbeCheck, TlsCheck>,
  deps: CheckDeps,
  timeoutMs: number,
  done: Done,
): Promise<Result> {
  switch (check.type) {
    case "tcp":
      return attemptTcp(check, timeoutMs, deps.tcpConnect ?? tcpConnect, deps.signal).then((a) =>
        fromAttempt(a, done),
      );
    case "dns":
      return attemptDns(check, timeoutMs, deps.resolve ?? resolveRecords, deps.signal).then((a) =>
        fromAttempt(a, done),
      );
    case "domain":
      return attemptDomain(check, timeoutMs, {
        fetch: deps.fetch,
        now: deps.now,
        monotonic: deps.monotonic,
        ...(deps.rdapBootstrapUrl !== undefined ? { bootstrapUrl: deps.rdapBootstrapUrl } : {}),
        ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
      }).then((a) => fromAttempt(a, done));
    case "http":
    case undefined:
      return attemptHttp(check, deps, timeoutMs, (status, code, reason) => {
        const r = done(status, code, reason);
        const objective = check.latencyObjectiveMs;
        if (status === "up" && objective !== undefined && r.latencyMs > objective) {
          return {
            ...r,
            status: "degraded",
            reason: `latency ${r.latencyMs}ms over objective ${objective}ms`,
          };
        }
        return r;
      });
    default: {
      const unreachable: never = check;
      throw new Error(`unexpected check ${String(unreachable)}`);
    }
  }
}

function fromAttempt(a: Attempt, done: Done): Result {
  return done(a.status, null, a.reason, a.certDaysLeft);
}

/** The body text up to the byte limit, and whether the response had more. */
interface BodyRead {
  text: string;
  isTruncated: boolean;
}

/** Reads the body once, up to the byte limit. */
async function readBody(
  body: ReadableStream<Uint8Array> | null,
  stopAfter?: string,
): Promise<BodyRead> {
  if (body === null) return { text: "", isTruncated: false };
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  let isTruncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (bytes + value.length > MAX_KEYWORD_BODY_BYTES) isTruncated = true;
      const room = MAX_KEYWORD_BODY_BYTES - bytes;
      bytes += Math.min(value.length, room);
      // Rescan only the tail that can hold a match straddling the previous chunk.
      const from = Math.max(0, text.length - (stopAfter?.length ?? 0) + 1);
      text += decoder.decode(value.subarray(0, room), { stream: true });
      if (stopAfter !== undefined && text.indexOf(stopAfter, from) !== -1) break;
      if (isTruncated) break;
    }
  } finally {
    // Best-effort cancel of the rest of the body; failure to cancel is irrelevant.
    await reader.cancel().catch(() => {});
  }
  return { text: text + decoder.decode(), isTruncated };
}

const DEFAULT_EXPECTED_STATUS: ExpectedStatus[] = ["200-299"];

function matchesStatus(code: number, expected: ExpectedStatus[]): boolean {
  return expected.some((entry) => {
    if (typeof entry === "number") return entry === code;
    const [lo, hi] = entry.split("-").map(Number);
    return lo !== undefined && hi !== undefined && code >= lo && code <= hi;
  });
}

/** Resolves an RFC 6901 pointer; `undefined` means the pointer does not resolve. */
function evaluatePointer(doc: unknown, pointer: string): { found: boolean; value?: unknown } {
  let current: unknown = doc;
  if (pointer === "") return { found: true, value: current };
  for (const raw of pointer.slice(1).split("/")) {
    const token = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current) && /^(0|[1-9]\d*)$/.test(token) && Number(token) < current.length) {
      current = current[Number(token)];
    } else if (isRecord(current) && Object.hasOwn(current, token)) {
      current = current[token];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: current };
}

function isDeepEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a)) {
    return (
      Array.isArray(b) && a.length === b.length && a.every((item, i) => isDeepEqual(item, b[i]))
    );
  }
  if (isRecord(a)) {
    if (!isRecord(b)) return false;
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && isDeepEqual(a[key], b[key]))
    );
  }
  return a === b;
}

/** The reason of the first failing assertion, or `null` when all hold. */
function jsonFailure(text: string, isTruncated: boolean, asserts: JsonAssertion[]): string | null {
  let doc: unknown;
  try {
    if (isTruncated) throw new Error("body over the limit");
    doc = JSON.parse(text);
  } catch {
    // The parse error text can quote the response body; the reason names the problem only.
    return "json: invalid body";
  }
  for (const assertion of asserts) {
    const found = evaluatePointer(doc, assertion.pointer);
    if (!Object.hasOwn(assertion, "equals")) {
      if (!found.found) return `json ${assertion.pointer}: missing`;
    } else if (!found.found || !isDeepEqual(found.value, assertion.equals)) {
      const got = found.found ? quote(JSON.stringify(found.value)) : "missing";
      return `json ${assertion.pointer}: expected ${quote(JSON.stringify(assertion.equals))}, got ${got}`;
    }
  }
  return null;
}

/** The reason the accepted response fails `keyword` or `jsonAssert`, or `null`. */
async function bodyFailure(check: HttpLikeCheck, res: Response): Promise<string | null> {
  const { keyword, jsonAssert } = check;
  if (keyword === undefined && jsonAssert === undefined) return null;
  const { text, isTruncated } = await readBody(
    res.body,
    jsonAssert === undefined ? keyword : undefined,
  );
  if (keyword !== undefined && !text.includes(keyword))
    return `keyword "${quote(keyword)}" not found`;
  return jsonAssert === undefined ? null : jsonFailure(text, isTruncated, jsonAssert);
}

type HttpLikeCheck = HttpCheck;

async function attemptHttp(
  check: HttpLikeCheck,
  deps: CheckDeps,
  timeoutMs: number,
  done: (status: Result["status"], statusCode: number | null, reason: string | null) => Result,
): Promise<Result> {
  try {
    const method = check.method ?? "GET";
    const expected = check.expectedStatus ?? DEFAULT_EXPECTED_STATUS;
    const signal =
      deps.signal === undefined
        ? AbortSignal.timeout(timeoutMs)
        : AbortSignal.any([AbortSignal.timeout(timeoutMs), deps.signal]);
    const fetched = await fetchFollowing(check, deps, method, expected, signal);
    if ("stop" in fetched) return done("down", fetched.stop.statusCode, fetched.stop.reason);
    const res = fetched.res;
    if (!matchesStatus(res.status, expected)) {
      // Best-effort body cancel after the response is handled; failure to cancel is irrelevant.
      await res.body?.cancel().catch(() => {});
      return done("down", res.status, `HTTP ${res.status} not in ${expected.join(", ")}`);
    }
    const failure = method === "HEAD" ? null : await bodyFailure(check, res);
    if (failure !== null) return done("down", res.status, failure);
    await res.body?.cancel().catch(() => {});
    return done("up", res.status, null);
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      return done("down", null, `timeout after ${timeoutMs}ms`);
    }
    // A fetch error message can quote a header value or the body, so only the code is used.
    return done("down", null, errorCode(err) ?? "request error");
  }
}

const MAX_REDIRECTS = 20;

const REDIRECT_STATUSES = [301, 302, 303, 307, 308];

type Fetched = { res: Response } | { stop: { statusCode: number | null; reason: string } };

/** True when the check sends a header or a body of its own: these must not leave the origin. */
function isSecretBearing(check: HttpLikeCheck): boolean {
  return Object.keys(check.headers ?? {}).length > 0 || check.body !== undefined;
}

/** The contract's rule, kept here too: the probe does not trust the checks it is served. */
function isHttpProtocol(protocol: string): boolean {
  return protocol === "http:" || protocol === "https:";
}

/** Why the check URL gets no request, or `null`. The reason never holds the URL. */
function urlFailure(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "invalid URL";
  }
  // After `new URL`, a protocol matches `[a-z][a-z0-9+.-]*:`, so quoting it is safe.
  return isHttpProtocol(parsed.protocol)
    ? null
    : `unsupported URL scheme "${quote(parsed.protocol)}"`;
}

type Hop = { url: string; method: string } | { reason: string };

/**
 * Sends the request and follows redirects here, one hop at a time, so that every hop is checked:
 * only `http:` and `https:` targets get a request. A check with headers or a body follows
 * redirects only within the same origin, and a 301, 302 or 303 only for GET; a redirect status in
 * `expectedStatus` is judged.
 * Other checks keep fetch's follow mode: any origin, the method rule of fetch, at most 20 hops.
 */
async function fetchFollowing(
  check: HttpLikeCheck,
  deps: CheckDeps,
  method: string,
  expected: ExpectedStatus[],
  signal: AbortSignal,
): Promise<Fetched> {
  const failure = urlFailure(check.url);
  if (failure !== null) return { stop: { statusCode: null, reason: failure } };
  const isSecret = isSecretBearing(check);
  let url = check.url;
  let current = method;
  let lastStatus: number | null = null;
  for (let hops = 0; ; hops++) {
    const sent = await sendHop(check, deps, url, current, signal);
    if (sent instanceof BlockedAddressError) {
      return { stop: { statusCode: lastStatus, reason: blockedReason(sent.category, hops > 0) } };
    }
    const res = sent;
    const location = res.headers.get("location");
    if (
      !REDIRECT_STATUSES.includes(res.status) ||
      location === null ||
      (isSecret && matchesStatus(res.status, expected))
    ) {
      return { res };
    }
    // Best-effort body cancel of the hop; failure to cancel is irrelevant.
    await res.body?.cancel().catch(() => {});
    const next = isSecret
      ? secretHop(res.status, current, location, url, hops)
      : openHop(res.status, current, location, url, hops);
    if ("reason" in next) return { stop: { statusCode: res.status, reason: next.reason } };
    url = next.url;
    current = next.method;
    lastStatus = res.status;
  }
}

/** One request without redirects; a blocked target comes back as its error, not a throw. */
async function sendHop(
  check: HttpLikeCheck,
  deps: CheckDeps,
  url: string,
  method: string,
  signal: AbortSignal,
): Promise<Response | BlockedAddressError> {
  try {
    return await deps.fetch(url, {
      method,
      redirect: "manual",
      // The probe's user-agent goes last: the contract forbids the header, and it must win anyway.
      headers: { ...resolvedHeaders(check), "user-agent": userAgent(deps.location) },
      // Bytes, not a string: fetch would add `content-type: text/plain` to a string body.
      ...(check.body !== undefined ? { body: new TextEncoder().encode(check.body) } : {}),
      signal,
    });
  } catch (err) {
    if (err instanceof BlockedAddressError) return err;
    throw err;
  }
}

/** The redirect target, or the reason it gets no request: it does not parse or is not http(s). */
function hopTarget(location: string, url: string): URL | { reason: string } {
  let target: URL;
  try {
    target = new URL(location, url);
  } catch {
    return { reason: "redirect to invalid location" };
  }
  return isHttpProtocol(target.protocol)
    ? target
    : { reason: `redirect to ${quote(target.protocol)} not followed` };
}

/** The next hop of a check with headers or a body: GET only, same origin. */
function secretHop(
  status: number,
  method: string,
  location: string,
  url: string,
  hops: number,
): Hop {
  if (status <= 303 && method !== "GET")
    return { reason: `HTTP ${status} redirect not followed for ${method}` };
  const target = hopTarget(location, url);
  if (!(target instanceof URL)) return target;
  if (target.origin !== new URL(url).origin)
    return { reason: `redirect to ${quote(target.origin)} not followed` };
  return hops >= MAX_REDIRECTS ? { reason: "too many redirects" } : { url: target.href, method };
}

/** The next hop of a check without headers and body, with the method rule of fetch's follow mode. */
function openHop(status: number, method: string, location: string, url: string, hops: number): Hop {
  const target = hopTarget(location, url);
  if (!(target instanceof URL)) return target;
  if (hops >= MAX_REDIRECTS) return { reason: "too many redirects" };
  const isToGet = (status === 303 && method !== "HEAD") || (status <= 302 && method === "POST");
  return { url: target.href, method: isToGet ? "GET" : method };
}

/** Header values as strings; an unresolved `{ env }` reference is dropped (the client skips such checks). */
function resolvedHeaders(check: HttpLikeCheck): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(check.headers ?? {})) {
    if (typeof value === "string") out[name] = value;
  }
  return out;
}

async function runTlsCheck(
  check: TlsCheck,
  deps: CheckDeps,
  timeoutMs: number,
  finish: (
    status: Result["status"],
    statusCode: number | null,
    reason: string | null,
    certDaysLeft?: number | null,
    attempts?: number,
  ) => Result,
): Promise<Result> {
  try {
    const { validTo } = await (deps.tlsConnect ?? tlsConnect)({
      host: check.host,
      port: check.port,
      timeoutMs,
    });
    const now = deps.now();
    const daysLeft = Math.floor((validTo - now) / DAY_MS);
    if (validTo <= now) return finish("down", null, "certificate expired", daysLeft);
    if (daysLeft <= check.warnDays) {
      return finish("down", null, `certificate expires in ${daysLeft} days`, daysLeft);
    }
    return finish("up", null, null, daysLeft);
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      return finish("down", null, `timeout after ${timeoutMs}ms`, null);
    }
    if (err instanceof BlockedAddressError) {
      return finish("down", null, blockedReason(err.category, false), null);
    }
    return finish("down", null, errorReason(err), null);
  }
}
