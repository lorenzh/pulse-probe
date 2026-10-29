import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Result } from "@lorenzh/pulse-contract";
import { runCheck } from "./check.ts";
import { fetchChecks, loadChecks, postResult } from "./client.ts";

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
  let seen: {
    method?: string | undefined;
    url?: string | undefined;
    type?: string | undefined;
    auth?: string | undefined;
    body?: string | undefined;
  } = {};
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
    assert.equal(ok, "accepted");
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
  assert.equal(ok, "dropped");
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
      "dropped",
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
      res.end();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.setHeader("x-pulse-contract", "1");
    res.end(
      JSON.stringify([
        {
          id: "a",
          name: "A",
          // eslint-disable-next-line sonarjs/no-clear-text-protocols -- fake URL for a stubbed fetch, no network
          url: "http://x",
          intervalMs: 60_000,
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
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        log: (m) => logs.push(m),
      },
      42,
    );
    assert.equal(hits, 3);
    assert.deepEqual(sleeps, [42, 42]);
    assert.equal(logs.length, 2);
    assert.deepEqual(checks, [
      // eslint-disable-next-line sonarjs/no-clear-text-protocols -- fake URL for a stubbed fetch, no network
      { id: "a", name: "A", url: "http://x", intervalMs: 60_000, timeoutMs: 500 },
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
      intervalMs: 60_000,
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
      intervalMs: 60_000,
    },
    // eslint-disable-next-line sonarjs/no-clear-text-protocols -- fake URL for a stubbed fetch, no network
    { id: "h", name: "H", url: "http://x", intervalMs: 5 },
  ]);
});

test("fetchChecks skips invalid checks, logs their id and keeps the others", async () => {
  const logs: string[] = [];
  const fakeFetch = (async () =>
    Response.json(
      [
        { id: "t", name: "T", type: "tls", intervalMs: 1 },
        // eslint-disable-next-line sonarjs/no-clear-text-protocols -- fake URL for a stubbed fetch, no network
        { id: "h", name: "H", url: "http://x", intervalMs: 5 },
        // eslint-disable-next-line sonarjs/no-clear-text-protocols -- fake URL for a stubbed fetch, no network
        { id: "noint", name: "N", url: "http://x" },
        // eslint-disable-next-line sonarjs/no-clear-text-protocols -- fake URL for a stubbed fetch, no network
        { id: "nan", name: "N", url: "http://x", intervalMs: "5" },
        { id: "nourl", name: "N", intervalMs: 5 },
        // eslint-disable-next-line sonarjs/no-clear-text-protocols -- fake URL for a stubbed fetch, no network
        { name: "noid", url: "http://x", intervalMs: 5 },
      ],
      { headers: { "x-pulse-contract": "1" } },
    )) as unknown as typeof fetch;
  // eslint-disable-next-line sonarjs/no-clear-text-protocols -- fake URL for a stubbed fetch, no network
  const checks = await fetchChecks("http://api", {
    fetch: fakeFetch,
    sleep: async () => {},
    log: (m) => logs.push(m),
  });
  assert.deepEqual(
    checks.map((c) => c.id),
    ["h"],
  );
  assert.equal(logs.length, 5);
  assert.match(logs[0] ?? "", /checks\[0\]/);
  assert.match(logs[1] ?? "", /checks\[2\]\.intervalMs/);
  assert.match(logs[4] ?? "", /checks\[5\]\.id/);
});

test("loadChecks skips an empty url or host and names the check id", async () => {
  const logs: string[] = [];
  const fakeFetch = (async () =>
    Response.json(
      [
        // eslint-disable-next-line sonarjs/no-clear-text-protocols -- fake URL for a stubbed fetch, no network
        { id: "ok", name: "O", url: "http://x", intervalMs: 5 },
        { id: "emptyurl", name: "U", url: "", intervalMs: 5 },
        {
          id: "emptyhost",
          name: "H",
          type: "tls",
          host: "",
          port: 443,
          warnDays: 7,
          intervalMs: 5,
        },
      ],
      { headers: { "x-pulse-contract": "1" } },
    )) as unknown as typeof fetch;
  // eslint-disable-next-line sonarjs/no-clear-text-protocols -- fake URL for a stubbed fetch, no network
  const checks = await loadChecks("http://api", { fetch: fakeFetch, log: (m) => logs.push(m) });
  assert.deepEqual(
    checks.map((c) => c.id),
    ["ok"],
  );
  assert.equal(logs.length, 2);
  assert.match(
    logs[0] ?? "",
    /skipping invalid check emptyurl: checks\[1\]\.url: must be a non-empty string/,
  );
  assert.match(
    logs[1] ?? "",
    /skipping invalid check emptyhost: checks\[2\]\.host: must be a non-empty string/,
  );
});

