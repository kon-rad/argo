# `social` addon

Status: **shipped** - Schedules and publishes posts with images or a video to LinkedIn, and to Instagram/YouTube/X through Buffer. Needs a provider configured, or the routes answer 503.

List it in the vault's `secondbrain.json` `addons` (or `MODULES` in `.env`) to turn it on. It is off in a fresh vault.

| | |
|---|---|
| Module | `social` |
| CLI | `secondbrain social` |
| Timers (server) | `secondbrain-social` |
| Env | `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `SOCIAL_REDIRECT_BASE_URL`, `SOCIAL_TOKEN_ENC_KEY`, `BUFFER_API_KEY`, `SOCIAL_MEDIA_BASE_URL`, `SOCIAL_X_MAX_CHARS` |
| Docs | `docs/modules.md#social` |

The manifest beside this file (`manifest.ts`) is the one place the addon is wired: its CLI, timers, wrappers, env and doc page. `deploy.sh`, `secondbrain features`, `doctor` and `secondbrain plan|apply` all read it. See `docs/addons.md`.
