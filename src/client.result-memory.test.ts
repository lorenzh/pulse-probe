// result post: encoded answers are classified with bounded peak memory in a fresh process per case.
import { afterAll, beforeAll, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { WIRE_VERSION, WIRE_VERSION_HEADER } from "@lorenzh/pulse-contract";

const BUDGET_MIB = 64;
const KILL_MS = 30_000;
const TEST_MS = 60_000;

interface CaseReport {
  name: string;
  outcome: string;
  growthMiB: number;
  mismatchLines: number;
  lines: number;
  hasToken: boolean;
}
interface Report {
  cases: CaseReport[];
  wholeGrowthMiB: number;
}
interface ChildReport extends Omit<CaseReport, "name"> {
  baselineMiB: number;
  peakMiB: number;
}

const servers: http.Server[] = [];
let targetHits = 0;
let report: Report | undefined;

function listen(handler: http.RequestListener): Promise<string> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    servers.push(server);
    server.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

function runChild(arg: string): Promise<ChildReport> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(import.meta.dir, "..", "test", "client-result-memory-child.ts"), arg],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    const killer = setTimeout(() => child.kill("SIGKILL"), KILL_MS);
    child.on("exit", (code) => {
      clearTimeout(killer);
      if (code !== 0) reject(new Error(`memory child exited with ${String(code)}`));
      else resolve(JSON.parse(out) as ChildReport);
    });
  });
}

beforeAll(async () => {
  const started = process.cpuUsage();
  const member = zstdCompressSync(Buffer.alloc(16 * 2 ** 20));
  const large = Buffer.concat(Array.from({ length: 16 }, () => member));
  const cpu = process.cpuUsage(started);
  expect((cpu.user + cpu.system) / 1e6).toBeLessThanOrEqual(0.1);

  const wire = { [WIRE_VERSION_HEADER]: String(WIRE_VERSION) };
  const encoded = { "content-encoding": "zstd", "content-length": String(large.length) };
  const target = await listen((_q, res) => {
    targetHits++;
    res.writeHead(204, wire);
    res.end();
  });
  const answer = (status: number, headers: Record<string, string>, body?: Buffer) =>
    listen((q, res) => {
      q.resume();
      q.on("end", () => {
        res.writeHead(status, headers);
        res.end(body);
      });
    });
  const cases = [
    { name: "M0", url: await answer(204, wire) },
    { name: "M1", url: await answer(200, { ...wire, ...encoded }, large) },
    { name: "M2", url: await answer(503, { [WIRE_VERSION_HEADER]: "999", ...encoded }, large) },
    {
      name: "M3",
      url: await answer(307, { ...wire, ...encoded, location: `${target}/results` }, large),
    },
  ];
  const token = `tok-${crypto.randomUUID()}`;
  const children: (ChildReport & { name: string })[] = [];
  for (const c of cases) {
    children.push({ name: c.name, ...(await runChild(JSON.stringify({ url: c.url, token }))) });
  }
  const first = children[0]?.baselineMiB ?? 0;
  report = {
    cases: children,
    wholeGrowthMiB: Math.max(...children.map((c) => c.peakMiB)) - first,
  };
  console.log(JSON.stringify(report));
}, TEST_MS);

afterAll(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

function reportOf(name: string): CaseReport {
  const found = report?.cases.find((c) => c.name === name);
  assert.ok(found !== undefined, `no report for ${name}`);
  assert.equal(found.hasToken, false);
  return found;
}

test(
  "small identity 204 is accepted with bounded memory",
  () => {
    const m0 = reportOf("M0");
    assert.equal(m0.outcome, "accepted");
    assert.equal(m0.lines, 0);
    assert.ok(m0.growthMiB <= BUDGET_MIB, `growth ${m0.growthMiB} MiB`);
  },
  TEST_MS,
);

test(
  "large encoded 200 is rejected with bounded memory",
  () => {
    const m1 = reportOf("M1");
    assert.equal(m1.outcome, "rejected");
    assert.ok(m1.growthMiB <= BUDGET_MIB, `growth ${m1.growthMiB} MiB`);
  },
  TEST_MS,
);

test(
  "large encoded 503 with a wire mismatch is retried with bounded memory",
  () => {
    const m2 = reportOf("M2");
    assert.equal(m2.outcome, "retry");
    assert.equal(m2.mismatchLines, 1);
    assert.ok(m2.growthMiB <= BUDGET_MIB, `growth ${m2.growthMiB} MiB`);
  },
  TEST_MS,
);

test(
  "large encoded 307 is refused with bounded memory",
  () => {
    const m3 = reportOf("M3");
    assert.equal(m3.outcome, "retry");
    assert.equal(targetHits, 0);
    assert.ok(m3.growthMiB <= BUDGET_MIB, `growth ${m3.growthMiB} MiB`);
  },
  TEST_MS,
);

test(
  "whole-child peak growth stays within 64 MiB",
  () => {
    const whole = report?.wholeGrowthMiB ?? Number.POSITIVE_INFINITY;
    assert.ok(whole <= BUDGET_MIB, `growth ${whole} MiB`);
  },
  TEST_MS,
);
