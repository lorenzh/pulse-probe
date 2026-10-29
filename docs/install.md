# Install

## Node

Requires Node 24 or newer.

```sh
npm ci
PULSE_API_URL=http://localhost:3000 PULSE_PROBE_TOKEN=<token> npm start
```

The probe needs a reachable pulse-api and a probe token that the API knows. See [configuration.md](configuration.md#probe-token).

Run one probe per location, each with its own `PULSE_LOCATION` and token:

```sh
PULSE_LOCATION=a PULSE_PROBE_TOKEN=<token-a> npm start
PULSE_LOCATION=b PULSE_PROBE_TOKEN=<token-b> npm start
```

## Docker

The image is multi-stage on `node:24-alpine`. It holds only the production dependencies, `package.json` and `src` (no tests, no tooling). It runs as the non-root `node` user with `node src/main.ts`. It has no `EXPOSE` and no `HEALTHCHECK`, because the probe serves no HTTP. The build needs github.com for the `pulse-contract` dependency and uses no token.

```sh
docker build --tag pulse-probe:local .
docker run --rm \
  -e PULSE_API_URL=http://host.docker.internal:3000 \
  -e PULSE_LOCATION=default \
  -e PULSE_PROBE_TOKEN=<token> \
  pulse-probe:local
```

The three variables are not set in the image. Pass them at run time. Without a token the container exits at startup.
