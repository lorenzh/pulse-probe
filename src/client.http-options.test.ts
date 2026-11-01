import { test } from "bun:test";
import assert from "node:assert/strict";
import { runCheck } from "./check.ts";
import { loadChecks } from "./client.ts";
import { parseHeaderHosts } from "./header-hosts.ts";

const svcHosts = parseHeaderHosts(
  '{"PULSE_HEADER_SVC_TOKEN":["svc.test"],"PULSE_HEADER_X":["svc.test"]}',
);

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
  return { fetch: impl as unknown as typeof fetch, calls };
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
  headers: { "Content-Type": "application/json", Authorization: { env: "PULSE_HEADER_SVC_TOKEN" } },
};

test("loadChecks calls /probe/checks with the bearer token and copies the new fields", async () => {
  const a = api({ "/probe/checks": () => Response.json([rich], wire) });
  const checks = await loadChecks("https://api", {
    fetch: a.fetch,
    log: () => {},
    token: "probe-tok",
    headerHosts: svcHosts,
    env: { PULSE_HEADER_SVC_TOKEN: "Bearer s3" },
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
  for (const env of [{}, { PULSE_HEADER_SVC_TOKEN: "" }]) {
    logs.length = 0;
    const a = api({ "/probe/checks": () => Response.json([rich, ok], wire) });
    const checks = await loadChecks("https://api", {
      fetch: a.fetch,
      log: (m) => logs.push(m),
      token: "t",
      headerHosts: svcHosts,
      env,
    });
    assert.deepEqual(
      checks.map((c) => c.id),
      ["ok"],
    );
    assert.deepEqual(logs, [
      "skipping check p: header Authorization env PULSE_HEADER_SVC_TOKEN is not set",
    ]);
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
      headerHosts: svcHosts,
      env: { PULSE_HEADER_SVC_TOKEN: value },
    });
    assert.deepEqual(
      checks.map((c) => c.id),
      ["ok"],
    );
    assert.deepEqual(logs, [
      "skipping check p: header Authorization env PULSE_HEADER_SVC_TOKEN is not a valid header value",
    ]);
    assert.ok(!JSON.stringify({ checks, logs }).includes("sentinel"));
  }
});

test("loadChecks skips env names without the PULSE_HEADER_ prefix and never reads them", async () => {
  // The contract now rejects such names, so the check is skipped as invalid before any lookup.
  for (const variable of ["PULSE_PROBE_TOKEN", "HOME", "pulse_header_x"]) {
    const logs: string[] = [];
    const reads: string[] = [];
    const env = new Proxy({} as Record<string, string | undefined>, {
      get: (_t, key) => {
        reads.push(String(key));
        return "sentinel-secret";
      },
    });
    const check = { ...rich, headers: { "X-Key": { env: variable } } };
    const a = api({ "/probe/checks": () => Response.json([check], wire) });
    const checks = await loadChecks("https://api", {
      fetch: a.fetch,
      log: (m) => logs.push(m),
      token: "t",
      headerHosts: svcHosts,
      env,
    });
    assert.deepEqual(checks, []);
    assert.equal(logs.length, 1);
    assert.match(logs[0] ?? "", /^skipping invalid check p: /);
    assert.deepEqual(reads, []);
  }
});

// compat: passes on the code before the redirect rewrite; it guards behavior that must not change.
test("compat: loadChecks resolves PULSE_HEADER_X", async () => {
  const check = { ...rich, headers: { "X-Key": { env: "PULSE_HEADER_X" } } };
  const a = api({ "/probe/checks": () => Response.json([check], wire) });
  const checks = await loadChecks("https://api", {
    fetch: a.fetch,
    log: () => {},
    token: "t",
    headerHosts: svcHosts,
    env: { PULSE_HEADER_X: "v" },
  });
  assert.deepEqual(checks[0]?.headers, { "X-Key": "v" });
});

const sentinel = "Bearer sentinel-552";

