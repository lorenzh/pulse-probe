import { test } from "bun:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Result } from "@lorenzh/pulse-contract";
import { runCheck } from "./check.ts";
import {
  type ClientDeps,
  fetchChecks,
  loadChecks,
  postResult,
  StartupAbortedError,
  skipLogger,
} from "./client.ts";
import { parseHeaderHosts } from "./header-hosts.ts";

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

test("postResult asks for a retry when the API is unreachable", async () => {
  const { server, url } = await listen(() => {});
  await close(server);
  const logs: string[] = [];
  const ok = await postResult(url, result, {
    fetch,
    log: (m) => logs.push(m),
    token: "tok-secret",
  });
  assert.equal(ok, "retry");
  assert.equal(logs.length, 0);
});

test("postResult rejects a 400", async () => {
  const { server, url } = await listen((_q, res) => {
    res.statusCode = 400;
    res.end("{}");
  });
  try {
    const logs: string[] = [];
    assert.equal(
      await postResult(url, result, { fetch, log: (m) => logs.push(m), token: "tok-secret" }),
      "rejected",
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
  const fakeFetch = (async () => Response.json(body)) as unknown as unknown as typeof fetch;
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
    )) as unknown as unknown as typeof fetch;
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

test("loadChecks drops heartbeat checks without a request or a log line", async () => {
  const logs: string[] = [];
  const urls: string[] = [];
  const fakeFetch = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return Response.json(
      [
        // eslint-disable-next-line sonarjs/no-clear-text-protocols -- fake URL for a stubbed fetch, no network
        { id: "h", name: "H", url: "http://x", intervalMs: 5 },
        { id: "t", name: "T", type: "tls", host: "x", port: 443, warnDays: 7, intervalMs: 5 },
        { id: "nightly", name: "Nightly", type: "heartbeat", period: 60000, grace: 0 },
      ],
      { headers: { "x-pulse-contract": "1" } },
    );
  }) as unknown as unknown as typeof fetch;
  // eslint-disable-next-line sonarjs/no-clear-text-protocols -- fake URL for a stubbed fetch, no network
  const checks = await loadChecks("http://api", { fetch: fakeFetch, log: (m) => logs.push(m) });
  assert.deepEqual(
    checks.map((c) => c.id),
    ["h", "t"],
  );
  // eslint-disable-next-line sonarjs/no-clear-text-protocols -- fake URL for a stubbed fetch, no network
  assert.deepEqual(urls, ["http://api/checks"]);
  assert.deepEqual(logs, []);
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
    )) as unknown as unknown as typeof fetch;
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

test("loadChecks skips a check with a non-http url and logs its path", async () => {
  const logs: string[] = [];
  const fakeFetch = (async () =>
    Response.json(
      [
        // eslint-disable-next-line sonarjs/no-clear-text-protocols -- fake URL for a stubbed fetch, no network
        { id: "ok", name: "O", url: "http://x", intervalMs: 5 },
        { id: "f", name: "F", url: "file:///etc/passwd", intervalMs: 5 },
      ],
      { headers: { "x-pulse-contract": "1" } },
    )) as unknown as typeof fetch;
  // eslint-disable-next-line sonarjs/no-clear-text-protocols -- fake URL for a stubbed fetch, no network
  const checks = await loadChecks("http://api", { fetch: fakeFetch, log: (m) => logs.push(m) });
  assert.deepEqual(
    checks.map((c) => c.id),
    ["ok"],
  );
  assert.deepEqual(logs, [
    "skipping invalid check f: checks[1].url: must be an http: or https: URL",
  ]);
});

test("fetchChecks times out on stalled headers and retries", async () => {
  let calls = 0;
  const fakeFetch = (() => {
    calls++;
    if (calls === 1) return new Promise(() => {});
    return Promise.resolve(Response.json([]));
  }) as unknown as unknown as typeof fetch;
  const logs: string[] = [];
  const sleeps: number[] = [];
  let firstTimer = true;
  // eslint-disable-next-line sonarjs/no-clear-text-protocols -- fake URL for a stubbed fetch, no network
  const p = fetchChecks("http://api", {
    fetch: fakeFetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    log: (m) => logs.push(m),
    schedule: (fn) => {
      if (firstTimer) queueMicrotask(fn);
      firstTimer = false;
      return () => {};
    },
  });
  assert.deepEqual(await p, []);
  assert.equal(calls, 2);
  assert.match(logs[0] ?? "", /timed out/);
  assert.equal(sleeps.length, 1);
});

