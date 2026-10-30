import assert from "node:assert/strict";
import { test } from "node:test";
import type { Result } from "@lorenzh/pulse-contract";
import { runCheck } from "./check.ts";
import type { ProbeCheck } from "./client.ts";

let t = 0;
const now = (): number => (t += 7);
const sleep = async (): Promise<void> => {};

interface Seen {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: unknown;
}

function fake(status: number, body: string | null = null, seen: Seen[] = []) {
  const impl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    seen.push({
      url: String(url),
      method: init?.method,
      headers: { ...(init?.headers as Record<string, string>) },
      body: init?.body,
    });
    return new Response(body, { status });
  };
  return { fetch: impl as typeof fetch, seen };
}

const base = { id: "h", name: "H", url: "https://x.test/", intervalMs: 100_000 };
const run = (check: ProbeCheck, f: typeof fetch): Promise<Result> =>
  runCheck(check, { fetch: f, now, monotonic: now, sleep, location: "default" });

test("sends method, headers, body and the probe user agent", async () => {
  const f = fake(200);
  const r = await run(
    {
      ...base,
      method: "POST",
      headers: { Authorization: "Bearer sentinel-secret", "user-agent": "evil" },
      body: '{"a":1}',
    },
    f.fetch,
  );
  assert.equal(r.status, "up");
  assert.equal(f.seen[0]?.method, "POST");
  assert.equal(f.seen[0]?.body, '{"a":1}');
  assert.equal(f.seen[0]?.headers.Authorization, "Bearer sentinel-secret");
  assert.match(f.seen[0]?.headers["user-agent"] ?? "", /^pulse-probe/);
});

test("defaults to GET without a body", async () => {
  const f = fake(200);
  await run(base, f.fetch);
  assert.equal(f.seen[0]?.method, "GET");
  assert.equal(f.seen[0]?.body, undefined);
});

test("HEAD never reads a body", async () => {
  const f = fake(200);
  const r = await run({ ...base, method: "HEAD" }, f.fetch);
  assert.equal(r.status, "up");
  assert.equal(f.seen[0]?.method, "HEAD");
});

test("expectedStatus accepts a listed code and a range", async () => {
  const list = { ...base, expectedStatus: [201, "300-399"] } satisfies ProbeCheck;
  assert.equal((await run(list, fake(201).fetch)).status, "up");
  assert.equal((await run(list, fake(302).fetch)).status, "up");
  const r = await run(list, fake(200).fetch);
  assert.equal(r.status, "down");
  assert.equal(r.statusCode, 200);
  assert.equal(r.reason, "HTTP 200 not in 201, 300-399");
});

test("a default check reports HTTP 503 not in 200-299", async () => {
  const r = await run(base, fake(503).fetch);
  assert.equal(r.reason, "HTTP 503 not in 200-299");
});

test("a 404 is up when expectedStatus is 404", async () => {
  const r = await run({ ...base, expectedStatus: [404] }, fake(404).fetch);
  assert.equal(r.status, "up");
});

test("a redirect is judged on the final status", async () => {
  const impl = async (): Promise<Response> => {
    const res = new Response("", { status: 200 });
    Object.defineProperty(res, "redirected", { value: true });
    return res;
  };
  const r = await run({ ...base, expectedStatus: [200] }, impl as typeof fetch);
  assert.equal(r.status, "up");
});

const json = (check: Partial<ProbeCheck> & object, body: string, status = 200) =>
  run({ ...base, method: "POST", body: "{}", ...check } as ProbeCheck, fake(status, body).fetch);

test("jsonAssert equals passes and fails with the documented reason", async () => {
  const asserts = [{ pointer: "/status", equals: "ok" }];
  assert.equal((await json({ jsonAssert: asserts }, '{"status":"ok"}')).status, "up");
  const r = await json({ jsonAssert: asserts }, '{"status":"degraded"}');
  assert.equal(r.status, "down");
  assert.equal(r.statusCode, 200);
  assert.equal(r.reason, 'json /status: expected "ok", got "degraded"');
});

