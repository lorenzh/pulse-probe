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
const deps = { fetch, now, sleep, location: "default" };

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

test("result carries the location and the request the user agent", async () => {
  let agent: string | undefined;
  const { server, url } = await listen((q, res) => {
    agent = q.headers["user-agent"];
    res.end("ok");
  });
  try {
    const r = await runCheck(
      { id: "a", name: "A", url, intervalMs: 1000 },
      { fetch, now, sleep, location: "eu" },
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
      { ...deps, sleep: async (ms) => void sleeps.push(ms) },
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
      { ...deps, sleep: async (ms) => void sleeps.push(ms) },
    );
    assert.equal(r.status, "down");
    assert.equal(r.statusCode, 503);
    assert.equal(r.reason, "HTTP 503");
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
