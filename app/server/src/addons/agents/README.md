# `agents` addon

Status: **shipped, depends on an agent-hub process** - Views over an agent-hub the engine does not ship: the Claude Code chats, the Hermes history and the `/cron` page. Without the hub, the pages have nothing to show.

List it in the vault's `secondbrain.json` `addons` (or `MODULES` in `.env`) to turn it on. It is off in a fresh vault.

| | |
|---|---|
| Module | `agents` |
| CLI | `secondbrain agents-sync` |
| Timers (server) | `secondbrain-agents-sync` |
| Env | `AGENT_HUB_URL`, `AGENT_HUB_TOKEN`, `ZEN_AGENT_URL`, `ZEN_AGENT_TOKEN`, `HERMES_HOME`, `AGENTS_SYNC_HOST` |
| Docs | `docs/modules.md#agents` |

The manifest beside this file (`manifest.ts`) is the one place the addon is wired: its CLI, timers, wrappers, env and doc page. `deploy.sh`, `secondbrain features`, `doctor` and `secondbrain plan|apply` all read it. See `docs/addons.md`.