test("loadChecks times out on a stalled body", async () => {
  const stalled = new ReadableStream<Uint8Array>({ start() {} });
  const fakeFetch = (async () =>
    new Response(stalled, { status: 200 })) as unknown as unknown as typeof fetch;
  // eslint-disable-next-line sonarjs/no-clear-text-protocols -- fake URL for a stubbed fetch, no network
  const p = loadChecks("http://api", {
    fetch: fakeFetch,
    log: () => {},
    schedule: (fn) => {
      setImmediate(fn);
      return () => {};
    },
  });
  await assert.rejects(p, /timed out after 10000ms/);
});

test("loadChecks rejects a body above the size cap", async () => {
  const big = `["${"x".repeat(5 * 1024 * 1024)}"]`;
  const fakeFetch = (async () =>
    new Response(big, { status: 200 })) as unknown as unknown as typeof fetch;
  const p = loadChecks(
    // eslint-disable-next-line sonarjs/no-clear-text-protocols -- fake URL for a stubbed fetch, no network
    "http://api",
    { fetch: fakeFetch, log: () => {} },
  );
  await assert.rejects(p, /larger than/);
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
  const fakeFetch = (async () => Response.json(body)) as unknown as unknown as typeof fetch;
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
  const fakeFetch = (async () => Response.json(body)) as unknown as unknown as typeof fetch;
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
      assert.equal(ok, "rejected");
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
  const fakeFetch: ClientDeps["fetch"] = async (input) => {
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
    Response.json(okBody, {
      headers: { [versionHeader]: "1" },
    })) as unknown as unknown as typeof fetch;
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
  const fakeFetch = (async () => Response.json(okBody)) as unknown as unknown as typeof fetch;
  assert.equal((await loadChecks("https://api", { fetch: fakeFetch, log })).length, 1);
  assert.equal((await loadChecks("https://api", { fetch: fakeFetch, log })).length, 1);
  assert.equal(logs.length, 1);
  assert.match(logs[0] ?? "", /x-pulse-contract/);
});

test("loadChecks logs an absent version header on a 2xx with an invalid body", async () => {
  const logs: string[] = [];
  const fakeFetch = (async () =>
    Response.json({ not: "an array" })) as unknown as unknown as typeof fetch;
  await assert.rejects(loadChecks("https://api", { fetch: fakeFetch, log: (m) => logs.push(m) }));
  assert.equal(logs.length, 1);
  assert.match(logs[0] ?? "", /x-pulse-contract/);
});

test("loadChecks stays quiet about an absent version header on a non-2xx", async () => {
  const logs: string[] = [];
  const fakeFetch = (async () =>
    new Response("no", { status: 500 })) as unknown as unknown as typeof fetch;
  await assert.rejects(loadChecks("https://api", { fetch: fakeFetch, log: (m) => logs.push(m) }));
  assert.deepEqual(logs, []);
});

test("fetchChecks treats a contract version mismatch as a failed fetch and retries", async () => {
  let calls = 0;
  const fakeFetch = (async () => {
    calls++;
    return Response.json(okBody, { headers: { [versionHeader]: calls === 1 ? "2" : "1" } });
  }) as unknown as unknown as typeof fetch;
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
    })) as unknown as unknown as typeof fetch;
  const outcome = await postResult("https://api", result, {
    fetch: fakeFetch,
    log: (m) => logs.push(m),
    token: "t",
  });
  assert.equal(outcome, "accepted");
  assert.equal(logs.length, 1);
  assert.match(logs[0] ?? "", /version mismatch/);
});

