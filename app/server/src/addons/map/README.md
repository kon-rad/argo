# `map` addon

Status: **shipped** - The 3D brain map of the vault, with the daily metrics over it. `backlinks` writes the `related:` block at the end of notes from their links.

List it in the vault's `secondbrain.json` `addons` (or `MODULES` in `.env`) to turn it on. It is off in a fresh vault.

| | |
|---|---|
| Module | `map` |
| CLI | `secondbrain map-build`, `metrics`, `backlinks` |
| Timers (server) | `secondbrain-map-build`, `secondbrain-metrics` |
| Env | none |
| Docs | `docs/modules.md#map` |

The manifest beside this file (`manifest.ts`) is the one place the addon is wired: its CLI, timers, wrappers, env and doc page. `deploy.sh`, `secondbrain features`, `doctor` and `secondbrain plan|apply` all read it. See `docs/addons.md`.
