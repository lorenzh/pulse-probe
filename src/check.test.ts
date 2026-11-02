import { test } from "bun:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { HttpMethod } from "@lorenzh/pulse-contract";
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
const sleep = async (): Promise<void> => {};
const deps = { fetch, now, monotonic: now, sleep, location: "default" };

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
    assert.equal(r.reason, "HTTP 500 not in 200-299");
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
    if (q.url === "/final") {
      res.end("ok");
      return;
    }
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

test("result carries the location and the request the user agent", async () => {
  let agent: string | undefined;
  const { server, url } = await listen((q, res) => {
    agent = q.headers["user-agent"];
    res.end("ok");
  });
  try {
    const r = await runCheck(
      { id: "a", name: "A", url, intervalMs: 1000 },
      { fetch, now, monotonic: now, sleep, location: "eu" },
    );
    assert.equal(r.location, "eu");
    assert.equal(agent, "pulse-probe (eu)");
  } finally {
    await close(server);
  }
});

test("no retries: a failure is down after one attempt", async () => {
  let hits = 0;
  const { server, url } = await listen((_q, res) => {
    hits++;
    res.statusCode = hits === 1 ? 500 : 200;
    res.end();
  });
  try {
    const r = await runCheck({ id: "a", name: "A", url, intervalMs: 100_000 }, deps);
    assert.equal(r.status, "down");
    assert.equal(r.attempts, 1);
    assert.equal(hits, 1);
  } finally {
    await close(server);
  }
});

