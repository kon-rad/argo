# `garden` addon

Status: **shipped** - A nightly shelf-keeping pass over `Projects/`, `Areas/` and `Research/`: headers, archive, stale areas, a `related:` block and a report. Shadow mode unless `garden.apply` is true.

List it in the vault's `secondbrain.json` `addons` (or `MODULES` in `.env`) to turn it on. It is off in a fresh vault.

| | |
|---|---|
| Module | `garden` |
| CLI | `secondbrain garden` |
| Timers (server) | `secondbrain-garden` |
| Env | none |
| Docs | `docs/garden.md` |

The manifest beside this file (`manifest.ts`) is the one place the addon is wired: its CLI, timers, wrappers, env and doc page. `deploy.sh`, `secondbrain features`, `doctor` and `secondbrain plan|apply` all read it. See `docs/addons.md`.
