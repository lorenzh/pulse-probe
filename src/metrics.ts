import type { Check, Result } from "@lorenzh/pulse-contract";

export const DURATION_BUCKETS_SECONDS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;

export const CHECK_STATES = ["up", "degraded", "down"] as const;

export type PostMetricOutcome = "ok" | "rejected" | "unknown-check" | "error";

export interface Metrics {
  /** Makes `checks` the configured set; series of removed checks disappear. */
  setChecks(checks: Check[]): void;
  recordResult(result: Result): void;
  recordPost(checkId: string, outcome: PostMetricOutcome): void;
  /** Prometheus text format. Holds check ids only, never URLs, keywords or tokens. */
  render(): string;
}

interface Histogram {
  /** Cumulative counts, one per bucket. */
  buckets: number[];
  count: number;
  sum: number;
}

function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
}

export function createMetrics(): Metrics {
  const status = new Map<string, Result["status"] | undefined>();
  const durations = new Map<string, Histogram>();
  const posted = new Map<string, number>();

  const renderStatus = (lines: string[]): void => {
    lines.push(
      "# HELP pulse_probe_check_status Current state of each check (1 for the current state).",
      "# TYPE pulse_probe_check_status gauge",
    );
    for (const [id, current] of status) {
      for (const state of CHECK_STATES) {
        lines.push(
          `pulse_probe_check_status{check="${escapeLabel(id)}",state="${state}"} ${current === state ? 1 : 0}`,
        );
      }
    }
  };

  const renderDurations = (lines: string[]): void => {
    lines.push(
      "# HELP pulse_probe_check_duration_seconds Check latency in seconds.",
      "# TYPE pulse_probe_check_duration_seconds histogram",
    );
    for (const [id, h] of durations) {
      const label = `check="${escapeLabel(id)}"`;
      for (const [i, bound] of DURATION_BUCKETS_SECONDS.entries()) {
        lines.push(
          `pulse_probe_check_duration_seconds_bucket{${label},le="${bound}"} ${h.buckets[i] ?? 0}`,
        );
      }
      lines.push(
        `pulse_probe_check_duration_seconds_bucket{${label},le="+Inf"} ${h.count}`,
        `pulse_probe_check_duration_seconds_sum{${label}} ${h.sum}`,
        `pulse_probe_check_duration_seconds_count{${label}} ${h.count}`,
      );
    }
  };

  return {
    setChecks(checks) {
      const ids = new Set(checks.map((c) => c.id));
      for (const id of [...status.keys()]) if (!ids.has(id)) status.delete(id);
      for (const id of [...durations.keys()]) if (!ids.has(id)) durations.delete(id);
      for (const key of [...posted.keys()]) {
        const [id = ""] = JSON.parse(key) as string[];
        if (!ids.has(id)) posted.delete(key);
      }
      for (const id of ids) if (!status.has(id)) status.set(id, undefined);
    },
    recordResult(result) {
      if (!status.has(result.checkId)) return;
      status.set(result.checkId, result.status);
      const h = durations.get(result.checkId) ?? {
        buckets: DURATION_BUCKETS_SECONDS.map(() => 0),
        count: 0,
        sum: 0,
      };
      const seconds = result.latencyMs / 1000;
      for (const [i, bound] of DURATION_BUCKETS_SECONDS.entries()) {
        if (seconds <= bound) h.buckets[i] = (h.buckets[i] ?? 0) + 1;
      }
      h.count++;
      h.sum += seconds;
      durations.set(result.checkId, h);
    },
    recordPost(checkId, outcome) {
      if (!status.has(checkId)) return;
      const key = JSON.stringify([checkId, outcome]);
      posted.set(key, (posted.get(key) ?? 0) + 1);
    },
    render() {
      const lines = [
        "# HELP pulse_up 1 while the probe process runs.",
        "# TYPE pulse_up gauge",
        "pulse_up 1",
        "# HELP pulse_probe_checks_configured Number of checks the probe runs.",
        "# TYPE pulse_probe_checks_configured gauge",
        `pulse_probe_checks_configured ${status.size}`,
      ];
      renderStatus(lines);
      renderDurations(lines);
      lines.push(
        "# HELP pulse_probe_results_posted_total Results posted to the API, by outcome.",
        "# TYPE pulse_probe_results_posted_total counter",
      );
      for (const [key, value] of posted) {
        const [id = "", outcome = ""] = JSON.parse(key) as string[];
        lines.push(
          `pulse_probe_results_posted_total{check="${escapeLabel(id)}",outcome="${outcome}"} ${value}`,
        );
      }
      return `${lines.join("\n")}\n`;
    },
  };
}
