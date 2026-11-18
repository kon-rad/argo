# `tv` addon

Status: **shipped** - A player for video episodes kept in the vault, with a kiosk mode for a TV. See `addons/tv-kiosk/` at the repo root for the Pi that drives it.

List it in the vault's `secondbrain.json` `addons` (or `MODULES` in `.env`) to turn it on. It is off in a fresh vault.

| | |
|---|---|
| Module | `tv` |
| CLI | none |
| Timers (server) | none |
| Env | none |
| Docs | `docs/modules.md#tv` |

The manifest beside this file (`manifest.ts`) is the one place the addon is wired: its CLI, timers, wrappers, env and doc page. `deploy.sh`, `secondbrain features`, `doctor` and `secondbrain plan|apply` all read it. See `docs/addons.md`.
