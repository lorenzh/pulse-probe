import { Resolver } from "node:dns/promises";
import type { DnsCheck, DnsRecordType } from "@lorenzh/pulse-contract";
import { BlockedAddressError } from "@lorenzh/pulse-kit";
import { blockedReason } from "./address-policy.ts";
import { type Attempt, attemptSignal, errorCode, errorReason, isTimeoutError } from "./attempt.ts";
import { quote } from "./reason.ts";

export interface ResolveOptions {
  dnsName: string;
  recordType: DnsRecordType;
  /** IP literal of the resolver; absent means the system resolver. */
  resolver?: string;
  timeoutMs: number;
  signal: AbortSignal;
}

/**
 * Looks up one record type. MX values read `"<priority> <exchange>"`, the chunks of a TXT
 * record are joined. Rejects with the resolver's error (`code` ENOTFOUND, ENODATA, ETIMEOUT).
 */
export type Resolve = (options: ResolveOptions) => Promise<string[]>;

async function query(resolver: Resolver, dnsName: string, type: DnsRecordType): Promise<string[]> {
  switch (type) {
    case "A":
      return resolver.resolve4(dnsName);
    case "AAAA":
      return resolver.resolve6(dnsName);
    case "CNAME":
      return resolver.resolveCname(dnsName);
    case "NS":
      return resolver.resolveNs(dnsName);
    case "MX":
      return (await resolver.resolveMx(dnsName)).map((r) => `${r.priority} ${r.exchange}`);
    case "TXT":
      return (await resolver.resolveTxt(dnsName)).map((chunks) => chunks.join(""));
    default: {
      const unreachable: never = type;
      throw new Error(`unsupported record type ${String(unreachable)}`);
    }
  }
}

export const resolveRecords: Resolve = async ({
  dnsName,
  recordType,
  resolver,
  timeoutMs,
  signal,
}) => {
  const r = new Resolver({ timeout: timeoutMs, tries: 1 });
  if (resolver !== undefined) r.setServers([resolver]);
  const onAbort = (): void => r.cancel();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await query(r, dnsName, recordType);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
};

function stripDot(name: string): string {
  return (name.endsWith(".") ? name.slice(0, -1) : name).toLowerCase();
}

function canonicalIPv6(value: string): string {
  try {
    return new URL(`http://[${value}]`).hostname.slice(1, -1);
  } catch {
    // Not an address: compare it as plain lowercase text.
    return value.toLowerCase();
  }
}

/** The value in the form both the answer and `expected` are compared in. */
function canonical(type: DnsRecordType, value: string): string {
  switch (type) {
    case "A":
      return value.trim();
    case "AAAA":
      return canonicalIPv6(value.trim());
    case "CNAME":
    case "NS":
      return stripDot(value.trim());
    case "MX": {
      const [priority, exchange, ...rest] = value.trim().split(/\s+/);
      return rest.length === 0 && exchange !== undefined
        ? `${priority} ${stripDot(exchange)}`
        : value.trim();
    }
    case "TXT":
      return value;
    default: {
      const unreachable: never = type;
      return String(unreachable);
    }
  }
}

export async function attemptDns(
  check: DnsCheck,
  timeoutMs: number,
  resolve: Resolve,
  shutdown?: AbortSignal,
): Promise<Attempt> {
  try {
    const raw = await resolve({
      dnsName: check.dnsName,
      recordType: check.recordType,
      ...(check.resolver !== undefined ? { resolver: check.resolver } : {}),
      timeoutMs,
      signal: attemptSignal(timeoutMs, shutdown),
    });
    const got = raw.map((v) => canonical(check.recordType, v));
    if (got.length === 0) return noData(check);
    if (check.expected === undefined) return { status: "up", reason: null };
    const expected = check.expected.map((v) => canonical(check.recordType, v));
    if (expected.every((v) => got.includes(v))) return { status: "up", reason: null };
    return {
      status: "down",
      reason: `expected [${quote(expected.join(", "))}], got [${quote(got.join(", "))}]`,
    };
  } catch (err) {
    return { status: "down", reason: failureReason(check, err, timeoutMs) };
  }
}

function noData(check: DnsCheck): Attempt {
  return { status: "down", reason: `no ${check.recordType} record for ${check.dnsName}` };
}

function failureReason(check: DnsCheck, err: unknown, timeoutMs: number): string {
  if (isTimeoutError(err)) return `timeout after ${timeoutMs}ms`;
  if (err instanceof BlockedAddressError) return blockedReason(err.category, false);
  const code = errorCode(err);
  if (code === "ETIMEOUT" || code === "ECANCELLED") return `timeout after ${timeoutMs}ms`;
  if (code === "ENOTFOUND") return `NXDOMAIN: ${check.dnsName} does not exist`;
  if (code === "ENODATA") return noData(check).reason ?? "";
  return errorReason(err);
}
