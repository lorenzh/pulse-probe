import { isIP } from "node:net";
import tls from "node:tls";
import type { Check, Result, TlsCheck } from "@lorenzh/pulse-contract";

import { userAgent } from "./location.ts";

export const DEFAULT_TIMEOUT_MS = 5000;

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
  ): Result => ({
    checkId: check.id,
    timestamp: start,
    status,
    statusCode,
    latencyMs: Math.max(0, deps.now() - start),
    reason,
    location: deps.location,
    ...(certDaysLeft !== undefined ? { certDaysLeft } : {}),
  });
  if (check.type === "tls") return runTlsCheck(check, deps, timeoutMs, finish);
  try {
    const res = await deps.fetch(check.url, {
      method: "GET",
      headers: { "user-agent": userAgent(deps.location) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.body?.cancel().catch(() => {});
    if (res.status >= 200 && res.status < 300) {
      return finish("up", res.status, null);
    }
    return finish("down", res.status, `HTTP ${res.status}`);
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      return finish("down", null, `timeout after ${timeoutMs}ms`);
    }
    return finish("down", null, errorReason(err));
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
