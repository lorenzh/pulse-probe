import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { runCheck } from "./check.ts";

function listen(handler: http.RequestListener): Promise<{ server: http.Server; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    });
  });
}
const close = (s: http.Server): Promise<void> =>
  new Promise((r) => {
    s.closeAllConnections();
    s.close(() => r());
  });

let t = 1000;
const now = (): number => (t += 7);
const deps = { fetch, now };

test("up on 200", async () => {
  const { server, url } = await listen((_q, res) => res.end("ok"));
  try {
    const r = await runCheck({ id: "a", name: "A", url, intervalMs: 1000 }, deps);
    assert.equal(r.status, "up");
    assert.equal(r.statusCode, 200);
    assert.equal(r.reason, null);
    assert.equal(r.checkId, "a");
    assert.equal(r.latencyMs, 7);
    assert.equal(typeof r.timestamp, "number");
  } finally {
    await close(server);
  }
});

test("down on 500 with reason", async () => {
  const { server, url } = await listen((_q, res) => {
    res.statusCode = 500;
    res.end();
  });
  try {
    const r = await runCheck({ id: "a", name: "A", url, intervalMs: 1000 }, deps);
    assert.equal(r.status, "down");
    assert.equal(r.statusCode, 500);
    assert.equal(r.reason, "HTTP 500");
  } finally {
    await close(server);
  }
});

test("down on timeout", async () => {
  const { server, url } = await listen(() => {});
  try {
    const r = await runCheck({ id: "a", name: "A", url, intervalMs: 1000, timeoutMs: 50 }, deps);
    assert.equal(r.status, "down");
    assert.equal(r.statusCode, null);
    assert.equal(r.reason, "timeout after 50ms");
  } finally {
    await close(server);
  }
});

test("down on connection refused", async () => {
  const { server, url } = await listen((_q, res) => res.end());
  await close(server);
  const r = await runCheck({ id: "a", name: "A", url, intervalMs: 1000 }, deps);
  assert.equal(r.status, "down");
  assert.equal(r.statusCode, null);
  assert.equal(r.reason, "ECONNREFUSED");
});

test("redirect is followed to 200", async () => {
  const { server, url } = await listen((q, res) => {
    if (q.url === "/final") return void res.end("ok");
    res.statusCode = 302;
    res.setHeader("location", "/final");
    res.end();
  });
  try {
    const r = await runCheck({ id: "a", name: "A", url, intervalMs: 1000 }, deps);
    assert.equal(r.status, "up");
    assert.equal(r.statusCode, 200);
  } finally {
    await close(server);
  }
});
