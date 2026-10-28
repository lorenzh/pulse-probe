# AGENTS.md

## Commands

```sh
npm ci           # install from the lockfile
npm run check    # lint, typecheck, then tests (coverage gate)
npm run lint     # Biome format and lint check, then SonarJS via ESLint (complexity <= 15)
npm run format   # Biome: apply formatting and safe fixes
```

A Lefthook pre-commit hook (installed by `npm ci` via `prepare`) runs `biome check` and ESLint (SonarJS, `tools/sonarjs/eslint.config.js`) on staged files and blocks the commit on failures. `npm test` fails below 80 % line coverage. The ESLint toolchain is the `tools/sonarjs` workspace (own TypeScript 6; the root stays on TypeScript 7).

## Conventions

- Strict TypeScript, ESM, Node 24 type stripping (erasable syntax only).
- Every change gets tests with `node:test`, next to the code they cover.
- Time-dependent logic takes an injectable clock. Tests never use real timers.
- Network tests run only against local servers started inside the test.
