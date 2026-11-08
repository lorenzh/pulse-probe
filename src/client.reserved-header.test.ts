import { afterAll, beforeAll, test } from "bun:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { loadChecks } from "./client.ts";
import { parseHeaderHosts } from "./header-hosts.ts";

const SENTINEL = "RESERVED-HEADER-SENTINEL-865";
const RESERVED = "__proto__";

interface Route {
  status: number;
  body: string;
}

// The feed is raw JSON text: a JSON literal keeps the reserved key as an own property after parse.
let routes: Record<string, Route> = {};
let server: http.Server;
let baseUrl = "";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const route = routes[req.url ?? ""];
    res.setHeader("x-pulse-contract", "1");
    res.setHeader("content-type", "application/json");
    if (route === undefined) {
      res.statusCode = 404;
      res.end("{}");
      return;
    }
    res.statusCode = route.status;
    res.end(route.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function record(id: string, headersJson: string | undefined): string {
  const headers = headersJson === undefined ? "" : `,"headers":${headersJson}`;
  return `{"id":"${id}","name":"${id}","url":"http://127.0.0.1:1/${id}","intervalMs":1000${headers}}`;
}

function feed(badHeaderValue: string, isBadFirst: boolean): string {
  const bad = record("bad", `{"${RESERVED}":${badHeaderValue}}`);
  const ok = record("ok", undefined);
  const items = isBadFirst ? [bad, ok] : [ok, bad];
  return `[${items.join(",")}]`;
}

const skipLine = (index: number): string =>
  `skipping invalid check bad: checks[${index}].headers.__proto__: is not an allowed header name`;

const deps = (lines: string[]): Parameters<typeof loadChecks>[1] => ({
  fetch,
  log: (message) => lines.push(message),
  token: "local-test-token",
  env: { PULSE_HEADER_RESERVED: SENTINEL },
  headerHosts: parseHeaderHosts('{"PULSE_HEADER_RESERVED":["127.0.0.1"]}'),
});

test("loadChecks skips a check with a reserved header name and loads its valid sibling", async () => {
  routes = { "/probe/checks": { status: 200, body: feed("null", true) } };
  const lines: string[] = [];
  const checks = await loadChecks(baseUrl, deps(lines));
  assert.deepEqual(
    checks.map((c) => c.id),
    ["ok"],
  );
  assert.deepEqual(lines, [skipLine(0)]);
});

test("loadChecks skips the reserved header name for every value class and either order", async () => {
  const classes = [
    "null",
    "1",
    "true",
    "[]",
    "{}",
    '{"env":"NOT_PREFIXED"}',
    `"${SENTINEL}"`,
    '{"env":"PULSE_HEADER_RESERVED"}',
  ];
  for (const value of classes) {
    for (const isBadFirst of [true, false]) {
      routes = { "/probe/checks": { status: 200, body: feed(value, isBadFirst) } };
      const lines: string[] = [];
      const checks = await loadChecks(baseUrl, deps(lines));
      const label = `${value} ${isBadFirst ? "first" : "last"}`;
      assert.deepEqual(
        checks.map((c) => c.id),
        ["ok"],
        label,
      );
      assert.deepEqual(lines, [skipLine(isBadFirst ? 0 : 1)], label);
      assert.ok(!lines.some((line) => line.includes(SENTINEL)), label);
    }
  }
});

test("loadChecks skips the reserved header name on the public checks fallback", async () => {
  routes = { "/checks": { status: 200, body: feed("null", true) } };
  const lines: string[] = [];
  const checks = await loadChecks(baseUrl, deps(lines));
  assert.deepEqual(
    checks.map((c) => c.id),
    ["ok"],
  );
  assert.deepEqual(lines, [skipLine(0)]);
});

test("loadChecks logs the reserved header skip once per logger", async () => {
  routes = { "/probe/checks": { status: 200, body: feed("null", true) } };
  const lines: string[] = [];
  const shared = deps(lines);
  for (let i = 0; i < 2; i++) {
    const checks = await loadChecks(baseUrl, shared);
    assert.deepEqual(
      checks.map((c) => c.id),
      ["ok"],
    );
  }
  assert.deepEqual(lines, [skipLine(0)]);
});
