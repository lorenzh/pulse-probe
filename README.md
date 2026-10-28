# pulse-probe

[![CI](https://github.com/lorenzh/pulse-probe/actions/workflows/ci.yml/badge.svg)](https://github.com/lorenzh/pulse-probe/actions/workflows/ci.yml)

pulse is an uptime monitor with a status page. This repository is its probe: a worker that fetches the checks from pulse-api, runs them over HTTP or as TLS certificate expiry checks (TCP checks may follow later) and posts the results back.

pulse-probe depends on [pulse-contract](https://github.com/lorenzh/pulse-contract) for its shared types (at build time) and talks to [pulse-api](https://github.com/lorenzh/pulse-api) at run time: `GET /checks` and `POST /results`. pulse-api must be reachable for the probe to do anything.

pulse is built by Paragon Factory agents from the issues in [pulse-meta](https://github.com/lorenzh/pulse-meta).

## Behavior

At startup the probe fetches the checks from the API (`GET /checks`, retried every 2000 ms until it succeeds), then runs each one immediately and every `intervalMs` after that. A check never overlaps with itself. Each run is an HTTP GET (redirects followed, default timeout 5000 ms unless the check sets `timeoutMs`) and its `Result` is posted to `POST /results`. If the API is unreachable or does not answer 204, the result is logged and dropped.

A response with a 2xx status is `up`. Anything else is `down`, with one of these reasons: `HTTP <code>`, `timeout after <n>ms`, or the error code or message (for example `ECONNREFUSED`).

## Retries

An HTTP check may set `retries` (integer 0..10, default 0) and `retryDelayMs` (integer 0..60000, default 1000). A failed attempt (non-2xx, timeout or network error) is repeated up to `retries` times, waiting `retryDelayMs` between attempts; the first success stops the loop and the result is `up`. The result is that of the last attempt (`status`, `statusCode`, `reason`, `latencyMs`), its `timestamp` is the start of the first attempt, and `attempts` is the number of attempts made. The probe stops retrying early when the next attempt would start at or after the end of the check's interval. TLS checks are not retried (`attempts` is 1).

## Install

Requires Node 24 or newer.

```sh
npm ci
```

## Run

```sh
npm start
```

## Settings

| Variable         | Default                 | Meaning                                                                         |
| ---------------- | ----------------------- | ------------------------------------------------------------------------------- |
| `PULSE_API_URL`  | `http://localhost:3000` | Base URL of pulse-api.                                                          |
| `PULSE_LOCATION` | `default`               | Name of this probe's location (trimmed, case-sensitive, at most 64 characters). |

Every result carries the location, and check requests send `User-Agent: pulse-probe (<location>)`. A longer location makes the probe exit at startup with an error. pulse-api declares a check down only when at least two locations report it down, so run several probes, each with its own location:

```sh
PULSE_LOCATION=a npm start
PULSE_LOCATION=b npm start
PULSE_LOCATION=c npm start
```

## Development

```sh
npm ci
npm run check   # lint, typecheck and tests
npm run lint    # Biome format and lint check, changes nothing
npm run format  # Biome: apply formatting and safe lint fixes
```

`npm ci` installs a Lefthook pre-commit hook that runs `biome check` on the staged files and rejects the commit if they are badly formatted or fail lint. Run `npm run format` to fix them.

## TLS checks

A check with `type: "tls"` (`host`, `port`, `warnDays`) connects to `host:port`, completes the handshake with `servername = host` and reads the leaf certificate's `valid_to`. `timeoutMs` (default 5000 ms) bounds connect plus handshake. The result has `statusCode` null and `certDaysLeft`, the floored whole days left (negative when expired, null when no certificate was read).

- `certDaysLeft <= warnDays` is `down` with reason `certificate expires in N days`.
- An expired certificate is `down` with reason `certificate expired`.
- A connect or handshake error is `down` with the error code, or `timeout after <n>ms`.
- Otherwise it is `up`.

The chain and the hostname are not verified (`rejectUnauthorized: false`); only the leaf's expiry is judged. The TLS tests need the `openssl` CLI.
