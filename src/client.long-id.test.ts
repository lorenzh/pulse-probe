// api client logs: long check IDs and validation texts are shortened while data stays complete.
import { test } from "bun:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { type Result, WIRE_VERSION, WIRE_VERSION_HEADER } from "@lorenzh/pulse-contract";
import { loadChecks, postResult } from "./client.ts";
import { parseHeaderHosts } from "./header-hosts.ts";

const wire = { [WIRE_VERSION_HEADER]: String(WIRE_VERSION) };

const longId = (prefix: string, tail: string): string => prefix.padEnd(80, "p") + tail.repeat(300);
const shown = (id: string): string => `${id.slice(0, 80)}…`;

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

const httpCheck = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  name: "n",
  type: "http",
  url: "http://svc.test/",
  intervalMs: 60_000,
  timeoutMs: 1_000,
  expectedStatus: [200],
  ...extra,
});

async function load(
  records: unknown[],
  log: (m: string) => void,
  env: Record<string, string | undefined> = {},
): Promise<Awaited<ReturnType<typeof loadChecks>>> {
  const api = await listen((_q, res) => {
    res.writeHead(200, { ...wire, "content-type": "application/json" });
    res.end(JSON.stringify(records));
  });
  try {
    return await loadChecks(api.url, {
      fetch,
      log,
      env,
      headerHosts: parseHeaderHosts(
        '{"PULSE_HEADER_MISSING":["svc.test"],"PULSE_HEADER_OK":["other.test"]}',
      ),
    });
  } finally {
    await close(api.server);
  }
}

test("an invalid record with a long id logs 80 units and an ellipsis", async () => {
  const id = longId("invalid-", "x");
  const logs: string[] = [];
  await load([{ id, type: "http" }], (m) => logs.push(m));
  assert.equal(logs.length, 1);
  const line = logs[0] ?? "";
  assert.ok(line.startsWith(`skipping invalid check ${shown(id)}: `), line);
  assert.ok(!line.includes(id));
  assert.ok(line.length <= 1200, String(line.length));
});

test("long validation text is capped at 1000 units", async () => {
  const key = "k".repeat(3000);
  const record = {
    id: "short",
    name: "n",
    type: "tcp",
    host: "svc.test",
    port: 1,
    intervalMs: 1000,
    [key]: 1,
  };
  const logs: string[] = [];
  await load([record], (m) => logs.push(m));
  assert.equal(logs.length, 1);
  const line = logs[0] ?? "";
  const prefix = "skipping invalid check short: ";
  assert.ok(line.startsWith(prefix), line.slice(0, 100));
  const text = line.slice(prefix.length);
  assert.equal(text.length, 1000);
  assert.ok(text.endsWith("…"));
  assert.ok(line.length <= 1200);
});

test("header skip and header denial lines bound the id", async () => {
  const skipped = longId("skipped-", "s");
  const denied = longId("denied-", "d");
  const logs: string[] = [];
  const checks = await load(
    [
      httpCheck(skipped, { headers: { Authorization: { env: "PULSE_HEADER_MISSING" } } }),
      httpCheck(denied, { headers: { Authorization: { env: "PULSE_HEADER_OK" } } }),
    ],
    (m) => logs.push(m),
    { PULSE_HEADER_OK: "value" },
  );
  assert.equal(logs.length, 2, logs.join("\n"));
  const skipLine = logs.find((l) => l.startsWith("skipping check ")) ?? "";
  assert.ok(
    skipLine.startsWith(`skipping check ${shown(skipped)}: header Authorization`),
    skipLine,
  );
  const denyLine = logs.find((l) => l.startsWith("check ")) ?? "";
  assert.ok(denyLine.startsWith(`check ${shown(denied)}: `), denyLine);
  assert.ok(denyLine.endsWith("; reporting down"));
  assert.ok(!logs.some((l) => l.includes(skipped) || l.includes(denied)));
  assert.equal(checks.length, 1);
  assert.equal(checks[0]?.id, denied);
  const denial = checks[0]?.headerDenial ?? "";
  assert.ok(denial.length > 0);
  assert.ok(denyLine.includes(denial));
});

test("drop lines bound the result id", async () => {
  const checkId = longId("result-", "r");
  for (const [status, tail] of [
    [401, "token rejected, check PULSE_PROBE_TOKEN and PULSE_LOCATION"],
    [400, "API answered HTTP 400"],
  ] as const) {
    let posted = "";
    const api = await listen((q, res) => {
      let body = "";
      q.on("data", (d: Buffer) => (body += d.toString()));
      q.on("end", () => {
        posted = (JSON.parse(body) as Result).checkId;
        res.writeHead(status, wire);
        res.end();
      });
    });
    try {
      const logs: string[] = [];
      const result: Result = {
        checkId,
        timestamp: 5,
        status: "up",
        statusCode: 204,
        latencyMs: 3,
        reason: null,
        location: "default",
        attempts: 1,
      };
      const outcome = await postResult(api.url, result, {
        fetch,
        log: (m) => logs.push(m),
        token: "t",
      });
      assert.equal(outcome, "rejected");
      assert.deepEqual(logs, [`dropping result for ${shown(checkId)}: ${tail}`]);
      assert.equal(posted, checkId);
    } finally {
      await close(api.server);
    }
  }
});

test("two long ids with the same prefix log one line each and stay quiet on reload", async () => {
  const first = longId("same-", "1");
  const second = longId("same-", "2");
  const records = [
    { id: first, type: "http" },
    { id: second, type: "http" },
  ];
  const logs: string[] = [];
  const log = (m: string): void => {
    logs.push(m);
  };
  await load(records, log);
  assert.equal(logs.length, 2);
  await load(records, log);
  assert.equal(logs.length, 2);
});
