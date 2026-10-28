import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Result } from "@lorenzh/pulse-contract";
import { fetchChecks, postResult } from "./client.ts";

const result: Result = {
  checkId: "a",
  timestamp: 5,
  status: "down",
  statusCode: 503,
  latencyMs: 3,
  reason: "HTTP 503",
  location: "default",
};

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

test("postResult sends Result JSON", async () => {
  let seen: { method?: string; url?: string; type?: string; body?: string } = {};
  const { server, url } = await listen((q, res) => {
    let body = "";
    q.on("data", (d) => (body += d));
    q.on("end", () => {
      seen = { method: q.method, url: q.url, type: q.headers["content-type"], body };
      res.statusCode = 204;
      res.end();
    });
  });
  try {
    const ok = await postResult(url + "/", result, { fetch, log: () => {} });
    assert.equal(ok, true);
    assert.equal(seen.method, "POST");
    assert.equal(seen.url, "/results");
    assert.equal(seen.type, "application/json");
    assert.deepEqual(JSON.parse(seen.body!), result);
  } finally {
    await close(server);
  }
});

test("postResult survives an unreachable API", async () => {
  const { server, url } = await listen(() => {});
  await close(server);
  const logs: string[] = [];
  const ok = await postResult(url, result, { fetch, log: (m) => logs.push(m) });
  assert.equal(ok, false);
  assert.equal(logs.length, 1);
});

test("postResult drops on non-204", async () => {
  const { server, url } = await listen((_q, res) => {
    res.statusCode = 400;
    res.end("{}");
  });
  try {
    const logs: string[] = [];
    assert.equal(await postResult(url, result, { fetch, log: (m) => logs.push(m) }), false);
    assert.equal(logs.length, 1);
  } finally {
    await close(server);
  }
});

test("fetchChecks retries until the API answers", async () => {
  let hits = 0;
  const { server, url } = await listen((_q, res) => {
    hits++;
    if (hits < 3) {
      res.statusCode = 503;
      return void res.end();
    }
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify([
        {
          id: "a",
          name: "A",
          url: "http://x",
          intervalMs: 1000,
          timeoutMs: 500,
          state: "up",
          consecutiveDown: 0,
          lastResultAt: null,
          lastReason: null,
        },
        {
          id: "b",
          name: "B",
          url: "http://y",
          intervalMs: 2000,
          state: "unknown",
          consecutiveDown: 0,
          lastResultAt: null,
          lastReason: null,
        },
      ]),
    );
  });
  try {
    const sleeps: number[] = [];
    const logs: string[] = [];
    const checks = await fetchChecks(
      url,
      {
        fetch,
        sleep: async (ms) => void sleeps.push(ms),
        log: (m) => logs.push(m),
      },
      42,
    );
    assert.equal(hits, 3);
    assert.deepEqual(sleeps, [42, 42]);
    assert.equal(logs.length, 2);
    assert.deepEqual(checks, [
      { id: "a", name: "A", url: "http://x", intervalMs: 1000, timeoutMs: 500 },
      { id: "b", name: "B", url: "http://y", intervalMs: 2000 },
    ]);
  } finally {
    await close(server);
  }
});
