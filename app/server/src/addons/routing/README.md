# `routing` addon

Status: **pilot** - The model-routing pilot: `org-router.ts`, the `route_decisions` / `route_outcomes` tables and the weekly routing report. One model in use, so nothing to choose between yet. Its code leaves the core tree in this addon's next slice.

List it in the vault's `secondbrain.json` `addons` (or `MODULES` in `.env`) to turn it on. It is off in a fresh vault.

| | |
|---|---|
| Module | `routing` |
| CLI | none (the routing subcommands live in `cli-org`) |
| Timers (server) | `secondbrain-routing-report` |
| Env | none |
| Docs | `docs/addons.md` |

The manifest beside this file (`manifest.ts`) is the one place the addon is wired: its CLI, timers, wrappers, env and doc page. `deploy.sh`, `secondbrain features`, `doctor` and `secondbrain plan|apply` all read it. See `docs/addons.md`.
