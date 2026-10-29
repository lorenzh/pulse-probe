# Operation

## Logs

The probe writes to standard error, each line prefixed with `[probe] `. There is no log level and no log file.

| Line                                                                                   | Meaning                                              |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `running <n> check(s) against <url> from location <location>`                          | Startup finished fetching the checks.                |
| `fetching checks failed: <reason>; retrying in 2000ms`                                 | The API is unreachable or answered badly at startup. |
| `dropping result for <id>: token rejected, check PULSE_PROBE_TOKEN and PULSE_LOCATION` | The API answered 401 or 403.                         |
| `dropping result for <id>: API answered HTTP <code>`                                   | The API did not answer 204.                          |
| `dropping result for <id>: <error>`                                                    | The post failed (network error or 10 s timeout).     |
| `check <id> failed unexpectedly: <error>`                                              | A check run threw. The check is rescheduled.         |
| `PULSE_PROBE_TOKEN is missing or empty`                                                | Fatal at startup, exit code 1.                       |

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

## Stopping

On `SIGINT` or `SIGTERM` the probe stops the scheduler and exits with code 0. A check that is running is abandoned.

## Locations

One probe is one location. How locations are combined is in [quorum and incidents](https://github.com/lorenzh/pulse-api/blob/main/docs/concepts.md#quorum-and-incidents).
