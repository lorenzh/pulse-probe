# Configuration

## Environment variables

These are all the variables the code reads (`src/main.ts`).

| Variable                 | Default                 | Meaning                                                                               |
| ------------------------ | ----------------------- | ------------------------------------------------------------------------------------- |
| `PULSE_API_URL`          | `http://localhost:3000` | Base URL of pulse-api. Trailing slashes are removed.                                  |
| `PULSE_LOCATION`         | `default`               | Name of this probe's location (trimmed, case-sensitive, at most 64 characters).       |
| `PULSE_PROBE_TOKEN`      | none (required)         | Secret token that authorizes this probe to post results to pulse-api.                 |
| `PULSE_CHECKS_RELOAD_MS` | `60000`                 | How often the probe reloads the checks from pulse-api, in ms. Integer, at least 5000. |

## Checks reload

- The probe reloads `GET /checks` every `PULSE_CHECKS_RELOAD_MS` and follows the result: it starts added checks, stops removed ones and restarts checks whose settings changed. Unchanged checks keep their schedule.
- A value below 5000 or one that is not an integer makes the probe exit at startup with `PULSE_CHECKS_RELOAD_MS must be an integer of at least 5000`.
- A failed reload keeps the running checks, is logged and is retried after 10 seconds (or the interval, if shorter).
- When the API answers 404 for a result (the check is unknown or no longer active), the probe reloads at once, at most every 5 seconds.
- Each `GET /checks` request times out after 10 seconds (headers and body). Each check is validated with the validators of pulse-contract. An invalid check is skipped and logged with the contract's error, for example `checks[3].intervalMs: must be a finite number > 0`. The probe also reads the `x-pulse-contract` header of the response: a missing header is logged once, a different version counts as a failed fetch and is retried. A version mismatch on the `POST /results` response is logged only.

## Location

- The value is trimmed. Unset or blank means `default`.
- More than 64 characters makes the probe exit at startup with `PULSE_LOCATION is longer than 64 characters`.
- Every result carries the location. Check requests send `User-Agent: pulse-probe (<location>)`.
- The location is not validated against the API at startup. The API checks it against the token.

How the API combines locations is described in [quorum and incidents](https://github.com/lorenzh/pulse-api/blob/main/docs/concepts.md#quorum-and-incidents). A single probe decides alone; with two or more locations reporting in the window, a check is down only when at least two report it down.

## Probe token

See also [locations and tokens](https://github.com/lorenzh/pulse-api/blob/main/docs/concepts.md#locations-and-tokens).

- The probe sends the token as `Authorization: Bearer <token>` on `POST /results`. It does not send it on `GET /checks`.
- The value is trimmed. Missing or blank makes the probe exit at startup with `PULSE_PROBE_TOKEN is missing or empty`. The message never contains the value.
- Create a token with `openssl rand -hex 32`. The API owner enters it, with the probe's location, in the API's tokens file.
- `PULSE_LOCATION` must equal the location of the token. Otherwise the API answers 403 for every result.
- The token is never logged. It travels in clear over plain HTTP, so run the API behind TLS or on a private network.

## Checks

The probe has no check configuration of its own. It fetches the checks once at startup from `GET /checks` on the API and retries every 10000 ms until that succeeds, logging `fetching checks failed: <reason>; retrying in 10000ms` each time. The checks are defined in the API's checks file.

### HTTP checks

Fields used: `id`, `name`, `url`, `intervalMs`, and optionally `timeoutMs`, `latencyObjectiveMs`, `retries`, `retryDelayMs`, `keyword`.

- Each run is an HTTP GET. Redirects are followed. The default timeout is 5000 ms.
- A 2xx response is `up`. Anything else is `down` with reason `HTTP <code>`, `timeout after <n>ms`, or the error code or message (for example `ECONNREFUSED`).
- If `latencyObjectiveMs` is set and the measured `latencyMs` is strictly above it, the result is `degraded` with reason `latency <n>ms over objective <m>ms`. Equal to the objective is still `up`. An objective at or above `timeoutMs` can never be reached, so the check is never degraded.

### Keyword

With `keyword` set, a 2xx answer is `up` only when its body contains the keyword.

- The match is a plain, case-sensitive substring on the body of the final response (after redirects). The body is decoded as UTF-8. There is no content-type filter.
- The probe reads at most 1 MiB (1,048,576 bytes) of the body and stops as soon as the keyword is found. A keyword that is not found within that limit, including one that straddles it, counts as not found.
- A missing keyword is `down` (never `degraded`) with the 2xx `statusCode` and reason `keyword "<text>" not found`. Retries apply as for any failed attempt.
- A non-2xx answer keeps reason `HTTP <code>`. A timeout or read error while reading the body keeps the timeout or error reason.
- `latencyMs` includes the time to read the body, so a found keyword can still lead to `degraded`.
- Without `keyword` the body is not read. TLS checks have no keyword.

Example: `{ "id": "home", "name": "Home", "url": "https://example.com", "intervalMs": 60000, "keyword": "Welcome" }`

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

### Retries

Only HTTP checks retry. `retries` is an integer 0..10 (default 0). `retryDelayMs` is an integer 0..60000 (default 1000).

- A failed attempt (non-2xx, timeout or network error) is repeated up to `retries` times, waiting `retryDelayMs` between attempts.
- The first success (`up` or `degraded`) stops the loop.
- The result is that of the last attempt. Its `timestamp` is the start of the first attempt. `attempts` is the number of attempts made.
- The probe stops retrying early when the next attempt would start at or after the end of the check's interval.
- TLS checks are not retried (`attempts` is 1).

### Schedule

Each check runs immediately at startup and then every `intervalMs`, measured from the start of the previous run. A check never overlaps with itself: the next run is scheduled only after the previous one, including its result post, has finished. If a run takes longer than the interval, the next one starts at once.
