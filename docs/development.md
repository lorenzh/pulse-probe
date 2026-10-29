# Development

Repository rules for agents and people are in [AGENTS.md](../AGENTS.md). Cross-repository context: [architecture](https://github.com/lorenzh/pulse-meta/blob/main/docs/architecture.md) and [factory](https://github.com/lorenzh/pulse-meta/blob/main/docs/factory.md).

## Run locally

```sh
npm ci
PULSE_PROBE_TOKEN=<token> npm start
```

Point `PULSE_API_URL` at a running pulse-api (default `http://localhost:3000`).

## Layout

- `src/main.ts`: entry point. Reads the environment and wires the real `fetch`, `now`, `sleep`, `setTimeout` and `clearTimeout`.
- `src/check.ts`: runs one check (HTTP with retries, or TLS certificate expiry).
- `src/client.ts`: talks to pulse-api (`GET /checks`, `POST /results`).
- `src/location.ts`: parses `PULSE_LOCATION`.
- `src/token.ts`: parses `PULSE_PROBE_TOKEN`.
- `src/scheduler.ts`: runs each check on its interval without overlap.

## Checks

```sh
npm run check   # lint, typecheck and tests (with coverage gate)
npm run lint    # Biome and SonarJS (ESLint), changes nothing
npm run format  # Biome: apply formatting and safe lint fixes
node --test src/check.test.ts
```

- Tests are written first (red, green, refactor) and sit next to the code as `src/<module>.test.ts`.
- Tests use hand-written fakes and inject `now`, `sleep` and `setTimeout`. They never wait in real time and use no external network.
- Line coverage must be at least 80 %. Cognitive complexity is limited to 15 per function.
- The TLS tests need the `openssl` CLI.
- Contract types are imported with `import type` from `@lorenzh/pulse-contract`, pinned to a full commit SHA.

## Hooks and CI

`npm ci` installs a Lefthook pre-commit hook that runs `biome check` and ESLint (SonarJS) on the staged files. CI runs the same steps as `npm run check` through the shared workflow in `lorenzh/pulse-config`, which also holds the shared Biome, TypeScript, Lefthook and ESLint configuration. Change a rule there, not here.
