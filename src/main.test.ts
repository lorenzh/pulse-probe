import { afterAll as after, test } from "bun:test";
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAIN = new URL("./main.ts", import.meta.url).pathname;

const SENTINEL = "tok-sentinel-481";
const dir = mkdtempSync(join(tmpdir(), "probe-main-"));

const servers: http.Server[] = [];
after(async () => {
  rmSync(dir, { recursive: true, force: true });
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

function tokenFile(name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

async function startupLine(env: Record<string, string>): Promise<string> {
  const r = run(env);
  assert.equal((await r.exit).code, 2);
  assert.ok(!r.stdout().includes(SENTINEL));
  assert.ok(!r.stderr().includes(SENTINEL));
  const lines = r.stderr().trimEnd().split("\n");
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /^pulse-probe: /);
  return lines[0] ?? "";
}

test("PULSE_PROBE_TOKEN_FILE alone: the API gets the trimmed file content as the token", async () => {
  const auth: string[] = [];
  const api = await fakeApi((req, res) => {
    if (req.url === "/probe/checks") auth.push(req.headers.authorization ?? "");
    res.setHeader("content-type", "application/json");
    res.end("[]");
  });
  const r = run({
    PULSE_PROBE_TOKEN_FILE: tokenFile("token-ok", `  ${SENTINEL}\n`),
    PULSE_API_URL: api,
  });
  await until(() => auth.length > 0);
  assert.equal(auth[0], `Bearer ${SENTINEL}`);
  r.child.kill("SIGTERM");
  assert.equal((await r.exit).code, 0);
  assert.ok(!r.stdout().includes(SENTINEL));
  assert.ok(!r.stderr().includes(SENTINEL));
});

test("both token variables exit 2 with one line naming both", async () => {
  const line = await startupLine({
    PULSE_PROBE_TOKEN: SENTINEL,
    PULSE_PROBE_TOKEN_FILE: tokenFile("token-both", SENTINEL),
  });
  assert.equal(line, "pulse-probe: set only one of PULSE_PROBE_TOKEN and PULSE_PROBE_TOKEN_FILE");
});

test("no token variable exits 2 with one line naming both", async () => {
  const line = await startupLine({ PULSE_PROBE_TOKEN: "  ", PULSE_PROBE_TOKEN_FILE: "" });
  assert.equal(line, "pulse-probe: PULSE_PROBE_TOKEN or PULSE_PROBE_TOKEN_FILE must be set");
});

test("an empty token file exits 2 with one line naming the path", async () => {
  const path = tokenFile("token-empty", " \n\t\n");
  assert.equal(
    await startupLine({ PULSE_PROBE_TOKEN_FILE: path }),
    `pulse-probe: PULSE_PROBE_TOKEN_FILE=${path}: file is empty`,
  );
});

test("a multi-line token file exits 2 without printing the content", async () => {
  const path = tokenFile("token-lines", `${SENTINEL}\n${SENTINEL}`);
  assert.equal(
    await startupLine({ PULSE_PROBE_TOKEN_FILE: path }),
    `pulse-probe: PULSE_PROBE_TOKEN_FILE=${path}: must hold one line`,
  );
});

test("a missing token file exits 2 with the path and ENOENT", async () => {
  const path = join(dir, "no-such-file");
  assert.equal(
    await startupLine({ PULSE_PROBE_TOKEN_FILE: path }),
    `pulse-probe: PULSE_PROBE_TOKEN_FILE=${path}: cannot read (ENOENT)`,
  );
});

test("a directory as token file exits 2 with the path and EISDIR", async () => {
  assert.equal(
    await startupLine({ PULSE_PROBE_TOKEN_FILE: dir }),
    `pulse-probe: PULSE_PROBE_TOKEN_FILE=${dir}: cannot read (EISDIR)`,
  );
});
