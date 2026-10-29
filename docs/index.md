# pulse-probe documentation

The probe fetches the checks from pulse-api, runs them and posts the results back. It serves no HTTP and has no database.

- [install.md](install.md): Node and Docker install, quick start.
- [configuration.md](configuration.md): environment variables, location and token rules, check types and retries.
- [operation.md](operation.md): logs, restarts, token and location changes.
- [troubleshooting.md](troubleshooting.md): startup errors and dropped results, with causes and actions.
- [development.md](development.md): local run, tests, lint and CI.

Shared rules (quorum, incidents, locations and tokens) live in pulse-api: [quorum and incidents](https://github.com/lorenzh/pulse-api/blob/main/docs/concepts.md#quorum-and-incidents) and [locations and tokens](https://github.com/lorenzh/pulse-api/blob/main/docs/concepts.md#locations-and-tokens).
