# `media` addon

Status: **shipped** - A browser over the media files the vault holds, local and on the bucket.

List it in the vault's `secondbrain.json` `addons` (or `MODULES` in `.env`) to turn it on. It is off in a fresh vault.

| | |
|---|---|
| Module | `media` |
| CLI | none |
| Timers (server) | none |
| Env | none |
| Docs | `docs/modules.md` |

The manifest beside this file (`manifest.ts`) is the one place the addon is wired: its CLI, timers, wrappers, env and doc page. `deploy.sh`, `secondbrain features`, `doctor` and `secondbrain plan|apply` all read it. See `docs/addons.md`.
