import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { type CheckDeps, DAY_MS, runCheck } from "./check.ts";

interface Rdap {
  url: string;
  hits: { bootstrap: number; domain: number };
  setDomain: (fn: (res: http.ServerResponse) => void) => void;
  setBootstrapFails: (fails: boolean) => void;
  close: () => Promise<void>;
}

const NOW = Date.UTC(2026, 0, 1);
let seq = 0;
const open: Rdap[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((r) => r.close()));
});

function events(daysFromNow: number | null): string {
  const list =
    daysFromNow === null
      ? [{ eventAction: "registration", eventDate: "2000-01-01T00:00:00Z" }]
      : [
          {
            eventAction: "expiration",
            eventDate: new Date(NOW + daysFromNow * DAY_MS).toISOString(),
          },
        ];
  return JSON.stringify({ events: list });
}

async function rdap(domainBody: () => string): Promise<Rdap> {
  const hits = { bootstrap: 0, domain: 0 };
  let domainHandler = (res: http.ServerResponse): void => {
    res.setHeader("content-type", "application/rdap+json");
    res.end(domainBody());
  };
  let isBootstrapFailing = false;
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith("/dns.json")) {
      hits.bootstrap++;
      if (isBootstrapFailing) {
        res.statusCode = 500;
        res.end();
        return;
      }
      const port = (server.address() as AddressInfo).port;
      res.end(
        JSON.stringify({
          services: [[["test"], [`http://ignored.test/`, `https://127.0.0.1:${port}/`]]],
        }),
      );
      return;
    }
    hits.domain++;
    domainHandler(res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const out: Rdap = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/dns.json?n=${seq++}`,
    hits,
    setDomain: (fn) => {
      domainHandler = fn;
    },
    setBootstrapFails: (fails) => {
      isBootstrapFailing = fails;
    },
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
  open.push(out);
  return out;
}

// The bootstrap lists an https URL; the test redirects every request to the local http server.
function localFetch(port: number): CheckDeps["fetch"] {
  return (input, init) => {
    const url = new URL(String(input));
    if (url.protocol === "https:") url.protocol = "http:";
    if (url.hostname === "127.0.0.1") url.port = String(port);
    return fetch(url, init);
  };
}

let mono = 0;
function depsFor(r: Rdap, over: Partial<CheckDeps> = {}): CheckDeps {
  const port = Number(new URL(r.url).port);
  return {
    fetch: localFetch(port),
    now: () => NOW,
    monotonic: () => mono,
    sleep: async () => {},
    location: "default",
    rdapBootstrapUrl: r.url,
    ...over,
  };
}

const domain = (extra: Record<string, unknown> = {}) => ({
  id: "m",
  name: "M",
  type: "domain" as const,
  domain: "example.test",
  warnDays: 30,
  intervalMs: 3_600_000,
  ...extra,
});

test("domain is up with the whole days left", async () => {
  const r = await rdap(() => events(90.5));
  const res = await runCheck(domain(), depsFor(r));
  assert.equal(res.status, "up");
  assert.equal(res.certDaysLeft, 90);
  assert.equal(res.reason, null);
});

test("domain is degraded at warnDays and up at warnDays + 1", async () => {
  const at = await rdap(() => events(30));
  const degraded = await runCheck(domain(), depsFor(at));
  assert.equal(degraded.status, "degraded");
  assert.equal(degraded.reason, "domain expires in 30 days");
  assert.equal(degraded.certDaysLeft, 30);
  const above = await rdap(() => events(31));
  assert.equal((await runCheck(domain(), depsFor(above))).status, "up");
});

test("domain is down and expired with a negative day count", async () => {
  const r = await rdap(() => events(-2.5));
  const res = await runCheck(domain(), depsFor(r));
  assert.equal(res.status, "down");
  assert.equal(res.reason, "domain expired");
  assert.equal(res.certDaysLeft, -3);
});

test("domain without an expiration event is unknown after the retries", async () => {
  const r = await rdap(() => events(null));
  const res = await runCheck(domain({ retries: 2 }), depsFor(r));
  assert.equal(res.status, "down");
  assert.equal(res.reason, "expiry date not found in RDAP answer");
  assert.equal(res.certDaysLeft, null);
  assert.equal(res.attempts, 3);
});

test("domain reports an RDAP HTTP error", async () => {
  const r = await rdap(() => "");
  r.setDomain((res) => {
    res.statusCode = 429;
    res.end();
  });
  const res = await runCheck(domain(), depsFor(r));
  assert.equal(res.reason, "RDAP 429");
});

test("domain follows at most three redirects", async () => {
  const r = await rdap(() => events(90));
  r.setDomain((res) => {
    res.statusCode = 302;
    res.setHeader("location", "/domain/example.test");
    res.end();
  });
  const res = await runCheck(domain(), depsFor(r));
  assert.equal(res.reason, "too many redirects");
  assert.equal(r.hits.domain, 4);
});

test("domain names a TLD without an RDAP service", async () => {
  const r = await rdap(() => events(90));
  const res = await runCheck(domain({ domain: "example.zz" }), depsFor(r));
  assert.equal(res.reason, "no RDAP service for .zz");
});

test("domain fetches the bootstrap once per day and keeps the stale map on failure", async () => {
  const r = await rdap(() => events(90));
  mono = 1000;
  const deps = depsFor(r);
  await runCheck(domain(), deps);
  await runCheck(domain(), deps);
  assert.equal(r.hits.bootstrap, 1);
  mono += DAY_MS;
  await runCheck(domain(), deps);
  assert.equal(r.hits.bootstrap, 2);
  mono += DAY_MS;
  r.setBootstrapFails(true);
  const res = await runCheck(domain(), deps);
  assert.equal(r.hits.bootstrap, 3);
  assert.equal(res.status, "up");
});

test("domain is down when the bootstrap fails and nothing is cached", async () => {
  const r = await rdap(() => events(90));
  r.setBootstrapFails(true);
  const res = await runCheck(domain(), depsFor(r));
  assert.equal(res.status, "down");
  assert.equal(res.reason, "RDAP bootstrap 500");
});

test("domain times out on a stalled RDAP server", async () => {
  const r = await rdap(() => events(90));
  r.setDomain(() => {});
  const res = await runCheck(domain({ timeoutMs: 50 }), depsFor(r));
  assert.equal(res.reason, "timeout after 50ms");
});

test("domain does not retry once shut down", async () => {
  const r = await rdap(() => events(null));
  const ctl = new AbortController();
  r.setDomain((res) => {
    ctl.abort();
    res.end(events(null));
  });
  const res = await runCheck(domain({ retries: 3 }), depsFor(r, { signal: ctl.signal }));
  assert.equal(res.status, "down");
  assert.equal(r.hits.domain, 1);
});
