# `uploads` addon

Status: **shipped** - Sends 1 GB to 50 GB files from a browser straight into the vault's B2 bucket. Needs `B2_*` configured, or every route answers 503.

List it in the vault's `secondbrain.json` `addons` (or `MODULES` in `.env`) to turn it on. It is off in a fresh vault.

| | |
|---|---|
| Module | `uploads` |
| CLI | none |
| Timers (server) | none |
| Env | `UPLOADS_MAX_GB`, `UPLOADS_PULL_TOKEN` |
| Docs | `docs/uploads.md` |

The manifest beside this file (`manifest.ts`) is the one place the addon is wired: its CLI, timers, wrappers, env and doc page. `deploy.sh`, `secondbrain features`, `doctor` and `secondbrain plan|apply` all read it. See `docs/addons.md`.