test("fetchChecks stops waiting for a retry when the signal aborts", async () => {
  const controller = new AbortController();
  const failingFetch: ClientDeps["fetch"] = async () => {
    throw new Error("down");
  };
  const result = fetchChecks("https://api", {
    fetch: failingFetch,
    sleep: (ms) =>
      new Promise<void>((_resolve, reject) => {
        assert.equal(ms, 10_000);
        controller.signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    log: () => {},
    signal: controller.signal,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(result, StartupAbortedError);
});

test("fetchChecks throws at once when the signal is already aborted", async () => {
  const failingFetch: ClientDeps["fetch"] = async () => {
    throw new Error("must not be called");
  };
  await assert.rejects(
    fetchChecks("https://api", {
      fetch: failingFetch,
      sleep: async () => {},
      log: () => {},
      signal: AbortSignal.abort(),
    }),
    StartupAbortedError,
  );
});

for (const status of [429, 500, 503]) {
  test(`postResult asks for a retry on HTTP ${status} without a log line`, async () => {
    const { server, url } = await listen((_q, res) => {
      res.statusCode = status;
      res.end("{}");
    });
    try {
      const logs: string[] = [];
      const outcome = await postResult(url, result, {
        fetch,
        log: (m) => logs.push(m),
        token: "t",
      });
      assert.equal(outcome, "retry");
      assert.deepEqual(logs, []);
    } finally {
      await close(server);
    }
  });
}

test("postResult rejects a non-204 success", async () => {
  const { server, url } = await listen((_q, res) => {
    res.statusCode = 200;
    res.end("{}");
  });
  try {
    const outcome = await postResult(url, result, { fetch, log: () => {}, token: "t" });
    assert.equal(outcome, "rejected");
  } finally {
    await close(server);
  }
});

test("capped and quoted reasons are posted as they are", async () => {
  const bodies: unknown[] = [];
  const api = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      bodies.push(await req.json());
      return new Response(null, { status: 204 });
    },
  });
  try {
    const redirect = await runCheck(
      { id: "r", name: "R", url: "http://a.test/", intervalMs: 60_000, headers: { "X-Key": "k" } },
      {
        fetch: (async () =>
          new Response(null, {
            status: 302,
            headers: { location: `http://${"a".repeat(2000)}.test/` },
          })) as unknown as typeof fetch,
        now: () => 1,
        monotonic: () => 1,
        sleep: async () => {},
        location: "default",
      },
    );
    const tcp = await runCheck(
      { id: "t", name: "T", type: "tcp", host: "127.0.0.1", port: 1, intervalMs: 60_000 },
      {
        fetch,
        now: () => 1,
        monotonic: () => 1,
        sleep: async () => {},
        location: "default",
        tcpConnect: async () => {
          throw new Error("m".repeat(5000));
        },
      },
    );
    const base = `http://127.0.0.1:${api.port}`;
    for (const r of [redirect, tcp]) {
      assert.equal(await postResult(base, r, { fetch, log: () => {}, token: "tok" }), "accepted");
    }
    assert.deepEqual(
      bodies.map((b) => {
        const { status, statusCode, reason } = b as Record<string, unknown>;
        return { status, statusCode, reason };
      }),
      [
        {
          status: "down",
          statusCode: 302,
          reason: `redirect to http://${"a".repeat(73)}… not followed`,
        },
        { status: "down", statusCode: null, reason: `${"m".repeat(999)}…` },
      ],
    );
  } finally {
    await api.stop(true);
  }
});

const SKIP_SENTINEL = "Bearer skip-sentinel-9f2";
const skipHosts = parseHeaderHosts('{"PULSE_HEADER_SKIP":["svc.test"]}');
const skipOk = { id: "ok", name: "OK", url: "https://svc.test/", intervalMs: 1000 };
const skipBad = { id: "bad", name: "Bad", url: "https://svc.test/", intervalMs: 0 };
const skipNoId = { name: "NoId", url: "https://svc.test/", intervalMs: 1000 };
const skipHdr = {
  id: "hdr",
  name: "Hdr",
  url: "https://svc.test/",
  intervalMs: 1000,
  headers: { Authorization: { env: "PULSE_HEADER_SKIP" } },
};

/** A fake api whose `GET /checks` answers the current `list`. */
function skipApi(list: { value: unknown[] }): typeof fetch {
  return (async () =>
    Response.json(list.value, { headers: { "x-pulse-contract": "1" } })) as unknown as typeof fetch;
}

test("loadChecks logs each skipped check once per logger across reloads", async () => {
  const logs: string[] = [];
  const log = (m: string): void => {
    logs.push(m);
  };
  const env: Record<string, string | undefined> = {};
  const list = { value: [skipBad, skipHdr, skipNoId, skipOk] as unknown[] };
  const deps = { fetch: skipApi(list), log, env, headerHosts: skipHosts };
  for (let i = 0; i < 3; i++) {
    const checks = await loadChecks("https://api", deps);
    assert.deepEqual(
      checks.map((c) => c.id),
      ["ok"],
    );
  }
  assert.deepEqual(logs, [
    "skipping invalid check bad: checks[0].intervalMs: must be an integer 1..2147483647",
    "skipping check hdr: header Authorization env PULSE_HEADER_SKIP is not set",
    "skipping invalid check: checks[2].id: is required",
  ]);

  env.PULSE_HEADER_SKIP = SKIP_SENTINEL;
  const recovered = await loadChecks("https://api", deps);
  assert.deepEqual(
    recovered.map((c) => c.id),
    ["hdr", "ok"],
  );
  delete env.PULSE_HEADER_SKIP;
  assert.deepEqual(
    (await loadChecks("https://api", deps)).map((c) => c.id),
    ["ok"],
  );
  // The same ID through the other skip path, reordered, and a second ID-less record stay quiet.
  list.value = [
    skipOk,
    { ...skipHdr, intervalMs: 0 },
    skipNoId,
    { ...skipNoId, name: "B" },
    skipBad,
  ];
  assert.deepEqual(
    (await loadChecks("https://api", deps)).map((c) => c.id),
    ["ok"],
  );
  assert.equal(logs.length, 3);

  const fresh: string[] = [];
  list.value = [skipBad, skipHdr, skipNoId, skipOk];
  await loadChecks("https://api", { ...deps, log: (m) => fresh.push(m) });
  assert.equal(fresh.length, 3);
  for (const line of [...logs, ...fresh]) assert.equal(line.includes("skip-sentinel"), false);
});

test("loadChecks logs two skipped ids with one line each", async () => {
  const logs: string[] = [];
  const list = {
    value: [
      { ...skipBad, id: "a" },
      { ...skipBad, id: "b" },
    ] as unknown[],
  };
  const deps = { fetch: skipApi(list), log: (m: string) => logs.push(m) };
  await loadChecks("https://api", deps);
  await loadChecks("https://api", deps);
  assert.equal(logs.length, 2);
});

test("skip warnings keep bounded state for hostile ids", async () => {
  const { heapStats } = await import("bun:jsc");
  const heap = (): number => {
    Bun.gc(true);
    return heapStats().heapSize / 1048576;
  };
  const cases = [
    {
      name: "long ids",
      count: 16,
      ids: (i: number) => [String(i).padStart(8, "0") + "x".repeat(1_048_568)],
    },
  ];
  for (const c of cases) {
    const log = (): void => {};
    const before = heap();
    for (let i = 0; i < c.count; i++) {
      const body = JSON.stringify(c.ids(i).map((id) => ({ id })));
      const fakeFetch = (async () =>
        new Response(body, { headers: { "x-pulse-contract": "1" } })) as unknown as typeof fetch;
      // eslint-disable-next-line sonarjs/no-clear-text-protocols -- fake URL for a stubbed fetch, no network
      assert.deepEqual(await loadChecks("http://api", { fetch: fakeFetch, log }), []);
    }
    assert.ok(heap() - before < 6, c.name);
  }
});

const OVERFLOW =
  "skipped checks exceed 10000 remembered IDs; new skip lines are suppressed until the probe restarts";

/** IDs `<prefix>00000` up to `<prefix><last>`, five digits each. */
function skipIds(prefix: string, from: number, to: number): string[] {
  const ids: string[] = [];
  for (let i = from; i <= to; i++) ids.push(prefix + String(i).padStart(5, "0"));
  return ids;
}

test("skip warnings saturate after 10000 ids across reloads", async () => {
  const logs: string[] = [];
  const log = (m: string): void => {
    logs.push(m);
  };
  const list = {
    value: [
      ...skipIds("c", 0, 10_000).map((id) => ({ id, type: "x" })),
      skipOk,
      skipHdr,
    ] as unknown[],
  };
  // The large body is serialized once; the small follow-up lists go through `skipApi`.
  const large = JSON.stringify(list.value);
  const small = skipApi(list);
  let isLarge = true;
  const deps = {
    fetch: (async (...args: Parameters<typeof fetch>) =>
      isLarge
        ? new Response(large, { headers: { "x-pulse-contract": "1" } })
        : small(...args)) as unknown as typeof fetch,
    log,
    env: { PULSE_HEADER_SKIP: SKIP_SENTINEL },
    headerHosts: skipHosts,
  };
  const counts: number[] = [];
  for (let i = 0; i < 3; i++) {
    const before = logs.length;
    const checks = await loadChecks("https://api", deps);
    assert.deepEqual(
      checks.map((c) => c.id),
      ["ok", "hdr"],
    );
    counts.push(logs.length - before);
  }
  assert.deepEqual(counts, [10001, 0, 0]);
  assert.equal(logs.filter((l) => l === OVERFLOW).length, 1);
  assert.equal(new Set(logs).size, logs.length);
  assert.equal(
    logs.some((l) => l.includes("skip-sentinel")),
    false,
  );

  const steps: [unknown[], string[]][] = [
    [
      [
        { ...skipOk, id: "c00005" },
        { ...skipBad, id: "late" },
      ],
      ["c00005"],
    ],
    [[], []],
    [
      [
        { ...skipBad, id: "late2" },
        { ...skipBad, id: "c00005" },
      ],
      [],
    ],
  ];
  isLarge = false;
  for (const [value, ids] of steps) {
    list.value = value;
    const before = logs.length;
    assert.deepEqual(
      (await loadChecks("https://api", deps)).map((c) => c.id),
      ids,
    );
    assert.equal(logs.length - before, 0);
  }
});

test("skipLogger logs the overflow line once per logger at 10000 remembered ids", () => {
  const lines: string[] = [];
  const log = (m: string): void => {
    lines.push(m);
  };
  const logSkip = skipLogger(log);
  const all = skipIds("k", 0, 10_000);
  const ids = all.slice(0, 10_000);
  for (const id of ids) logSkip(id, id);
  assert.equal(lines.length, 10000);
  assert.equal(lines.includes(OVERFLOW), false);
  for (const id of ids) logSkip(id, id);
  assert.equal(lines.length, 10000);
  logSkip("k10000", "line k10000");
  assert.equal(lines.length, 10001);
  assert.equal(lines[10000], OVERFLOW);
  for (const id of ["k10001", "k10002", null, "k00000"]) logSkip(id, String(id));
  skipLogger(log)("k10003", "line k10003");
  assert.equal(lines.length, 10001);

  // A fresh log starts empty and saturates on its own; the saturated one stays quiet.
  const fresh: string[] = [];
  const logFresh = skipLogger((m) => fresh.push(m));
  for (const id of all) logFresh(id, id);
  assert.equal(fresh.length, 10001);
  assert.equal(fresh[10000], OVERFLOW);
  skipLogger(log)("k00001", "line k00001");
  assert.equal(lines.length, 10001);
});

test("loadChecks keeps lone-surrogate ids distinct", async () => {
  const logs: string[] = [];
  const list = {
    value: [
      { ...skipBad, id: "\ud800" },
      { ...skipBad, id: "\ud801" },
    ] as unknown[],
  };
  const deps = { fetch: skipApi(list), log: (m: string) => logs.push(m) };
  await loadChecks("https://api", deps);
  assert.equal(logs.length, 2);
  assert.notEqual(logs[0], logs[1]);
  assert.equal(logs.filter((l) => l.includes("\ud800")).length, 1);
  assert.equal(logs.filter((l) => l.includes("\ud801")).length, 1);
  await loadChecks("https://api", deps);
  assert.equal(logs.length, 2);
});

test("loadChecks keeps an empty id apart from a record without id", async () => {
  const logs: string[] = [];
  const list = { value: [{ ...skipBad, id: "" }, skipNoId] as unknown[] };
  await loadChecks("https://api", { fetch: skipApi(list), log: (m: string) => logs.push(m) });
  assert.equal(logs.length, 2);
});
