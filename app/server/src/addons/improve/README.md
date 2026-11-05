# `improve` addon

Status: **proposal** - The self-improvement loop from the plan. Docs only, no code paths: a proposal, not shipped. It gains a manifest and a Status line like the others.

List it in the vault's `secondbrain.json` `addons` (or `MODULES` in `.env`) to turn it on. It is off in a fresh vault.

| | |
|---|---|
| Module | `improve` |
| CLI | none |
| Timers (server) | none |
| Env | none |
| Docs | `docs/addons.md` |

The manifest beside this file (`manifest.ts`) is the one place the addon is wired: its CLI, timers, wrappers, env and doc page. `deploy.sh`, `secondbrain features`, `doctor` and `secondbrain plan|apply` all read it. See `docs/addons.md`.