test("jsonAssert compares numbers, null and objects deeply and strictly", async () => {
  const doc = '{"n":1,"z":null,"o":{"a":[1,{"b":2}]}}';
  const ok = [
    { pointer: "/n", equals: 1 },
    { pointer: "/z", equals: null },
    { pointer: "/o", equals: { a: [1, { b: 2 }] } },
    { pointer: "/o/a/1/b", equals: 2 },
    { pointer: "", equals: JSON.parse(doc) },
  ];
  assert.equal((await json({ jsonAssert: ok }, doc)).status, "up");
  const strict = await json({ jsonAssert: [{ pointer: "/n", equals: "1" }] }, doc);
  assert.equal(strict.reason, 'json /n: expected "1", got 1');
  const nul = await json({ jsonAssert: [{ pointer: "/z", equals: 0 }] }, doc);
  assert.equal(nul.reason, "json /z: expected 0, got null");
});

test("jsonAssert reports missing values and exists", async () => {
  const doc = '{"a":{"b/c":1}}';
  const miss = await json({ jsonAssert: [{ pointer: "/x", equals: 1 }] }, doc);
  assert.equal(miss.reason, "json /x: expected 1, got missing");
  const ex = await json({ jsonAssert: [{ pointer: "/x", exists: true }] }, doc);
  assert.equal(ex.reason, "json /x: missing");
  const ok = await json({ jsonAssert: [{ pointer: "/a/b~1c", exists: true }] }, doc);
  assert.equal(ok.status, "up");
});

test("jsonAssert reports an invalid body", async () => {
  const asserts = [{ pointer: "", exists: true as const }];
  assert.equal((await json({ jsonAssert: asserts }, "<html>")).reason, "json: invalid body");
  const big = `"${"a".repeat(1_048_600)}"`;
  assert.equal((await json({ jsonAssert: asserts }, big)).reason, "json: invalid body");
});

test("jsonAssert truncates quoted response values to 80 characters", async () => {
  const long = "x".repeat(200);
  const r = await json({ jsonAssert: [{ pointer: "/v", equals: "y" }] }, `{"v":"${long}"}`);
  const expectedGot = `"${"x".repeat(79)}…`;
  assert.equal(r.reason, `json /v: expected "y", got ${expectedGot}`);
});

test("the first failing assertion decides", async () => {
  const asserts = [
    { pointer: "/a", equals: 1 },
    { pointer: "/b", equals: 2 },
  ];
  const r = await json({ jsonAssert: asserts }, '{"a":0,"b":0}');
  assert.equal(r.reason, "json /a: expected 1, got 0");
});

test("keyword is checked before jsonAssert on the same body", async () => {
  const asserts = [{ pointer: "/a", equals: 1 }];
  const miss = await json({ keyword: "nope", jsonAssert: asserts }, '{"a":2}');
  assert.equal(miss.reason, 'keyword "nope" not found');
  const bad = await json({ keyword: "a", jsonAssert: asserts }, '{"a":2}');
  assert.equal(bad.reason, "json /a: expected 1, got 2");
  assert.equal((await json({ keyword: "a", jsonAssert: asserts }, '{"a":1}')).status, "up");
});

test("a status failure wins over assertions", async () => {
  const r = await json({ jsonAssert: [{ pointer: "/a", exists: true }] }, "{}", 503);
  assert.equal(r.reason, "HTTP 503 not in 200-299");
});

test("secrets never reach the result or the reason", async () => {
  const secret = "sentinel-secret-value";
  const bodySecret = "sentinel-body-value";
  const f = fake(200, '{"status":"degraded"}');
  const r = await run(
    {
      ...base,
      method: "POST",
      headers: { Authorization: secret },
      body: bodySecret,
      jsonAssert: [{ pointer: "/status", equals: "ok" }],
    },
    f.fetch,
  );
  const text = JSON.stringify(r);
  assert.ok(!text.includes(secret));
  assert.ok(!text.includes(bodySecret));
  const failing = await run({ ...base, headers: { Authorization: secret } }, (async () => {
    throw Object.assign(new Error(`bad ${secret}`), { cause: { code: "ECONNRESET" } });
  }) as typeof fetch);
  assert.equal(failing.reason, "ECONNRESET");
});
