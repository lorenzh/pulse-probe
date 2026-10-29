# Troubleshooting

## `PULSE_PROBE_TOKEN is missing or empty`

Cause: the variable is unset or blank. The probe exits with code 1.
Action: set `PULSE_PROBE_TOKEN` to the token that the API owner entered. In Docker, pass `-e PULSE_PROBE_TOKEN=<token>`.

## `PULSE_LOCATION is longer than 64 characters`

Cause: the trimmed location is too long. The probe exits at startup.
Action: use a shorter name, and the same one in the API's tokens file.

## `token rejected, check PULSE_PROBE_TOKEN and PULSE_LOCATION`

Full line: `dropping result for <id>: token rejected, ...`.
Cause: the API answered 401 or 403. The token is unknown, or `PULSE_LOCATION` differs from the location of the token (an unset location means `default`).
Action: compare both values with the API's tokens file. The probe keeps running and drops every result until you fix them and restart it.

## `fetching checks failed: ... retrying in 2000ms`

Cause: pulse-api is down, `PULSE_API_URL` is wrong (the reason shows `HTTP <code>`, a network code such as `ECONNREFUSED`, or `unexpected response`), or a TLS check is invalid (`invalid tls check <id>`).
Action: fix the URL or start the API, or fix the check in the API's checks file and restart the API. The probe retries on its own. Inside Docker, `localhost` is the container; use `host.docker.internal` or the service name.

## `dropping result for <id>: API answered HTTP <code>`

Cause: the API answered something other than 204 (and not 401 or 403), for example 400 for an unknown check id or an invalid body.
Action: restart the API and then the probe if the checks changed, so both use the same check ids. Read the API log for the reason.

## `dropping result for <id>: <error>`

Cause: the post failed, for example `fetch failed` or a timeout after 10 seconds.
Action: check that the API is reachable from the probe.

## A check is always `down` with `ECONNREFUSED` or `timeout after <n>ms`

Cause: the probe cannot reach the target from where it runs, or the target is slower than `timeoutMs` (default 5000 ms).
Action: test the URL from the probe's host. Raise `timeoutMs` in the API's checks file if needed.

## New or changed checks do not run

Cause: the probe reads the checks once at startup.
Action: restart the API, then the probe.

## No incident opens although a probe reports down

See [quorum and incidents](https://github.com/lorenzh/pulse-api/blob/main/docs/concepts.md#quorum-and-incidents). A single location decides alone, but an incident needs three consecutive down evaluations. With two or more locations in the window, at least two must report down.
