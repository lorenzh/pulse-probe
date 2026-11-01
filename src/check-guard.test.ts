/* eslint-disable sonarjs/no-hardcoded-ip -- test fixtures for the private-range deny list, never dialed */
import { test } from "bun:test";
import assert from "node:assert/strict";
import { BlockedAddressError } from "@lorenzh/pulse-kit";
import type { TlsConnectOptions } from "./check.ts";
import type { ResolveOptions } from "./check-dns.ts";
import { createCheckGuard } from "./check-guard.ts";
import type { TcpConnectOptions } from "./check-tcp.ts";

function refused(): Error {
  return Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
}

function setup(answers: Record<string, string[]>, lookupMs = 0, connectMs = 0) {
  let clock = 0;
  const lookups: string[] = [];
  const tcp: TcpConnectOptions[] = [];
  const tls: TlsConnectOptions[] = [];
  const resolves: ResolveOptions[] = [];
  const failFor = new Set<string>();
  const guard = createCheckGuard({
    fetch: async () => new Response("ok"),
    lookup: async (host) => {
      lookups.push(host);
      clock += lookupMs;
      return answers[host] ?? [];
    },
    tcpConnect: async (options) => {
      tcp.push(options);
      if (failFor.has(options.host)) throw refused();
    },
    tlsConnect: async (options) => {
      tls.push(options);
      clock += connectMs;
      if (failFor.has(options.host)) throw refused();
      return { validTo: 1 };
    },
    resolve: async (options) => {
      resolves.push(options);
      return ["10.0.0.1"];
    },
    monotonic: () => clock,
  });
  return { guard, lookups, tcp, tls, resolves, failFor };
}

const signal = (): AbortSignal => new AbortController().signal;

test("tcp connects to the resolved address and falls back on a refused connection", async () => {
  const s = setup({ "public.test": ["2001:db8::1", "203.0.113.10"] });
  s.failFor.add("2001:db8::1");
  await s.guard.tcpConnect({ host: "public.test", port: 25, signal: signal() });
  assert.deepEqual(
    s.tcp.map((o) => [o.host, o.port]),
    [
      ["2001:db8::1", 25],
      ["203.0.113.10", 25],
    ],
  );
});

test("tcp to a name resolving to a private address makes no connect call", async () => {
  const s = setup({ "internal.test": ["10.0.0.5"] });
  await assert.rejects(
    s.guard.tcpConnect({ host: "internal.test", port: 25, signal: signal() }),
    (err: unknown) => err instanceof BlockedAddressError && err.category === "private",
  );
  assert.equal(s.tcp.length, 0);
});

test("tcp to an IPv6 literal is classified without a lookup", async () => {
  const s = setup({});
  await assert.rejects(
    s.guard.tcpConnect({ host: "::1", port: 25, signal: signal() }),
    (err: unknown) => err instanceof BlockedAddressError && err.category === "loopback",
  );
  await s.guard.tcpConnect({ host: "2001:db8::1", port: 25, signal: signal() });
  assert.equal(s.lookups.length, 0);
  assert.deepEqual(
    s.tcp.map((o) => o.host),
    ["2001:db8::1"],
  );
});

test("tls connects to the address with the name as servername and falls back", async () => {
  const s = setup({ "public.test": ["2001:db8::1", "203.0.113.10"] });
  s.failFor.add("2001:db8::1");
  const out = await s.guard.tlsConnect({ host: "public.test", port: 443, timeoutMs: 1000 });
  assert.deepEqual(out, { validTo: 1 });
  assert.deepEqual(s.tls, [
    { host: "2001:db8::1", port: 443, timeoutMs: 1000, servername: "public.test" },
    { host: "203.0.113.10", port: 443, timeoutMs: 1000, servername: "public.test" },
  ]);
});

test("tls to an IP literal sets no servername", async () => {
  const s = setup({});
  await s.guard.tlsConnect({ host: "203.0.113.10", port: 443, timeoutMs: 1000 });
  assert.deepEqual(s.tls, [{ host: "203.0.113.10", port: 443, timeoutMs: 1000 }]);
});

test("tls gives the connect the time the lookup left", async () => {
  const s = setup({ "public.test": ["203.0.113.10"] }, 300);
  await s.guard.tlsConnect({ host: "public.test", port: 443, timeoutMs: 1000 });
  assert.equal(s.tls[0]?.timeoutMs, 700);
});

test("tls fallback attempts share one deadline", async () => {
  const s = setup({ "public.test": ["2001:db8::1", "203.0.113.10", "203.0.113.11"] }, 0, 600);
  s.failFor.add("2001:db8::1");
  s.failFor.add("203.0.113.10");
  await assert.rejects(
    s.guard.tlsConnect({ host: "public.test", port: 443, timeoutMs: 1000 }),
    (err: unknown) => err instanceof Error && err.name === "TimeoutError",
  );
  assert.deepEqual(
    s.tls.map((o) => o.timeoutMs),
    [1000, 400],
  );
});

test("tls to a name resolving to a private address makes no connect call", async () => {
  const s = setup({ "internal.test": ["10.0.0.5"] });
  await assert.rejects(
    s.guard.tlsConnect({ host: "internal.test", port: 443, timeoutMs: 1000 }),
    (err: unknown) => err instanceof BlockedAddressError && err.category === "private",
  );
  assert.equal(s.tls.length, 0);
});

test("dns blocks a private resolver literal before any query", async () => {
  const s = setup({});
  const base = { dnsName: "example.test", recordType: "A" as const, timeoutMs: 1000 };
  await assert.rejects(
    s.guard.resolve({ ...base, resolver: "127.0.0.53", signal: signal() }),
    (err: unknown) => err instanceof BlockedAddressError && err.category === "loopback",
  );
  assert.equal(s.resolves.length, 0);
  assert.deepEqual(await s.guard.resolve({ ...base, resolver: "8.8.8.8", signal: signal() }), [
    "10.0.0.1",
  ]);
  assert.deepEqual(await s.guard.resolve({ ...base, signal: signal() }), ["10.0.0.1"]);
  assert.equal(s.resolves.length, 2);
  assert.equal(s.lookups.length, 0);
});
