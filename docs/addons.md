# Addons

Status: **works** - the core six features are always on; every other module is an addon, off until your vault lists it.

The core features (`projects`, `memory`, `org`, `board`, `usage`, `summaries`) ship on in every vault. Everything else is an **addon**: still in this repo, but off until you list it. Enabling one is a line in the vault's `secondbrain.json`:

```json
{ "addons": ["map", "voice", "social"] }
```

`MODULES=map,voice` in `.env` still works and means the same thing; `addons` in `secondbrain.json` is the newer home.

Each addon has one place it is wired, a manifest at `app/server/src/addons/<name>/manifest.ts`, the same shape as a core feature's (`app/server/src/features/<name>/manifest.ts`): the CLI commands, the timers, the PATH wrappers, the env keys and the doc page. `secondbrain features list` prints the core features and the addons with their state; `secondbrain plan|apply` and `deploy.sh` read the same manifests for the units and the env, so an addon's timer installs only when the addon is on and off means nothing mounts, links or runs.

| Addon | One line | CLI | Timers (server) |
|---|---|---|---|
| [`ring`](modules.md#ring) | Data from a wearable ring that a client pushes in | `ring-pull` | - |
| [`agents`](modules.md#agents) | Views over a separately-run agent-hub, and `/cron` | `agents-sync` | `agents-sync` |
| [`map`](modules.md#map) | A 3D map of the vault, projects and goals, with metrics | `map-build`, `metrics`, `backlinks` | `map-build`, `metrics` |
| [`tv`](modules.md#tv) | A player for video episodes kept in the vault | - | - |
| [`voice`](modules.md#voice) | Read a note aloud through a local speech server (local only) | - | - |
| [`livestream`](modules.md#livestream) | A public JSON of stream stats for YouTube, Twitch and Kick | `livestream` | `livestream` |
| [`media`](modules.md) | A browser over the vault's media files | - | - |
| [`social`](modules.md#social) | Schedule and publish posts to LinkedIn and through Buffer | `social` | `social` |
| [`fund`](modules.md#fund) | A read-only view of an agentic fund | - | - |
| [`chat`](modules.md#chat) | Ask your second brain, answered from retrieved passages | - | - |
| [`uploads`](uploads.md) | Send 1 GB to 50 GB files from a browser to the B2 bucket | - | - |
| [`garden`](garden.md) | A nightly shelf-keeping pass over Projects/, Areas/ and Research/ | `garden` | `garden` |
| [`routing`](modules.md) | The model-routing pilot: tier selection and the weekly routing report | - | `routing-report` |
| [`classify`](modules.md) | The wake gate: one calibrated decision about a state, logged | `classify` | - |
| [`dispatch`](modules.md) | The zen-agent dispatcher: one run per bot with open wakeups | `dispatch` | `dispatch` |
| [`improve`](modules.md) | The self-improvement loop (proposal) | - | - |

Two addons run outside the app and so keep a `manifest.json` at the repo root instead of a TypeScript manifest: `addons/tv-kiosk/` (a Raspberry Pi that shows the app on a TV) and `addons/telegram-bridge/` (a Python bridge with its own unit and env). `deploy`, `doctor` and this index read both shapes.

## Pilot and proposal addons

Four addons are pilots or proposals rather than shipped code. Each now has a manifest under `app/server/src/addons/<name>/` and a Status line, so it shows in `secondbrain features list`, but it is off unless your vault lists it:

| Addon | Status | What it is |
|---|---|---|
| `routing` | pilot | The model-routing tier selection and the `route_decisions` / `route_outcomes` ledger, and the weekly routing report (its timer moved off the org manifest onto this one). |
| `classify` | pilot | The wake gate (`secondbrain classify`): one calibrated decision about a state, logged to `classify_decisions`. |
| `dispatch` | pilot | The zen-agent dispatcher (`secondbrain dispatch`), one run per bot with open wakeups. Off unless the module is on and the server sets `ORG_DISPATCH=on`. |
| `improve` | proposal | The self-improvement loop from the plan. Docs only: no code paths, no CLI, no timer. |

Their **code** now lives under each addon's folder: `addons/classify/` (`org-classify.ts`, the `classify/` module and `cli.ts`), `addons/dispatch/` (`index.ts`, `store.ts` and `cli.ts`) and `addons/routing/` (`org-router.ts`). Their CLIs ride the manifest's command table (`secondbrain classify`, `secondbrain dispatch`), so the launcher dispatches them like any other feature command and `secondbrain features help` lists them; the routing subcommands stay on the core `org` command, which imports the router from `addons/routing/`.

## Adding an addon

An addon is a folder `app/server/src/addons/<name>/manifest.ts` (and a `routes.ts` beside it when it has API routes), plus its name in `ADDON_MODULES` (`app/server/src/modules.ts`). `test/addons.test.ts` fails the build when a name in `ADDON_MODULES` has no manifest, when an addon claims to be core, or when the two lists disagree. `test/features.test.ts` checks that every file a manifest names (CLI entry, unit pair, wrapper, doc page) exists.