test("retries: success on the second attempt is up", async () => {
  let hits = 0;
  const { server, url } = await listen((_q, res) => {
    hits++;
    res.statusCode = hits === 1 ? 500 : 200;
    res.end();
  });
  const sleeps: number[] = [];
  try {
    const r = await runCheck(
      { id: "a", name: "A", url, intervalMs: 100_000, retries: 1 },
      {
        ...deps,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    assert.equal(r.status, "up");
    assert.equal(r.statusCode, 200);
    assert.equal(r.reason, null);
    assert.equal(r.attempts, 2);
    assert.equal(hits, 2);
    assert.deepEqual(sleeps, [1000]);
  } finally {
    await close(server);
  }
});

test("retries: always failing reports the last attempt and waits retryDelayMs", async () => {
  let hits = 0;
  const { server, url } = await listen((_q, res) => {
    hits++;
    res.statusCode = hits === 1 ? 500 : 503;
    res.end();
  });
  const sleeps: number[] = [];
  try {
    const r = await runCheck(
      { id: "a", name: "A", url, intervalMs: 100_000, retries: 1, retryDelayMs: 250 },
      {
        ...deps,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    assert.equal(r.status, "down");
    assert.equal(r.statusCode, 503);
    assert.equal(r.reason, "HTTP 503 not in 200-299");
    assert.equal(r.attempts, 2);
    assert.equal(hits, 2);
    assert.deepEqual(sleeps, [250]);
  } finally {
    await close(server);
  }
});

test("retries: success stops the loop early", async () => {
  let hits = 0;
  const { server, url } = await listen((_q, res) => {
    hits++;
    res.end();
  });
  try {
    const r = await runCheck({ id: "a", name: "A", url, intervalMs: 100_000, retries: 5 }, deps);
    assert.equal(r.attempts, 1);
    assert.equal(hits, 1);
  } finally {
    await close(server);
  }
});

test("retries: the deadline guard stops retrying near the interval end", async () => {
  const { server, url } = await listen((_q, res) => {
    res.statusCode = 500;
    res.end();
  });
  let clock = 0;
  const sleeps: number[] = [];
  try {
    const r = await runCheck(
      { id: "a", name: "A", url, intervalMs: 2500, retries: 5, retryDelayMs: 1000 },
      {
        ...deps,
        now: () => clock,
        monotonic: () => clock,
        sleep: async (ms) => {
          sleeps.push(ms);
          clock += ms;
        },
      },
    );
    // t=0 fail, wait -> 1000 fail, wait -> 2000 fail; 2000+1000 >= 2500 so stop
    assert.equal(r.status, "down");
    assert.equal(r.attempts, 3);
    assert.deepEqual(sleeps, [1000, 1000]);
    assert.equal(r.timestamp, 0);
    assert.equal(r.latencyMs, 0);
  } finally {
    await close(server);
  }
});

/** A clock whose first reading is 0 and later readings are `latency`. */
const clockWithLatency = (latency: number) => {
  let n = 0;
  return () => (n++ === 0 ? 0 : latency);
};

async function objectiveRun(
  latency: number,
  objective: number | undefined,
  status = 200,
  retries?: number,
) {
  const { server, url } = await listen((_q, res) => {
    res.statusCode = status;
    res.end();
  });
  try {
    return await runCheck(
      {
        id: "a",
        name: "A",
        url,
        intervalMs: 1000,
        ...(objective !== undefined ? { latencyObjectiveMs: objective } : {}),
        ...(retries !== undefined ? { retries } : {}),
      },
      { ...deps, now: clockWithLatency(latency), monotonic: clockWithLatency(latency) },
    );
  } finally {
    await close(server);
  }
}

test("up when latency is below the objective", async () => {
  const r = await objectiveRun(400, 500);
  assert.equal(r.status, "up");
  assert.equal(r.reason, null);
});

test("up when latency equals the objective", async () => {
  const r = await objectiveRun(500, 500);
  assert.equal(r.status, "up");
  assert.equal(r.reason, null);
});

test("degraded when latency is above the objective", async () => {
  const r = await objectiveRun(850, 500);
  assert.equal(r.status, "degraded");
  assert.equal(r.statusCode, 200);
  assert.equal(r.latencyMs, 850);
  assert.equal(r.reason, "latency 850ms over objective 500ms");
});

test("never degraded without an objective", async () => {
  const r = await objectiveRun(5000, undefined);
  assert.equal(r.status, "up");
});

test("slow 503 stays down", async () => {
  const r = await objectiveRun(850, 500, 503);
  assert.equal(r.status, "down");
  assert.equal(r.reason, "HTTP 503 not in 200-299");
});

test("degraded result is not retried", async () => {
  let calls = 0;
  const { server, url } = await listen((_q, res) => {
    calls++;
    res.end();
  });
  try {
    const r = await runCheck(
      { id: "a", name: "A", url, intervalMs: 1000, latencyObjectiveMs: 1, retries: 2 },
      { ...deps, now: clockWithLatency(50), monotonic: clockWithLatency(50) },
    );
    assert.equal(r.status, "degraded");
    assert.equal(r.attempts, 1);
    assert.equal(calls, 1);
  } finally {
    await close(server);
  }
});

test("timeout stays down with an objective", async () => {
  const { server, url } = await listen(() => {});
  try {
    const r = await runCheck(
      { id: "a", name: "A", url, intervalMs: 1000, timeoutMs: 50, latencyObjectiveMs: 10 },
      deps,
    );
    assert.equal(r.status, "down");
    assert.equal(r.reason, "timeout after 50ms");
  } finally {
    await close(server);
  }
});

function bodyFetch(
  status: number,
  chunks: Array<Uint8Array | Error>,
  state = { cancelled: false, pulled: 0 },
) {
  const impl = async (): Promise<Response> => {
    let i = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        state.pulled++;
        const c = chunks[i++];
        if (c === undefined) controller.close();
        else if (c instanceof Error) controller.error(c);
        else controller.enqueue(c);
      },
      cancel() {
        state.cancelled = true;
      },
    });
    return new Response(body, { status });
  };
  return { fetch: impl as unknown as typeof fetch, state };
}
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const kwCheck = (keyword?: string, retries?: number) => ({
  id: "k",
  name: "K",
  url: "http://x.test",
  intervalMs: 100_000,
  retryDelayMs: 0,
  ...(keyword !== undefined ? { keyword } : {}),
  ...(retries !== undefined ? { retries } : {}),
});

test("keyword present is up and cancels the rest", async () => {
  const f = bodyFetch(200, [enc("hello wor"), enc("ld"), enc("more"), enc("more")]);
  const r = await runCheck(kwCheck("world"), { ...deps, fetch: f.fetch });
  assert.equal(r.status, "up");
  assert.equal(r.statusCode, 200);
  assert.ok(f.state.cancelled);
  assert.ok(f.state.pulled < 5);
});

test("keyword absent is down, retried with attempts counted", async () => {
  const f = bodyFetch(200, [enc("maintenance")]);
  const r = await runCheck(kwCheck("x", 2), { ...deps, fetch: f.fetch });
  assert.equal(r.status, "down");
  assert.equal(r.statusCode, 200);
  assert.equal(r.reason, 'keyword "x" not found');
  assert.equal(r.attempts, 3);
});

test("keyword is case sensitive", async () => {
  const f = bodyFetch(200, [enc("Hello")]);
  const r = await runCheck(kwCheck("hello"), { ...deps, fetch: f.fetch });
  assert.equal(r.reason, 'keyword "hello" not found');
});

test("keyword non-2xx keeps HTTP reason", async () => {
  const f = bodyFetch(503, [enc("hello")]);
  const r = await runCheck(kwCheck("hello"), { ...deps, fetch: f.fetch });
  assert.equal(r.status, "down");
  assert.equal(r.reason, "HTTP 503 not in 200-299");
});

test("keyword beyond the 1 MiB limit is not found", async () => {
  const f = bodyFetch(200, [new Uint8Array(1_048_576).fill(97), enc("needle"), enc("rest")]);
  const r = await runCheck(kwCheck("needle"), { ...deps, fetch: f.fetch });
  assert.equal(r.status, "down");
  assert.equal(r.reason, 'keyword "needle" not found');
  assert.ok(f.state.cancelled);
});

test("keyword straddling the limit is not found", async () => {
  const f = bodyFetch(200, [new Uint8Array(1_048_574).fill(97), enc("needle")]);
  const r = await runCheck(kwCheck("needle"), { ...deps, fetch: f.fetch });
  assert.equal(r.status, "down");
});

test("no keyword does not read the body", async () => {
  const f = bodyFetch(200, [enc("a"), enc("b")]);
  const r = await runCheck(kwCheck(), { ...deps, fetch: f.fetch });
  assert.equal(r.status, "up");
  assert.ok(f.state.cancelled);
  assert.ok(f.state.pulled <= 1);
});

test("body read error keeps the error reason", async () => {
  const err = Object.assign(new Error("boom"), { code: "ECONNRESET" });
  const f = bodyFetch(200, [enc("a"), err]);
  const r = await runCheck(kwCheck("zzz"), { ...deps, fetch: f.fetch });
  assert.equal(r.status, "down");
  assert.equal(r.statusCode, null);
  assert.equal(r.reason, "ECONNRESET");
});

test("body timeout keeps the timeout reason", async () => {
  const timeout = new DOMException("t", "TimeoutError");
  const f = bodyFetch(200, [timeout as unknown as Error]);
  const r = await runCheck({ ...kwCheck("zzz"), timeoutMs: 50 }, { ...deps, fetch: f.fetch });
  assert.equal(r.reason, "timeout after 50ms");
});

test("timestamp is the wall clock and latency uses the monotonic clock", async () => {
  const { server, url } = await listen((_q, res) => res.end("ok"));
  let mono = 50;
  try {
    const r = await runCheck(
      { id: "a", name: "A", url, intervalMs: 1000 },
      {
        ...deps,
        now: () => 1_700_000_000_000,
        monotonic: () => {
          mono += 30;
          return mono;
        },
      },
    );
    assert.equal(r.timestamp, 1_700_000_000_000);
    assert.equal(r.latencyMs, 30);
  } finally {
    await close(server);
  }
});

test("a wall clock step back does not change latency or the retry budget", async () => {
  const { server, url } = await listen((_q, res) => {
    res.statusCode = 500;
    res.end();
  });
  let wall = 10_000;
  let mono = 0;
  const sleeps: number[] = [];
  try {
    const r = await runCheck(
      { id: "a", name: "A", url, intervalMs: 3500, retries: 5, retryDelayMs: 1000 },
      {
        ...deps,
        now: () => (wall -= 3_600_000),
        monotonic: () => mono,
        sleep: async (ms) => {
          sleeps.push(ms);
          mono += ms;
        },
      },
    );
    // The budget follows the monotonic clock: 0, 1000, 2000 and 3000 ms. A wall clock that
    // keeps stepping back would never use it up and allow all six attempts.
    assert.equal(r.attempts, 4);
    assert.equal(r.latencyMs, 0);
    assert.deepEqual(sleeps, [1000, 1000, 1000]);
  } finally {
    await close(server);
  }
});

/** A fetch that records each call and answers 200. */
function recordingFetch(): { calls: string[]; fetch: typeof fetch } {
  const calls: string[] = [];
  const f = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response("ok");
  }) as unknown as typeof fetch;
  return { calls, fetch: f };
}

