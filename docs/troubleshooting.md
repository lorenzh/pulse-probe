# Troubleshooting

## `PULSE_PROBE_TOKEN is missing or empty`

Cause: the variable is unset or blank. The probe exits with code 2.
Action: set `PULSE_PROBE_TOKEN` to the token that the API owner entered. In Docker, pass `-e PULSE_PROBE_TOKEN='<token>'`. Replace `<token>` with the real token.

## `PULSE_LOCATION is longer than 64 characters`

Cause: the trimmed location is too long. The probe exits at startup.
Action: use a shorter name, and the same one in the API's tokens file.

## `token rejected, check PULSE_PROBE_TOKEN and PULSE_LOCATION`

Full line: `dropping result for <id>: token rejected, ...`.
Cause: the API answered 401 or 403. The token is unknown, or `PULSE_LOCATION` differs from the location of the token (an unset location means `default`).
Action: compare both values with the API's tokens file. The probe keeps running and drops every result until you fix them and restart it.

## `fetching checks failed: ... retrying in 10000ms`

Cause: pulse-api is down, `PULSE_API_URL` is wrong (the reason shows `HTTP <code>`, a network code such as `ECONNREFUSED`, or `unexpected response`), or the request timed out after 10 seconds (`timed out`).
Action: fix the URL or start the API. The probe retries on its own. After the first start it keeps the running checks and logs `reloading checks failed`. Inside Docker, `localhost` is the container; use `host.docker.internal` or the service name.

## `skipping invalid check: ...`

Cause: the API sent a check that fails the contract validator. The message names the field, for example `checks[3].intervalMs: must be an integer 1..2147483647` (`intervalMs` and `timeoutMs` accept 1 to 2147483647, the largest timer delay). The probe skips it and runs the others.
Action: fix the check in the API's checks file and restart the API. The probe picks it up on its next reload.

## `contract version mismatch: ...`

Cause: the API reports a different `x-pulse-contract` version than this probe was built for. The probe treats the fetch as failed and retries. Update the probe or the API so both use the same contract version. A mismatch on the `POST /results` response is logged and the result is handled as usual.

## `dropping result for <id>: API answered HTTP <code>`

Cause: the API answered something other than 204 (and not 401 or 403), for example 400 for an invalid body. On 404 (unknown or removed check) the probe reloads its checks at once.
Action: read the API log for the reason. After a checks change, restart only the API.

## `dropping result for <id>: <error>`

Cause: the post failed, for example `fetch failed` or a timeout after 10 seconds.
Action: check that the API is reachable from the probe.

## A check is always `down` with `ECONNREFUSED` or `timeout after <n>ms`

Cause: the probe cannot reach the target from where it runs, or the target is slower than `timeoutMs` (default 5000 ms).
Action: test the URL from the probe's host. Raise `timeoutMs` in the API's checks file if needed.

## New or changed checks do not run

Cause: the API reads its checks file at startup, and the probe reloads every `PULSE_CHECKS_RELOAD_MS` (default 60 s).
Action: restart the API, then wait one reload interval. Look for `reloading checks failed` in the probe log.

## No incident opens although a probe reports down

See [quorum and incidents](https://github.com/lorenzh/pulse-api/blob/main/docs/concepts.md#quorum-and-incidents). A single location decides alone, but an incident needs three consecutive down evaluations. With two or more locations in the window, at least two must report down.
