# `livestream` addon

Status: **shipped** - A minute poller that writes a public JSON of stream stats (viewers, hours) for YouTube, Twitch and Kick.

List it in the vault's `secondbrain.json` `addons` (or `MODULES` in `.env`) to turn it on. It is off in a fresh vault.

| | |
|---|---|
| Module | `livestream` |
| CLI | `secondbrain livestream` |
| Timers (server) | `secondbrain-livestream` |
| Env | `LIVESTREAM_YOUTUBE`, `LIVESTREAM_TWITCH`, `LIVESTREAM_KICK`, `LIVESTREAM_PUBLIC_DIR` |
| Docs | `docs/modules.md#livestream` |

The manifest beside this file (`manifest.ts`) is the one place the addon is wired: its CLI, timers, wrappers, env and doc page. `deploy.sh`, `secondbrain features`, `doctor` and `secondbrain plan|apply` all read it. See `docs/addons.md`.
