import { isIP } from "node:net";
import {
  connectFirst,
  createGuardedFetch,
  type GuardedFetch,
  type LookupAll,
  resolveAllowed,
} from "@lorenzh/pulse-kit";
import { blockedCategory } from "./address-policy.ts";
import type { CheckDeps, TlsConnect } from "./check.ts";
import type { Resolve } from "./check-dns.ts";
import type { TcpConnect } from "./check-tcp.ts";

export interface CheckGuardDeps {
  fetch: (input: string, init: BunFetchRequestInit) => Promise<Response>;
  lookup: LookupAll;
  tcpConnect: TcpConnect;
  tlsConnect: TlsConnect;
  resolve: Resolve;
  /** Monotonic clock (ms): the lookup time is taken from the TLS connect budget. */
  monotonic: () => number;
}

export interface CheckGuard {
  fetch: CheckDeps["fetch"];
  tcpConnect: TcpConnect;
  tlsConnect: TlsConnect;
  resolve: Resolve;
}

/**
 * The check transports with the private-range policy: every connection goes to an address
 * that was resolved and allowed, and a DNS check's explicit resolver must be allowed.
 */
export function createCheckGuard(deps: CheckGuardDeps): CheckGuard {
  const { lookup } = deps;
  const classify = blockedCategory;
  const fetch: GuardedFetch = createGuardedFetch({ fetch: deps.fetch, lookup, classify });

  const tcpConnect: TcpConnect = async (options) => {
    const { signal } = options;
    const addresses = await resolveAllowed(options.host, { lookup, classify, signal });
    await connectFirst(addresses, (host) => deps.tcpConnect({ ...options, host }), signal);
  };

  const tlsConnect: TlsConnect = async (options) => {
    const { host, timeoutMs } = options;
    const signal = AbortSignal.timeout(timeoutMs);
    const start = deps.monotonic();
    const addresses = await resolveAllowed(host, { lookup, classify, signal });
    const servername = options.servername ?? (isIP(host) === 0 ? host : undefined);
    return connectFirst(
      addresses,
      (address) => {
        // All attempts share one deadline: each connect gets only the time that is left.
        const remaining = timeoutMs - (deps.monotonic() - start);
        if (remaining <= 0) {
          return Promise.reject(new DOMException("The operation timed out.", "TimeoutError"));
        }
        return deps.tlsConnect({
          host: address,
          port: options.port,
          timeoutMs: remaining,
          ...(servername !== undefined ? { servername } : {}),
        });
      },
      signal,
    );
  };

  const resolve: Resolve = async (options) => {
    if (options.resolver !== undefined) {
      await resolveAllowed(options.resolver, { lookup, classify, signal: options.signal });
    }
    return deps.resolve(options);
  };

  return { fetch, tcpConnect, tlsConnect, resolve };
}
