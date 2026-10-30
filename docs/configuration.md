# Configuration

## Environment variables

These are all the variables the code reads (`src/main.ts`).

| Variable                 | Default                 | Meaning                                                                                                                                        |
| ------------------------ | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `PULSE_API_URL`          | `http://localhost:3000` | Base URL of pulse-api. Must be an http(s) URL without credentials, query or fragment; empty or invalid exits 2. The trailing slash is removed. |
| `PULSE_LOCATION`         | `default`               | Name of this probe's location (trimmed, case-sensitive, at most 64 characters).                                                                |
| `PULSE_PROBE_TOKEN`      | none (required)         | Secret token that authorizes this probe to post results to pulse-api.                                                                          |
| `PULSE_CHECKS_RELOAD_MS` | `60000`                 | How often the probe reloads the checks from pulse-api, in ms. Integer, 5000 to 2147483647.                                                     |
| `PULSE_LOG_LEVEL`        | `info`                  | `debug`, `info`, `warn` or `error`. Any other value is a startup error.                                                                        |
| `PULSE_HEALTH_PORT`      | unset (no listener)     | Port of the optional health and metrics listener, 0 to 65535. The Docker image sets 9100.                                                      |
| `PULSE_HEALTH_HOST`      | `127.0.0.1`             | Address the listener binds to. The Docker image sets `0.0.0.0`.                                                                                |

