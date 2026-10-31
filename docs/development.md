# Development

Repository rules for agents and people are in [AGENTS.md](../AGENTS.md). Cross-repository context: [architecture](https://github.com/lorenzh/pulse-meta/blob/main/docs/architecture.md) and [factory](https://github.com/lorenzh/pulse-meta/blob/main/docs/factory.md).

## Run locally

```sh
bun install --frozen-lockfile
PULSE_PROBE_TOKEN='<token>' bun run start
```

Replace `<token>` with the real probe token. Point `PULSE_API_URL` at a running pulse-api (default `http://localhost:3000`).

## Layout

- `src/main.ts`: entry point, built on `runService` from pulse-kit. Wires the real `fetch`, `now`, `sleep`, `setTimeout` and `clearTimeout`.
- `src/check.ts`: runs one check (HTTP, TCP, DNS or domain with retries, or TLS certificate expiry). `check-tcp.ts`, `check-dns.ts` and `check-domain.ts` hold one attempt of those types; `attempt.ts` holds their shared result and error helpers.
- `src/client.ts`: talks to pulse-api (`GET /probe/checks` with fallback to `GET /checks`, through `fetchJson` from pulse-contract, `POST /results`).
- `src/location.ts`: parses `PULSE_LOCATION`.
- `src/reload-interval.ts`: parses `PULSE_CHECKS_RELOAD_MS`.
- `src/reloader.ts`: reloads the checks periodically and on request, keeps the old ones on failure.
- `src/settings.ts`: reads the environment with the pulse-kit readers.
- `src/metrics.ts`: the probe metrics on the pulse-kit registry.
- `src/token.ts`: reads the token from `PULSE_PROBE_TOKEN` or `PULSE_PROBE_TOKEN_FILE` (the file reader is injected).
- `src/scheduler.ts`: runs each check on its interval without overlap and follows check changes with `sync`.

## Checks

```sh
bun run check   # lint, typecheck and tests (with coverage gate)
bun run lint    # Biome and SonarJS (ESLint), changes nothing
bun run format  # Biome: apply formatting and safe lint fixes
bun test src/check.test.ts
```

- Tests are written first (red, green, refactor) and sit next to the code as `src/<module>.test.ts`.
- Tests use hand-written fakes and inject `now`, `sleep` and `setTimeout`. Most tests never wait in real time, but some use real 50 ms timeouts (`check.test.ts`, `tls.test.ts`). They use no external network.
- Line coverage must be at least 80 %. Cognitive complexity is limited to 15 per function.
- The TLS tests need the `openssl` CLI.
- Contract types are imported with `import type` from `@lorenzh/pulse-contract`, pinned to a full commit SHA. The same holds for `@lorenzh/pulse-kit`, which provides the env readers, `runService`, the ops server, the metrics registry and the logger.

## Hooks and CI

`bun install --frozen-lockfile` installs a Lefthook pre-commit hook that runs `biome check` and ESLint (SonarJS) on the staged files. CI runs the same steps as `bun run check` through the shared workflow in `lorenzh/pulse-config`, which also holds the shared Biome, TypeScript, Lefthook and ESLint configuration. Change a rule there, not here.

CI (`.github/workflows/ci.yml`) has three jobs:

- `check`: lint, typecheck and tests through the shared `check.yml`. Lint also runs `pulse-workflows`, which fails on an action that is not approved, a checkout without `persist-credentials: false`, or a `pulse-config` ref that differs from the `package.json` pin.
- `docker`: builds the image, checks that it holds no test files, and runs `Image ignores dotenv files` (`scripts/image-dotenv.sh`), which checks that the service and its healthcheck ignore `.env`, `.env.production` and `.env.local` mounted into `/app`. It runs twice, natively on `ubuntu-24.04` (amd64) and `ubuntu-24.04-arm` (arm64). `fail-fast` is off, so one failing leg keeps the other leg's log.
- `release`: runs only on a tag and calls the shared `release.yml`. See [Releasing](#releasing).

The `check.yml` ref, the `release.yml` ref and `@lorenzh/pulse-config` in `package.json` (with `bun.lock`) carry the same SHA. Change them together.

## Releasing

A person releases the probe by pushing a SemVer tag:

```sh
git tag vX.Y.Z <sha on main> && git push origin vX.Y.Z
```

- The tag must match `vX.Y.Z` or `vX.Y.Z-<pre-release>` (no leading zeros, no `+build`). Any other tag fails the release before anything is built.
- A stable tag `vX.Y.Z` must point to a commit on `main`. A pre-release tag may point anywhere, for example to a test branch.
- The tag run executes the same gate as `main`: `check` and both `docker` legs (amd64 and arm64). The `release` job runs only when all of them pass. A failed, cancelled or skipped gate skips it.
- The release publishes a multi-arch image (linux/amd64, linux/arm64) to `ghcr.io/lorenzh/pulse-probe` with the tags `X.Y.Z`, `X.Y` and `X`. `X.Y` and `X` move only forward to the highest stable tag; a pre-release gets only its own tag. There is no `latest` and no `edge` tag. A push to `main` or a pull request publishes nothing.
- The version comes from the git tag. `package.json` `version` stays `0.0.0`.
- Never move or re-push a release tag. The workflow refuses to publish a version that already exists; push a new version instead.
- The release builds the image again from the tagged commit, so its digest can differ from the image that the gate checked.

Verify the build provenance of a release:

```sh
gh attestation verify oci://ghcr.io/lorenzh/pulse-probe:<version> --owner lorenzh
```

Setups pin an exact version by digest (`ghcr.io/lorenzh/pulse-probe:X.Y.Z@sha256:<digest>`), because `X` moves across breaking 0.x minors. Tag rules, owner steps (package visibility, cleanup of test tags) and the workflow itself are documented in [pulse-config](https://github.com/lorenzh/pulse-config#releasing-images).
