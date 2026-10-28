import { isIP } from "node:net";
import tls from "node:tls";
import type { Check, Result, TlsCheck } from "@lorenzh/pulse-contract";

import { userAgent } from "./location.ts";

export const DEFAULT_TIMEOUT_MS = 5000;

export const DEFAULT_RETRY_DELAY_MS = 1000;

export const DAY_MS = 86_400_000;

export interface TlsConnectOptions {
  host: string;
  port: number;
  timeoutMs: number;
}

/** Connects, completes the handshake and returns the leaf certificate's `valid_to` (epoch ms). */
export type TlsConnect = (options: TlsConnectOptions) => Promise<{ validTo: number }>;

/**
 * Reads the leaf certificate of a TLS endpoint. The chain and the hostname are not
 * verified (`rejectUnauthorized: false`); `timeoutMs` bounds connect plus handshake.
 */
export const tlsConnect: TlsConnect = ({ host, port, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const signal = AbortSignal.timeout(timeoutMs);
    const socket = tls.connect({
      host,
      port,
      ...(isIP(host) === 0 ? { servername: host } : {}),
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

export interface CheckDeps {
  fetch: typeof fetch;
  /** Defaults to the real TLS connection. */
  tlsConnect?: TlsConnect;
  now: () => number;
  /** Waits `ms` milliseconds between attempts. */
  sleep: (ms: number) => Promise<void>;
  /** Probe location name, set on every result. */
  location: string;
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
    certDaysLeft?: number | null,
    attempts = 1,
    attemptStart = start,
  ): Result => ({
    checkId: check.id,
    timestamp: start,
    status,
    statusCode,
    latencyMs: Math.max(0, deps.now() - attemptStart),
    reason,
    location: deps.location,
    attempts,
    ...(certDaysLeft !== undefined ? { certDaysLeft } : {}),
  });
  if (check.type === "tls") return runTlsCheck(check, deps, timeoutMs, finish);
  const retries = check.retries ?? 0;
  const retryDelayMs = check.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  for (let attempt = 1; ; attempt++) {
    const attemptStart = attempt === 1 ? start : deps.now();
    const result = await attemptHttp(check.url, deps, timeoutMs, (status, code, reason) =>
      finish(status, code, reason, undefined, attempt, attemptStart),
    );
    if (result.status === "up" || attempt > retries) return result;
    if (deps.now() + retryDelayMs >= start + check.intervalMs) return result;
    await deps.sleep(retryDelayMs);
  }
}

async function attemptHttp(
  url: string,
  deps: CheckDeps,
  timeoutMs: number,
  done: (status: Result["status"], statusCode: number | null, reason: string | null) => Result,
): Promise<Result> {
  try {
    const res = await deps.fetch(url, {
      method: "GET",
      headers: { "user-agent": userAgent(deps.location) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.body?.cancel().catch(() => {});
    if (res.status >= 200 && res.status < 300) {
      return done("up", res.status, null);
    }
    return done("down", res.status, `HTTP ${res.status}`);
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      return done("down", null, `timeout after ${timeoutMs}ms`);
    }
    return done("down", null, errorReason(err));
  }
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
    return finish("down", null, errorReason(err), null);
  }
}
