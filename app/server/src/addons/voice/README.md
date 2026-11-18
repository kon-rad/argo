# `voice` addon

Status: **shipped (local only)** - Reads a note aloud through a local OpenAI-compatible speech server. Never mounted on a server: the routes only exist on a local deployment.

List it in the vault's `secondbrain.json` `addons` (or `MODULES` in `.env`) to turn it on. It is off in a fresh vault.

| | |
|---|---|
| Module | `voice` |
| CLI | none |
| Timers (server) | none |
| Env | `TTS_URL`, `TTS_MODEL` |
| Docs | `docs/modules.md#voice` |

The manifest beside this file (`manifest.ts`) is the one place the addon is wired: its CLI, timers, wrappers, env and doc page. `deploy.sh`, `secondbrain features`, `doctor` and `secondbrain plan|apply` all read it. See `docs/addons.md`.
