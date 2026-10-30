import { test } from "bun:test";
import assert from "node:assert/strict";
import { loadChecks } from "./client.ts";

const wire = { headers: { "x-pulse-contract": "1" } };

const tcp = {
  id: "t",
  name: "T",
  type: "tcp",
  host: "db.test",
  port: 5432,
  intervalMs: 1000,
  retries: 2,
  retryDelayMs: 500,
  timeoutMs: 900,
};
const dns = {
  id: "d",
  name: "D",
  type: "dns",
  dnsName: "a.test",
  recordType: "A",
  expected: ["192.0.2.1"],
  resolver: "192.0.2.53",
  intervalMs: 1000,
};
const domain = {
  id: "m",
  name: "M",
  type: "domain",
  domain: "example.test",
  warnDays: 30,
  intervalMs: 3_600_000,
};

test("loadChecks keeps tcp, dns and domain checks with all their fields", async () => {
  const body = [tcp, dns, domain].map((c) => ({ ...c, state: "up", certDaysLeft: null }));
  const fakeFetch = (async () => Response.json(body, wire)) as unknown as typeof fetch;
  const checks = await loadChecks("https://api", { fetch: fakeFetch, log: () => {} });
  assert.deepEqual(checks, [tcp, dns, domain]);
});

test("loadChecks skips an invalid new-type check and keeps the valid ones", async () => {
  const logs: string[] = [];
  const bad = { ...domain, id: "short", intervalMs: 60_000 };
  const unknown = { id: "u", name: "U", type: "icmp", host: "x", intervalMs: 1000 };
  const fakeFetch = (async () =>
    Response.json([tcp, bad, unknown, dns], wire)) as unknown as typeof fetch;
  const checks = await loadChecks("https://api", { fetch: fakeFetch, log: (m) => logs.push(m) });
  assert.deepEqual(checks, [tcp, dns]);
  assert.equal(logs.filter((m) => m.startsWith("skipping invalid check")).length, 2);
});

test("loadChecks keeps checks of every probed type that carry an availabilityTarget", async () => {
  const http = { id: "h", name: "H", url: "https://a.test", intervalMs: 1000 };
  const tls = {
    id: "s",
    name: "S",
    type: "tls",
    host: "a.test",
    port: 443,
    warnDays: 14,
    intervalMs: 1000,
  };
  const all = [http, tls, tcp, dns, domain];
  const logs: string[] = [];
  const body = all.map((c) => ({ ...c, availabilityTarget: 99.9 }));
  const fakeFetch = (async () => Response.json(body, wire)) as unknown as typeof fetch;
  const checks = await loadChecks("https://api", { fetch: fakeFetch, log: (m) => logs.push(m) });
  assert.deepEqual(logs, []);
  assert.deepEqual(checks, all);
});
