import { test } from "bun:test";
import assert from "node:assert/strict";
import net, { type AddressInfo } from "node:net";
import { type CheckDeps, runCheck } from "./check.ts";
import type { TcpConnect } from "./check-tcp.ts";

let t = 1000;
const tick = (): number => (t += 7);
const deps: CheckDeps = {
  fetch,
  now: tick,
  monotonic: tick,
  sleep: async () => {},
  location: "default",
};

function tcpCheck(port: number, extra: Record<string, unknown> = {}) {
  return {
    id: "t",
    name: "T",
    type: "tcp" as const,
    host: "127.0.0.1",
    port,
    intervalMs: 60_000,
    ...extra,
  };
}

test("tcp is up on an open port, sends nothing and closes the connection", async () => {
  const received: unknown[] = [];
  let isClosed = false;
  const server = net.createServer((socket) => {
    socket.on("data", (d) => received.push(d));
    socket.on("close", () => {
      isClosed = true;
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const port = (server.address() as AddressInfo).port;
    const r = await runCheck(tcpCheck(port), deps);
    assert.equal(r.status, "up");
    assert.equal(r.reason, null);
    assert.equal(r.statusCode, null);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(isClosed, true);
    assert.equal(received.length, 0);
  } finally {
    server.close();
  }
});

test("tcp is down with the refusal in the reason on a closed port", async () => {
  const server = net.createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((r) => server.close(() => r()));
  const r = await runCheck(tcpCheck(port), deps);
  assert.equal(r.status, "down");
  assert.equal(r.reason, "connection refused (ECONNREFUSED)");
});

test("tcp is down with the timeout when the connection never completes", async () => {
  const connect: TcpConnect = ({ signal }) =>
    new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
  const r = await runCheck(tcpCheck(1, { timeoutMs: 30 }), { ...deps, tcpConnect: connect });
  assert.equal(r.status, "down");
  assert.equal(r.reason, "timeout after 30ms");
});

test("tcp names an unknown host", async () => {
  const connect: TcpConnect = async () => {
    throw Object.assign(new Error("getaddrinfo ENOTFOUND x"), { code: "ENOTFOUND" });
  };
  const r = await runCheck(tcpCheck(1), { ...deps, tcpConnect: connect });
  assert.equal(r.reason, "host not found (ENOTFOUND)");
});

test("tcp retries and reports the attempts; shutdown stops the retries", async () => {
  let calls = 0;
  const connect: TcpConnect = async () => {
    calls++;
    if (calls < 3) throw Object.assign(new Error("x"), { code: "ECONNREFUSED" });
  };
  const r = await runCheck(tcpCheck(1, { retries: 3 }), { ...deps, tcpConnect: connect });
  assert.equal(r.status, "up");
  assert.equal(r.attempts, 3);

  calls = 0;
  const ctl = new AbortController();
  const failing: TcpConnect = async () => {
    calls++;
    ctl.abort();
    throw Object.assign(new Error("x"), { code: "ECONNREFUSED" });
  };
  const stopped = await runCheck(tcpCheck(1, { retries: 3 }), {
    ...deps,
    tcpConnect: failing,
    signal: ctl.signal,
  });
  assert.equal(stopped.status, "down");
  assert.equal(calls, 1);
});

test("a long error message is capped at 1000 characters in the reason", async () => {
  const connect: TcpConnect = async () => {
    throw new Error("m".repeat(5000));
  };
  const r = await runCheck(tcpCheck(1), { ...deps, tcpConnect: connect });
  assert.equal(r.status, "down");
  assert.equal(r.reason, `${"m".repeat(999)}…`);
  assert.equal(r.reason?.length, 1000);
});
