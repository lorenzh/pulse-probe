# Troubleshooting

## `PULSE_PROBE_TOKEN or PULSE_PROBE_TOKEN_FILE must be set`

Cause: both variables are unset or blank. The probe exits with code 2.
Action: set `PULSE_PROBE_TOKEN` to the token that the API owner entered, or `PULSE_PROBE_TOKEN_FILE` to the path of a file that holds it. In Docker, pass `-e PULSE_PROBE_TOKEN='<token>'`. Replace `<token>` with the real token.

## `set only one of PULSE_PROBE_TOKEN and PULSE_PROBE_TOKEN_FILE`

Cause: both variables are set in the environment (`-e`, `--env-file`, Compose `environment:`/`env_file:`; from source also the shell or a `.env` in the working directory). The probe exits with code 2 and does not read the file.
Action: remove one of them. With a token file, remove `PULSE_PROBE_TOKEN` from all of these sources.

## `PULSE_PROBE_TOKEN_FILE=<path>: cannot read (<CODE>)`

Cause: the probe cannot read the file. `ENOENT`: it does not exist (check the path and the mount). `EACCES`: the probe user (uid 1000 in the image) may not read it. `EISDIR`: the path is a directory. Without a code the line ends in `cannot read`. The probe exits with code 2.
Action: fix the path, the mount or the file mode, for example `chmod 0444 probe-token.txt`, then restart the probe.

## `PULSE_PROBE_TOKEN_FILE=<path>: file is empty`

Cause: the file is empty or holds only whitespace. The probe exits with code 2.
Action: write the token into the file, for example with `openssl rand -hex 32 > probe-token.txt`, and give the same token to the API owner.

## `PULSE_PROBE_TOKEN_FILE=<path>: must hold one line`

Cause: the trimmed content holds a line break, so it is more than one token. The probe exits with code 2. A trailing newline alone is fine.
Action: leave only the token in the file, on one line.

## `PULSE_PROBE_TOKEN_FILE=<path>: must hold printable ASCII`

Also `PULSE_PROBE_TOKEN must hold printable ASCII` for the variable.
Cause: the trimmed token holds a character that is not printable ASCII (space to `~`): a NUL byte, a tab, a non-ASCII letter, or bytes that are not UTF-8. A file saved as UTF-16, for example by PowerShell `>`, or a path that points at the wrong file causes this too. Such a value cannot be sent as an `Authorization` header. The probe exits with code 2 and does not print the value.
Action: write the token as plain ASCII, for example with `openssl rand -hex 32 > probe-token.txt`. On Windows use `Set-Content -Encoding ascii`. Restart the probe.

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

Cause: the API answered something final other than 204 (and not 401 or 403), for example 400 for an invalid body. HTTP 429 and 5xx are not final: those results are buffered. On 404 (unknown or removed check) the probe reloads its checks at once.
Action: read the API log for the reason. After a checks change, restart only the API.

## `API unreachable or busy: buffering results`

Cause: a post failed (network error, 10 s timeout, HTTP 429 or 5xx). The probe keeps the results in memory and delivers them in order when the API answers; `buffer empty again` closes the episode.
Action: check that the API is reachable from the probe. Watch `pulse_probe_buffered_results` and `pulse_probe_results_dropped_total`. Results beyond `PULSE_BUFFER_MAX_RESULTS` or `PULSE_BUFFER_MAX_AGE_MS` are dropped, and a restart loses the buffer.

## A check is always `down` with `ECONNREFUSED` or `timeout after <n>ms`

Cause: the probe cannot reach the target from where it runs, or the target is slower than `timeoutMs` (default 5000 ms).
Action: test the URL from the probe's host. Raise `timeoutMs` in the API's checks file if needed.

## A check is `down` with `blocked: <category> address (PULSE_PROBE_BLOCK_PRIVATE_RANGES)`

`PULSE_PROBE_BLOCK_PRIVATE_RANGES` is on, and the check's host (or one of its DNS answers, or a redirect target with `redirect blocked:`) is in a blocked range. Point the check at a public address, run it from a probe with the setting off, or turn the setting off. See [blocking private ranges](configuration.md#blocking-private-ranges).

## New or changed checks do not run

Cause: the API reads its checks file at startup, and the probe reloads every `PULSE_CHECKS_RELOAD_MS` (default 60 s).
Action: restart the API, then wait one reload interval. Look for `reloading checks failed` in the probe log.

## No incident opens although a probe reports down

See [quorum and incidents](https://github.com/lorenzh/pulse-api/blob/main/docs/concepts.md#quorum-and-incidents). A single location decides alone, but an incident needs three consecutive down evaluations. With two or more locations in the window, at least two must report down.