test("a check URL that is not http or https gets no request", async () => {
  const cases = [
    ["file:///proc/self/environ", 'unsupported URL scheme "file:"'],
    ["data:text/plain,x", 'unsupported URL scheme "data:"'],
    ["not a url", "invalid URL"],
  ];
  for (const [url, reason] of cases) {
    const rec = recordingFetch();
    const r = await runCheck(
      { id: "a", name: "A", url: url ?? "", intervalMs: 100_000, retries: 1 },
      { ...deps, fetch: rec.fetch },
    );
    assert.deepEqual([r.status, r.statusCode, r.reason, r.attempts], ["down", null, reason, 2]);
    assert.equal(rec.calls.length, 0);
  }
});

test("an https URL with credentials is checked", async () => {
  const rec = recordingFetch();
  const r = await runCheck(
    { id: "a", name: "A", url: "https://user:secret@h.test/", intervalMs: 1000 },
    { ...deps, fetch: rec.fetch },
  );
  assert.equal(r.status, "up");
  assert.equal(rec.calls.length, 1);
});

test("latency is sent in whole milliseconds and never below 0", async () => {
  for (const [readings, expected] of [
    [[100.25, 101.75], 2],
    [[0, -3], 0],
  ] as const) {
    const { server, url } = await listen((_q, res) => res.end("ok"));
    try {
      let i = 0;
      const mono = (): number => readings[Math.min(i++, 1)] ?? 0;
      const r = await runCheck(
        { id: "a", name: "A", url, intervalMs: 1000 },
        { ...deps, monotonic: mono },
      );
      assert.equal(r.latencyMs, expected);
    } finally {
      await close(server);
    }
  }
});

