import { afterAll as after, test } from "bun:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Result } from "@lorenzh/pulse-contract";
import { runCheck } from "./check.ts";
import type { ProbeCheck } from "./client.ts";

let t = 0;
const now = (): number => (t += 7);
const sleep = async (): Promise<void> => {};

const servers: Server[] = [];
after(() => {
  for (const s of servers) s.close();
});

interface Hit {
  method: string | undefined;
  url: string | undefined;
  key: string | undefined;
  body: string;
}

/** A real server on 127.0.0.1:0; `handler` picks the answer from the path. */
async function serve(
  handler: (url: string, origin: string) => { status: number; location?: string },
): Promise<{ origin: string; hits: Hit[] }> {
  const hits: Hit[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      hits.push({
        method: req.method,
        url: req.url,
        key: req.headers["x-key"] as string | undefined,
        body: Buffer.concat(chunks).toString(),
      });
      const answer = handler(
        req.url ?? "",
        `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      );
      res.writeHead(answer.status, answer.location ? { location: answer.location } : {});
      res.end("ok");
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits };
}

const run = (check: Partial<ProbeCheck> & { url: string }): Promise<Result> =>
  runCheck(
    {
      id: "r",
      name: "R",
      intervalMs: 100_000,
      headers: { "X-Key": "sentinel-secret" },
      ...check,
    } as ProbeCheck,
    {
      fetch,
      now,
      monotonic: now,
      sleep,
      location: "default",
    },
  );

test("a cross-origin redirect with headers ends down and the target sees nothing", async () => {
  const other = await serve(() => ({ status: 200 }));
  const first = await serve(() => ({ status: 302, location: `${other.origin}/x?q=secret` }));
  const r = await run({ url: `${first.origin}/` });
  assert.equal(r.status, "down");
  assert.equal(r.statusCode, 302);
  assert.equal(r.reason, `redirect to ${other.origin} not followed`);
  assert.equal(other.hits.length, 0);
});

test("a redirect with a body is not followed across origins either", async () => {
  const other = await serve(() => ({ status: 200 }));
  const first = await serve(() => ({ status: 307, location: `${other.origin}/` }));
  const r = await run({
    url: `${first.origin}/`,
    method: "POST",
    body: "sentinel-body",
    headers: undefined,
  });
  assert.equal(r.status, "down");
  assert.equal(other.hits.length, 0);
});

// compat: passes on the code before the redirect rewrite; it guards behavior that must not change.
test("compat: a same-origin redirect keeps the header and is followed", async () => {
  const s = await serve((url) =>
    url === "/" ? { status: 302, location: "/next" } : { status: 200 },
  );
  const r = await run({ url: `${s.origin}/` });
  assert.equal(r.status, "up");
  assert.deepEqual(
    s.hits.map((h) => [h.url, h.key]),
    [
      ["/", "sentinel-secret"],
      ["/next", "sentinel-secret"],
    ],
  );
});

// compat: passes on the code before the redirect rewrite; it guards behavior that must not change.
test("compat: 307 same-origin keeps method and body", async () => {
  const s = await serve((url) =>
    url === "/" ? { status: 307, location: "/next" } : { status: 200 },
  );
  const r = await run({ url: `${s.origin}/`, method: "POST", body: "payload" });
  assert.equal(r.status, "up");
  assert.deepEqual(
    s.hits.map((h) => [h.method, h.body]),
    [
      ["POST", "payload"],
      ["POST", "payload"],
    ],
  );
});

test("a POST answered with 302 is down after one request", async () => {
  const s = await serve(() => ({ status: 302, location: "/next" }));
  const r = await run({ url: `${s.origin}/`, method: "POST", body: "b" });
  assert.equal(r.status, "down");
  assert.equal(r.statusCode, 302);
  assert.equal(r.reason, "HTTP 302 redirect not followed for POST");
  assert.equal(s.hits.length, 1);
});

test("a HEAD answered with 302 is not followed", async () => {
  const s = await serve(() => ({ status: 302, location: "/next" }));
  const r = await run({ url: `${s.origin}/`, method: "HEAD" });
  assert.equal(r.reason, "HTTP 302 redirect not followed for HEAD");
  assert.equal(s.hits.length, 1);
});

test("a redirect status in expectedStatus is judged, not followed", async () => {
  const s = await serve(() => ({ status: 302, location: "/next" }));
  const r = await run({ url: `${s.origin}/`, expectedStatus: [302] });
  assert.equal(r.status, "up");
  assert.equal(s.hits.length, 1);
});

test("more than 20 hops is down with too many redirects", async () => {
  const s = await serve(() => ({ status: 302, location: "/again" }));
  const r = await run({ url: `${s.origin}/` });
  assert.equal(r.status, "down");
  assert.equal(r.reason, "too many redirects");
  assert.equal(s.hits.length, 21);
});

test("an invalid Location is down", async () => {
  const s = await serve(() => ({ status: 302, location: "//[bad" }));
  const r = await run({ url: `${s.origin}/` });
  assert.equal(r.reason, "redirect to invalid location");
});

test("an https to http hop is not followed", async () => {
  const seen: string[] = [];
  const f = (async (u: string | URL | Request, i?: RequestInit) => {
    seen.push(String(u));
    assert.equal(i?.redirect, "manual");
    return new Response(null, { status: 302, headers: { location: "http://x.test/" } });
  }) as unknown as typeof fetch;
  const r = await runCheck(
    { id: "r", name: "R", url: "https://x.test/", intervalMs: 1000, headers: { "X-Key": "k" } },
    { fetch: f, now, monotonic: now, sleep, location: "default" },
  );
  assert.equal(r.reason, "redirect to http://x.test not followed");
  assert.deepEqual(seen, ["https://x.test/"]);
});

// compat: passes on the code before the redirect rewrite; it guards behavior that must not change.
test("compat: a check without headers and body still lets fetch follow redirects", async () => {
  const s = await serve((url) =>
    url === "/" ? { status: 302, location: "/next" } : { status: 200 },
  );
  const r = await run({ url: `${s.origin}/`, headers: undefined });
  assert.equal(r.status, "up");
  assert.equal(s.hits.length, 2);
});

// compat: passes on the code before the redirect rewrite; it guards behavior that must not change.
test("compat: no reason holds a header value or a body", async () => {
  const other = await serve(() => ({ status: 200 }));
  const first = await serve(() => ({ status: 307, location: `${other.origin}/` }));
  const r = await run({ url: `${first.origin}/`, method: "POST", body: "sentinel-body" });
  assert.ok(!JSON.stringify(r).includes("sentinel"));
});
