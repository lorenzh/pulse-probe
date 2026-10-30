import type { Result } from "@lorenzh/pulse-contract";
import type { PostOutcome } from "./client.ts";

export const BACKOFF_START_MS = 1000;
export const BACKOFF_MAX_MS = 30_000;

export type DropReason = "buffer_full" | "too_old" | "rejected";

export interface BufferDeps {
  /** Posts one result once. The caller wires the real client and the shutdown signal. */
  post: (result: Result) => Promise<PostOutcome>;
  /** Wall clock in ms; compared with `result.timestamp`. */
  now: () => number;
  /** Waits `ms`; rejects when the shutdown signal aborts. */
  sleep: (ms: number) => Promise<void>;
  signal: AbortSignal;
  log: (message: string) => void;
  maxResults: number;
  maxAgeMs: number;
  /** Called after every post attempt, direct or from the buffer. */
  onPost: (result: Result, outcome: PostOutcome) => void;
  onDrop: (reason: DropReason) => void;
  onDeliveredLate: () => void;
  onSize: (size: number) => void;
}

export interface ResultBuffer {
  /** Posts directly while nothing is buffered; otherwise queues behind the buffer. */
  submit: (result: Result) => Promise<void>;
  /** Resolves when the sender has stopped. */
  idle: () => Promise<void>;
  /** Drops what is left, logs the count and returns it. Call after shutdown. */
  close: () => number;
}

export function createResultBuffer(deps: BufferDeps): ResultBuffer {
  const queue: Result[] = [];
  let sender: Promise<void> | undefined;
  let isBuffering = false;
  let delivered = 0;
  let dropped = 0;
  // The head being posted; a full buffer may evict it while the post is in flight.
  let inFlight: Result | undefined;

  const isTooOld = (r: Result): boolean => deps.now() - r.timestamp > deps.maxAgeMs;

  const drop = (reason: DropReason): void => {
    dropped++;
    deps.onDrop(reason);
  };

  const enqueue = (result: Result): void => {
    if (!isBuffering) {
      isBuffering = true;
      delivered = 0;
      dropped = 0;
      deps.log("API unreachable or busy: buffering results");
    }
    if (isTooOld(result)) {
      drop("too_old");
    } else {
      if (queue.length >= deps.maxResults) {
        const oldest = queue.shift();
        // The in-flight head is counted once, by sendHead, when its post ends.
        if (oldest !== undefined && oldest !== inFlight)
          drop(isTooOld(oldest) ? "too_old" : "buffer_full");
      }
      queue.push(result);
    }
    deps.onSize(queue.length);
  };

  const finishIfEmpty = (): void => {
    if (queue.length > 0 || !isBuffering) return;
    isBuffering = false;
    deps.log(`buffer empty again: ${delivered} delivered, ${dropped} dropped`);
  };

  const sendHead = async (head: Result): Promise<"sent" | "retry"> => {
    inFlight = head;
    let outcome: PostOutcome;
    try {
      outcome = await deps.post(head);
    } finally {
      inFlight = undefined;
    }
    deps.onPost(head, outcome);
    const isEvicted = queue[0] !== head;
    if (isEvicted) {
      // A full buffer evicted the head during the post: count its outcome here, once.
      if (outcome === "accepted") {
        delivered++;
        deps.onDeliveredLate();
      } else {
        drop(outcome === "retry" ? "buffer_full" : "rejected");
      }
    }
    if (outcome === "retry") return "retry";
    if (!isEvicted) {
      queue.shift();
      if (outcome === "accepted") {
        delivered++;
        deps.onDeliveredLate();
      } else {
        drop("rejected");
      }
      deps.onSize(queue.length);
    }
    return "sent";
  };

  const runSender = async (): Promise<void> => {
    let backoff = BACKOFF_START_MS;
    try {
      // The attempt that started the sender failed, so wait before the first retry.
      await deps.sleep(backoff);
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      while (queue.length > 0 && !deps.signal.aborted) {
        const head = queue[0];
        if (head === undefined) break;
        if (isTooOld(head)) {
          queue.shift();
          drop("too_old");
          deps.onSize(queue.length);
          continue;
        }
        if ((await sendHead(head)) === "sent") {
          backoff = BACKOFF_START_MS;
          continue;
        }
        await deps.sleep(backoff);
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      }
      if (!deps.signal.aborted) finishIfEmpty();
    } catch {
      // The backoff sleep rejects when shutdown aborts it; close() reports what is left.
    } finally {
      sender = undefined;
    }
  };

  const startSender = (): void => {
    if (sender !== undefined || deps.signal.aborted) return;
    sender = runSender();
  };

  return {
    async submit(result) {
      if (queue.length === 0 && sender === undefined) {
        const outcome = await deps.post(result);
        deps.onPost(result, outcome);
        if (outcome === "accepted") return;
        if (outcome !== "retry") {
          deps.onDrop("rejected");
          return;
        }
      }
      enqueue(result);
      startSender();
    },
    idle: async () => {
      await sender;
    },
    close() {
      const lost = queue.length;
      queue.length = 0;
      deps.onSize(0);
      if (lost > 0) deps.log(`shutting down: ${lost} buffered result(s) lost`);
      return lost;
    },
  };
}
