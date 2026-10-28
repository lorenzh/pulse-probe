# pulse-probe

Worker that runs checks (HTTP, later TCP and TLS) and posts results to pulse-api.

Runs checks and posts their results to pulse-api.

## Behavior

At startup the probe fetches the checks from the API (`GET /checks`, retried until it succeeds), then runs each one immediately and every `intervalMs` after that. A check never overlaps with itself. Each run is an HTTP GET (redirects followed, default timeout 5000 ms) and its `Result` is posted to `POST /results`. If the API is unreachable the result is logged and dropped.

Down reasons: `HTTP <code>`, `timeout after <n>ms`, or the error code or message (for example `ECONNREFUSED`).

## Run

```sh
PULSE_API_URL=http://localhost:3000 npm start   # PULSE_API_URL defaults to http://localhost:3000
```

## Development

```sh
npm ci
npm run check   # typecheck and tests
```

Part of pulse — issues and specs live in https://github.com/lorenzh/pulse-meta
