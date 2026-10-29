import http from "node:http";

export const DEFAULT_HEALTH_HOST = "127.0.0.1";

export interface HealthSettings {
  port: number;
  host: string;
}

/** `ready: false` carries a short reason for the 503 body. */
export type Readiness = { ready: true } | { ready: false; reason: string };

export interface HealthDeps {
  readiness: () => Readiness;
  renderMetrics: () => string;
}

export interface HealthServer {
  /** The bound port (useful when `port` was 0). */
  port: number;
  close(): Promise<void>;
}

/** Reads PULSE_HEALTH_PORT and PULSE_HEALTH_HOST. Returns undefined when the port is unset or blank. */
export function parseHealthSettings(
  rawPort: string | undefined,
  rawHost: string | undefined,
): HealthSettings | undefined {
  const portText = (rawPort ?? "").trim();
  if (portText === "") return undefined;
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port > 65_535) {
    throw new Error("PULSE_HEALTH_PORT must be an integer from 0 to 65535");
  }
  const host = (rawHost ?? "").trim();
  return { port, host: host === "" ? DEFAULT_HEALTH_HOST : host };
}

function handle(deps: HealthDeps, req: http.IncomingMessage, res: http.ServerResponse): void {
  const path = (req.url ?? "").split("?")[0];
  if (req.method !== "GET" || (path !== "/healthz" && path !== "/metrics")) {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found\n");
    return;
  }
  if (path === "/metrics") {
    res
      .writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" })
      .end(deps.renderMetrics());
    return;
  }
  const readiness = deps.readiness();
  if (readiness.ready) res.writeHead(200, { "content-type": "text/plain" }).end("ok\n");
  else res.writeHead(503, { "content-type": "text/plain" }).end(`${readiness.reason}\n`);
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise<void>((done) => {
    server.close(() => done());
    server.closeAllConnections();
  });
}

/** Serves GET /healthz and GET /metrics. Rejects when the port cannot be bound. */
export function startHealthServer(
  settings: HealthSettings,
  deps: HealthDeps,
): Promise<HealthServer> {
  const server = http.createServer((req, res) => handle(deps, req, res));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(settings.port, settings.host, () => {
      server.off("error", reject);
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : settings.port;
      resolve({
        port,
        close: () => closeServer(server),
      });
    });
  });
}
