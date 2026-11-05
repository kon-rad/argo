# Addons

Status: **works** - the core five features are always on; every other module is an addon, off until your vault lists it.

The core features (`projects`, `org`, `board`, `usage`, `summaries`) ship on in every vault. Everything else is an **addon**: still in this repo, but off until you list it. Enabling one is a line in the vault's `secondbrain.json`:

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

Two addons run outside the app and so keep a `manifest.json` at the repo root instead of a TypeScript manifest: `addons/tv-kiosk/` (a Raspberry Pi that shows the app on a TV) and `addons/telegram-bridge/` (a Python bridge with its own unit and env). `deploy`, `doctor` and this index read both shapes.

## Pilot and proposal addons

Four addons are named in the plan but not yet given a manifest, because each is a pilot or a proposal rather than shipped code: `routing` (`org-router.ts`, `route_decisions`, the routing report timer), `classify` (the wake gate at `secondbrain classify`), `dispatch` (the zen-agent dispatcher, which stays a pilot addon) and `improve` (the self-improvement loop, docs only). Their app paths are removed from the core as phase 5's second slice lands; each gets a manifest and a Status line when it does.

## Adding an addon

An addon is a folder `app/server/src/addons/<name>/manifest.ts` (and a `routes.ts` beside it when it has API routes), plus its name in `ADDON_MODULES` (`app/server/src/modules.ts`). `test/addons.test.ts` fails the build when a name in `ADDON_MODULES` has no manifest, when an addon claims to be core, or when the two lists disagree. `test/features.test.ts` checks that every file a manifest names (CLI entry, unit pair, wrapper, doc page) exists.
