# `routing` addon

Status: **pilot** - The model-routing pilot: `org-router.ts`, the `route_decisions` / `route_outcomes` tables and the weekly routing report. One model in use, so nothing to choose between yet. Its code (`org-router.ts`) lives in this folder; the routing subcommands stay on the core `org` command.

List it in the vault's `secondbrain.json` `addons` (or `MODULES` in `.env`) to turn it on. It is off in a fresh vault.

| | |
|---|---|
| Module | `routing` |
| CLI | none (the routing subcommands live on the core `org` command, which imports `org-router.ts`) |
| Timers (server) | `secondbrain-routing-report` |
| Env | none |
| Docs | `docs/addons.md` |

The manifest beside this file (`manifest.ts`) is the one place the addon is wired: its CLI, timers, wrappers, env and doc page. `deploy.sh`, `secondbrain features`, `doctor` and `secondbrain plan|apply` all read it. See `docs/addons.md`.
