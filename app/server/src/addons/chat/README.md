# `chat` addon

Status: **shipped** - Ask your second brain: conversations answered from retrieved passages, with citations. Planned to become a base feature.

List it in the vault's `secondbrain.json` `addons` (or `MODULES` in `.env`) to turn it on. It is off in a fresh vault.

| | |
|---|---|
| Module | `chat` |
| CLI | none |
| Timers (server) | none |
| Env | `RERANK_URL`, `RERANK_API_KEY`, `RERANK_MODEL` |
| Docs | `docs/modules.md#chat` |

The manifest beside this file (`manifest.ts`) is the one place the addon is wired: its CLI, timers, wrappers, env and doc page. `deploy.sh`, `secondbrain features`, `doctor` and `secondbrain plan|apply` all read it. See `docs/addons.md`.