test("the latency objective compares the rounded latency", async () => {
  const below = await objectiveRun(500.4, 500);
  assert.deepEqual([below.status, below.latencyMs, below.reason], ["up", 500, null]);
  const above = await objectiveRun(500.5, 500);
  assert.deepEqual(
    [above.status, above.latencyMs, above.reason],
    ["degraded", 501, "latency 501ms over objective 500ms"],
  );
});

interface RetryRun {
  fetches: string[];
  sleeps: number[];
  attempts: number;
}

/** Runs an HTTP check against a fake fetch that answers `answer(hop)`; nothing reaches the network. */
async function runRetry(
  method: HttpMethod | undefined,
  answer: (hop: number) => Response,
): Promise<RetryRun> {
  const fetches: string[] = [];
  const sleeps: number[] = [];
  const fakeFetch = async (
    _input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    fetches.push(init?.method ?? "GET");
    return answer(fetches.length);
  };
  const r = await runCheck(
    {
      id: "a",
      name: "A",
      url: "http://example.test/",
      intervalMs: 100_000,
      retries: 3,
      retryDelayMs: 10,
      ...(method !== undefined ? { method } : {}),
    },
    {
      fetch: fakeFetch,
      now,
      monotonic: now,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      location: "default",
    },
  );
  return { fetches, sleeps, attempts: r.attempts };
}

const fail = (): Response => new Response(null, { status: 500 });

for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const) {
  test(`retries: ${method} makes one attempt without sleep`, async () => {
    const run = await runRetry(method, fail);
    assert.deepEqual(run, { fetches: [method], sleeps: [], attempts: 1 });
  });
}

