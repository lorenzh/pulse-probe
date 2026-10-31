# pulse-probe

[![CI](https://github.com/lorenzh/pulse-probe/actions/workflows/ci.yml/badge.svg)](https://github.com/lorenzh/pulse-probe/actions/workflows/ci.yml)

pulse is an uptime monitor with a status page. This repository is its probe: a worker that fetches the checks from [pulse-api](https://github.com/lorenzh/pulse-api), runs them over HTTP, as TLS certificate expiry checks, as TCP connect checks, as DNS record checks or as domain expiry checks over RDAP (it skips `heartbeat` checks, which the API evaluates) and posts the results back. Results it cannot deliver wait in a bounded in-memory buffer and are delivered in order when pulse-api answers again (`PULSE_BUFFER_MAX_RESULTS`, `PULSE_BUFFER_MAX_AGE_MS`; see `docs/`). It uses the shared types of [pulse-contract](https://github.com/lorenzh/pulse-contract) and serves HTTP only on the optional health and metrics listener (`PULSE_HEALTH_PORT`).

pulse is built by Paragon Factory agents from the issues in [pulse-meta](https://github.com/lorenzh/pulse-meta).

## Quick start

Requires Bun 1.4.0 and a reachable pulse-api that knows your probe token.

```sh
bun install --frozen-lockfile
PULSE_API_URL=http://localhost:3000 PULSE_LOCATION=default PULSE_PROBE_TOKEN='<token>' bun run start
```

With Docker:

```sh
docker build --tag pulse-probe:local .
docker run --rm -e PULSE_API_URL=http://host.docker.internal:3000 -e PULSE_PROBE_TOKEN='<token>' pulse-probe:local
```

The image runs `bun --no-env-file`: it never reads a `.env` file, also not one mounted into `/app`. Pass settings with `-e`, `--env-file` or Compose `environment:`.

Released images are on `ghcr.io/lorenzh/pulse-probe` (linux/amd64 and linux/arm64, tags `X.Y.Z`, `X.Y` and `X`, no `latest`):

```sh
docker pull ghcr.io/lorenzh/pulse-probe:0.1.0
docker run --rm -e PULSE_API_URL=http://host.docker.internal:3000 -e PULSE_PROBE_TOKEN='<token>' ghcr.io/lorenzh/pulse-probe:0.1.0
```

Pin a version by digest in a setup. How releases are made and verified: [releasing](docs/development.md#releasing).

Replace `<token>` with the real probe token. `PULSE_PROBE_TOKEN_FILE` can replace `PULSE_PROBE_TOKEN` and point at a file that holds the token: see [probe token](docs/configuration.md#probe-token) and [token from a file (Compose secrets)](docs/install.md#token-from-a-file-compose-secrets).

Checks reach whatever the probe's network reaches, internal addresses included: see [network reach of checks](docs/configuration.md#network-reach-of-checks).

## Documentation

See [docs/index.md](docs/index.md): install, configuration, operation, troubleshooting and development. The quorum and incident rules are in the pulse-api docs: [quorum and incidents](https://github.com/lorenzh/pulse-api/blob/main/docs/concepts.md#quorum-and-incidents) and [locations and tokens](https://github.com/lorenzh/pulse-api/blob/main/docs/concepts.md#locations-and-tokens).

## Development

Run `bun run check` (lint, typecheck, tests). See [docs/development.md](docs/development.md) and [AGENTS.md](AGENTS.md).

Licensed under the MIT licence, see [LICENSE](LICENSE).