/** A fake API serving one check on `url` with an env Authorization header, and a fake target. */
function boundSetup(url: () => string): {
  fetch: typeof fetch;
  targetCalls: { url: string; auth: string | null }[];
} {
  const targetCalls: { url: string; auth: string | null }[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const href = String(input);
    if (href.startsWith("https://api/")) {
      const check = {
        id: "b",
        name: "B",
        url: url(),
        intervalMs: 60_000,
        headers: { Authorization: { env: "PULSE_HEADER_T" } },
      };
      return Response.json([check], wire);
    }
    targetCalls.push({ url: href, auth: new Headers(init?.headers).get("authorization") });
    return new Response("ok");
  };
  return { fetch: impl as unknown as typeof fetch, targetCalls };
}

const checkDeps = (f: typeof fetch) => ({
  fetch: f,
  now: () => 1000,
  monotonic: () => 5,
  sleep: async () => {},
  location: "default",
});

test("an unbound env header is never sent; the check reports down with the denial", async () => {
  for (const policy of ['{"PULSE_HEADER_T":["a.test"]}', "{}", '{"PULSE_HEADER_T":[]}']) {
    const logs: string[] = [];
    const reads: string[] = [];
    const env = new Proxy({} as Record<string, string | undefined>, {
      get: (_t, key) => {
        reads.push(String(key));
        return sentinel;
      },
    });
    const s = boundSetup(() => "http://b.test/x?q=1");
    const [check] = await loadChecks("https://api", {
      fetch: s.fetch,
      log: (m) => logs.push(m),
      env,
      headerHosts: parseHeaderHosts(policy),
    });
    assert.ok(check !== undefined);
    assert.equal(check.headers, undefined);
    const result = await runCheck(check, checkDeps(s.fetch));
    assert.equal(s.targetCalls.length, 0);
    assert.deepEqual(reads, []);
    const reason = "header Authorization env PULSE_HEADER_T is not bound to host b.test";
    assert.deepEqual(result, {
      checkId: "b",
      timestamp: 1000,
      status: "down",
      statusCode: null,
      latencyMs: 0,
      reason,
      location: "default",
      attempts: 1,
    });
    assert.deepEqual(logs, [`check b: ${reason}; reporting down`]);
    const text = JSON.stringify({ result, logs, headers: check.headers ?? null });
    assert.ok(!text.includes("sentinel-552"));
    assert.ok(!text.includes("q=1"));
  }
});

test("a bound env header is sent; a reload that retargets to an unbound host sends nothing", async () => {
  let target = "http://a.test/x";
  const s = boundSetup(() => target);
  const deps = {
    fetch: s.fetch,
    log: () => {},
    env: { PULSE_HEADER_T: sentinel },
    headerHosts: parseHeaderHosts('{"PULSE_HEADER_T":["a.test"]}'),
  };
  const [first] = await loadChecks("https://api", deps);
  assert.ok(first !== undefined);
  await runCheck(first, checkDeps(s.fetch));
  assert.deepEqual(s.targetCalls, [{ url: "http://a.test/x", auth: sentinel }]);
  target = "http://b.test/x";
  const [second] = await loadChecks("https://api", deps);
  assert.ok(second !== undefined);
  const r = await runCheck(second, checkDeps(s.fetch));
  assert.equal(s.targetCalls.length, 1);
  assert.equal(r.status, "down");
  assert.equal(JSON.stringify(second).includes("sentinel-552"), false);
});

test("a header resolved before the denied one is dropped too", async () => {
  const check = {
    ...rich,
    url: "https://other.test/",
    headers: { "X-A": { env: "PULSE_HEADER_X" }, Authorization: { env: "PULSE_HEADER_SVC_TOKEN" } },
  };
  const hosts = parseHeaderHosts('{"PULSE_HEADER_X":["other.test"]}');
  const a = api({ "/probe/checks": () => Response.json([check], wire) });
  const [loaded] = await loadChecks("https://api", {
    fetch: a.fetch,
    log: () => {},
    token: "t",
    headerHosts: hosts,
    env: { PULSE_HEADER_X: "sentinel-x", PULSE_HEADER_SVC_TOKEN: "sentinel-y" },
  });
  assert.equal(loaded?.headers, undefined);
  assert.equal(
    loaded?.headerDenial,
    "header Authorization env PULSE_HEADER_SVC_TOKEN is not bound to host other.test",
  );
  assert.ok(!JSON.stringify(loaded).includes("sentinel"));
});
