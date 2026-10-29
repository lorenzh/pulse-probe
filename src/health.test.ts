import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHealthSettings, type Readiness, startHealthServer } from "./health.ts";

test("parseHealthSettings: unset means no listener, bad port throws", () => {
  assert.equal(parseHealthSettings(undefined, undefined), undefined);
  assert.deepEqual(parseHealthSettings("9100", undefined), { port: 9100, host: "127.0.0.1" });
  assert.deepEqual(parseHealthSettings("9100", "0.0.0.0"), { port: 9100, host: "0.0.0.0" });
  assert.throws(() => parseHealthSettings("abc", undefined), /PULSE_HEALTH_PORT/);
  assert.throws(() => parseHealthSettings("70000", undefined), /PULSE_HEALTH_PORT/);
});

test("health server answers /readyz by readiness, /healthz always, and serves /metrics", async () => {
  let readiness: Readiness = { ready: false, reason: "checks not loaded yet" };
  const server = await startHealthServer(
    { port: 0, host: "127.0.0.1" },
    { readiness: () => readiness, renderMetrics: () => "pulse_up 1\n" },
  );
  try {
    const base = `http://127.0.0.1:${server.port}`;
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    const down = await fetch(`${base}/readyz`);
    assert.equal(down.status, 503);
    assert.equal(await down.text(), "checks not loaded yet\n");
    readiness = { ready: true };
    const up = await fetch(`${base}/readyz`);
    assert.equal(up.status, 200);
    assert.equal(await up.text(), "ok\n");
    const metrics = await fetch(`${base}/metrics`);
    assert.equal(metrics.status, 200);
    assert.equal(await metrics.text(), "pulse_up 1\n");
    assert.equal((await fetch(`${base}/other`)).status, 404);
  } finally {
    await server.close();
  }
});

test("/healthz stays 200 during shutdown while /readyz is 503", async () => {
  const readiness: Readiness = { ready: false, reason: "shutting down" };
  const server = await startHealthServer(
    { port: 0, host: "127.0.0.1" },
    { readiness: () => readiness, renderMetrics: () => "" },
  );
  try {
    const base = `http://127.0.0.1:${server.port}`;
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    const ready = await fetch(`${base}/readyz`);
    assert.equal(ready.status, 503);
    assert.equal(await ready.text(), "shutting down\n");
  } finally {
    await server.close();
  }
});

test("startHealthServer rejects when the port is taken", async () => {
  const deps = { readiness: (): Readiness => ({ ready: true }), renderMetrics: () => "" };
  const first = await startHealthServer({ port: 0, host: "127.0.0.1" }, deps);
  try {
    await assert.rejects(startHealthServer({ port: first.port, host: "127.0.0.1" }, deps));
  } finally {
    await first.close();
  }
});
