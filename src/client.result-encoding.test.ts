import { test } from "bun:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { type Result, WIRE_VERSION, WIRE_VERSION_HEADER } from "@lorenzh/pulse-contract";
import { postResult } from "./client.ts";

const token = `tok-${crypto.randomUUID()}`;
const marker = `body-${crypto.randomUUID()}`;
const wire = { [WIRE_VERSION_HEADER]: String(WIRE_VERSION) };

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

/** Posts once against a server that answers `status` with `coding` and a small encoded body. */
async function answer(
  status: number,
  coding: string | undefined,
): Promise<{ outcome: string; logs: string[] }> {
  const api = await listen((_q, res) => {
    const headers = { ...wire, ...(coding === undefined ? {} : { "content-encoding": coding }) };
    res.writeHead(status, headers);
    res.end(status === 204 ? undefined : gzipSync(marker));
  });
  try {
    const logs: string[] = [];
    const outcome = await postResult(api.url, result, {
      fetch,
      log: (m) => logs.push(m),
      token,
    });
    assert.ok(!logs.some((l) => l.includes(token) || l.includes(marker)));
    return { outcome, logs };
  } finally {
    await close(api.server);
  }
}

test("result post asks for identity coding", async () => {
  let seen: string | undefined;
  const api = await listen((q, res) => {
    seen = q.headers["accept-encoding"];
    res.writeHead(204, wire);
    res.end();
  });
  try {
    await postResult(api.url, result, { fetch, log: () => {}, token });
    assert.equal(seen, "identity");
  } finally {
    await close(api.server);
  }
});

test("an encoded 204 is retried", async () => {
  for (const coding of ["gzip", "br", "x-unknown"]) {
    const { outcome, logs } = await answer(204, coding);
    assert.equal(outcome, "retry", coding);
    assert.deepEqual(logs, []);
  }
});

test("a combined coding on a 204 is retried", async () => {
  for (const coding of ["identity, gzip", "gzip, identity", "identity,identity"]) {
    assert.equal((await answer(204, coding)).outcome, "retry", coding);
  }
});

test("identity in any case and spacing on a 204 is accepted", async () => {
  for (const coding of [undefined, "", "  ", "identity", " IDENTITY ", "Identity"]) {
    const { outcome, logs } = await answer(204, coding);
    assert.equal(outcome, "accepted", String(coding));
    assert.deepEqual(logs, []);
  }
});

test("encoded error answers keep their status outcome", async () => {
  assert.equal((await answer(503, "gzip")).outcome, "retry");
  assert.equal((await answer(429, "gzip")).outcome, "retry");
  const unauthorized = await answer(401, "gzip");
  assert.equal(unauthorized.outcome, "rejected");
  assert.deepEqual(unauthorized.logs, [
    "dropping result for a: token rejected, check PULSE_PROBE_TOKEN and PULSE_LOCATION",
  ]);
  const missing = await answer(404, "gzip");
  assert.equal(missing.outcome, "unknown-check");
  assert.deepEqual(missing.logs, ["dropping result for a: API answered HTTP 404"]);
  const ok = await answer(200, "gzip");
  assert.equal(ok.outcome, "rejected");
  assert.deepEqual(ok.logs, ["dropping result for a: API answered HTTP 200"]);
});

test("a stalled 503 body does not hold the outcome", async () => {
  let hold = (): void => {};
  const held = new Promise<void>((r) => (hold = r));
  const api = await listen((_q, res) => {
    res.writeHead(503, { ...wire, "content-type": "text/plain" });
    res.write(`${marker}-partial`);
    // The body stays open until the test has its outcome.
    void held.then(() => res.end());
  });
  try {
    const outcome = await postResult(api.url, result, { fetch, log: () => {}, token });
    assert.equal(outcome, "retry");
  } finally {
    hold();
    await close(api.server);
  }
});

test("a direct 204 is accepted with the same request", async () => {
  let seen: Record<string, string | undefined> = {};
  const api = await listen((q, res) => {
    let body = "";
    q.on("data", (d: Buffer) => (body += d.toString()));
    q.on("end", () => {
      seen = {
        method: q.method,
        url: q.url,
        type: q.headers["content-type"],
        auth: q.headers.authorization,
        body,
      };
      res.writeHead(204, wire);
      res.end();
    });
  });
  try {
    const outcome = await postResult(`${api.url}/`, result, { fetch, log: () => {}, token });
    assert.equal(outcome, "accepted");
    assert.equal(seen.method, "POST");
    assert.equal(seen.url, "/results");
    assert.equal(seen.type, "application/json");
    assert.equal(seen.auth, `Bearer ${token}`);
    assert.deepEqual(JSON.parse(seen.body ?? ""), result);
  } finally {
    await close(api.server);
  }
});
