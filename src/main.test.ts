import { afterAll as after, test } from "bun:test";
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";

const MAIN = new URL("./main.ts", import.meta.url).pathname;

const servers: http.Server[] = [];
after(async () => {
  for (const s of servers) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

async function fakeApi(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

interface Run {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  exit: Promise<{ code: number | null }>;
}

function run(env: Record<string, string>): Run {
  const child = spawn(process.execPath, [MAIN], {
    env: { PATH: process.env.PATH ?? "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout?.on("data", (d: Buffer) => {
    out += d.toString();
  });
  child.stderr?.on("data", (d: Buffer) => {
    err += d.toString();
  });
  const exit = new Promise<{ code: number | null }>((resolve) =>
    child.on("close", (code) => resolve({ code })),
  );
  return { child, stdout: () => out, stderr: () => err, exit };
}

async function until(cond: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!cond()) {
    assert.ok(Date.now() < deadline, "timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

for (const [name, env] of [
  ["PULSE_PROBE_TOKEN", {}],
  ["PULSE_API_URL", { PULSE_PROBE_TOKEN: "tok-secret", PULSE_API_URL: "bogus" }],
  ["PULSE_LOCATION", { PULSE_PROBE_TOKEN: "tok-secret", PULSE_LOCATION: "x".repeat(65) }],
  ["PULSE_CHECKS_RELOAD_MS", { PULSE_PROBE_TOKEN: "tok-secret", PULSE_CHECKS_RELOAD_MS: "1" }],
  ["PULSE_LOG_LEVEL", { PULSE_PROBE_TOKEN: "tok-secret", PULSE_LOG_LEVEL: "loud" }],
  ["PULSE_HEALTH_PORT", { PULSE_PROBE_TOKEN: "tok-secret", PULSE_HEALTH_PORT: "abc" }],
] as const) {
  test(`a bad ${name} exits 2 with one line and no stack`, async () => {
    const r = run(env);
    const { code } = await r.exit;
    assert.equal(code, 2);
    const lines = r.stderr().trimEnd().split("\n");
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? "", new RegExp(`^pulse-probe: .*${name}`));
    assert.ok(!r.stderr().includes("tok-secret"));
  });
}

test("an occupied health port exits 2 with one line naming both settings and no API call", async () => {
  let apiCalls = 0;
  const api = await fakeApi((_q, res) => {
    apiCalls++;
    res.end("[]");
  });
  const blocker = http.createServer();
  servers.push(blocker);
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const port = (blocker.address() as AddressInfo).port;
  const r = run({
    PULSE_PROBE_TOKEN: "tok-secret",
    PULSE_API_URL: api,
    PULSE_HEALTH_HOST: "127.0.0.1",
    PULSE_HEALTH_PORT: String(port),
  });
  assert.equal((await r.exit).code, 2);
  const lines = r.stderr().trimEnd().split("\n");
  assert.equal(lines.length, 1);
  assert.match(
    lines[0] ?? "",
    /^pulse-probe: cannot listen on 127\.0\.0\.1:\d+ \(PULSE_HEALTH_HOST\/PULSE_HEALTH_PORT\): /,
  );
  assert.equal(r.stdout(), "");
  assert.equal(apiCalls, 0);
});

test("SIGTERM while the startup fetch retries exits 0 quickly", async () => {
  const api = await fakeApi((_q, res) => {
    res.statusCode = 500;
    res.end();
  });
  const r = run({ PULSE_PROBE_TOKEN: "tok-secret", PULSE_API_URL: api });
  await until(() => r.stderr().includes("fetching checks failed"));
  const started = Date.now();
  r.child.kill("SIGTERM");
  const { code } = await r.exit;
  assert.equal(code, 0);
  assert.ok(Date.now() - started < 3000);
});

test("healthz, metrics, debug logs and clean shutdown against a fake API", async () => {
  const target = await fakeApi((_q, res) => res.end("ok"));
  const posted: string[] = [];
  const api = await fakeApi((req, res) => {
    if (req.url === "/probe/checks" && req.headers.authorization === "Bearer tok-secret") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify([
          { id: "home", name: "Home", url: `${target}/?secret=abc`, intervalMs: 60_000 },
        ]),
      );
      return;
    }
    req.resume();
    req.on("end", () => {
      posted.push(req.url ?? "");
      res.statusCode = 204;
      res.end();
    });
  });
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const r = run({
    PULSE_PROBE_TOKEN: "tok-secret",
    PULSE_API_URL: api,
    PULSE_LOG_LEVEL: "debug",
    PULSE_HEALTH_PORT: String(port),
  });
  await until(() => posted.length > 0);
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await fetch(`${base}/readyz`)).status, 200);
  const metrics = await (await fetch(`${base}/metrics`)).text();
  assert.match(metrics, /pulse_probe_check_status\{check="home",state="up"\} 1/);
  assert.match(metrics, /posted_total\{check="home",outcome="ok"\} 1/);
  assert.ok(!metrics.includes("secret=abc"));
  assert.ok(!metrics.includes("tok-secret"));
  r.child.kill("SIGTERM");
  assert.equal((await r.exit).code, 0);
  const debug = r
    .stdout()
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .find((l) => l.msg === "check result");
  assert.ok(debug);
  assert.equal(debug.level, "debug");
  assert.equal(debug.check, "home");
  assert.match(String(debug.time), /^\d{4}-\d\d-\d\dT/);
  assert.ok(!r.stdout().includes("secret=abc"));
});
