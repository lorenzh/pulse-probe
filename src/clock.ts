// Wall clock for result timestamps and TLS expiry; monotonic clock for scheduling and latency.
export const now = (): number => Date.now();
export const monotonic = (): number => performance.now();