A bad value exits with code 2 and one line `pulse-probe: <message>` naming the variable. See [operation](operation.md#exit-codes).

If the health listener cannot bind (port in use, no permission, unknown address), the probe exits with code 2 and `pulse-probe: cannot listen on <host>:<port> (PULSE_HEALTH_HOST/PULSE_HEALTH_PORT): PULSE_HEALTH_PORT: cannot listen (EADDRINUSE)`. The last code is `EADDRINUSE`, `EACCES` or `EADDRNOTAVAIL`.

## Checks reload

- The probe reloads the checks the same way (`GET /probe/checks`, falling back to `GET /checks`) every `PULSE_CHECKS_RELOAD_MS` and follows the result: it starts added checks, stops removed ones and restarts checks whose settings changed. Unchanged checks keep their schedule.
- A value below 5000, above 2147483647 (the largest timer delay) or one that is not an integer makes the probe exit at startup with `PULSE_CHECKS_RELOAD_MS must be an integer from 5000 to 2147483647`.
- A failed reload keeps the running checks, is logged and is retried after 10 seconds (or the interval, if shorter).
- When the API answers 404 for a result (the check is unknown or no longer active), the probe reloads at once, at most every 5 seconds.
- The probe fetches `GET /probe/checks` with the Bearer token, which serves headers and bodies. When the API answers 404 (an older API), the probe falls back to the public `GET /checks`. Any other failure is retried. `GET /checks` goes through the shared `fetchJson` client of pulse-contract. A request times out after 10 seconds (headers and body). A body above 5 MiB fails the fetch and is retried. The HTTP status is checked before the version header. Each check is validated with the validators of pulse-contract. An invalid check is skipped and logged with the contract's error, for example `checks[3].intervalMs: must be an integer 1..2147483647`. The probe also reads the `x-pulse-contract` header of the response: a missing header is logged once, a different version counts as a failed fetch and is retried. A version mismatch on the `POST /results` response is logged only.

## Location

- The value is trimmed. Unset or blank means `default`.
- More than 64 characters makes the probe exit at startup with `PULSE_LOCATION is longer than 64 characters`.
- Every result carries the location. Check requests send `User-Agent: pulse-probe (<location>)`.
- The location is not validated against the API at startup. The API checks it against the token.

How the API combines locations is described in [quorum and incidents](https://github.com/lorenzh/pulse-api/blob/main/docs/concepts.md#quorum-and-incidents). A single probe decides alone; with two or more locations reporting in the window, a check is down only when at least two report it down.

## Probe token

See also [locations and tokens](https://github.com/lorenzh/pulse-api/blob/main/docs/concepts.md#locations-and-tokens).

- The probe sends the token as `Authorization: Bearer <token>` on `POST /results`. It also sends it on `GET /probe/checks` (see below). It does not send it on the public `GET /checks`.
- The value is trimmed. Missing or blank makes the probe exit at startup with `PULSE_PROBE_TOKEN is missing or empty`. The message never contains the value.
- Create a token with `openssl rand -hex 32`. The API owner enters it, with the probe's location, in the API's tokens file.
- `PULSE_LOCATION` must equal the location of the token. Otherwise the API answers 403 for every result.
- The token is never logged. It travels in clear over plain HTTP, so run the API behind TLS or on a private network.

## Checks

The probe has no check configuration of its own. It fetches the checks once at startup from `GET /probe/checks` on the API (with the probe token; an API that answers 404 gets the public `GET /checks` instead) and retries every 10000 ms until that succeeds, logging `fetching checks failed: <reason>; retrying in 10000ms` each time. The checks are defined in the API's checks file.

### HTTP checks

Fields used: `id`, `name`, `url`, `intervalMs`, and optionally `timeoutMs`, `latencyObjectiveMs`, `retries`, `retryDelayMs`, `keyword`, `method`, `headers`, `body`, `expectedStatus`, `jsonAssert`.

- Each run is an HTTP request with `method` (default GET). Redirects are followed. The default timeout is 5000 ms.
- A final status in `expectedStatus` (default `200-299`) is `up`. Anything else is `down` with reason `HTTP <code> not in <expectedStatus joined with ", ">`, for example `HTTP 503 not in 200-299`, `timeout after <n>ms`, or the error code (for example `ECONNREFUSED`). An error without a code gives `request error`; the error message is never used, because it can quote a header value or the body.
- If `latencyObjectiveMs` is set and the measured `latencyMs` is strictly above it, the result is `degraded` with reason `latency <n>ms over objective <m>ms`. Equal to the objective is still `up`. An objective at or above `timeoutMs` can never be reached, so the check is never degraded.

### Keyword

With `keyword` set, a 2xx answer is `up` only when its body contains the keyword.

- The match is a plain, case-sensitive substring on the body of the final response (after redirects). The body is decoded as UTF-8. There is no content-type filter.
- The probe reads at most 1 MiB (1,048,576 bytes) of the body and stops as soon as the keyword is found. A keyword that is not found within that limit, including one that straddles it, counts as not found.
- A missing keyword is `down` (never `degraded`) with the 2xx `statusCode` and reason `keyword "<text>" not found`. Retries apply as for any failed attempt.
- A status outside `expectedStatus` keeps reason `HTTP <code> not in <list>`. A timeout or read error while reading the body keeps the timeout or error reason.
- `latencyMs` includes the time to read the body, so a found keyword can still lead to `degraded`.
- Without `keyword` and `jsonAssert` the body is not read. TLS checks have no keyword.

### Request options

- `method`: GET (default), HEAD, POST, PUT, PATCH, DELETE or OPTIONS. `body` is sent as written. There is no default `Content-Type`; set it in `headers`.
- `headers`: a value is a literal string or `{ "env": "NAME" }`. `NAME` must start with `PULSE_HEADER_` (case-sensitive); the probe never reads another variable for a header. The probe resolves `NAME` from its own process environment each time it loads the checks, so a secret lives in the probe environment and never in the API. The variable replaces the whole header value, so a bearer token needs the scheme in the variable (`PULSE_HEADER_SVC_TOKEN="Bearer <token>"`). If the variable is unset or empty, the probe skips that check and logs `skipping check <id>: header <Name> env NAME is not set` (names only). A value that is not a valid header value (for example one with a CR, LF or TAB) skips the check with `... env NAME is not a valid header value`. A name without the prefix skips the check with `... env NAME must start with PULSE_HEADER_`. Set the variable in every probe location. Literal header values and bodies are clear text in the checks file and in the api database; use `{ "env" }` for secrets. The probe always sends its own `User-Agent`.
- `expectedStatus` accepts codes and `"lo-hi"` ranges. The final status after redirects is judged.
- Redirects: a check with `headers` or a `body` follows redirects in the probe, up to 20, and only within the same origin (scheme, host and port). A redirect to another origin, from https to http, or from http to https ends `down` with reason `redirect to <origin> not followed` (origin only), and the target gets no request. A 301, 302 or 303 on a method other than GET (HEAD included) is not followed: `down` with reason `HTTP <status> redirect not followed for <METHOD>`. More than 20 hops is `down` with `too many redirects`; an unparsable `Location` is `down` with `redirect to invalid location`. A redirect status listed in `expectedStatus` is judged as it is, not followed. Checks without headers and body follow redirects as before.
- Header values, env values and bodies are never logged or put in results, reasons or `/metrics`.

### JSON assertions

`jsonAssert` is a list of `{ "pointer", "equals" }` or `{ "pointer", "exists": true }` (RFC 6901 pointers; `""` is the whole document; `equals` is a deep, strictly typed comparison). It is checked on an accepted status, after `keyword`, on the same single body read (at most 1 MiB; a body over the limit counts as invalid; a body of exactly 1 MiB is read in full). HEAD never reads a body. Reasons, first failure wins:

- `keyword "<text>" not found`
- `json: invalid body`
- `json <pointer>: expected <JSON>, got <JSON>` (`got` is `missing` when absent)
- `json <pointer>: missing` for `exists`

Quoted response values are cut to 80 characters with `…`.

Example: `{ "id": "home", "name": "Home", "url": "https://example.com", "intervalMs": 60000, "keyword": "Welcome" }`

Example: `{ "id": "svc", "name": "Svc", "url": "https://svc.example/v1", "intervalMs": 60000, "method": "POST", "headers": { "Authorization": { "env": "PULSE_HEADER_SVC_TOKEN" } }, "body": "{}", "expectedStatus": [200], "jsonAssert": [{ "pointer": "/status", "equals": "ok" }] }`


### TLS checks

A check with `type: "tls"` has `host`, `port` and `warnDays`, and optionally `timeoutMs` (default 5000 ms, covers connect plus handshake).

- The probe connects to `host:port`, completes the handshake with `servername = host` (set only when `host` is a name, not an IP address) and reads the leaf certificate's `valid_to`.
- The result has `statusCode` null and `certDaysLeft`, the floored whole days left (negative when expired, null when no certificate was read).
- `certDaysLeft <= warnDays` is `down` with reason `certificate expires in N days`.
- An expired certificate is `down` with reason `certificate expired`.
- A connect or handshake error is `down` with the error code, or `timeout after <n>ms`.
- Otherwise it is `up`.
- The chain and the hostname are not verified (`rejectUnauthorized: false`). Only the leaf's expiry is judged.
- A TLS check with an empty `host` or a non-integer `port` or `warnDays` fails the contract validator. The probe skips it, logs `skipping invalid check ...: <error>` and runs the others.

### Heartbeat checks

A check with `type: "heartbeat"` is never run by the probe. Jobs ping the API, and the API judges it.

- The probe drops heartbeat checks from the list it fetches, before scheduling. It sends no request for them and logs no line for them, also on reload.
- The check counts in no log line or metric of the probe.
- Heartbeat checks must not be configured in the API before this probe version runs, or an older probe would run them as HTTP checks.

### Retries

Only HTTP checks retry. `retries` is an integer 0..10 (default 0). `retryDelayMs` is an integer 0..60000 (default 1000).

- A failed attempt (non-2xx, timeout or network error) is repeated up to `retries` times, waiting `retryDelayMs` between attempts.
- The first success (`up` or `degraded`) stops the loop.
- The result is that of the last attempt. Its `timestamp` is the start of the first attempt. `attempts` is the number of attempts made.
- The probe stops retrying early when the next attempt would start at or after the end of the check's interval.
- TLS checks are not retried (`attempts` is 1).

### Schedule

Each check runs immediately at startup and then every `intervalMs`, measured from the start of the previous run. A check never overlaps with itself: the next run is scheduled only after the previous one, including its result post, has finished. If a run takes longer than the interval, the next one starts at once.

## Migration

Breaking: a header `{ "env": "NAME" }` now needs `NAME` to start with `PULSE_HEADER_`. Checks that reference other names are skipped, with a log line, until renamed. Rename the variable in every probe location and in the checks file, for example `SVC_TOKEN` to `PULSE_HEADER_SVC_TOKEN`.
