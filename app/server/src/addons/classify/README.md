# `classify` addon

Status: **pilot** - The wake gate (`classify/`, `org-classify.ts`): one calibrated decision about a state, logged to `classify_decisions`. One provider, so the pilot has not run. Its code (`org-classify.ts`, the `classify/` module, `cli.ts`) lives in this folder.

List it in the vault's `secondbrain.json` `addons` (or `MODULES` in `.env`) to turn it on. It is off in a fresh vault.

| | |
|---|---|
| Module | `classify` |
| CLI | `secondbrain classify` |
| Timers (server) | none |
| Env | none |
| Docs | `docs/addons.md` |

The manifest beside this file (`manifest.ts`) is the one place the addon is wired: its CLI, timers, wrappers, env and doc page. `deploy.sh`, `secondbrain features`, `doctor` and `secondbrain plan|apply` all read it. See `docs/addons.md`.
