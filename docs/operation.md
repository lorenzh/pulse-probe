# Operation

## Logs

The probe writes JSON lines: `{"time":"<ISO 8601>","level":"info","msg":"...", ...fields}`. `debug` and `info` go to standard output, `warn` and `error` to standard error. `PULSE_LOG_LEVEL` (default `info`) sets the lowest level written. At `debug` the probe logs every check result with `check` (id), `status`, `latencyMs` and `location`, never the URL.

| Message                                                                                | Level | Meaning                                              |
| -------------------------------------------------------------------------------------- | ----- | ---------------------------------------------------- |
| `running <n> check(s) against <url> from location <location>`                          | info  | Startup finished fetching the checks.                |
| `fetching checks failed: <reason>; retrying in 10000ms`                                | warn  | The API is unreachable or answered badly at startup. |
| `dropping result for <id>: token rejected, check PULSE_PROBE_TOKEN and PULSE_LOCATION` | warn  | The API answered 401 or 403.                         |
| `dropping result for <id>: API answered HTTP <code>`                                   | warn  | The API did not answer 204.                          |
| `API unreachable or busy: buffering results`                                           | warn  | The first result was buffered after an empty buffer. |
| `buffer empty again: <n> delivered, <m> dropped`                                       | warn  | The buffer is empty; counts since buffering started. |
| `shutting down: <n> buffered result(s) lost`                                           | warn  | Shutdown with results still in the buffer.           |
| `check <id> failed unexpectedly: <error>`                                              | error | A check run threw. The check is rescheduled.         |

Retryable failures (network error, timeout, HTTP 429 or 5xx) write no line per result.

## Result buffer

- Results the probe cannot deliver wait in a bounded in-memory buffer (`PULSE_BUFFER_MAX_RESULTS`, `PULSE_BUFFER_MAX_AGE_MS`; see [configuration](configuration.md#result-buffer)). While the buffer is not empty, every new result queues behind it, so delivery keeps the order.
- One sender posts the oldest result first. After a failed attempt it waits 1 s, doubling up to 30 s, and starts again at 1 s after a success. `Retry-After` is ignored.
- A result that pulse-api rejects (400, 401, 403, 404 or any other non-204 answer that is not retryable) is dropped and counted `rejected`; it does not block the ones behind it.
- **Lost on restart or shutdown:** the buffer lives in memory only. On a restart or a stop the whole buffer is lost; the probe logs the count.
- **How replayed results appear:** pulse-api marks a result `late` only when it is older than the newest stored result of the same check and location. Results replayed in order are not late: they drive state, incidents and `consecutive_down` with their original timestamps. A replay can open or resolve an incident with an old timestamp, so notifications can arrive after the outage with old times. `late` shows only for out-of-order arrival. A few results in flight when buffering starts can arrive out of order; the API then marks the older one late (history only).
- pulse-api rejects results older than 7 days with 400. Keep `PULSE_BUFFER_MAX_AGE_MS` below that.
- Alerts: `pulse_probe_buffered_results > 0` for 10 minutes; `increase(pulse_probe_results_dropped_total[1h]) > 0`.

## State

The probe keeps no state on disk. A restart loses nothing except the results that were dropped.

## After the checks change

The API reads its checks file at startup. After the file changes, restart the API only. Each running probe reloads the checks on its own within `PULSE_CHECKS_RELOAD_MS` (default 60 s) and needs no restart.

## Changing the token or location

Both are read at startup. Restart the probe after changing `PULSE_PROBE_TOKEN`, `PULSE_PROBE_TOKEN_FILE` or `PULSE_LOCATION`. With a token file, replace the file content and restart the probe; the file is read only at startup.

Token rotation:

1. The API owner adds the new token and restarts the API.
2. Set the new `PULSE_PROBE_TOKEN`, or write the new token into the file of `PULSE_PROBE_TOKEN_FILE`, and restart the probe.
3. The API owner removes the old token and restarts the API again. The API reads its tokens only at startup, so the old token works until this restart. After it, the old token gets 401.

Between steps 1 and 3 the old token still works. Roll out in this order when you introduce tokens: give probes their tokens first (an old API ignores the header), then enable tokens on the API.

## Health and metrics

Set `PULSE_HEALTH_PORT` to start an HTTP listener (off by default). The Docker image enables it on port 9100 and has a `HEALTHCHECK` that fetches `/healthz` (liveness). Do not publish the port: `/metrics` holds check ids.

- `GET /healthz`: liveness. `200 ok` whenever the listener serves, also while the probe shuts down, until the listener closes. The Docker `HEALTHCHECK` uses it. **Breaking change of meaning:** it used to report readiness; use `/readyz` for that.
- `GET /readyz`: readiness. `200 ok` once the checks were fetched at least once and the probe is not shutting down, else `503` with a short reason. A failed post does not make the probe unready.
- `GET /metrics`: Prometheus text. Counters reset on restart. Never a token, URL or keyword.

| Series                                            | Type      | Meaning                                                                                                                             |
| ------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `pulse_up`                                        | gauge     | Always 1 while the process runs.                                                                                                    |
| `pulse_probe_checks_configured`                   | gauge     | Number of checks running.                                                                                                           |
| `pulse_probe_check_status{check,state}`           | gauge     | 1 for the current state (`up`, `degraded`, `down`), else 0.                                                                         |
| `pulse_probe_check_duration_seconds{check}`       | histogram | Check latency. Buckets 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10 s.                                                                       |
| `pulse_probe_results_posted_total{check,outcome}` | counter   | Post attempts by outcome: `ok`, `rejected` (final non-204), `unknown-check` (404), `error` (retryable: network, timeout, 429, 5xx). |
| `pulse_probe_buffered_results`                    | gauge     | Results waiting in the buffer.                                                                                                      |
| `pulse_probe_results_dropped_total{reason}`       | counter   | Results dropped: `buffer_full`, `too_old`, `rejected`. All three start at 0.                                                        |
| `pulse_probe_results_delivered_late_total`        | counter   | Results delivered from the buffer, not by a direct post.                                                                            |

## Exit codes

| Code | Meaning                                                                                                                                            |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Clean stop after `SIGINT` or `SIGTERM`.                                                                                                            |
| 2    | Configuration or startup error: one line `pulse-probe: <message>` naming the variable, no stack. This includes a health port that cannot be bound. |
| 1    | Unexpected runtime failure.                                                                                                                        |

Earlier versions exited with 1 on a bad token or reload interval.

## Stopping

The signal handlers are registered before anything else. On `SIGINT` or `SIGTERM` the probe turns `/readyz` to 503 (`/healthz` stays 200), stops the reloader and scheduler, aborts the running checks and posts, closes the health listener, drops the result buffer (logging how many results were lost) and exits with code 0. This also works while the startup fetch is still retrying. Waiting for in-flight work is bounded by 5 s; when the bound is hit the probe logs a warning and still exits 0. A second signal has no extra effect.

## Locations

One probe is one location. How locations are combined is in [quorum and incidents](https://github.com/lorenzh/pulse-api/blob/main/docs/concepts.md#quorum-and-incidents).

## Shared runtime (pulse-kit)

Startup, shutdown, the health listener, the metrics text and the logger come from `@lorenzh/pulse-kit`. Differences to earlier versions:

- `PULSE_HEALTH_PORT` and `PULSE_LOG_LEVEL` errors read `<NAME>: must be ...` (a colon after the name).
- A failure at startup other than a configuration error is logged as a JSON line `startup failed` with an `error` field, and the probe exits with 1.
- A log field named `time`, `level` or `msg` never replaces the base key.
- `/metrics` output is unchanged.
