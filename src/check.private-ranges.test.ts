/* eslint-disable sonarjs/no-hardcoded-ip -- test fixtures for the private-range deny list, never dialed */
import { afterAll, test } from "bun:test";
import assert from "node:assert/strict";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import type { Result } from "@lorenzh/pulse-contract";
import { type CheckDeps, runCheck, type TlsConnectOptions, tlsConnect } from "./check.ts";
import { resolveRecords } from "./check-dns.ts";
import { createCheckGuard } from "./check-guard.ts";
import { tcpConnect } from "./check-tcp.ts";
import type { ProbeCheck } from "./client.ts";

const NOW = Date.UTC(2026, 0, 1);
const PUBLIC_IP = "203.0.113.10";
const PRIVATE_IP = "10.0.0.5";
const LOOPBACK = "blocked: loopback address (PULSE_PROBE_BLOCK_PRIVATE_RANGES)";
const PRIVATE = "blocked: private address (PULSE_PROBE_BLOCK_PRIVATE_RANGES)";
const REDIRECT_PRIVATE = "redirect blocked: private address (PULSE_PROBE_BLOCK_PRIVATE_RANGES)";

interface Call {
  url: string;
  init: BunFetchRequestInit;
}

type Answer = (call: Call) => Response;

/** A guard with fake lookups. `answer` set means a fake underlying fetch, else the real one. */
function guarded(
  answers: Record<string, string[] | string[][]>,
  answer?: Answer,
  transports: Partial<Parameters<typeof createCheckGuard>[0]> = {},
) {
  const calls: Call[] = [];
  const lookups: string[] = [];
  const turns = new Map<string, number>();
  const guard = createCheckGuard({
    fetch: async (url, init) => {
      calls.push({ url, init });
      return answer === undefined ? fetch(url, init) : answer({ url, init });
    },
    lookup: async (host) => {
      lookups.push(host);
      const list = answers[host] ?? [];
      const turn = turns.get(host) ?? 0;
      turns.set(host, turn + 1);
      const first = list[0];
      if (Array.isArray(first)) return (list as string[][])[turn] ?? [];
      return list as string[];
    },
    tcpConnect,
    tlsConnect,
    resolve: resolveRecords,
    monotonic: () => 0,
    ...transports,
  });
  const deps: CheckDeps = {
    ...guard,
    now: () => NOW,
    monotonic: () => 0,
    sleep: async () => {},
    location: "default",
  };
  return { deps, calls, lookups };
}

const plainDeps: CheckDeps = {
  fetch,
  now: () => NOW,
  monotonic: () => 0,
  sleep: async () => {},
  location: "default",
};

