import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
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
  return { fetch: impl as typeof fetch, state };
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
