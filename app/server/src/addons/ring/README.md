# `ring` addon

Status: **shipped** - Stores what a separate ring client pushes in, next to the notes. The ring pull mirrors another server's tables and is never run on a local install.

List it in the vault's `secondbrain.json` `addons` (or `MODULES` in `.env`) to turn it on. It is off in a fresh vault.

| | |
|---|---|
| Module | `ring` |
| CLI | `secondbrain ring-pull` |
| Timers (server) | none |
| Env | `RING_PULL_SSH_HOST`, `RING_PULL_DB` |
| Docs | `docs/modules.md#ring` |

The manifest beside this file (`manifest.ts`) is the one place the addon is wired: its CLI, timers, wrappers, env and doc page. `deploy.sh`, `secondbrain features`, `doctor` and `secondbrain plan|apply` all read it. See `docs/addons.md`.
