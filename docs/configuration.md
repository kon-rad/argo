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
| `MODULES` | empty | Optional features, comma separated: `ring`, `agents`, `projects`, `org`, `usage`, `map`, `tv`, `voice`, `livestream`, `media`, `social`, `fund`, `chat`. Unknown names are ignored |
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

## Chat providers

Used by the `chat` module and by the embedder's optional contextual-enrichment step. A provider is offered in the app only when its key is set; which models each one lists comes from `app/config/llm-presets.json` plus the vault's `chat.providers` (below).

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | unset | Anthropic (Claude) |
| `OPENAI_API_KEY` | unset | OpenAI |
| `TOGETHER_API_KEY` | unset | Together AI (shared with embeddings and the database page) |
| `OPENROUTER_API_KEY` | unset | OpenRouter |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | A local Ollama needs no key and is always offered |
| `RERANK_URL`, `RERANK_API_KEY` | unset | A Cohere-compatible `/rerank` endpoint (Together, Cohere, Jina) for the chat's optional reranking step. Unset: the switch is off |
| `RERANK_MODEL` | `Salesforce/Llama-Rank-V1` | The reranker model at that endpoint |

The Embeddings source's config (Sources page) takes `contextualize` (boolean), `context_provider` and `context_model` for the enrichment step; see [rag.md](rag.md).

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
| `SB_LEDGER_DIR`, `SB_LEDGER_TOKEN` | agent ledger (on each machine, not the server) | the OS data folder, the token in `ledger.json` | Where a machine's agent ledger keeps `ledger.db` and `ledger.json`, and a token that overrides the stored one. See the app README, "Agent ledger" |
| `PROJECTS_FEED_TOKEN` | `projects` | unset | Read-only bearer token for `GET /api/feed/projects` (a kiosk panel). Unset: the route doesn't exist. `deploy.sh` generates one |
| `ORG_OWNER` | `org` | `owner` | Your handle on the agent board (lowercase, `a-z0-9-`) |
| `ORG_VAULT_ASSIGNEE` | `org` | `vault-session` | The kanban assignee for vault work: a Claude Code session on your machine that no dispatcher spawns (lowercase, `a-z0-9-`). Cards on boards that still use the old slug `m4` keep working |
| `ORG_SESSION_MAX_RUNS` | `org` | `3` | Runs one remembered agent session carries before the next wake starts fresh. `1` never resumes |
| `ORG_TASK_WAKE_RETRIES`, `ORG_TASK_WAKE_BACKOFF_MINUTES` | `org` | `2`, `15` | A card that keeps waking its bot waits 15, then 30 minutes between wakes, and after 2 re-wakes in 24 h is held until a person wakes it (`wake-add --reason owner`) |
| `ORG_TZ` | `org` | `UTC` | The local day for "one routine wakeup per day" and the dispatcher's quiet hours (an IANA zone name) |
| `ORG_DISPATCH` | `org` | `off` | `on`: the engine's dispatcher runs bots whose roster `runtime` is `zen-agent` (`secondbrain org-dispatch`; a timer on the server). `off`: wakeups are left to your own dispatcher |
| `ORG_DISPATCH_TICK_SECONDS`, `ORG_DISPATCH_PARALLEL` | `org` | `120`, `2` | How often the dispatcher looks, and how many bots run at once |
| `ORG_DISPATCH_QUIET` | `org` | unset | Local hours with no wakes, `HH-HH` (e.g. `01-07`) |
| `ORG_DISPATCH_DAILY_TOKENS` | `org` | `0` (off) | Tokens all bots together may spend in one local day before the rest of the day's wakes are held |
| `ORG_ZEN_COMMAND` | `org` | `zen-agent` | The zen-agent command the dispatcher runs (on the PATH, or absolute) |
| `ZEN_SESSIONS_DIR` | `usage` | `<vault>/.zen/sessions` | Where zen-agent writes its traces; `usage-sync` reads them into the ledger |
| `CLASSIFY_PROVIDER` | `org` | `none` | The classify step's provider: `openrouter` (Jev through OpenRouter with `OPENROUTER_API_KEY`) or `typesafe` (with `TYPESAFE_API_KEY`). `none`: every decision falls through to the old path |
| `CLASSIFY_DAILY_TOKENS` | `org` | `2000000` | Classifier input tokens per day; above it, decisions fall through |
| `TYPESAFE_API_KEY` | `org` | unset | A direct TypeSafe key, when `CLASSIFY_PROVIDER=typesafe` |
| `RING_PULL_SSH_HOST`, `RING_PULL_DB` | `ring` | unset, `secondbrain` | Mirror a server's ring tables over ssh |
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
| `fund.dir`, `fund.txService`, `fund.explorer` | `fund` | Vault folder of the fund's state (default `fund`), the Safe Transaction Service URL and the block explorer for its chain (defaults: Base) |
| `projects.reportFile` | `projects` | Where `cli-projects render` writes the markdown report (default `projects.md`) |
| `chat.defaultProvider` | `chat` | The preset provider the chat starts on, when its key is set |
| `chat.systemPrompt` | `chat` | Replaces the engine's base system prompt (still editable in the app's settings modal) |
| `chat.providers.<id>` | `chat` | Per preset provider: `models` to add (`[{ "id", "label" }]`), another `default` model, another `baseUrl` |
| `classify.allow` | `org` | Channel slugs and vault folder prefixes whose text may be sent to the classifier. Empty (the default): every decision falls through and nothing leaves the machine |
| `classify.model` | `org` | `provider/model` for decisions whose schema pins none (default `openrouter/typesafe/jev-1.14`) |
| `classify.schemasDir` | `org` | Vault folder of decision schemas, `<decision>.yaml` (default `.agents/classify`); the engine's defaults fill in what is missing |
| `dispatch.tiers` | `org` | `{ "flash-low" \| "flash-high" \| "mid" \| "strong": { "model", "thinking" } }`: what the card-tier decision routes to. Unset tiers use zen-agent's own model |
| `dispatch.budgets` | `org` | Per wake reason (`dm`, `mention`, `handoff`, `task`, `routine`, `owner`): `{ "turns", "tokens", "minutes" }` |
| `dispatch.tools` | `org` | Per wake reason: zen-agent tool sets (`fs`, `shell`, `skills`, `knowledge`, `kanban`, `org`, `subagent`) |

Example:

```json
{
  "goalsFile": "Areas/goals.md",
  "map": { "divisionFolders": { "writing": ["Areas/blog"] } },
  "tv": { "shows": { "weekly": "The weekly report" } },
  "livestream": { "youtube": "example" }
}
```
