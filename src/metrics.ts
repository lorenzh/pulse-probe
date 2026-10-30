import type { Result } from "@lorenzh/pulse-contract";
import { createRegistry, DURATION_BUCKETS_SECONDS } from "@lorenzh/pulse-kit";
import type { DropReason } from "./buffer.ts";
import type { ProbeCheck } from "./client.ts";

export { DURATION_BUCKETS_SECONDS };

export const CHECK_STATES = ["up", "degraded", "down"] as const;

export const DROP_REASONS = ["buffer_full", "too_old", "rejected"] as const;

export type PostMetricOutcome = "ok" | "rejected" | "unknown-check" | "error";

export interface Metrics {
  /** Makes `checks` the configured set; series of removed checks disappear. */
  setChecks(checks: ProbeCheck[]): void;
  recordResult(result: Result): void;
  recordPost(checkId: string, outcome: PostMetricOutcome): void;
  setBuffered(size: number): void;
  recordDrop(reason: DropReason): void;
  recordDeliveredLate(): void;
  /** Prometheus text format. Holds check ids only, never URLs, keywords or tokens. */
  render(): string;
}

export function createMetrics(): Metrics {
  const registry = createRegistry();
  const up = registry.gauge("pulse_up", "1 while the probe process runs.");
  const configured = registry.gauge(
    "pulse_probe_checks_configured",
    "Number of checks the probe runs.",
  );
  const status = registry.gauge(
    "pulse_probe_check_status",
    "Current state of each check (1 for the current state).",
  );
  const durations = registry.histogram(
    "pulse_probe_check_duration_seconds",
    "Check latency in seconds.",
  );
  const posted = registry.counter(
    "pulse_probe_results_posted_total",
    "Results posted to the API, by outcome.",
  );
  const buffered = registry.gauge(
    "pulse_probe_buffered_results",
    "Results waiting in the buffer for the API.",
  );
  const dropped = registry.counter(
    "pulse_probe_results_dropped_total",
    "Results dropped without delivery, by reason.",
  );
  const deliveredLate = registry.counter(
    "pulse_probe_results_delivered_late_total",
    "Results delivered from the buffer instead of a direct post.",
  );
  for (const reason of DROP_REASONS) dropped.inc({ reason }, 0);
  deliveredLate.inc({}, 0);
  let bufferedSize = 0;
  // Current state per configured check, in configuration order.
  const states = new Map<string, Result["status"] | undefined>();

  registry.collect(() => {
    up.set(1);
    buffered.set(bufferedSize);
    configured.set(states.size);
    for (const [id, current] of states) {
      for (const state of CHECK_STATES) {
        status.set(current === state ? 1 : 0, { check: id, state });
      }
    }
  });

  return {
    setChecks(checks) {
      const ids = new Set(checks.map((c) => c.id));
      for (const id of [...states.keys()]) {
        if (ids.has(id)) continue;
        states.delete(id);
        status.remove({ check: id });
        durations.remove({ check: id });
        posted.remove({ check: id });
      }
      for (const id of ids) if (!states.has(id)) states.set(id, undefined);
    },
    recordResult(result) {
      if (!states.has(result.checkId)) return;
      states.set(result.checkId, result.status);
      durations.observe(result.latencyMs / 1000, { check: result.checkId });
    },
    recordPost(checkId, outcome) {
      if (!states.has(checkId)) return;
      posted.inc({ check: checkId, outcome });
    },
    setBuffered(size) {
      bufferedSize = size;
    },
    recordDrop(reason) {
      dropped.inc({ reason });
    },
    recordDeliveredLate() {
      deliveredLate.inc();
    },
    render: () => registry.render(),
  };
}
