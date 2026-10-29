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
  attempts: 1,
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
  let seen: { method?: string; url?: string; type?: string; auth?: string; body?: string } = {};
  const { server, url } = await listen((q, res) => {
    let body = "";
    q.on("data", (d) => (body += d));
    q.on("end", () => {
      seen = {
        method: q.method,
        url: q.url,
        type: q.headers["content-type"],
        auth: q.headers.authorization,
        body,
      };
      res.statusCode = 204;
      res.end();
    });
  });
  try {
    const ok = await postResult(url + "/", result, { fetch, log: () => {}, token: "tok-secret" });
    assert.equal(ok, true);
    assert.equal(seen.method, "POST");
    assert.equal(seen.url, "/results");
    assert.equal(seen.type, "application/json");
    assert.equal(seen.auth, "Bearer tok-secret");
    assert.deepEqual(JSON.parse(seen.body!), result);
  } finally {
    await close(server);
  }
});

test("postResult survives an unreachable API", async () => {
  const { server, url } = await listen(() => {});
  await close(server);
  const logs: string[] = [];
  const ok = await postResult(url, result, {
    fetch,
    log: (m) => logs.push(m),
    token: "tok-secret",
  });
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
    assert.equal(
      await postResult(url, result, { fetch, log: (m) => logs.push(m), token: "tok-secret" }),
      false,
    );
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
          // eslint-disable-next-line sonarjs/no-clear-text-protocols -- fake URL for a stubbed fetch, no network
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
          // eslint-disable-next-line sonarjs/no-clear-text-protocols -- fake URL for a stubbed fetch, no network
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
      // eslint-disable-next-line sonarjs/no-clear-text-protocols -- fake URL for a stubbed fetch, no network
      { id: "a", name: "A", url: "http://x", intervalMs: 1000, timeoutMs: 500 },
      // eslint-disable-next-line sonarjs/no-clear-text-protocols -- fake URL for a stubbed fetch, no network
      { id: "b", name: "B", url: "http://y", intervalMs: 2000 },
    ]);
  } finally {
    await close(server);
  }
});

test("fetchChecks passes tls checks through and rebuilds http checks", async () => {
  const body = [
    {
      id: "t",
      name: "T",
      type: "tls",
      host: "example.com",
      port: 443,
      warnDays: 14,
      intervalMs: 1000,
      state: "up",
      certDaysLeft: 40,
    },
    // eslint-disable-next-line sonarjs/no-clear-text-protocols -- fake URL for a stubbed fetch, no network
    { id: "h", name: "H", url: "http://x", intervalMs: 5, state: "up" },
  ];
  const fakeFetch = (async () => Response.json(body)) as unknown as typeof fetch;
  // eslint-disable-next-line sonarjs/no-clear-text-protocols -- fake URL for a stubbed fetch, no network
  const checks = await fetchChecks("http://api", {
    fetch: fakeFetch,
    sleep: async () => {},
    log: () => {},
  });
  assert.deepEqual(checks, [
    {
      id: "t",
      name: "T",
      type: "tls",
      host: "example.com",
      port: 443,
      warnDays: 14,
      intervalMs: 1000,
    },
    // eslint-disable-next-line sonarjs/no-clear-text-protocols -- fake URL for a stubbed fetch, no network
    { id: "h", name: "H", url: "http://x", intervalMs: 5 },
  ]);
});

test("fetchChecks retries on an invalid tls check", async () => {
  let calls = 0;
  const logs: string[] = [];
  const fakeFetch = (async () => {
    calls++;
    return Response.json(
      calls === 1
        ? [{ id: "t", name: "T", type: "tls", intervalMs: 1 }]
        : // eslint-disable-next-line sonarjs/no-clear-text-protocols -- fake URL for a stubbed fetch, no network
          [{ id: "h", name: "H", url: "http://x", intervalMs: 5 }],
    );
  }) as unknown as typeof fetch;
  // eslint-disable-next-line sonarjs/no-clear-text-protocols -- fake URL for a stubbed fetch, no network
  const checks = await fetchChecks("http://api", {
    fetch: fakeFetch,
    sleep: async () => {},
    log: (m) => logs.push(m),
  });
  assert.equal(checks.length, 1);
  assert.equal(calls, 2);
  assert.match(logs[0] ?? "", /invalid tls check t/);
});

test("fetchChecks forwards retries and retryDelayMs", async () => {
  const body = [
    // eslint-disable-next-line sonarjs/no-clear-text-protocols -- fake URL for a stubbed fetch, no network
    { id: "h", name: "H", url: "http://x", intervalMs: 5000, retries: 2, retryDelayMs: 300 },
  ];
  const fakeFetch = (async () => Response.json(body)) as unknown as typeof fetch;
  // eslint-disable-next-line sonarjs/no-clear-text-protocols -- fake URL for a stubbed fetch, no network
  const checks = await fetchChecks("http://api", {
    fetch: fakeFetch,
    sleep: async () => {},
    log: () => {},
  });
  assert.deepEqual(checks, body);
});

test("fetchChecks forwards latencyObjectiveMs", async () => {
  // eslint-disable-next-line sonarjs/no-clear-text-protocols -- fake URL for a stubbed fetch, no network
  const body = [{ id: "h", name: "H", url: "http://x", intervalMs: 5000, latencyObjectiveMs: 500 }];
  const fakeFetch = (async () => Response.json(body)) as unknown as typeof fetch;
  // eslint-disable-next-line sonarjs/no-clear-text-protocols -- fake URL for a stubbed fetch, no network
  const checks = await fetchChecks("http://api", {
    fetch: fakeFetch,
    sleep: async () => {},
    log: () => {},
  });
  assert.deepEqual(checks, body);
});

for (const status of [401, 403]) {
  test(`postResult logs a distinct message on HTTP ${status} without the token`, async () => {
    const { server, url } = await listen((_q, res) => {
      res.statusCode = status;
      res.end("{}");
    });
    try {
      const logs: string[] = [];
      const ok = await postResult(url, result, {
        fetch,
        log: (m) => logs.push(m),
        token: "tok-secret",
      });
      assert.equal(ok, false);
      assert.equal(logs.length, 1);
      assert.match(logs[0] ?? "", /token rejected, check PULSE_PROBE_TOKEN and PULSE_LOCATION/);
      assert.doesNotMatch(logs[0] ?? "", /tok-secret/);
    } finally {
      await close(server);
    }
  });
}

test("fetchChecks sends no Authorization header", async () => {
  let auth: string | undefined = "unset";
  const { server, url } = await listen((q, res) => {
    auth = q.headers.authorization;
    res.setHeader("content-type", "application/json");
    res.end("[]");
  });
  try {
    await fetchChecks(url, { fetch, sleep: async () => {}, log: () => {} });
    assert.equal(auth, undefined);
  } finally {
    await close(server);
  }
});
