# `dispatch` addon

Status: **pilot** - The engine's zen-agent dispatcher: one run per bot with open wakeups. Stays a pilot addon; the timer installs only when the module is on and `ORG_DISPATCH=on`. Its code (`index.ts`, `store.ts`, `cli.ts`) lives in this folder.

List it in the vault's `secondbrain.json` `addons` (or `MODULES` in `.env`) to turn it on. It is off in a fresh vault.

| | |
|---|---|
| Module | `dispatch` |
| CLI | `secondbrain dispatch` |
| Timers (server) | `secondbrain-dispatch` |
| Env | `ORG_DISPATCH`, `ORG_DISPATCH_TICK_SECONDS`, `ORG_DISPATCH_PARALLEL`, `ORG_DISPATCH_QUIET`, `ORG_DISPATCH_DAILY_TOKENS` |
| Docs | `docs/addons.md` |

The manifest beside this file (`manifest.ts`) is the one place the addon is wired: its CLI, timers, wrappers, env and doc page. `deploy.sh`, `secondbrain features`, `doctor` and `secondbrain plan|apply` all read it. See `docs/addons.md`.
