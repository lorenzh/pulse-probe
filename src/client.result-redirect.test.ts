// result post: every redirect is retried and its target gets no request.
import { afterAll, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Result, WIRE_VERSION, WIRE_VERSION_HEADER } from "@lorenzh/pulse-contract";
import { createResultBuffer } from "./buffer.ts";
import { postResult } from "./client.ts";

const dir = mkdtempSync(join(tmpdir(), "probe-result-redirect-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const token = `tok-${crypto.randomUUID()}`;
const wire = { [WIRE_VERSION_HEADER]: String(WIRE_VERSION) };

const result = (checkId: string): Result => ({
  checkId,
  timestamp: 5,
  status: "down",
  statusCode: 503,
  latencyMs: 3,
  reason: "HTTP 503",
  location: "default",
  attempts: 1,
});

type Server = http.Server | https.Server;

function listen<S extends Server>(server: S, scheme: string): Promise<{ server: S; url: string }> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `${scheme}://127.0.0.1:${(server.address() as AddressInfo).port}` });
    });
  });
}
const listenHttp = (handler: http.RequestListener): Promise<{ server: http.Server; url: string }> =>
  listen(http.createServer(handler), "http");
const close = (s: Server): Promise<void> =>
  new Promise((r) => {
    s.closeAllConnections();
    s.close(() => r());
  });

async function target(): Promise<{ server: http.Server; url: string; hits: () => number }> {
  let count = 0;
  const t = await listenHttp((_q, res) => {
    count++;
    res.statusCode = 204;
    res.end();
  });
  return { ...t, hits: () => count };
}

function redirectTo(status: number, location: string | undefined): http.RequestListener {
  return (_q, res) => {
    res.writeHead(status, { ...wire, ...(location === undefined ? {} : { location }) });
    res.end();
  };
}

async function post(url: string, logs: string[], f: typeof fetch = fetch): Promise<string> {
  return postResult(url, result("a"), { fetch: f, log: (m) => logs.push(m), token });
}

test("result post refuses a same-origin redirect", async () => {
  const paths: string[] = [];
  const api = await listenHttp((q, res) => {
    paths.push(q.url ?? "");
    if (q.url === "/results") return redirectTo(307, "/elsewhere")(q, res);
    res.statusCode = 204;
    res.end();
  });
  try {
    const logs: string[] = [];
    assert.equal(await post(api.url, logs), "retry");
    assert.deepEqual(paths, ["/results"]);
    assert.deepEqual(logs, []);
  } finally {
    await close(api.server);
  }
});

for (const status of [301, 302, 303, 307, 308]) {
  test(`result post refuses a cross-origin redirect (${status})`, async () => {
    const t = await target();
    const api = await listenHttp(redirectTo(status, `${t.url}/results`));
    try {
      const logs: string[] = [];
      assert.equal(await post(api.url, logs), "retry");
      assert.equal(t.hits(), 0);
      assert.deepEqual(logs, []);
    } finally {
      await close(api.server);
      await close(t.server);
    }
  });
}

test("result post refuses an https-to-http redirect", async () => {
  const key = join(dir, "api.key");
  const cert = join(dir, "api.crt");
  const made = Bun.spawnSync(
    [
      "openssl",
      ...["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"],
      ...["-keyout", key, "-out", cert, "-subj", "/CN=127.0.0.1", "-days", "1"],
      ...["-addext", "subjectAltName=IP:127.0.0.1"],
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  assert.equal(made.exitCode, 0);
  const ca = readFileSync(cert, "utf8");
  const t = await target();
  const api = await listen(
    https.createServer(
      { key: readFileSync(key, "utf8"), cert: ca },
      redirectTo(302, `${t.url}/results`),
    ),
    "https",
  );
  const trusting = ((input: string | URL | Request, init?: RequestInit) =>
    fetch(input, { ...init, tls: { ca } })) as typeof fetch;
  try {
    const logs: string[] = [];
    assert.equal(await post(api.url, logs, trusting), "retry");
    assert.equal(t.hits(), 0);
    assert.deepEqual(logs, []);
  } finally {
    await close(api.server);
    await close(t.server);
  }
});

test("result post retries a 3xx without a location", async () => {
  for (const status of [300, 302]) {
    const api = await listenHttp(redirectTo(status, undefined));
    try {
      const logs: string[] = [];
      assert.equal(await post(api.url, logs), "retry", `HTTP ${status}`);
      assert.deepEqual(logs, []);
    } finally {
      await close(api.server);
    }
  }
});

test("a wire mismatch on a redirect logs once", async () => {
  let hits = 0;
  const api = await listenHttp((q, res) => {
    if (q.url !== "/results") hits++;
    res.writeHead(q.url === "/results" ? 307 : 204, {
      [WIRE_VERSION_HEADER]: "999",
      location: "/elsewhere",
    });
    res.end();
  });
  try {
    const logs: string[] = [];
    const outcome = await post(api.url, logs);
    assert.equal(logs.length, 1);
    assert.match(logs[0] ?? "", /^API answered POST \/results with a contract version mismatch: /);
    assert.equal(outcome, "retry");
    assert.equal(hits, 0);
  } finally {
    await close(api.server);
  }
});

test("a redirected result stays buffered and is delivered after a direct 204", async () => {
  const t = await target();
  let posts = 0;
  const delivered: string[] = [];
  const api = await listenHttp((q, res) => {
    let body = "";
    q.on("data", (d: Buffer) => (body += d.toString()));
    q.on("end", () => {
      posts++;
      if (posts <= 2) return redirectTo(307, `${t.url}/results`)(q, res);
      delivered.push((JSON.parse(body) as Result).checkId);
      res.writeHead(204, wire);
      res.end();
    });
  });
  const sleeps: number[] = [];
  let release = (): void => {};
  const gate = new Promise<void>((r) => (release = r));
  const drops: string[] = [];
  const logs: string[] = [];
  const buffer = createResultBuffer({
    post: (r) => postResult(api.url, r, { fetch, log: (m) => logs.push(m), token }),
    now: () => 10,
    sleep: (ms) => {
      sleeps.push(ms);
      return gate;
    },
    signal: new AbortController().signal,
    log: (m) => logs.push(m),
    maxResults: 10,
    maxAgeMs: 60_000,
    onPost: () => {},
    onDrop: (reason) => drops.push(reason),
    onDeliveredLate: () => {},
    onSize: () => {},
  });
  try {
    await buffer.submit(result("first"));
    await buffer.submit(result("second"));
    release();
    await buffer.idle();
    assert.deepEqual(delivered, ["first", "second"]);
    assert.equal(sleeps[0], 1000);
    assert.deepEqual(drops, []);
    assert.equal(t.hits(), 0);
    assert.equal(buffer.close(), 0);
    assert.ok(logs.includes("buffer empty again: 2 delivered, 0 dropped"), logs.join("\n"));
    assert.ok(!logs.some((l) => l.includes(token)));
  } finally {
    await close(api.server);
    await close(t.server);
  }
});
