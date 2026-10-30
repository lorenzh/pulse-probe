import { test } from "bun:test";
import assert from "node:assert/strict";
import { type CheckDeps, runCheck } from "./check.ts";
import type { Resolve, ResolveOptions } from "./check-dns.ts";

let t = 1000;
const tick = (): number => (t += 7);
const deps: CheckDeps = {
  fetch,
  now: tick,
  monotonic: tick,
  sleep: async () => {},
  location: "default",
};

type RecordType = "A" | "AAAA" | "CNAME" | "MX" | "TXT" | "NS";

function dnsCheck(recordType: RecordType, extra: Record<string, unknown> = {}) {
  return {
    id: "d",
    name: "D",
    type: "dns" as const,
    dnsName: "example.test",
    recordType,
    intervalMs: 60_000,
    ...extra,
  };
}

const answer =
  (values: string[]): Resolve =>
  async () =>
    values;
const fail =
  (code: string): Resolve =>
  async () => {
    throw Object.assign(new Error(code), { code });
  };

test("dns is up when the answer has the expected values, extra values allowed", async () => {
  const check = dnsCheck("A", { expected: ["192.0.2.1"] });
  const r = await runCheck(check, { ...deps, resolve: answer(["192.0.2.2", "192.0.2.1"]) });
  assert.equal(r.status, "up");
  assert.equal(r.reason, null);
});

test("dns without expected is up on any record", async () => {
  const r = await runCheck(dnsCheck("A"), { ...deps, resolve: answer(["192.0.2.9"]) });
  assert.equal(r.status, "up");
});

test("dns ignores case and the trailing dot of names", async () => {
  const check = dnsCheck("CNAME", { expected: ["Target.Example.Test."] });
  const r = await runCheck(check, { ...deps, resolve: answer(["target.example.test"]) });
  assert.equal(r.status, "up");
});

test("dns compares MX as priority and exchange, and joins nothing else", async () => {
  const check = dnsCheck("MX", { expected: ["10 MAIL.example.test."] });
  const up = await runCheck(check, {
    ...deps,
    resolve: answer(["10 mail.example.test", "20 b.test"]),
  });
  assert.equal(up.status, "up");
  const down = await runCheck(check, { ...deps, resolve: answer(["20 mail.example.test"]) });
  assert.equal(down.status, "down");
});

test("dns compares IPv6 addresses in canonical form", async () => {
  const check = dnsCheck("AAAA", { expected: ["2001:db8:0:0:0:0:0:1"] });
  const r = await runCheck(check, { ...deps, resolve: answer(["2001:db8::1"]) });
  assert.equal(r.status, "up");
});

test("dns TXT values are compared as one string", async () => {
  const check = dnsCheck("TXT", { expected: ["v=spf1 -all"] });
  const r = await runCheck(check, { ...deps, resolve: answer(["v=spf1 -all"]) });
  assert.equal(r.status, "up");
});

test("dns mismatch is down and lists expected and actual values", async () => {
  const check = dnsCheck("A", { expected: ["192.0.2.1"] });
  const r = await runCheck(check, { ...deps, resolve: answer(["192.0.2.2", "192.0.2.3"]) });
  assert.equal(r.status, "down");
  assert.equal(r.reason, "expected [192.0.2.1], got [192.0.2.2, 192.0.2.3]");
});

test("dns NXDOMAIN and no data have their own reasons", async () => {
  const nx = await runCheck(dnsCheck("A"), { ...deps, resolve: fail("ENOTFOUND") });
  assert.equal(nx.reason, "NXDOMAIN: example.test does not exist");
  const nodata = await runCheck(dnsCheck("MX"), { ...deps, resolve: fail("ENODATA") });
  assert.equal(nodata.reason, "no MX record for example.test");
  const empty = await runCheck(dnsCheck("MX"), { ...deps, resolve: answer([]) });
  assert.equal(empty.reason, "no MX record for example.test");
});

test("dns timeout is down with the timeout reason", async () => {
  const hang: Resolve = ({ signal }) =>
    new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
  const r = await runCheck(dnsCheck("A", { timeoutMs: 30 }), { ...deps, resolve: hang });
  assert.equal(r.status, "down");
  assert.equal(r.reason, "timeout after 30ms");
  const viaResolver = await runCheck(dnsCheck("A", { timeoutMs: 30 }), {
    ...deps,
    resolve: fail("ETIMEOUT"),
  });
  assert.equal(viaResolver.reason, "timeout after 30ms");
});

test("dns passes the resolver and the record type to the lookup", async () => {
  const seen: ResolveOptions[] = [];
  const resolve: Resolve = async (o) => {
    seen.push(o);
    return ["192.0.2.1"];
  };
  await runCheck(dnsCheck("A", { resolver: "192.0.2.53", timeoutMs: 1234 }), { ...deps, resolve });
  assert.equal(seen[0]?.resolver, "192.0.2.53");
  assert.equal(seen[0]?.recordType, "A");
  assert.equal(seen[0]?.timeoutMs, 1234);
});

test("dns retries a failed lookup", async () => {
  let calls = 0;
  const resolve: Resolve = async () => {
    calls++;
    if (calls === 1) throw Object.assign(new Error("x"), { code: "ETIMEOUT" });
    return ["192.0.2.1"];
  };
  const r = await runCheck(dnsCheck("A", { retries: 1 }), { ...deps, resolve });
  assert.equal(r.status, "up");
  assert.equal(r.attempts, 2);
});

test("dns compares values that are not addresses or MX pairs as plain text", async () => {
  const bad6 = await runCheck(dnsCheck("AAAA", { expected: ["NOT-AN-ADDRESS"] }), {
    ...deps,
    resolve: answer(["not-an-address"]),
  });
  assert.equal(bad6.status, "up");
  const odd = await runCheck(dnsCheck("MX", { expected: ["mail.example.test"] }), {
    ...deps,
    resolve: answer(["mail.example.test"]),
  });
  assert.equal(odd.status, "up");
});
