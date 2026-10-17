# Configuration

Three places, each for one kind of value. Nothing personal is ever compiled into the engine.

| File | Holds | Committed? |
|---|---|---|
| `<vault>/.env` | Keys and per-machine settings on your laptop | No (gitignored) |
| `/etc/secondbrain/env` | The same, on a server (owned `root:<app user>`, mode 640) | No |
| `<vault>/secondbrain.json` | Structured, non-secret settings for modules | Yes, to your private vault |

The app reads `<vault>/.env` at start (`app/server/src/config.ts`), validates every value, and refuses to start with a clear message if one is invalid. A value already in the process environment wins over the file.

## Core settings

| Variable | Default | Purpose |
|---|---|---|
| `VAULT_ROOT` | The folder that holds `.secondbrain/` | Which vault to index |
| `DATABASE_URL` | `postgres://localhost:5432/secondbrain` | The index database |
| `PORT` | `5123` | HTTP port (always bound to `127.0.0.1`) |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `DEPLOYMENT` | `local` | `local` (no login, loopback) or `server` (login required). See [deployment.md](deployment.md) |
| `MODULES` | empty | Optional features, comma separated: `ring`, `agents`, `projects`, `org`, `usage`, `map`, `tv`, `voice`, `livestream`, `localai`. Unknown names are ignored |
| `OWNER_NAME` | `owner` | Your name in the authenticator app and as a comment author |
| `DEV_LOG_PATH`, `DOCS_PATH` | unset | Vault-relative notes the nav bar links to; unset hides the link |
| `SCAN_INTERVAL_MINUTES` | `0` | Rescan and re-embed every N minutes; `0` means only when asked |
| `INDEXER` | `on` | `off` on a machine that uses another machine's database: it never scans or embeds |
| `SECONDBRAIN_SETTINGS` | `<vault>/secondbrain.json` | Where the structured settings live |

## Search and the database page

| Variable | Default | Purpose |
|---|---|---|
| `TOGETHER_API_KEY` | unset | Embeddings for semantic search, and the database page's question-to-SQL box. Without it, semantic search falls back to Ollama or returns 503; keyword search always works |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Local embeddings, when the embeddings source's provider is `ollama` |
| `SQL_MODEL` | a Together-hosted model | The model that writes SQL for the database page. Queries run read-only |

## Server and login

Required when `DEPLOYMENT=server`; the app refuses to start without them.

| Variable | Purpose |
|---|---|
| `PUBLIC_ORIGIN` | The browser-visible origin, for example `https://brain.example.com`. Every mutating request must carry it as `Origin` |
| `AUTH_PASSWORD_HASH`, `AUTH_TOTP_SECRET` | Printed by `secondbrain auth-setup`, which you run on your own machine |
| `B2_SERVE_URL` | Optional: a local `b2store serve` for big files kept only in object storage |

Deploy settings (`DEPLOY_*`) are read by `deploy.sh` only: see [deployment.md](deployment.md#settings).

## Using another machine's database

| Variable | Where | Purpose |
|---|---|---|
| `SECONDBRAIN_DB_URL` | Vault `.env` | The launcher connects to this database instead of a local one, and starts the app with `INDEXER=off` |
| `SECONDBRAIN_DB=local` | Environment | Force the local database for one run |

## Module settings

| Variable | Module | Default | Purpose |
|---|---|---|---|
| `AGENT_HUB_URL`, `AGENT_HUB_TOKEN` | `agents` | unset | The agent-hub service that serves the kanban board and chats. Unset: those tabs say so |
| `HERMES_HOME` | `agents`, archive | `~/.hermes` | Hermes's home on this machine |
| `ARCHIVE_SSH_HOST`, `REMOTE_HERMES_HOME`, `REMOTE_HERMES_USER` | archive | unset | Pull a server's Hermes history over ssh; unset skips the pull |
| `PROJECTS_FEED_TOKEN` | `projects` | unset | Read-only bearer token for `GET /api/feed/projects` (a kiosk panel). Unset: the route doesn't exist. `deploy.sh` generates one |
| `ORG_OWNER` | `org` | `owner` | Your handle on the agent board (lowercase, `a-z0-9-`) |
| `RING_PULL_SSH_HOST`, `RING_PULL_DB` | `ring` | unset, `secondbrain` | Mirror a server's ring tables over ssh |
| `LOCAL_AI_EXPORT_URL`, `LOCAL_AI_HOST` | `localai` | unset, `local` | The model host's logging gateway (base URL) and the `usage_hosts` slug its rows go under |
| `TTS_URL`, `TTS_MODEL` | `voice` | `http://127.0.0.1:8880`, a Kokoro model | A local OpenAI-compatible speech server. Never used on a server |
| `ROBOT_LAUNCH_SCRIPT` | none (local only) | unset | A script the "start robot" button runs. Unset: the route isn't mounted |

## Agent hooks

| Variable | Purpose |
|---|---|
| `DEV_LOG_INDEX` | The README the dev-log gate tells agents to link new entries from |
| `SB_GUARD_LOCAL` | An explicit path to `guard.local.json` |

## `secondbrain.json`

Settings that don't fit on one env line. Every section is optional; a file that doesn't parse is reported and ignored, and the app uses empty defaults. `vault-template/secondbrain.example.json` has one of each.

| Key | Module | Holds |
|---|---|---|
| `goalsFile` | `projects`, `map` | Your goals note: markdown tables of `\| W1 \| Goal \| Measure \| Due \| Status \|` |
| `missionFile` | `map` | Your mission note |
| `map.divisionFolders` | `map` | `{ "division": ["folder", ...] }`: which folders belong to which division when no project claims them |
| `map.missionFolders` | `map` | Notes that sit at the centre of the map |
| `metrics[]` | `map` | Numbers the map tracks. Each has `key`, `label`, `unit` (`followers`, `subscribers`, `hours`, `usd`, `count`), optional `goal`, `target`, `division`, `headline`, and either `collect` (type `youtube`, `x`, `instagram` or `base-balance`) or `sum` (a list of other metric keys) |
| `tv.episodesDir` | `tv` | Where episodes live in the vault (default `tv/episodes`) |
| `tv.shows` | `tv` | `{ "slug": "Show name" }` |
| `livestream.youtube`, `.twitch`, `.kick` | `livestream` | Your channel handle on each platform |
| `projects.reportFile` | `projects` | Where `cli-projects render` writes the markdown report (default `projects.md`) |

Example:

```json
{
  "goalsFile": "Areas/goals.md",
  "map": { "divisionFolders": { "writing": ["Areas/blog"] } },
  "tv": { "shows": { "weekly": "The weekly report" } },
  "livestream": { "youtube": "example" }
}
```
