# `fund` addon

Status: **shipped** - A read-only view of an agentic fund: wallet balances, transactions, pending approvals and run health.

List it in the vault's `secondbrain.json` `addons` (or `MODULES` in `.env`) to turn it on. It is off in a fresh vault.

| | |
|---|---|
| Module | `fund` |
| CLI | none |
| Timers (server) | none |
| Env | `BASE_RPC_URL` |
| Docs | `docs/modules.md#fund` |

The manifest beside this file (`manifest.ts`) is the one place the addon is wired: its CLI, timers, wrappers, env and doc page. `deploy.sh`, `secondbrain features`, `doctor` and `secondbrain plan|apply` all read it. See `docs/addons.md`.
