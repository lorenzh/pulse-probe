// Child process of src/client.result-memory.test.ts. It posts one result per case with the real
// postResult and prints one JSON report: outcomes, RSS growth in MiB and booleans, never inputs.
// Real time is used only to sample RSS (every 4 ms, so at least every 5 ms, until 1000 ms after the call returns).
import type { Result } from "@lorenzh/pulse-contract";
import { postResult } from "../src/client.ts";

interface Case {
  name: string;
  url: string;
}

const MIB = 2 ** 20;
const SAMPLE_MS = 4;
const WINDOW_MS = 1000;

const arg = process.argv[2];
if (arg === undefined) throw new Error("missing case list");
const { cases, token } = JSON.parse(arg) as { cases: Case[]; token: string };

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

const reports: Record<string, unknown>[] = [];
let firstBaseline: number | undefined;
let wholePeak = 0;

for (const c of cases) {
  Bun.gc(true);
  const baseline = process.memoryUsage().rss;
  firstBaseline ??= baseline;
  let peak = baseline;
  const sample = (): void => {
    peak = Math.max(peak, process.memoryUsage().rss);
  };
  sample();
  const sampler = setInterval(sample, SAMPLE_MS);
  const logs: string[] = [];
  const outcome = await postResult(c.url, result, { fetch, log: (m) => logs.push(m), token });
  await new Promise((r) => setTimeout(r, WINDOW_MS));
  clearInterval(sampler);
  sample();
  wholePeak = Math.max(wholePeak, peak);
  reports.push({
    name: c.name,
    outcome,
    growthMiB: Math.floor((peak - baseline) / MIB),
    mismatchLines: logs.filter((l) => l.includes("contract version mismatch")).length,
    lines: logs.length,
    hasToken: logs.some((l) => l.includes(token)),
  });
}

const wholeGrowthMiB = Math.floor((wholePeak - (firstBaseline ?? wholePeak)) / MIB);
process.stdout.write(`${JSON.stringify({ cases: reports, wholeGrowthMiB })}\n`);
