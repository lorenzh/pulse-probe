# pulse-probe

[![CI](https://github.com/lorenzh/pulse-probe/actions/workflows/ci.yml/badge.svg)](https://github.com/lorenzh/pulse-probe/actions/workflows/ci.yml)

pulse is an uptime monitor with a status page. This repository is its probe: a worker that fetches the checks from [pulse-api](https://github.com/lorenzh/pulse-api), runs them over HTTP or as TLS certificate expiry checks and posts the results back. It uses the shared types of [pulse-contract](https://github.com/lorenzh/pulse-contract) and serves HTTP only on the optional health and metrics listener (`PULSE_HEALTH_PORT`).

pulse is built by Paragon Factory agents from the issues in [pulse-meta](https://github.com/lorenzh/pulse-meta).

## Quick start

Requires Node 24 or newer and a reachable pulse-api that knows your probe token.

```sh
npm ci
PULSE_API_URL=http://localhost:3000 PULSE_LOCATION=default PULSE_PROBE_TOKEN='<token>' npm start
```

With Docker:

```sh
docker build --tag pulse-probe:local .
docker run --rm -e PULSE_API_URL=http://host.docker.internal:3000 -e PULSE_PROBE_TOKEN='<token>' pulse-probe:local
```

Replace `<token>` with the real probe token.

## Documentation

See [docs/index.md](docs/index.md): install, configuration, operation, troubleshooting and development. The quorum and incident rules are in the pulse-api docs: [quorum and incidents](https://github.com/lorenzh/pulse-api/blob/main/docs/concepts.md#quorum-and-incidents) and [locations and tokens](https://github.com/lorenzh/pulse-api/blob/main/docs/concepts.md#locations-and-tokens).

## Development

Run `npm run check` (lint, typecheck, tests). See [docs/development.md](docs/development.md) and [AGENTS.md](AGENTS.md).

Licensed under the MIT licence, see [LICENSE](LICENSE).
