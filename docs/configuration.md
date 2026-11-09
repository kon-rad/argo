# Configuration

Status: **works** - every env variable and `secondbrain.json` key the app reads, as shipped.

Three places, each for one kind of value. Nothing personal is ever compiled into the engine.

| File | Holds | Committed? |
|---|---|---|
| `<vault>/.env` | Keys and per-machine settings on your laptop | No (gitignored) |
| `/etc/secondbrain/env` | The same, on a server (owned `root:<app user>`, mode 640) | No |
| `<vault>/secondbrain.json` | Structured, non-secret settings for modules | Yes, to your private vault |

The app reads `<vault>/.env` at start (`app/server/src/config.ts`), validates every value, and refuses to start with a clear message if one is invalid. A value already in the process environment wins over the file.

## Instance configuration and feature manifests

These names refer to different layers:

| Term | Location | Who edits it | Purpose |
|---|---|---|---|
| **Instance configuration** | `<vault>/secondbrain.json` (or `SECONDBRAIN_SETTINGS`) | The instance owner | Non-secret choices for this installation, such as enabled addons and Usage panels |
| **Example instance configuration** | `<vault>/secondbrain.example.json`, copied from the engine's `vault-template/` | Read it as a reference | Examples of supported settings; the app does not load this file automatically |
| **Feature manifest** | Engine `app/server/src/features/<name>/manifest.ts` or `app/server/src/addons/<name>/manifest.ts` | Engine contributors | Registration and lifecycle wiring for a feature: commands, routes, units and configuration metadata |

Use **instance configuration** for the user's JSON file and **feature manifest** or **addon manifest** for the engine registration files. If another page calls `secondbrain.json` a "vault manifest", it means the instance configuration, not a feature manifest. Enabling an existing addon changes instance configuration; implementing a new addon changes engine code. See [Addons](addons.md#instance-configuration-and-feature-manifests).

