# Configuration

## Environment variables

These are all the variables the code reads (`src/main.ts`).

| Variable            | Default                 | Meaning                                                                         |
| ------------------- | ----------------------- | ------------------------------------------------------------------------------- |
| `PULSE_API_URL`     | `http://localhost:3000` | Base URL of pulse-api. Trailing slashes are removed.                            |
| `PULSE_LOCATION`    | `default`               | Name of this probe's location (trimmed, case-sensitive, at most 64 characters). |
| `PULSE_PROBE_TOKEN` | none (required)         | Secret token that authorizes this probe to post results to pulse-api.           |

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

The probe has no check configuration of its own. It fetches the checks once at startup from `GET /checks` on the API and retries every 2000 ms until that succeeds. The checks are defined in the API's checks file.

### HTTP checks

Fields used: `id`, `name`, `url`, `intervalMs`, and optionally `timeoutMs`, `latencyObjectiveMs`, `retries`, `retryDelayMs`.

- Each run is an HTTP GET. Redirects are followed. The default timeout is 5000 ms.
- A 2xx response is `up`. Anything else is `down` with reason `HTTP <code>`, `timeout after <n>ms`, or the error code or message (for example `ECONNREFUSED`).
- If `latencyObjectiveMs` is set and the measured `latencyMs` is strictly above it, the result is `degraded` with reason `latency <n>ms over objective <m>ms`. Equal to the objective is still `up`. An objective at or above `timeoutMs` can never be reached, so the check is never degraded.

### TLS checks

A check with `type: "tls"` has `host`, `port` and `warnDays`, and optionally `timeoutMs` (default 5000 ms, covers connect plus handshake).

- The probe connects to `host:port`, completes the handshake with `servername = host` and reads the leaf certificate's `valid_to`.
- The result has `statusCode` null and `certDaysLeft`, the floored whole days left (negative when expired, null when no certificate was read).
- `certDaysLeft <= warnDays` is `down` with reason `certificate expires in N days`.
- An expired certificate is `down` with reason `certificate expired`.
- A connect or handshake error is `down` with the error code, or `timeout after <n>ms`.
- Otherwise it is `up`.
- The chain and the hostname are not verified (`rejectUnauthorized: false`). Only the leaf's expiry is judged.
- A TLS check with an empty `host` or a non-integer `port` or `warnDays` makes the startup fetch fail with `invalid tls check <id>`, and the probe keeps retrying.

### Retries

Only HTTP checks retry. `retries` is an integer 0..10 (default 0). `retryDelayMs` is an integer 0..60000 (default 1000).

- A failed attempt (non-2xx, timeout or network error) is repeated up to `retries` times, waiting `retryDelayMs` between attempts.
- The first success (`up` or `degraded`) stops the loop.
- The result is that of the last attempt. Its `timestamp` is the start of the first attempt. `attempts` is the number of attempts made.
- The probe stops retrying early when the next attempt would start at or after the end of the check's interval.
- TLS checks are not retried (`attempts` is 1).

### Schedule

Each check runs immediately at startup and then every `intervalMs`, measured from the start of the previous run. A check never overlaps with itself: the next run is scheduled only after the previous one, including its result post, has finished. If a run takes longer than the interval, the next one starts at once.