test("fetchChecks times out on stalled headers and retries", async () => {
  const controllers: AbortController[] = [];
  let calls = 0;
  const fakeFetch = ((_u: unknown, init?: RequestInit) => {
    calls++;
    if (calls === 1) return new Promise(() => {});
    assert.ok(init?.signal);
    return Promise.resolve(Response.json([]));
  }) as unknown as typeof fetch;
  const logs: string[] = [];
  const sleeps: number[] = [];
  // eslint-disable-next-line sonarjs/no-clear-text-protocols -- fake URL for a stubbed fetch, no network
  const p = fetchChecks("http://api", {
    fetch: fakeFetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    log: (m) => logs.push(m),
    timeoutSignal: () => {
      const c = new AbortController();
      controllers.push(c);
      if (controllers.length === 1) queueMicrotask(() => c.abort());
      return c.signal;
    },
  });
  assert.deepEqual(await p, []);
  assert.equal(calls, 2);
  assert.match(logs[0] ?? "", /timed out/);
  assert.equal(sleeps.length, 1);
});

test("loadChecks times out on a stalled body", async () => {
  const stalled = new ReadableStream<Uint8Array>({ start() {} });
  const fakeFetch = (async () => new Response(stalled, { status: 200 })) as unknown as typeof fetch;
  const c = new AbortController();
  // eslint-disable-next-line sonarjs/no-clear-text-protocols -- fake URL for a stubbed fetch, no network
  const p = loadChecks("http://api", {
    fetch: fakeFetch,
    log: () => {},
    timeoutSignal: () => c.signal,
  });
  setImmediate(() => c.abort());
  await assert.rejects(p, /timed out/);
});

test("postResult reports an unknown check on 404", async () => {
  const { server, url } = await listen((_q, res) => {
    res.statusCode = 404;
    res.end("{}");
  });
  try {
    const outcome = await postResult(url, result, { fetch, log: () => {}, token: "t" });
    assert.equal(outcome, "unknown-check");
  } finally {
    await close(server);
  }
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
      assert.equal(ok, "dropped");
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

test("fetchChecks keeps the keyword so runCheck marks a body without it down", async () => {
  const fakeFetch: typeof fetch = async (input) => {
    if (String(input).endsWith("/checks")) {
      return Response.json([
        {
          id: "a",
          name: "A",
          url: "http://site.test/",
          intervalMs: 60_000,
          keyword: "Welcome",
          retries: 1,
        },
      ]);
    }
    return new Response("maintenance", { status: 200 });
  };
  const checks = await fetchChecks("http://api.test", {
    fetch: fakeFetch,
    sleep: async () => {},
    log: () => {},
  });
  const [check] = checks;
  assert.ok(check);
  const r = await runCheck(check, {
    fetch: fakeFetch,
    now: () => 0,
    monotonic: () => 0,
    sleep: async () => {},
    location: "default",
  });
  assert.equal(r.status, "down");
  assert.equal(r.statusCode, 200);
  assert.equal(r.reason, 'keyword "Welcome" not found');
  assert.equal(r.attempts, 2);
});

const versionHeader = "x-pulse-contract";
const okBody = [{ id: "h", name: "H", url: "https://x", intervalMs: 5 }];

test("fetchChecks accepts a matching contract version without logging", async () => {
  const logs: string[] = [];
  const fakeFetch = (async () =>
    Response.json(okBody, { headers: { [versionHeader]: "1" } })) as unknown as typeof fetch;
  const checks = await fetchChecks("https://api", {
    fetch: fakeFetch,
    sleep: async () => {},
    log: (m) => logs.push(m),
  });
  assert.equal(checks.length, 1);
  assert.deepEqual(logs, []);
});

test("loadChecks logs an absent version header once per logger and continues", async () => {
  const logs: string[] = [];
  const log = (m: string): void => {
    logs.push(m);
  };
  const fakeFetch = (async () => Response.json(okBody)) as unknown as typeof fetch;
  assert.equal((await loadChecks("https://api", { fetch: fakeFetch, log })).length, 1);
  assert.equal((await loadChecks("https://api", { fetch: fakeFetch, log })).length, 1);
  assert.equal(logs.length, 1);
  assert.match(logs[0] ?? "", /x-pulse-contract/);
});

test("fetchChecks treats a contract version mismatch as a failed fetch and retries", async () => {
  let calls = 0;
  const fakeFetch = (async () => {
    calls++;
    return Response.json(okBody, { headers: { [versionHeader]: calls === 1 ? "2" : "1" } });
  }) as unknown as typeof fetch;
  const logs: string[] = [];
  const sleeps: number[] = [];
  const checks = await fetchChecks(
    "https://api",
    {
      fetch: fakeFetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      log: (m) => logs.push(m),
    },
    7,
  );
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [7]);
  assert.equal(checks.length, 1);
  assert.match(logs[0] ?? "", /version mismatch/);
});

test("postResult logs a contract version mismatch and keeps the outcome", async () => {
  const logs: string[] = [];
  const fakeFetch = (async () =>
    new Response(null, {
      status: 204,
      headers: { [versionHeader]: "9" },
    })) as unknown as typeof fetch;
  const outcome = await postResult("https://api", result, {
    fetch: fakeFetch,
    log: (m) => logs.push(m),
    token: "t",
  });
  assert.equal(outcome, "accepted");
  assert.equal(logs.length, 1);
  assert.match(logs[0] ?? "", /version mismatch/);
});