For a fresh instance, follow [Set up your vault](onboarding/02-set-up-your-vault.md#step-2-create-the-vault). No engine source edit is needed to set instance options. Secrets and per-machine environment values stay in `.env` or the server environment file.

## Core settings

| Variable | Default | Purpose |
|---|---|---|
| `VAULT_ROOT` | The folder that holds `.secondbrain/` | Which vault to index |
| `DATABASE_URL` | `postgres://localhost:5432/secondbrain` | The index database |
| `PORT` | `5123` | HTTP port (always bound to `127.0.0.1`) |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `DEPLOYMENT` | `local` | `local` (no login, loopback) or `server` (login required). See [deployment.md](deployment.md) |
| `SUMMARIES`, `SUMMARIES_M1_URL` | unset | `SUMMARIES=on` is deprecated (one release): put `summaries` in `MODULES` instead. `SUMMARIES_M1_URL` is the home server's Ollama address that the default chain tries first. See [summaries.md](summaries.md) |
| `B2_KEY_ID`, `B2_APP_KEY`, `B2_BUCKET`, `B2_S3_ENDPOINT` | unset | uploads: the bucket and its S3 endpoint. Presigned URLs are signed with this key; it never reaches the browser |
| `B2STORE_CRYPT_PASSWORD`, `B2STORE_CRYPT_PASSWORD2` | unset | uploads: the rclone-crypt passwords when the vault part of the bucket is encrypted (the same rclone-crypt passwords the object-storage tooling uses) |
| `UPLOADS_MAX_GB` | `50` | uploads: the largest single file the page accepts |
| `UPLOADS_PULL_TOKEN` | unset | uploads: bearer token (16+ characters) the second machine's puller sends |
| `MODULES` | empty | Optional features, comma separated: `ring`, `agents`, `projects`, `org`, `board`, `usage`, `summaries`, `map`, `tv`, `voice`, `livestream`, `media`, `social`, `fund`, `chat`, `uploads`, `garden`. Unknown names are ignored |
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
| `OLLAMA_MACHINES` | unset | Connected computers that run Ollama: comma-separated `name=url` pairs, e.g. `box1=http://192.0.2.10:11434,box2=http://192.0.2.11:11434`. See below |
| `RERANK_URL`, `RERANK_API_KEY` | unset | A Cohere-compatible `/rerank` endpoint (Together, Cohere, Jina) for the chat's optional reranking step. Unset: the switch is off |
| `RERANK_MODEL` | `Salesforce/Llama-Rank-V1` | The reranker model at that endpoint |

**Connected computers.** Each `name=url` pair in `OLLAMA_MACHINES` adds a chat provider with id `ollama-<name>` and label `Ollama · <name>`. The name is `[a-z0-9][a-z0-9_-]*`; the url is the machine's Ollama base, with no `/v1`. The models are not listed in any file: the app asks the machine (`GET <url>/api/tags`, 2.5 s timeout) each time the settings modal opens, cached for about 20 s, and offers every model except embedding models (BERT family, or "embed" in the name). The first model is the default. A machine that does not answer stays in the list as `(offline)` and cannot be picked; it never slows or breaks the rest. Invalid pairs are skipped with one warning at start. The single-host `ollama` provider (`OLLAMA_URL`) is unchanged. The zen-agent harness reads the same variable the same way.

The Embeddings source's config (Sources page) takes `contextualize` (boolean), `context_provider` and `context_model` for the enrichment step; see [rag.md](rag.md).

## Server and login

Required when `DEPLOYMENT=server`; the app refuses to start without them.

| Variable | Purpose |
|---|---|
| `PUBLIC_ORIGIN` | The browser-visible origin, for example `https://brain.example.com`. Every mutating request must carry it as `Origin` |
| `AUTH_PASSWORD_HASH`, `AUTH_TOTP_SECRET` | Printed by `secondbrain auth-setup`, which you run on your own machine |
| `B2_SERVE_URL` | Optional: a local object-storage file server for big files kept only in object storage |

Deploy settings (`DEPLOY_*`) are read by `deploy.sh` only: see [deployment.md](deployment.md#settings).

## Generated config: `plan`, `apply`, `upgrade`

A server's `/etc/secondbrain/env` and its systemd units are generated from `secondbrain.json`'s `server` block plus the enabled feature manifests, instead of being hand-edited and drifting.

| Command | Does |
|---|---|
| `secondbrain plan` | Prints the env file and units this server should have and how they differ from what is on disk. **Writes nothing** |
| `secondbrain apply` | Writes that plan. Refused unless `server.generate` is `true` |
| `secondbrain upgrade` | The same plan as a dry run; `--yes` writes it. Re-fetching and moving the engine pin are not wired yet |

Generation is **off by default** (`server.generate: false`), so a merge never changes a running server's units by itself; turning it on and running `apply` is the owner's step. `SB_UNIT_DIR` and `SB_ENV_FILE` override where the units and the env file are written (a dry run or a test). `test/env-schema.test.ts` fails the build when the code reads a `process.env` key that is neither in the schema nor on its documented worklist, so a setting cannot appear without a default and a line in this page.

## Using another machine's database

| Variable | Where | Purpose |
|---|---|---|
| `SECONDBRAIN_DB_URL` | Vault `.env` | The launcher connects to this database instead of a local one, and starts the app with `INDEXER=off` |
| `SECONDBRAIN_DB=local` | Environment | Force the local database for one run |

## Hiring Desk production settings

These settings are optional strings in the global environment schema and are validated only when `desk` boots. With the addon disabled, no payment configuration or runtime module is required. Enabling desk fails before the HTTP listener starts if its production configuration is incomplete. There is no fixture fallback.

| Variable | Default | Purpose |
|---|---|---|
| `DESK_DOMAIN` | unset | Public desk/v1 record domain |
| `DESK_CHAIN_ID` | unset | Settlement network, explicitly `5042002` for Arc Testnet |
| `DESK_PAYMENT_INTERFACE` | unset | Explicit `arc:testnet:erc20-usdc:transfer:v1` or preserved `arc:testnet:native-usdc:eip-7708:v1`; never inferred |
| `DESK_USDC_ADDRESS` | unset | Verified ERC-20 USDC contract, required for the ERC-20 interface |
| `DESK_RPC_URL` | unset | Server-only HTTP(S) RPC URL; never returned to the public client |
| `DESK_PUBLIC_ORIGIN` | unset | Exact allowed HTTPS browser origin, without a trailing slash |
| `DESK_RUNTIME_MODULE` | unset | Absolute path to a trusted server-only ES module exporting `createDeskRuntime` for live marketplace, identity, publication and worker services |

The engine supplies a real JSON-RPC reader, the explicitly selected settlement adapter and PostgreSQL receipt reservation. The runtime module supplies the remaining production services through the existing Phase 1 contracts. All adapters must be live, including capabilities and provider wallet transaction preparation. This is a production composition boundary, not a shipped host runtime: a deployment without concrete live host services is blocked. See [desk boot contract](https://github.com/kon-rad/argo/blob/0c96d254d517e0203f4e98813cd95569336eb5d9/app/server/src/addons/desk/README.md#production-boot-contract).

## Module settings

| Variable | Module | Default | Purpose |
|---|---|---|---|
| `AGENT_HUB_URL`, `AGENT_HUB_TOKEN` | `agents` | unset | The agent-hub service that serves Claude chats and the Telegram toggle. Unset: those tabs say so |
| `ZEN_AGENT_URL`, `ZEN_AGENT_TOKEN` | `agents` | unset | The `zen-agent serve` process behind `/api/zen` (the zen-agent chat page). The token is the serve process's `ZEN_SERVE_TOKEN`. Unset: the page says so |
| `HERMES_HOME` | `agents`, archive | `~/.hermes` | Hermes's home on this machine |
| `ARCHIVE_SSH_HOST`, `REMOTE_HERMES_HOME`, `REMOTE_HERMES_USER` | archive | unset | Pull a server's Hermes history over ssh; unset skips the pull |
| `SB_LEDGER_DIR`, `SB_LEDGER_TOKEN` | agent ledger (on each machine, not the server) | the OS data folder, the token in `ledger.json` | Where a machine's agent ledger keeps `ledger.db` and `ledger.json`, and a token that overrides the stored one. See the app README, "Agent ledger" |
| `PROJECTS_FEED_TOKEN` | `projects` | unset | Read-only bearer token for `GET /api/feed/projects` (a kiosk panel). Unset: the route doesn't exist. `deploy.sh` generates one |
| `KNOWLEDGE_TOKEN` | any | unset | Read-only bearer token for an agent on the same machine (zen-agent's `search_notes` and `read_note`). Opens `GET /api/search`, `/api/search/global` and `/api/file/source` and nothing else, only from loopback and never through a proxy (a request with a forwarding header, or a Host that is not `127.0.0.1`, `localhost` or `[::1]`, is refused). At least 32 characters; `openssl rand -hex 24`. Unset: the token does nothing |
| `ORG_OWNER` | `org` | `owner` | Your handle on the agent board (lowercase, `a-z0-9-`) |
| `ORG_VAULT_ASSIGNEE` | `org` | `vault-session` | The kanban assignee for vault work: a Claude Code session on your machine that no dispatcher spawns (lowercase, `a-z0-9-`). Cards on boards that still use the older assignee slug keep working |
| `ORG_SESSION_MAX_RUNS` | `org` | `3` | Runs one remembered `claude-code` agent session carries before the next wake starts fresh. `1` never resumes. Not used by the `zen-agent` lane, whose wakes are always fresh |
| `BOARD_LEASE_MINUTES` | `board` | `60` | How long a claimed card stays a lane's without a heartbeat before the `board-reclaim` sweep puts it back to ready |
| `BOARD_URL`, `BOARD_TOKEN` | `board` | unset | On a machine that is not the server: `cli-board` and agents reach the board over HTTPS as the roster member the token names (`cli-board token create <agent>`). Unset: the database connection is used |
| `ORG_TASK_WAKE_RETRIES`, `ORG_TASK_WAKE_BACKOFF_MINUTES` | `org` | `2`, `15` | A card that keeps waking its bot waits 15, then 30 minutes between wakes, and after 2 re-wakes in 24 h is held until a person wakes it (`wake-add --reason owner`) |
| `ORG_TZ` | `org` | `UTC` | The local day for "one routine wakeup per day" and the dispatcher's quiet hours (an IANA zone name) |
| `ORG_DISPATCH` | `org` | `off` | `on`: the engine's dispatcher runs bots whose roster `runtime` is `zen-agent` (`secondbrain dispatch`; a timer on the server). `off`: wakeups are left to your own dispatcher |
| `ORG_DISPATCH_TICK_SECONDS`, `ORG_DISPATCH_PARALLEL` | `org` | `120`, `2` | How often the dispatcher looks, and how many bots run at once |
| `ORG_DISPATCH_QUIET` | `org` | unset | Local hours with no wakes, `HH-HH` (e.g. `01-07`) |
| `ORG_DISPATCH_DAILY_TOKENS` | `org` | `0` (off) | Tokens all bots together may spend in one local day before the rest of the day's wakes are held |
| `ORG_ZEN_COMMAND` | `org` | `zen-agent` | The zen-agent command the dispatcher runs (on the PATH, or absolute) |
| `ZEN_SESSIONS_DIR` | `usage` | `<vault>/.zen/sessions` | Where zen-agent writes its traces; `usage-sync` reads them into the ledger |
| `CLASSIFY_PROVIDER` | `org` | `none` | The classify step's provider: `openrouter` (through OpenRouter with `OPENROUTER_API_KEY`) or `typesafe` (with `TYPESAFE_API_KEY`). `none`: every decision falls through to the old path |
| `CLASSIFY_DAILY_TOKENS` | `org` | `2000000` | Classifier input tokens per day; above it, decisions fall through |
| `TYPESAFE_API_KEY` | `org` | unset | A direct provider key, when `CLASSIFY_PROVIDER=typesafe` |
| `YOUTUBE_API_KEY` | `map` (social metrics) | unset | YouTube Data API v3 key for the social metrics collector ([social-metrics.md](social-metrics.md)). Unset: configured YouTube accounts report a missing key; nothing else changes. Instagram tokens for the same collector are stored encrypted with `SOCIAL_TOKEN_ENC_KEY` |
| `RING_PULL_SSH_HOST`, `RING_PULL_DB` | `ring` | unset, `secondbrain` | Mirror a server's ring tables over ssh |
| `TTS_URL`, `TTS_MODEL` | `voice` | `http://127.0.0.1:8880`, a Kokoro model | A local OpenAI-compatible speech server. Never used on a server |
| `ROBOT_LAUNCH_SCRIPT` | none (local only) | unset | A script the "start robot" button runs. Unset: the route isn't mounted |

## Doctor

`secondbrain doctor` checks the whole install and exits non-zero when a critical check fails. The same checks answer at `GET /api/health` (`{"ok": true, "checks": [...]}`), so a monitor and a person read one answer. It checks Node's major version, Postgres, the `vector` extension, pending migrations, unknown names in `MODULES`, a stale `AGENTS.md`, an unparsable `secondbrain.json`, the sync state, and each core feature's tables (the feature's manifest names them).

`--deep` adds the checks that only make sense on the deployed server (failed `secondbrain-*` units, the last backup); `?deep=1` does the same over HTTP. `--json` prints the checks as JSON. The doctor is additive: a failed non-critical check (a stale doc, a missing backup) is a warning, not an error.

## Vault sync

Per-machine settings for `secondbrain-vault sync` ([sync.md](sync.md)); the shared policy lives in `secondbrain.json`, below.

| Variable | Default | Purpose |
|---|---|---|
| `SYNC_ROLE` | `owner` | `owner` (you edit here; a conflict stops and alerts) or `agent` (a server; a conflict keeps both versions) |
| `SYNC_MACHINE` | the hostname | Name in sync commit messages and conflict copies |
| `SYNC_INTERVAL_MIN` | `60` | Minutes between runs, used by `sync install` |
| `SYNC_CONFLICTS` | by role | `stop` or `both` |
| `SYNC_ALERT` | `desktop` | `desktop`, `log`, or an `https://` webhook URL |
| `SYNC_STATE_DIR` | `~/.local/state/secondbrain` | Where `sync.json` and `sync.log` are written and where the app reads the sync chip from |

## Agent hooks

| Variable | Purpose |
|---|---|
| `DEV_LOG_INDEX` | The README the dev-log gate tells agents to link new entries from |
| `SB_GUARD_LOCAL` | An explicit path to `guard.local.json` |

## `secondbrain.json`

The **instance configuration** holds settings that do not fit on one env line. Every section is optional. A missing file uses defaults; an unparsable or invalid file is reported and ignored, and the app uses defaults. `init` copies `vault-template/secondbrain.example.json` into a new vault as a reference, not as the active file.

Start with `secondbrain.json` containing `{}` and add only the sections you need. Alternatively, copy `secondbrain.example.json` to `secondbrain.json`, then remove unwanted sections and replace placeholder paths, handles and models before starting the app. Do not overwrite an existing instance configuration when following setup instructions again.

The app loads `<vault>/secondbrain.json` once per server process. `SECONDBRAIN_SETTINGS` selects another file; a relative value is resolved against the vault root. Restart the app after edits. Commit non-secret instance settings to your private vault and sync them to other machines; keep credentials out of this file. For server provisioning, [plan and apply](#generated-config-plan-apply-upgrade) use the `server` block together with the engine's feature manifests. They do not create subscription logins or provider credentials.

The reference below lists shipped settings. It is not a generic registry for arbitrary subscription accounts or harnesses; a new integration still needs engine support.

| Key | Module | Holds |
|---|---|---|
| `server.*` | server | The `server` block: `generate` (default `false`), `host`, `publicOrigin`, `user`, `dir`, `vaultDir`, `hermesHome`, and `backup` (`schedule`, `keepDaily`, `keepWeekly`). Source for `secondbrain plan\|apply`; see "Generated config" above |
| `usage.subscriptions` | `usage` | Ordered quota panels: `codex`, `claude-code`. Default `[]`: no subscription readers are polled |
| `usage.credits` | `usage` | Ordered prepaid credit panels: `openrouter`, `fal`, `gemini`. Default `[]` |
| `usage.sections` | `usage` | Visible sections: `running`, `ledger`, `sessions`, `summaries`. Default all four; `[]` hides all four |
| `goalsFile` | `projects`, `map` | Your goals note: markdown tables of `\| W1 \| Goal \| Measure \| Due \| Status \|` |
| `missionFile` | `map` | Your mission note |
| `map.divisionFolders` | `map` | `{ "division": ["folder", ...] }`: which folders belong to which division when no project claims them |
| `map.missionFolders` | `map` | Notes that sit at the centre of the map |
| `metrics[]` | `map` | Numbers the map tracks. Each has `key`, `label`, `unit` (`followers`, `subscribers`, `hours`, `usd`, `count`), optional `goal`, `target`, `division`, `headline`, and either `collect` (type `youtube`, `x`, `instagram` or `base-balance`) or `sum` (a list of other metric keys) |
| `socialMetrics.*` | `map` | Social accounts the daily metrics timer reads through APIs: `youtube[]` (`channelId`), `instagram[]` (`username`, `tokenEnv`), `x[]` (`handle`, `postIdsFile`), `linkedin[]` (`account`, manual entries only), each with optional `key`, `label`, `staleHours`; and `staleHours` (36), `postDays` (90), `maxPosts` (500), `instagramApiVersion`. All lists empty by default. See [social-metrics.md](social-metrics.md) |
| `tv.episodesDir` | `tv` | Where episodes live in the vault (default `tv/episodes`) |
| `tv.shows` | `tv` | `{ "slug": "Show name" }` |
| `livestream.youtube`, `.twitch`, `.kick` | `livestream` | Your channel handle on each platform |
| `fund.dir`, `fund.txService`, `fund.explorer` | `fund` | Vault folder of the fund's state (default `fund`), the Safe Transaction Service URL and the block explorer for its chain (defaults: Base) |
| `projects.reportFile` | `projects` | Where `cli-projects render` writes the markdown report (default `projects.md`) |
| `summaries.chain`, `summaries.minSteps`, `summaries.quietMinutes`, `summaries.maxInputChars` | `usage` | Which providers write session summaries and in what order, the shortest session worth summarizing, how long a session must be quiet, and how much transcript is sent. Defaults in `app/config/summaries.json`; see [summaries.md](summaries.md) |
| `chat.defaultProvider` | `chat` | The preset provider the chat starts on, when its key is set |
| `chat.systemPrompt` | `chat` | Replaces the engine's base system prompt (still editable in the app's settings modal) |
| `chat.providers.<id>` | `chat` | Per preset provider: `models` to add (`[{ "id", "label" }]`), another `default` model, another `baseUrl` |
| `sync.remote`, `sync.branch` | vault sync | What every machine syncs with (default `origin`, `main`) |
| `sync.agentOwned` | vault sync | Files only `agent`-role machines commit, e.g. a rendered report |
| `sync.embeddedRepos`, `sync.maxFileMB`, `sync.settleSeconds`, `sync.heartbeat` | vault sync | `ignore` or `record` nested repos' pointers; largest file to commit (20); recent-write wait (90); write `.sync/<machine>.json` with each commit (off). See [sync.md](sync.md#settings) |
| `classify.allow` | `org` | Channel slugs and vault folder prefixes whose text may be sent to the classifier. Empty (the default): every decision falls through and nothing leaves the machine |
| `classify.model` | `org` | `provider/model` for decisions whose schema pins none (default: a hosted model over OpenRouter) |
| `classify.schemasDir` | `org` | Vault folder of decision schemas, `<decision>.json` (default `.agents/classify`); the engine's defaults fill in what is missing |
| `dispatch.tiers` | `org` | `{ "flash-low" \| "flash-high" \| "mid" \| "strong": { "model", "thinking" } }`: what the card-tier decision routes to. Unset tiers use zen-agent's own model |
| `dispatch.budgets` | `org` | Per wake reason (`dm`, `mention`, `handoff`, `task`, `routine`, `owner`): `{ "turns", "tokens", "minutes" }` |
| `dispatch.tools` | `org` | Per wake reason: zen-agent tool sets (`fs`, `shell`, `skills`, `knowledge`, `kanban`, `org`, `subagent`) |
| `dispatch.fallback` | `org` | What runs when a connected computer's model is down: `{ "model", "thinking"?, "retryOnError"? }`. Unset: no fallback. See "Model fallback" below |
| `memory.capture` | `memory` | The capture loop: `{ "enabled", "trigger", "everyMinutes", "maxWakesPerRun", "minTurns", "outcomes", "maxAgeHours", "maxFactsPerWake", "dedupe", "dedupeSimilarity", "scope", "chain", "promptFile", "systemPrompt" }`. Off by default; see [memory.md](memory.md#the-capture-loop-how-a-bots-own-memory-gets-written) |
| `garden.roots` | `garden` | Folders whose immediate subfolders are shelves (default `Projects`, `Areas`, `Research`) |
| `garden.archiveDir`, `garden.catalogFile`, `garden.reportDir`, `garden.shelfFile` | `garden` | Where archived shelves go (`Archives`), the rendered catalog (`garden/catalog.md`), the nightly reports (`garden/reports`) and the shelf note's file name (`README.md`) |
| `garden.projectArchiveAfterDays`, `garden.areaProposeAfterDays` | `garden` | Days without a commit before a project shelf is archived (90) or an area shelf is proposed (180) |
| `garden.maxMoves`, `garden.maxRenames` | `garden` | Caps per run (25 moves, 5 renames) |
| `garden.pinned` | `garden` | Shelves the gardener never archives, proposes or renames |
| `garden.apply` | `garden` | `true` lets the nightly timer move files; default `false` only writes READMEs, the catalog and the report. See [garden.md](garden.md) |

Example:

```json
{
  "goalsFile": "Areas/goals.md",
  "map": { "divisionFolders": { "writing": ["Areas/blog"] } },
  "tv": { "shows": { "weekly": "The weekly report" } },
  "livestream": { "youtube": "example" }
}
```

## Model fallback

A bot on a connected computer's model (`OLLAMA_MACHINES`, provider `ollama-<name>`) has no model when that computer is off, asleep or has unloaded the model. One setting names what runs instead:

```json
{ "dispatch": { "fallback": { "model": "together/deepseek-ai/DeepSeek-V4.1-Flash", "thinking": "off", "retryOnError": true } } }
```

| Field | Default | Says |
|---|---|---|
| `model` | required | A `provider/model` zen-agent can call with a key from the environment (`zen-agent models --available` lists them; a model pi-ai does not know goes in `zen.json` `providers`) |
| `thinking` | the run's own | Thinking level for the fallback run |
| `retryOnError` | `true` | Re-run once on the fallback when a run on the machine ends with a provider error |

What the dispatcher does with it, per wake:

1. **Before the run.** After the tier and the router have chosen the model, the dispatcher looks at its provider: `provider/model` ids by their prefix, a bare alias such as `qwen3.6:35b-a3b` through the routing catalog. If the provider is a connected computer, the dispatcher asks its Ollama for its models (2.5 s, cached 20 s). No answer: the run starts on the fallback model instead, logged as `fallback: <machine> did not answer`, with `--meta fallback=machine-down` on the trace.
2. **After the run.** A run on the machine that exits non-zero (not `3`, the budget stop) with a provider error in its last words (`not in provider … catalogue`, `ECONNREFUSED`, `fetch failed`, `502`, …) is recorded as a failed run and re-run once on the fallback under run id `<run>-fb`, with `--meta fallback=run-error`. A run that failed on its task (tests red, blocked) is not retried.
3. **What does not change.** The router's floors and parks stand: a card the router parks stays parked, only the host changes. The budget is the one the tier set. The wakeup's result is prefixed `[fallback machine-down: <model>]` or `[fallback run-error: <model>]`, so the board and `/usage` show which runs fell back.

Unset, nothing falls back: the wake fails the way it did before, and the card goes back to `ready`. Hermes-runtime bots are not dispatched here and keep their own `fallback_providers`.

### Usage page providers and sections

The Usage page owns subscription quotas, prepaid balances and run/session accounting. The navigation header and agent profile link to Usage instead of polling duplicate quota or token summaries. Select the providers and sections this installation uses in its instance configuration, `<vault>/secondbrain.json`:

```json
{
  "usage": {
    "subscriptions": ["codex", "claude-code"],
    "credits": ["openrouter"],
    "sections": ["running", "ledger", "sessions", "summaries"]
  }
}
```

Restart the app after changing instance configuration; settings are read once per server process.

Subscriptions and credits default to empty lists. Listing a provider enables its panel; it does not create credentials, purchase a plan, or change a provider's limits. Array order determines panel order. An explicit empty `sections` list hides all four optional page sections, while subscription/credit panels are controlled separately. Disabled sections do not start their UI polling. The Usage core feature and its navigation remain available.

For Codex, install the supported Codex CLI as the same OS user that runs the app, then sign in using its ChatGPT subscription. `ORG_CODEX_COMMAND` selects the executable (default `codex`). The app starts `codex app-server` using its default stdio transport (no `--stdio` flag), then makes bounded, read-only app-server calls to `account/read` and `account/rateLimits/read`. It strips API-key and endpoint overrides, rejects API-key authentication, caches quota readings, and never launches a model turn to fetch a quota. CLI credentials stay with Codex and are never returned to the browser.

If the default `codex` command is absent from the app service's `PATH`, the quota reader also checks the service user's `~/.local/bin/codex`. A custom `ORG_CODEX_COMMAND` is used exactly as configured; use an absolute executable path when the service has a different `PATH` from your interactive shell. Verify quotas under the actual service user's environment, since a successful interactive-shell read does not verify service executable discovery.

Quota windows are identified by their reported duration, not by assuming `primary` means five hours: 300 minutes is five hours and 10,080 minutes is weekly. Other returned buckets/windows keep their own labels. Some plans report only a weekly window; the UI does not fabricate a missing five-hour quota. It shows used and remaining percentages, reset time, observation time, and unavailable or stale readings. A passed reset means the previous percentage is no longer current, not that a new reading is zero. Account limits apply to the authenticated account across its usage; they are distinct from tokens recorded on this installation.

Agent selection and Telegram bot controls live on the Usage page when the agents module is enabled, rather than in desktop or mobile headers.

Claude Code uses the existing statusline/run-log snapshots for five-hour and weekly quota readings; its history is kept. Nonexpired observations over 30 minutes old are shown as stale, and an account with only expired windows is unavailable until collection supplies a new reading. Missing windows and missing observations name the statusline wrapper and usage collector to check. A fresh weekly window can still be current when an older five-hour window has expired. Neither subscription panel estimates quota from token counts or labels API-equivalent dollar costs as subscription charges. The prepaid API cards remain separate.

The authenticated Usage API provides `GET /api/usage/config` and `GET /api/usage/subscriptions`. Configuration contains only the allow-listed presentation settings, and subscription responses contain only sanitized quota fields. `GET /api/usage/plan` remains the legacy Claude history endpoint.

Official Codex protocol reference: [account rate limits](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt). This UI reads limits; it does not increase them, buy resets, or enforce a separate local spending policy.

The opt-in Mac usage installer accepts `CODEX_HOME` (default `~/.codex`),
`USAGE_HOST` (required unique host slug), `USAGE_PUSH_HOST` (required existing SSH
destination), and `USAGE_PUSH_STATE` (default `~/.local/share/secondbrain`).
It persists them in the LaunchAgent. See [native conversation setup](modules.md#native-codex-conversation-usage).
`USAGE_PUSH_MAX_BYTES` remains a soft budget for whole Codex session replay.

### Codex quotas in a hardened server service

The systemd app service keeps `ProtectHome=read-only`. The Codex CLI still needs writable local state for a read-only quota request, so the template permits only the app user's optional `~/.codex` directory in addition to the vault and app data. The leading `-` on this `ReadWritePaths` entry lets services without a Codex installation start normally. It does not create a login or copy credentials.

If `CODEX_HOME` names another absolute directory, add that exact directory to the service's writable paths with `sudo systemctl edit secondbrain`:

```ini
[Service]
ReadWritePaths=-/srv/codex-state
```

Replace the example path with the selected `CODEX_HOME`, keep its ownership with the app user, and restart the app after `sudo systemctl daemon-reload`. Leave `ProtectHome=read-only` enabled. Verify quota retrieval through the running app's authenticated `/api/usage/subscriptions` endpoint; a successful shell probe does not verify the systemd sandbox.
