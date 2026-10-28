# pulse-probe

pulse is an uptime monitor with a status page. This repository is its probe: a worker that fetches the checks from pulse-api, runs them over HTTP (TCP and TLS checks may follow later) and posts the results back.

pulse-probe depends on [pulse-contract](https://github.com/lorenzh/pulse-contract) for its shared types (at build time) and talks to [pulse-api](https://github.com/lorenzh/pulse-api) at run time: `GET /checks` and `POST /results`. pulse-api must be reachable for the probe to do anything.

pulse is built by Paragon Factory agents from the issues in [pulse-meta](https://github.com/lorenzh/pulse-meta).

## Behavior

At startup the probe fetches the checks from the API (`GET /checks`, retried every 2000 ms until it succeeds), then runs each one immediately and every `intervalMs` after that. A check never overlaps with itself. Each run is an HTTP GET (redirects followed, default timeout 5000 ms unless the check sets `timeoutMs`) and its `Result` is posted to `POST /results`. If the API is unreachable or does not answer 204, the result is logged and dropped.

A response with a 2xx status is `up`. Anything else is `down`, with one of these reasons: `HTTP <code>`, `timeout after <n>ms`, or the error code or message (for example `ECONNREFUSED`).

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

| Variable        | Default                 | Meaning                |
| --------------- | ----------------------- | ---------------------- |
| `PULSE_API_URL` | `http://localhost:3000` | Base URL of pulse-api. |

## Development

```sh
npm ci
npm run check   # lint, typecheck and tests
npm run lint    # Biome format and lint check, changes nothing
npm run format  # Biome: apply formatting and safe lint fixes
```

`npm ci` installs a Lefthook pre-commit hook that runs `biome check` on the staged files and rejects the commit if they are badly formatted or fail lint. Run `npm run format` to fix them.