for (const method of ["GET", "HEAD", undefined] as const) {
  test(`retries: ${method ?? "omitted method"} uses the retry budget`, async () => {
    const run = await runRetry(method, fail);
    assert.equal(run.fetches.length, 4);
    assert.deepEqual(run.sleeps, [10, 10, 10]);
    assert.equal(run.attempts, 4);
  });
}

test("retries: POST redirected by 303 to a failing GET is not retried", async () => {
  const run = await runRetry("POST", (hop) =>
    hop === 1 ? new Response(null, { status: 303, headers: { location: "/next" } }) : fail(),
  );
  assert.deepEqual(run, { fetches: ["POST", "GET"], sleeps: [], attempts: 1 });
});

test("aborting a GET during the retry wait ends the run after 1 fetch", async () => {
  const ctl = new AbortController();
  let fetches = 0;
  const fakeFetch = async (): Promise<Response> => {
    fetches++;
    return new Response(null, { status: 500 });
  };
  const abortingSleep = (_ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      ctl.abort({ why: "changed" });
    });
  const r = await runCheck(
    { id: "a", name: "A", url: "http://check.test/", intervalMs: 60_000, retries: 2 },
    { ...deps, fetch: fakeFetch, sleep: abortingSleep, signal: ctl.signal },
  );
  assert.equal(fetches, 1);
  assert.equal(r.attempts, 1);
});

test("an abort that lands just after the retry sleep resolves starts no new attempt", async () => {
  const schedules: { name: string; arm: (abort: () => void) => void }[] = [
    { name: "inside sleep", arm: (abort) => abort() },
    { name: "one microtask later", arm: (abort) => queueMicrotask(abort) },
    { name: "two microtasks later", arm: (abort) => queueMicrotask(() => queueMicrotask(abort)) },
  ];
  for (const { name, arm } of schedules) {
    const ctl = new AbortController();
    let fetches = 0;
    const r = await runCheck(
      {
        id: "a",
        name: "A",
        url: "http://check.test/",
        intervalMs: 60_000,
        timeoutMs: 60_000,
        retries: 2,
      },
      {
        ...deps,
        fetch: async (): Promise<Response> => {
          fetches++;
          return new Response(null, { status: 500 });
        },
        sleep: async (): Promise<void> => {
          arm(() => ctl.abort());
        },
        signal: ctl.signal,
      },
    );
    assert.equal(fetches, 1, name);
    assert.equal(r.attempts, 1, name);
    assert.equal(r.statusCode, 500, name);
  }
});

test("a run aborted on entry starts no work for any check type", async () => {
  const ctl = new AbortController();
  ctl.abort({ why: "shutdown" });
  const calls: string[] = [];
  const fakeDeps = {
    ...deps,
    signal: ctl.signal,
    fetch: async (): Promise<Response> => {
      calls.push("fetch");
      return new Response("ok");
    },
    tcpConnect: async (): Promise<void> => {
      calls.push("tcp");
    },
    tlsConnect: async (): Promise<{ validTo: number }> => {
      calls.push("tls");
      return { validTo: 1 };
    },
    resolve: async (): Promise<string[]> => {
      calls.push("dns");
      return ["192.0.2.1"];
    },
  };
  const base = { name: "X", intervalMs: 60_000, timeoutMs: 60_000, retries: 2 };
  const checks = [
    { ...base, id: "http", url: "http://check.test/" },
    { ...base, id: "tcp", type: "tcp" as const, host: "check.test", port: 25 },
    { ...base, id: "tls", type: "tls" as const, host: "check.test", port: 443, warnDays: 14 },
    { ...base, id: "dns", type: "dns" as const, dnsName: "check.test", recordType: "A" as const },
    { ...base, id: "domain", type: "domain" as const, domain: "check.test", warnDays: 14 },
  ];
  for (const check of checks) {
    const r = await runCheck(check, fakeDeps);
    assert.deepEqual([r.checkId, r.status, r.reason], [check.id, "down", "timeout after 60000ms"]);
  }
  assert.deepEqual(calls, []);
});
