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

### `.env` files

When you run from source (`bun run start`), Bun 1.4.0 loads these files from the working directory, later ones winning:

- `.env`
- `.env.development`, `.env.production` or `.env.test`, by `NODE_ENV` (unset means `development`)
- `.env.local` (not loaded when `NODE_ENV=test`)
- `.env.development.local`, `.env.production.local` or `.env.test.local`, by `NODE_ENV`

Real environment variables win over all of them. A `.env` with `PULSE_PROBE_TOKEN` plus an exported `PULSE_PROBE_TOKEN_FILE` stops the start with `set only one of PULSE_PROBE_TOKEN and PULSE_PROBE_TOKEN_FILE`. Keep `.env` files out of git; `.gitignore` lists `.env` and `.env.*`. The image ships no `.env` (`.dockerignore` excludes it), but a file mounted into `/app` would be loaded too.

## Docker

The image is multi-stage on `oven/bun:1.4.0-alpine` (pinned by digest). It holds only the production dependencies, `package.json` and `src` (no tests, no tooling). It runs as the non-root `bun` user with `bun src/main.ts`. It sets `PULSE_HEALTH_PORT=9100` and `PULSE_HEALTH_HOST=0.0.0.0` and has a `HEALTHCHECK` on `/healthz` (liveness; `/readyz` reports readiness). It has no `EXPOSE`; do not publish the port. The build needs github.com for the `pulse-contract` and `pulse-kit` dependencies and uses no token.

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
