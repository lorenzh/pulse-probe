import assert from "node:assert/strict";
import { test } from "node:test";
import { loadChecks } from "./client.ts";

const wire = { headers: { "x-pulse-contract": "1" } };

interface Call {
  url: string;
  auth: string | null;
}

function api(
  routes: Record<string, () => Response>,
  calls: Call[] = [],
): { fetch: typeof fetch; calls: Call[] } {
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, auth: headers.get("authorization") });
    const route = routes[new URL(url).pathname];
    return route === undefined ? new Response("", { status: 404 }) : route();
  };
  return { fetch: impl as typeof fetch, calls };
}

const rich = {
  id: "p",
  name: "P",
  url: "https://svc.test/",
  intervalMs: 1000,
  method: "POST",
  body: '{"x":1}',
  expectedStatus: [200, "300-399"],
  jsonAssert: [{ pointer: "/status", equals: "ok" }],
  headers: { "Content-Type": "application/json", Authorization: { env: "SVC_TOKEN" } },
};

test("loadChecks calls /probe/checks with the bearer token and copies the new fields", async () => {
  const a = api({ "/probe/checks": () => Response.json([rich], wire) });
  const checks = await loadChecks("https://api", {
    fetch: a.fetch,
    log: () => {},
    token: "probe-tok",
    env: { SVC_TOKEN: "Bearer s3" },
  });
  assert.deepEqual(a.calls, [{ url: "https://api/probe/checks", auth: "Bearer probe-tok" }]);
  assert.deepEqual(checks, [
    {
      ...rich,
      headers: { "Content-Type": "application/json", Authorization: "Bearer s3" },
    },
  ]);
});

test("loadChecks falls back to /checks when /probe/checks answers 404", async () => {
  const a = api({ "/checks": () => Response.json([{ ...rich, headers: undefined }], wire) });
  const checks = await loadChecks("https://api", { fetch: a.fetch, log: () => {}, token: "t" });
  assert.deepEqual(
    a.calls.map((c) => c.url),
    ["https://api/probe/checks", "https://api/checks"],
  );
  assert.equal(a.calls[1]?.auth, null);
  assert.equal(checks.length, 1);
});

test("loadChecks throws on other failures of /probe/checks without a fallback", async () => {
  const a = api({ "/probe/checks": () => new Response("", { status: 401 }) });
  await assert.rejects(
    loadChecks("https://api", { fetch: a.fetch, log: () => {}, token: "t" }),
    /HTTP 401/,
  );
  assert.equal(a.calls.length, 1);
});

test("loadChecks skips a check whose env reference is unset or empty, logging names only", async () => {
  const logs: string[] = [];
  const ok = { id: "ok", name: "OK", url: "https://x.test/", intervalMs: 1000 };
  for (const env of [{}, { SVC_TOKEN: "" }]) {
    logs.length = 0;
    const a = api({ "/probe/checks": () => Response.json([rich, ok], wire) });
    const checks = await loadChecks("https://api", {
      fetch: a.fetch,
      log: (m) => logs.push(m),
      token: "t",
      env,
    });
    assert.deepEqual(
      checks.map((c) => c.id),
      ["ok"],
    );
    assert.deepEqual(logs, ["skipping check p: header Authorization env SVC_TOKEN is not set"]);
  }
});

test("the log of a skipped check holds no header value", async () => {
  const logs: string[] = [];
  const check = {
    ...rich,
    headers: { "X-Key": "sentinel-literal", Authorization: { env: "MISSING" } },
  };
  const a = api({ "/probe/checks": () => Response.json([check], wire) });
  await loadChecks("https://api", {
    fetch: a.fetch,
    log: (m) => logs.push(m),
    token: "t",
    env: {},
  });
  const text = logs.join("\n");
  assert.ok(!text.includes("sentinel-literal"));
  assert.ok(!text.includes('{"x":1}'));
});

test("loadChecks skips a check whose env value is not a valid header value, logging names only", async () => {
  const logs: string[] = [];
  const ok = { id: "ok", name: "OK", url: "https://x.test/", intervalMs: 1000 };
  for (const value of ["sentinel\r\nx", "sentinel\nx", "sentinel\tx", "sentinel\rx"]) {
    logs.length = 0;
    const a = api({ "/probe/checks": () => Response.json([rich, ok], wire) });
    const checks = await loadChecks("https://api", {
      fetch: a.fetch,
      log: (m) => logs.push(m),
      token: "t",
      env: { SVC_TOKEN: value },
    });
    assert.deepEqual(
      checks.map((c) => c.id),
      ["ok"],
    );
    assert.deepEqual(logs, [
      "skipping check p: header Authorization env SVC_TOKEN is not a valid header value",
    ]);
    assert.ok(!JSON.stringify({ checks, logs }).includes("sentinel"));
  }
});
