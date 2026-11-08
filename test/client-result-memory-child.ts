// result post: an encoded answer is classified with bounded peak memory.
import type { Result } from "@lorenzh/pulse-contract";
import { postResult } from "../src/client.ts";

const MIB = 2 ** 20;
const KIB = 1024;
const SAMPLE_MS = 4;
const WINDOW_MS = 1000;

const arg = process.argv[2];
if (arg === undefined) throw new Error("missing case");
const { url, token } = JSON.parse(arg) as { url: string; token: string };

const result: Result = {
  checkId: "memory",
  timestamp: 5,
  status: "up",
  statusCode: 204,
  latencyMs: 3,
  reason: null,
  location: "default",
  attempts: 1,
};

Bun.gc(true);
const baseline = process.memoryUsage().rss;
const startMax = process.resourceUsage().maxRSS * KIB;
let peak = baseline;
const sample = (): void => {
  const max = process.resourceUsage().maxRSS * KIB;
  peak = Math.max(peak, process.memoryUsage().rss, max > startMax ? max : 0);
};
sample();
const sampler = setInterval(sample, SAMPLE_MS);
const logs: string[] = [];
const outcome = await postResult(url, result, { fetch, log: (m) => logs.push(m), token });
await new Promise((r) => setTimeout(r, WINDOW_MS));
clearInterval(sampler);
sample();

process.stdout.write(
  `${JSON.stringify({
    outcome,
    baselineMiB: Math.floor(baseline / MIB),
    peakMiB: Math.floor(peak / MIB),
    growthMiB: Math.floor((peak - baseline) / MIB),
    mismatchLines: logs.filter((l) => l.includes("contract version mismatch")).length,
    lines: logs.length,
    hasToken: logs.some((l) => l.includes(token)),
  })}\n`,
);
