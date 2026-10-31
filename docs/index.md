# pulse-probe documentation

The probe fetches the checks from pulse-api, runs them and posts the results back. It serves HTTP only on the optional health and metrics listener, and has no database.

- [install.md](install.md): Bun and Docker install, quick start.
- [configuration.md](configuration.md): environment variables, location and token rules (also the token file `PULSE_PROBE_TOKEN_FILE`), check types and retries, network reach of checks.
- [operation.md](operation.md): logs, restarts, token and location changes.
- [troubleshooting.md](troubleshooting.md): startup errors and dropped results, with causes and actions.
- [development.md](development.md): local run, tests, lint, CI and releasing.

Shared rules (quorum, incidents, locations and tokens) live in pulse-api: [quorum and incidents](https://github.com/lorenzh/pulse-api/blob/main/docs/concepts.md#quorum-and-incidents) and [locations and tokens](https://github.com/lorenzh/pulse-api/blob/main/docs/concepts.md#locations-and-tokens).
