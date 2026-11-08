import { test } from "bun:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fetchChecks, loadChecks, type ProbeCheck, StartupAbortedError } from "./client.ts";
import { startReloader } from "./reloader.ts";

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

/** Runs `fetchChecks` until its first failure, then stops it through the shutdown signal. */
async function firstFailure(url: string, token: string | undefined): Promise<string[]> {
  const logs: string[] = [];
  const controller = new AbortController();
  const deps = {
    fetch,
    log: (m: string) => logs.push(m),
    sleep: async () => {
      controller.abort();
      throw new Error("stopped");
    },
    signal: controller.signal,
    ...(token === undefined ? {} : { token }),
  };
  await assert.rejects(fetchChecks(url, deps, 1), StartupAbortedError);
  return logs;
}

const validCheck = (id: string): Record<string, unknown> => ({
  id,
  name: id,
  type: "http",
  url: "http://127.0.0.1:1/",
  intervalMs: 60_000,
  timeoutMs: 1_000,
  expectedStatus: [200],
});

test("authenticated check read is not redirected", async () => {
  const token = `tok-${crypto.randomUUID()}`;
  const targetSeen: { auth: string | undefined }[] = [];
  const target = await listen((q, res) => {
    targetSeen.push({ auth: q.headers.authorization });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify([validCheck("from-target")]));
  });
  const apiPaths: string[] = [];
  const api = await listen((q, res) => {
    apiPaths.push(q.url ?? "");
    if (q.url === "/probe/checks") {
      res.statusCode = 307;
      res.setHeader("location", `${target.url}/probe/checks`);
      res.end();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify([validCheck("public")]));
  });
  try {
    const logs = await firstFailure(api.url, token);
    assert.equal(targetSeen.length, 0);
    assert.deepEqual(apiPaths, ["/probe/checks"]);
    assert.equal(logs.length, 1);
    assert.match(logs[0] ?? "", /^fetching checks failed: HTTP 307; /);
    assert.ok(!logs.some((l) => l.includes(token)));
  } finally {
    await close(api.server);
    await close(target.server);
  }
});

test("invalid JSON from the api logs the fixed text", async () => {
  const marker = `body-${crypto.randomUUID()}`;
  const api = await listen((_q, res) => {
    res.setHeader("content-type", "application/json");
    res.end(`{"${marker}": ${marker}`);
  });
  try {
    const logs = await firstFailure(api.url, undefined);
    const failure = logs.find((l) => l.startsWith("fetching checks failed:")) ?? "";
    assert.ok(failure.includes("invalid JSON: response body is not valid JSON"), failure);
    assert.ok(!logs.some((l) => l.includes(marker)));
  } finally {
    await close(api.server);
  }
});

/** A target that counts the requests it gets. */
async function countingTarget(): Promise<{ server: http.Server; url: string; hits: () => number }> {
  let count = 0;
  const t = await listen((_q, res) => {
    count++;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify([validCheck("from-target")]));
  });
  return { ...t, hits: () => count };
}

test("tokenless check read is not redirected", async () => {
  const target = await countingTarget();
  const api = await listen((_q, res) => {
    res.statusCode = 308;
    res.setHeader("location", `${target.url}/checks`);
    res.end();
  });
  try {
    const logs = await firstFailure(api.url, undefined);
    assert.equal(target.hits(), 0);
    assert.equal(logs.length, 1);
    assert.match(logs[0] ?? "", /^fetching checks failed: HTTP 308; /);
  } finally {
    await close(api.server);
    await close(target.server);
  }
});

test("fallback check read is not redirected", async () => {
  const token = `tok-${crypto.randomUUID()}`;
  const target = await countingTarget();
  const apiPaths: string[] = [];
  const api = await listen((q, res) => {
    apiPaths.push(q.url ?? "");
    res.statusCode = q.url === "/probe/checks" ? 404 : 307;
    if (res.statusCode === 307) res.setHeader("location", `${target.url}/checks`);
    res.end();
  });
  try {
    const logs = await firstFailure(api.url, token);
    assert.equal(target.hits(), 0);
    assert.deepEqual(apiPaths, ["/probe/checks", "/checks"]);
    assert.equal(logs.length, 1);
    assert.match(logs[0] ?? "", /^fetching checks failed: HTTP 307; /);
    assert.ok(!logs.some((l) => l.includes(token)));
  } finally {
    await close(api.server);
    await close(target.server);
  }
});

test("invalid JSON on reload logs the fixed text and keeps the checks", async () => {
  const marker = `body-${crypto.randomUUID()}`;
  let calls = 0;
  const api = await listen((_q, res) => {
    calls++;
    res.setHeader("content-type", "application/json");
    res.setHeader("x-pulse-contract", "1");
    res.end(calls === 1 ? `{"${marker}": ${marker}` : JSON.stringify([validCheck("next")]));
  });
  const pending: (() => void)[] = [];
  let scheduled = (): void => {};
  const timer = {
    setTimeout: (fn: () => void): unknown => {
      pending.push(fn);
      scheduled();
      return pending.length;
    },
    clearTimeout: (): void => {},
  };
  /** Fires the pending tick and waits until the reloader schedules the next one. */
  const tick = async (): Promise<void> => {
    const fn = pending.shift();
    const next = new Promise<void>((r) => (scheduled = r));
    fn?.();
    await next;
  };
  const logs: string[] = [];
  const applied: ProbeCheck[][] = [];
  const reloader = startReloader({
    timer,
    now: () => 0,
    load: () => loadChecks(api.url, { fetch, log: (m) => logs.push(m) }),
    apply: (checks) => applied.push(checks),
    log: (m) => logs.push(m),
    intervalMs: 60_000,
    retryMs: 1_000,
    minGapMs: 0,
  });
  try {
    await tick();
    assert.deepEqual(logs, [
      "reloading checks failed: invalid JSON: response body is not valid JSON; keeping the current checks",
    ]);
    assert.equal(applied.length, 0);
    await tick();
    assert.deepEqual(
      applied.map((checks) => checks.map((c) => c.id)),
      [["next"]],
    );
    assert.equal(logs.length, 1);
    assert.ok(!logs.some((l) => l.includes(marker)));
  } finally {
    reloader.stop();
    await close(api.server);
  }
});
