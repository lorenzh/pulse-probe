# Install

## Bun

Requires Bun 1.4.0.

```sh
bun install --frozen-lockfile
PULSE_API_URL=http://localhost:3000 PULSE_PROBE_TOKEN='<token>' bun run start
```

The probe needs a reachable pulse-api and a probe token that the API knows. See [configuration.md](configuration.md#probe-token).

Replace `<token>`, `<token-a>` and `<token-b>` with the real tokens.

Run one probe per location, each with its own `PULSE_LOCATION` and token:

```sh
PULSE_LOCATION=a PULSE_PROBE_TOKEN='<token-a>' bun run start
PULSE_LOCATION=b PULSE_PROBE_TOKEN='<token-b>' bun run start
```

### Settings sources

The image starts Bun with `--no-env-file`, also for the healthcheck. It never reads dotenv files such as `.env`, also not ones mounted into `/app`. Pass settings with `-e`, `docker run --env-file` (Docker reads that file on the host) or Compose `environment:`/`env_file:`. The token can also come from a file through `PULSE_PROBE_TOKEN_FILE`.

`bun run start` is plain Bun, which also reads a `.env` in the working directory, so keep settings in the shell environment.

## Docker

The image is multi-stage on `oven/bun:1.4.0-alpine` (pinned by digest). It holds only the production dependencies, `package.json` and `src` (no tests, no tooling). It runs as the non-root `bun` user with `bun --no-env-file src/main.ts`. It sets `PULSE_HEALTH_PORT=9100` and `PULSE_HEALTH_HOST=0.0.0.0` and has a `HEALTHCHECK` that fetches `127.0.0.1:$PULSE_HEALTH_PORT/healthz` (liveness; `/readyz` reports readiness). The healthcheck reads the port at run time and uses 9100 when the variable is unset or empty. It does not support `PULSE_HEALTH_PORT=0` (ephemeral port). It has no `EXPOSE`; do not publish the port. The build needs github.com for the `pulse-contract` and `pulse-kit` dependencies and uses no token.

```sh
docker build --tag pulse-probe:local .
docker run --rm \
  -e PULSE_API_URL=http://host.docker.internal:3000 \
  -e PULSE_LOCATION=default \
  -e PULSE_PROBE_TOKEN='<token>' \
  pulse-probe:local
```

Replace `<token>` with the real token. The three variables are not set in the image. Pass them at run time. Without `PULSE_PROBE_TOKEN` or `PULSE_PROBE_TOKEN_FILE` the container exits at startup.

### Token from a file (Compose secrets)

Keep the token out of the environment with `PULSE_PROBE_TOKEN_FILE`:

```yaml
services:
  probe:
    image: pulse-probe:local
    environment:
      PULSE_API_URL: http://api:3000
      PULSE_LOCATION: default
      PULSE_PROBE_TOKEN_FILE: /run/secrets/probe_token
    secrets:
      - probe_token
secrets:
  probe_token:
    file: ./probe-token.txt
```

- Create the file with `openssl rand -hex 32 > probe-token.txt`.
- Compose (not Swarm) bind-mounts the file with its host owner and mode and ignores `uid`, `gid` and `mode`. It must be readable by uid 1000, for example with `chmod 0444 probe-token.txt`, or `chown 1000 probe-token.txt && chmod 0400 probe-token.txt`. Otherwise the probe exits 2 with `cannot read (EACCES)`.
- Do not set `PULSE_PROBE_TOKEN` as well.
- With `docker run`: `-v "$PWD/probe-token.txt:/run/secrets/probe_token:ro" -e PULSE_PROBE_TOKEN_FILE=/run/secrets/probe_token`.
- Kubernetes: mount a Secret as a volume and put the path of its key in `PULSE_PROBE_TOKEN_FILE`.