const servers: net.Server[] = [];
afterAll(async () => {
  for (const s of servers) {
    if (s instanceof http.Server) s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

interface Target {
  port: number;
  hits: () => number;
  connections: () => number;
}

async function httpTarget(handler?: http.RequestListener): Promise<Target> {
  let hits = 0;
  let connections = 0;
  const server = http.createServer((req, res) => {
    hits++;
    if (handler === undefined) res.end("ok");
    else handler(req, res);
  });
  server.on("connection", () => connections++);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { port, hits: () => hits, connections: () => connections };
}

async function tcpTarget(): Promise<Target> {
  let connections = 0;
  const server = net.createServer((socket) => {
    connections++;
    socket.destroy();
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { port, hits: () => connections, connections: () => connections };
}

function httpCheck(url: string, extra: Record<string, unknown> = {}): ProbeCheck {
  return { id: "h", name: "H", url, intervalMs: 60_000, ...extra };
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

function expectDown(r: Result, reason: string, statusCode: number | null = null): void {
  assert.equal(r.status, "down");
  assert.equal(r.reason, reason);
  assert.equal(r.statusCode, statusCode);
}

// Acceptance

test("a: a loopback literal is blocked and the local server gets no request", async () => {
  const target = await httpTarget();
  const g = guarded({});
  const r = await runCheck(httpCheck(`http://127.0.0.1:${target.port}/`), g.deps);
  expectDown(r, LOOPBACK);
  assert.equal(target.hits(), 0);
});

test("b: a name resolving to a private address is blocked with no fetch call", async () => {
  const g = guarded({ "internal.test": ["10.0.0.5"] }, () => new Response("ok"));
  const r = await runCheck(httpCheck("http://internal.test:8080/"), g.deps);
  expectDown(r, PRIVATE);
  assert.equal(g.calls.length, 0);
});

test("c: a redirect to a private address stops with the 302 status", async () => {
  const g = guarded({ "public.test": ["203.0.113.10"], "internal.test": ["192.168.1.20"] }, () =>
    redirect("http://internal.test/"),
  );
  const r = await runCheck(httpCheck("http://public.test/"), g.deps);
  expectDown(r, REDIRECT_PRIVATE, 302);
  assert.deepEqual(
    g.calls.map((c) => c.url),
    [`http://${PUBLIC_IP}/`],
  );
});

test("d: with the setting off the same targets are reached", async () => {
  const a = await httpTarget();
  const ra = await runCheck(httpCheck(`http://127.0.0.1:${a.port}/`), plainDeps);
  assert.equal(ra.status, "up");
  assert.equal(a.hits(), 1);

  const b = await httpTarget();
  const rb = await runCheck(httpCheck(`http://localhost:${b.port}/`), plainDeps);
  assert.equal(rb.status, "up");
  assert.equal(b.hits(), 1);

  const end = await httpTarget();
  const start = await httpTarget((_req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${end.port}/` });
    res.end();
  });
  const rc = await runCheck(httpCheck(`http://127.0.0.1:${start.port}/`), plainDeps);
  assert.equal(rc.status, "up");
  assert.equal(end.hits(), 1);
});

// Per type

test("tcp and tls to a loopback literal are blocked with no connection", async () => {
  const target = await tcpTarget();
  const g = guarded({});
  const base = { id: "t", name: "T", host: "127.0.0.1", port: target.port, intervalMs: 60_000 };
  const tcp = await runCheck({ ...base, type: "tcp" }, g.deps);
  expectDown(tcp, LOOPBACK);
  const tls = await runCheck({ ...base, type: "tls", warnDays: 14 }, g.deps);
  expectDown(tls, LOOPBACK);
  assert.equal(tls.certDaysLeft, null);
  assert.equal(target.connections(), 0);
});

test("tcp and tls to a name resolving to a private address make no connect call", async () => {
  let connects = 0;
  const g = guarded({ "internal.test": ["10.0.0.5"] }, undefined, {
    tcpConnect: async () => {
      connects++;
    },
    tlsConnect: async () => {
      connects++;
      return { validTo: NOW };
    },
  });
  const base = { id: "t", name: "T", host: "internal.test", port: 443, intervalMs: 60_000 };
  expectDown(await runCheck({ ...base, type: "tcp" }, g.deps), PRIVATE);
  expectDown(await runCheck({ ...base, type: "tls", warnDays: 14 }, g.deps), PRIVATE);
  assert.equal(connects, 0);
});

test("tls to a public name connects to the address with the name as servername", async () => {
  const seen: TlsConnectOptions[] = [];
  const g = guarded({ "public.test": ["203.0.113.10"] }, undefined, {
    tlsConnect: async (options) => {
      seen.push(options);
      return { validTo: NOW + 90 * 86_400_000 };
    },
  });
  const r = await runCheck(
    {
      id: "t",
      name: "T",
      type: "tls",
      host: "public.test",
      port: 443,
      warnDays: 14,
      intervalMs: 60_000,
    },
    g.deps,
  );
  assert.equal(r.status, "up");
  assert.deepEqual(seen, [
    { host: "203.0.113.10", port: 443, timeoutMs: 5000, servername: "public.test" },
  ]);
});

test("https goes to the address with the name in host and tls.serverName", async () => {
  const g = guarded({ "public.test": ["203.0.113.10"] }, () => new Response("ok"));
  const r = await runCheck(httpCheck("https://public.test/"), g.deps);
  assert.equal(r.status, "up");
  assert.equal(g.calls.length, 1);
  const call = g.calls[0];
  assert.equal(call?.url, "https://203.0.113.10/");
  assert.equal(new Headers(call?.init.headers).get("host"), "public.test");
  assert.equal(call?.init.tls?.serverName, "public.test");
});

test("http to a public name that answers 200 is up", async () => {
  const g = guarded({ "public.test": ["203.0.113.10"] }, () => new Response("ok"));
  const r = await runCheck(httpCheck("http://public.test/"), g.deps);
  assert.equal(r.status, "up");
  assert.equal(r.statusCode, 200);
});

test("a mixed answer is blocked with no fetch call", async () => {
  const g = guarded({ "mixed.test": ["203.0.113.10", "10.0.0.5"] }, () => new Response("ok"));
  expectDown(await runCheck(httpCheck("http://mixed.test/"), g.deps), PRIVATE);
  assert.equal(g.calls.length, 0);
});

test("a DNS change between hops blocks the second hop", async () => {
  const g = guarded({ "flip.test": [["203.0.113.10"], ["127.0.0.1"]] }, () => redirect("/next"));
  const r = await runCheck(httpCheck("http://flip.test/"), g.deps);
  expectDown(r, "redirect blocked: loopback address (PULSE_PROBE_BLOCK_PRIVATE_RANGES)", 302);
  assert.equal(g.calls.length, 1);
  assert.equal(g.lookups.length, 2);
});

test("the existing cross-origin rule stops a secret-bearing redirect before the policy", async () => {
  const g = guarded({ "public.test": ["203.0.113.10"] }, () => redirect(`http://${PRIVATE_IP}/`));
  const r = await runCheck(httpCheck("http://public.test/", { headers: { "x-k": "v" } }), g.deps);
  expectDown(r, "redirect to http://10.0.0.5 not followed", 302);
  assert.deepEqual(g.lookups, ["public.test"]);
});

test("dns: a loopback resolver is blocked, a public one and the system resolver are not", async () => {
  let queries = 0;
  const g = guarded({}, undefined, {
    resolve: async () => {
      queries++;
      return ["10.0.0.1"];
    },
  });
  const base = {
    id: "d",
    name: "D",
    type: "dns" as const,
    dnsName: "example.test",
    recordType: "A" as const,
    intervalMs: 60_000,
  };
  expectDown(await runCheck({ ...base, resolver: "127.0.0.53" }, g.deps), LOOPBACK);
  assert.equal(queries, 0);
  assert.equal((await runCheck({ ...base, resolver: "8.8.8.8" }, g.deps)).status, "up");
  assert.equal(queries, 1);
  const system = await runCheck({ ...base, expected: ["10.0.0.1"] }, g.deps);
  assert.equal(system.status, "up");
  assert.equal(queries, 2);
});

const domainCheck = {
  id: "m",
  name: "M",
  type: "domain" as const,
  domain: "example.test",
  warnDays: 30,
  intervalMs: 3_600_000,
};

function bootstrap(...urls: string[]): Response {
  return Response.json({ services: [[["test"], urls]] });
}

test("domain: a loopback bootstrap is blocked with no fetch call", async () => {
  const g = guarded({ "boot-loop.test": ["127.0.0.1"] }, () => new Response("{}"));
  const r = await runCheck(domainCheck, {
    ...g.deps,
    rdapBootstrapUrl: "https://boot-loop.test/dns.json",
  });
  expectDown(r, LOOPBACK);
  assert.equal(r.certDaysLeft, null);
  assert.equal(g.calls.length, 0);
});

test("domain: a private RDAP service is blocked after the bootstrap fetch", async () => {
  const g = guarded(
    { "boot-svc.test": ["203.0.113.10"], "rdap-private.test": ["192.168.1.1"] },
    () => bootstrap("https://rdap-private.test/"),
  );
  const r = await runCheck(domainCheck, {
    ...g.deps,
    rdapBootstrapUrl: "https://boot-svc.test/dns.json",
  });
  expectDown(r, PRIVATE);
  assert.equal(g.calls.length, 1);
});

test("domain: an RDAP redirect to a listed host on a private address is blocked", async () => {
  const g = guarded(
    {
      "boot-redir.test": ["203.0.113.10"],
      "rdap-pub.test": ["203.0.113.11"],
      "rdap-redir.test": ["10.1.1.1"],
    },
    ({ url }) =>
      url.startsWith("https://203.0.113.10/")
        ? bootstrap("https://rdap-pub.test/", "https://rdap-redir.test/")
        : redirect("https://rdap-redir.test/domain/example.test"),
  );
  const r = await runCheck(domainCheck, {
    ...g.deps,
    rdapBootstrapUrl: "https://boot-redir.test/dns.json",
  });
  expectDown(r, REDIRECT_PRIVATE);
  assert.equal(g.calls.length, 2);
});

for (const [label, host, reason] of [
  ["decimal", "2130706433", LOOPBACK],
  ["hex", "0x7f.1", LOOPBACK],
  ["short", "127.1", LOOPBACK],
  ["mapped IPv6", "[::ffff:127.0.0.1]", LOOPBACK],
  ["zero", "0", "blocked: unspecified address (PULSE_PROBE_BLOCK_PRIVATE_RANGES)"],
] as const) {
  test(`the ${label} spelling ${host} is blocked with a real fetch`, async () => {
    const target = await httpTarget();
    const g = guarded({});
    const r = await runCheck(httpCheck(`http://${host}:${target.port}/`), g.deps);
    expectDown(r, reason);
    assert.equal(target.hits(), 0);
  });
}

test("a blocked reason holds no secret, host or address of the check", async () => {
  const g = guarded({ "internal.test": ["10.0.0.5"] }, () => new Response("ok"));
  const r = await runCheck(
    httpCheck("http://user:pw-sentinel@internal.test/?q=query-sentinel", {
      method: "POST",
      headers: { "x-k": "header-sentinel" },
      body: "body-sentinel",
    }),
    g.deps,
  );
  expectDown(r, PRIVATE);
  for (const text of [
    "pw-sentinel",
    "query-sentinel",
    "header-sentinel",
    "body-sentinel",
    "internal.test",
    "10.0.0.5",
  ]) {
    assert.ok(!(r.reason ?? "").includes(text), text);
  }
});
