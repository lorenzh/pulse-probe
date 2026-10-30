import { connect } from "node:net";
import type { TcpCheck } from "@lorenzh/pulse-contract";
import { type Attempt, attemptSignal, errorCode, errorReason, isTimeoutError } from "./attempt.ts";

export interface TcpConnectOptions {
  host: string;
  port: number;
  signal: AbortSignal;
}

/** Opens a connection and closes it at once, writing nothing. Rejects on error or abort. */
export type TcpConnect = (options: TcpConnectOptions) => Promise<void>;

export const tcpConnect: TcpConnect = ({ host, port, signal }) =>
  new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    const onAbort = (): void => {
      socket.destroy();
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    socket.once("connect", () => {
      signal.removeEventListener("abort", onAbort);
      socket.destroy();
      resolve();
    });
    socket.once("error", (err) => {
      signal.removeEventListener("abort", onAbort);
      socket.destroy();
      reject(err);
    });
  });

export async function attemptTcp(
  check: TcpCheck,
  timeoutMs: number,
  connectFn: TcpConnect,
  shutdown?: AbortSignal,
): Promise<Attempt> {
  try {
    await connectFn({
      host: check.host,
      port: check.port,
      signal: attemptSignal(timeoutMs, shutdown),
    });
    return { status: "up", reason: null };
  } catch (err) {
    if (isTimeoutError(err)) return { status: "down", reason: `timeout after ${timeoutMs}ms` };
    const code = errorCode(err);
    if (code === "ECONNREFUSED")
      return { status: "down", reason: "connection refused (ECONNREFUSED)" };
    if (code === "ENOTFOUND") return { status: "down", reason: "host not found (ENOTFOUND)" };
    return { status: "down", reason: errorReason(err) };
  }
}
