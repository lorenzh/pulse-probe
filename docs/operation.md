# Operation

## Logs

The probe writes JSON lines: `{"time":"<ISO 8601>","level":"info","msg":"...", ...fields}`. `debug` and `info` go to standard output, `warn` and `error` to standard error. `PULSE_LOG_LEVEL` (default `info`) sets the lowest level written. At `debug` the probe logs every check result with `check` (id), `status`, `latencyMs` and `location`, never the URL.

| Message                                                                                | Level | Meaning                                              |
| -------------------------------------------------------------------------------------- | ----- | ---------------------------------------------------- |
| `running <n> check(s) against <url> from location <location>`                          | info  | Startup finished fetching the checks.                |
| `fetching checks failed: <reason>; retrying in 10000ms`                                | warn  | The API is unreachable or answered badly at startup. |
| `dropping result for <id>: token rejected, check PULSE_PROBE_TOKEN and PULSE_LOCATION` | warn  | The API answered 401 or 403.                         |
| `dropping result for <id>: API answered HTTP <code>`                                   | warn  | The API did not answer 204.                          |
| `dropping result for <id>: <error>`                                                    | warn  | The post failed (network error or 10 s timeout).     |
| `check <id> failed unexpectedly: <error>`                                              | error | A check run threw. The check is rescheduled.         |

Dropped results are not queued or retried.

## State

The probe keeps no state on disk. A restart loses nothing except the results that were dropped.

## After the checks change

The API reads its checks file at startup. After the file changes, restart the API only. Each running probe reloads the checks on its own within `PULSE_CHECKS_RELOAD_MS` (default 60 s) and needs no restart.

## Changing the token or location

Both are read at startup. Restart the probe after changing `PULSE_PROBE_TOKEN` or `PULSE_LOCATION`.

Token rotation:

1. The API owner adds the new token and restarts the API.
2. Set the new `PULSE_PROBE_TOKEN` and restart the probe.
3. The API owner removes the old token and restarts the API again. The API reads its tokens only at startup, so the old token works until this restart. After it, the old token gets 401.

Between steps 1 and 3 the old token still works. Roll out in this order when you introduce tokens: give probes their tokens first (an old API ignores the header), then enable tokens on the API.

## Health and metrics

Set `PULSE_HEALTH_PORT` to start an HTTP listener (off by default). The Docker image enables it on port 9100 and has a `HEALTHCHECK` that fetches `/healthz`. Do not publish the port: `/metrics` holds check ids.

- `GET /healthz`: `200 ok` once the checks were fetched at least once and the probe is not shutting down, else `503` with a short reason. A failed post does not make the probe unhealthy.
- `GET /metrics`: Prometheus text. Counters reset on restart. Never a token, URL or keyword.

| Series                                            | Type      | Meaning                                                                                            |
| ------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------- |
| `pulse_up`                                        | gauge     | Always 1 while the process runs.                                                                   |
| `pulse_probe_checks_configured`                   | gauge     | Number of checks running.                                                                          |
| `pulse_probe_check_status{check,state}`           | gauge     | 1 for the current state (`up`, `degraded`, `down`), else 0.                                        |
| `pulse_probe_check_duration_seconds{check}`       | histogram | Check latency. Buckets 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10 s.                                      |
| `pulse_probe_results_posted_total{check,outcome}` | counter   | Posts by outcome: `ok`, `rejected` (non-204), `unknown-check` (404), `error` (network or timeout). |

## Exit codes

| Code | Meaning                                                                                                                                            |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Clean stop after `SIGINT` or `SIGTERM`.                                                                                                            |
| 2    | Configuration or startup error: one line `pulse-probe: <message>` naming the variable, no stack. This includes a health port that cannot be bound. |
| 1    | Unexpected runtime failure.                                                                                                                        |

Earlier versions exited with 1 on a bad token or reload interval.

## Stopping

The signal handlers are registered before anything else. On `SIGINT` or `SIGTERM` the probe turns `/healthz` to 503, stops the reloader and scheduler, aborts the running checks and posts, closes the health listener and exits with code 0. This also works while the startup fetch is still retrying. Waiting for in-flight work is bounded by 5 s; when the bound is hit the probe logs a warning and still exits 0. A second signal has no extra effect.

## Locations

One probe is one location. How locations are combined is in [quorum and incidents](https://github.com/lorenzh/pulse-api/blob/main/docs/concepts.md#quorum-and-incidents).
