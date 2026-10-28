import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import tls from "node:tls";
import type { TlsCheck } from "@lorenzh/pulse-contract";
import { DAY_MS, runCheck } from "./check.ts";

const dir = mkdtempSync(join(tmpdir(), "probe-tls-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function makeCert(name: string, days: number): { key: string; cert: string } {
  const key = join(dir, `${name}.key`);
  const cert = join(dir, `${name}.crt`);
  execFileSync(
    "openssl",
    [
      ...["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"],
      ...["-keyout", key, "-out", cert, "-subj", "/CN=localhost", "-days", String(days)],
    ],
    { stdio: "ignore" },
  );
  return { key: readFileSync(key, "utf8"), cert: readFileSync(cert, "utf8") };
}

async function serve(
  days: number,
  onSni?: (name: string | false) => void,
): Promise<{ server: tls.Server; port: number }> {
  const { key, cert } = makeCert(`c${days}-${Math.random().toString(36).slice(2)}`, days);
  const server = tls.createServer({
    key,
    cert,
    SNICallback: (name, cb) => {
      onSni?.(name);
      cb(null, tls.createSecureContext({ key, cert }));
    },
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as AddressInfo).port };
}
const close = (s: net.Server): Promise<void> => new Promise((r) => s.close(() => r()));

const deps = { fetch, now: () => Date.now(), sleep: async () => {}, location: "default" };
const tlsCheck = (port: number, extra: Partial<TlsCheck> = {}): TlsCheck => ({
  id: "t",
  name: "T",
  type: "tls",
  host: "localhost",
  port,
  warnDays: 14,
  intervalMs: 1000,
  ...extra,
});

test("tls: 90 day cert is up", async () => {
  const { server, port } = await serve(90);
  try {
    const r = await runCheck(tlsCheck(port), deps);
    assert.equal(r.status, "up");
    assert.equal(r.reason, null);
    assert.equal(r.statusCode, null);
    assert.ok(r.certDaysLeft === 89 || r.certDaysLeft === 90);
  } finally {
    await close(server);
  }
});

test("tls: 5 day cert is down within threshold", async () => {
  const { server, port } = await serve(5);
  try {
    const r = await runCheck(tlsCheck(port), deps);
    assert.equal(r.status, "down");
    assert.ok(r.certDaysLeft === 4 || r.certDaysLeft === 5);
    assert.equal(r.reason, `certificate expires in ${r.certDaysLeft} days`);
  } finally {
    await close(server);
  }
});

test("tls: boundary around warnDays with injected clock", async () => {
  const validTo = Date.parse("2030-01-31T00:00:00Z");
  const run = (nowMs: number) =>
    runCheck(tlsCheck(1), {
      ...deps,
      now: () => nowMs,
      tlsConnect: async () => ({ validTo }),
    });
  const exact = await run(validTo - 14 * DAY_MS - 1000);
  assert.equal(exact.status, "down");
  assert.equal(exact.certDaysLeft, 14);
  assert.equal(exact.reason, "certificate expires in 14 days");
  const below = await run(validTo - 14 * DAY_MS + 1000);
  assert.equal(below.status, "down");
  assert.equal(below.certDaysLeft, 13);
});

test("tls: warnDays + 1 is up", async () => {
  const validTo = Date.parse("2030-01-31T00:00:00Z");
  const r = await runCheck(tlsCheck(1), {
    ...deps,
    now: () => validTo - 15 * DAY_MS - 1000,
    tlsConnect: async () => ({ validTo }),
  });
  assert.equal(r.status, "up");
  assert.equal(r.certDaysLeft, 15);
});

test("tls: expired certificate", async () => {
  const validTo = 1_000_000;
  const r = await runCheck(tlsCheck(1), {
    ...deps,
    now: () => validTo + 3 * DAY_MS,
    tlsConnect: async () => ({ validTo }),
  });
  assert.equal(r.status, "down");
  assert.equal(r.reason, "certificate expired");
  assert.equal(r.certDaysLeft, -3);
});

test("tls: refused connection", async () => {
  const probe = net.createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as AddressInfo).port;
  await close(probe);
  const r = await runCheck(tlsCheck(port, { host: "127.0.0.1" }), deps);
  assert.equal(r.status, "down");
  assert.equal(r.reason, "ECONNREFUSED");
  assert.equal(r.certDaysLeft, null);
});

test("tls: timeout when handshake never completes", async () => {
  const sockets: net.Socket[] = [];
  const server = net.createServer((s) => sockets.push(s));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const port = (server.address() as AddressInfo).port;
    const r = await runCheck(tlsCheck(port, { host: "127.0.0.1", timeoutMs: 50 }), deps);
    assert.equal(r.status, "down");
    assert.equal(r.reason, "timeout after 50ms");
    assert.equal(r.certDaysLeft, null);
  } finally {
    for (const s of sockets) s.destroy();
    await close(server);
  }
});

test("tls: sends the host as SNI", async () => {
  const seen: Array<string | false> = [];
  const { server, port } = await serve(90, (n) => seen.push(n));
  try {
    await runCheck(tlsCheck(port), deps);
    assert.deepEqual(seen, ["localhost"]);
  } finally {
    await close(server);
  }
});
