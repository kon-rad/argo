# Second Brain

A local web app that indexes, browses and searches an [Obsidian](https://obsidian.md) vault — with full-text search, wikilink navigation, backlinks, and semantic search over embedded note chunks.

Markdown files on disk are the source of truth. Postgres is a disposable index over them: drop the database, re-scan, lose nothing.

```
secondbrain          start the server and open the browser
secondbrain scan     re-index the vault
secondbrain embed    embed new and changed notes for semantic search
secondbrain status   is it running, and how big is the index?
```

---

## Relationship to the vault

This app is part of the **secondbrain engine** repo. Your notes live in your own vault, usually a private git repo, which includes the engine as a submodule at `.secondbrain/`:

```
my-vault/                    ← your vault (private). Notes, .env, your own rules and skills.
├── Areas/  Projects/  …     ← notes
├── .env                     ← settings and credentials. Read by the app, never copied into it.
└── .secondbrain/            ← the engine (this repo), pinned to a version
    └── app/                 ← THIS APP
```

The link between them is one config value, `VAULT_ROOT`. By default the app finds the vault two levels up (`<vault>/.secondbrain/app`), or one level up when the engine is checked out on its own. Point it anywhere and the app indexes that vault instead. Nothing is duplicated: the app reads note content into Postgres as an index and only writes a note when you save it in the editor.

Obsidian skips dot-folders, so `.secondbrain/` (and its `node_modules`) never shows up in Obsidian's search.

---

## Tech stack

### Runtime and language

| | | Why |
|---|---|---|
| **Node** | 22 LTS | Native `fetch`, `AbortSignal.timeout`, stable ESM |
| **TypeScript** | 5.9, `strict` | NodeNext resolution; `.js` extensions in relative imports |
| **Module system** | ESM throughout | `"type": "module"` in every package |
| **Workspaces** | npm workspaces | `server` and `web`; all scripts live in the root `package.json` |

### Data layer

| | | Why |
|---|---|---|
| **Database** | PostgreSQL 15 (Homebrew) | Already running locally; no Docker daemon needed for a single-user app |
| **Vectors** | [pgvector](https://github.com/pgvector/pgvector) 0.8.1, HNSW, cosine | Embeddings live in the same database as the notes, so a deleted file drops its vectors in the same transaction. A separate vector store would need a second daemon and could drift out of sync |
| **Query layer** | `pg` driver + hand-written SQL — **no ORM** | Full-text ranking and vector search are the core features, and both are expressed as SQL an ORM would only wrap. The trade-off is deliberate: no compile-time schema types, in exchange for `ts_rank_cd`, `ts_headline`, `websearch_to_tsquery`, `DISTINCT ON` and `<=>` written directly |
| **Migrations** | `node-pg-migrate`, plain SQL up/down | Versioned schema, no codegen step |
| **Validation** | Zod 4 | At the HTTP boundary and on every source config |

Full-text search uses a generated `tsvector` column with weighted title and body, indexed with GIN. Vector search uses an HNSW index (`m=16, ef_construction=64`) over `vector(1024)`.

### Server

| | |
|---|---|
| **HTTP** | Express 5, REST/JSON, bound to `127.0.0.1` only |
| **Jobs** | In-process serial queue; progress in an `ingest_runs` table |
| **Connectors** | `{ id, configSchema, run(ctx) }` — `vault` and `embeddings` ship today |

In `local` mode there is no authentication: the server binds loopback only, and localhost *is* the security boundary. Binding `0.0.0.0` would publish the whole vault to the network.

### Embeddings

| | | Why |
|---|---|---|
| **Default model** | `intfloat/multilingual-e5-large-instruct` via Together AI | 1024 dimensions, 512-token window. As of 2026-08-27 it is the only embedding model Together still serves serverless |
| **Local alternative** | Ollama (`nomic-embed-text`, `bge-m3`) | Set the embeddings source `provider` to `ollama`. Nothing leaves the machine; works the same on an Ubuntu server |
| **Chunking** | Heading-aware, ~400 tokens, 60-token overlap | Chunks never straddle a section; code fences are never split unbalanced |
| **Query prefix** | Per model family | e5-instruct, e5 and bge each want a different query-side prefix. Omitting it costs recall and raises no error |

### Frontend

React 19 · Vite 8 · TanStack Query 5 · React Router 7 · Tailwind 4 · `react-markdown` 10 + `remark-gfm` with a custom remark plugin that turns `[[wikilinks]]` into in-app navigation.

### Testing

Vitest 4 + Supertest, running against a **real** `secondbrain_test` database — no mocked `pg`. The schema is rebuilt from migrations on every run.

---

## Search

Three modes, all on `GET /api/search`:

| Mode | What it does | When it wins |
|---|---|---|
| `keyword` | Postgres full-text with `websearch_to_tsquery` | Exact words, quoted `"phrases"`, `-exclusions`. Also the only mode that finds images and PDFs, by filename |
| `semantic` | Nearest neighbours over embedded chunks | Finds notes that never use your words |
| `hybrid` | Both, fused by reciprocal rank | The best default when you are not sure |

Hybrid uses **reciprocal rank fusion** (`k=60`) rather than blending scores. `ts_rank_cd` and cosine similarity are on unrelated scales; normalising one onto the other is a fudge factor that needs re-tuning whenever the corpus changes. Ranks are directly comparable. If the embedding provider is unreachable, hybrid degrades to keyword-only and says so in the response rather than failing.

---

## Getting started

Requires Node 22, PostgreSQL 15, and pgvector.

```bash
# pgvector must be built against the SAME Postgres the server talks to.
# Homebrew's bottle targets the default formula, which may not be yours.
git clone --branch v0.8.1 https://github.com/pgvector/pgvector.git
cd pgvector && make PG_CONFIG=$(brew --prefix postgresql@15)/bin/pg_config
make install PG_CONFIG=$(brew --prefix postgresql@15)/bin/pg_config

createdb secondbrain
cd app && npm install && npm run migrate:up
npm run build && npm start
```

Configuration comes from the **vault-root** `.env`, never a copy inside the engine:

| Variable | Default | Purpose |
|---|---|---|
| `VAULT_ROOT` | the vault around `.secondbrain/` | Which vault to index |
| `MODULES` | empty | Optional features, comma separated; see the table below |
| `OWNER_NAME` | `owner` | Your name in the authenticator app and on the Agents board |
| `DEV_LOG_PATH`, `DOCS_PATH` | unset | Vault-relative notes the nav links to; unset hides the link |
| `ROBOT_LAUNCH_SCRIPT` | unset | Local only: a script the robot button runs |
| `ARCHIVE_SSH_HOST` | unset | ssh alias of a server to pull Hermes archives from; unset skips the pull |
| `REMOTE_HERMES_USER`, `REMOTE_HERMES_HOME` | `hermes`, `~hermes/.hermes` | Where Hermes lives on that server |
| `RING_PULL_SSH_HOST` | unset | ssh alias of the server whose ring tables a local copy mirrors |
| `DATABASE_URL` | `postgres://localhost:5432/secondbrain` | |
| `PORT` | `5123` | |
| `TOGETHER_API_KEY` | — | Optional. Without it, semantic search reports 503 and everything else works |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | For the local embedding provider |
| `ORG_OWNER` | `owner` | org module: your name on the agent message board (the human agent) |
| `TTS_URL`, `TTS_MODEL` | `http://127.0.0.1:8880`, Kokoro | voice module: the local OpenAI-compatible speech server |
| `INDEXER` | `on` | `off` on a machine that uses another machine's database: it then never scans or embeds |
| `SECONDBRAIN_SETTINGS` | `<vault>/secondbrain.json` | Where the structured settings below live |

### Modules

Everything beyond browse, search and the database page is a module. A module that is off mounts no API routes and shows no nav link.

| Module | What it adds |
|---|---|
| `ring` | The Ring page: wearable ring data a client pushes in |
| `agents` | Agents and Cron pages over an agent-hub (kanban, Claude chats, Hermes history) |
| `projects` | A project tracker (divisions, projects, features, verifications) on `/projects`, `cli-projects`, a kiosk feed and a rendered markdown report |
| `org` | An agent company's message board on `/org` (`cli-org`): channels, DMs, wakeups for a dispatcher, row-level security per agent |
| `usage` | A ledger of Claude Code and Hermes usage on `/usage`, with plan percentages and API credit balances; also the ingest route each machine's agent ledger syncs to (below) |
| `map` | A 3D brain map of the vault on `/map`, with a lean kiosk view and daily metrics |
| `tv` | A player for rendered video episodes kept in the vault, on `/tv` |
| `voice` | Read a note aloud through a local speech server (never on a server) |
| `livestream` | A minute poller of your YouTube, Twitch and Kick channels and a public summary JSON |
| `media` | A gallery of every image, video and audio file in the vault on `/media`, with a lightbox player; `.b2.md` stubs play from B2 where the original isn't on disk |

### Agent ledger (every machine that runs agents)

Each machine that runs Claude Code or Hermes keeps its own record of every turn (prompts, responses, thinking, tool calls and results, tokens, model, provider) in a local SQLite file, and syncs it to the server when it can reach it. Offline, nothing is lost: rows wait locally until the server confirms them. It runs on macOS, Linux and Windows with Node 22.5 or later and nothing else.

```bash
# On the server (usage module on): a token for the machine, shown once
secondbrain ingest-device add laptop-2 --display "Second laptop" --kind laptop
# Build the one-file bundle, copy it to the machine, install it there
app/bin/build-ledger.sh            # -> server/dist/ledger/ledger.mjs
node --no-warnings ledger.mjs install --server https://brain.example.com --token sbd_… --host laptop-2
node --no-warnings ledger.mjs status
```

`install` writes `ledger.json` (0600, it holds the token) next to `ledger.db` in the OS data folder (macOS `~/Library/Application Support/secondbrain`, Linux `$XDG_DATA_HOME/secondbrain`, Windows `%LOCALAPPDATA%\secondbrain`; `SB_LEDGER_DIR` overrides) and schedules `ledger run` every two minutes (launchd, a systemd user timer, or Task Scheduler). Options: `--hermes <dir>[=<label>]` for each Hermes home (default `~/.hermes`), `--claude-dir`, `--redact-env <file>` (repeatable) for env files whose secret-named values are removed before anything leaves the machine (the server only knows its own keys; an unreadable file stops the sync rather than send unredacted), `--retain-days N` to drop synced turns older than N days on a small disk, `--proxy` for the capture proxy. `SB_LEDGER_TOKEN` overrides the stored token.

**Capture proxy (optional).** Claude Code doesn't write its system prompt or tool definitions to disk. With `--proxy`, a local pass-through proxy runs as a service and `env.ANTHROPIC_BASE_URL` in `~/.claude/settings.json` points new Claude Code sessions at it: it forwards every request unchanged, never records headers, and keeps each Messages call with the system prompt, tools and messages stored once by hash. If it stops answering, the next `ledger run` takes Claude Code off it; `ledger proxy-off` does that by hand.

**Hermes tokens per request.** Hermes keeps only session totals. The plugin in `harness/hermes/usage-ledger/` appends one JSON line per model request (tokens, model, provider, timing, and a match key: the response's tool-call ids or a hash of its text, never the text) to `<hermes home>/usage/calls-YYYY-MM-DD.jsonl`. Install it in every home and profile with `harness/hermes/install-usage-ledger.sh <hermes-home>...`, then restart the gateway. The ledger, `secondbrain agents-sync` and the Mac archive run read those files into `usage_calls` (source `hermes` or `hermes:<profile>`), and the session view puts each call's tokens on the response it made. Usage totals still take Hermes from its own session counters. Known gaps: Hermes runs one hook per turn at a time, so a second side call finishing at the same moment in the same turn is skipped (Hermes logs a warning); side calls with no session (idle gateway work) are not recorded. With `--proxy`, the ledger syncs only when `--redact-env` is set, because proxy captures are stored by content hash and can't be redacted afterwards.

Upgrade the server before the machines: a ledger newer than the server may send rows the server doesn't know yet; they are kept and retried (`ledger requeue` retries them at once).

### `secondbrain.json`

Settings that don't fit one env line live in the vault, in `secondbrain.json` at its root. Every section is optional; a file that doesn't parse is reported and ignored. `vault-template/secondbrain.example.json` shows each one.

| Key | Used by | Holds |
|---|---|---|
| `goalsFile`, `missionFile` | projects, map | Your goals note (tables of `\| W1 \| Goal \| Measure \| Due \| Status \|`) and mission note |
| `map.divisionFolders`, `map.missionFolders` | map | Which folders belong to which division when no project claims them |
| `metrics` | map | The numbers the map tracks, each with a `collect` source (YouTube, X, Instagram, a Base balance) or a `sum` of others |
| `tv.episodesDir`, `tv.shows` | tv | Where episodes live (default `tv/episodes`) and each show's name |
| `livestream.youtube`, `.twitch`, `.kick` | livestream | Your channel on each platform |
| `projects.reportFile` | projects | Where `cli-projects render` writes the report (default `projects.md`) |

Then `secondbrain scan` to build the index and `secondbrain embed` to build the vector index. Every setting: [docs/configuration.md](../docs/configuration.md).

---

## Remote access (a server)

The same app can run on a server over a checkout of your vault that a git sync keeps current. `DEPLOYMENT=server` switches it into internet-facing mode:

| | Local (`local`) | Server (`server`) |
|---|---|---|
| Who can reach it | loopback only | anyone, via Caddy on 443 |
| Login | none | password + authenticator code |
| Robot launcher, HTTP shutdown | mounted (if configured) | not mounted |
| 500 error text | shown | logged only |
| Rescan + re-embed | a button | every `SCAN_INTERVAL_MINUTES` |

**Auth design.** One user. Password hashed with scrypt (128 MiB, verified one at a time), plus RFC 6238 TOTP with single-use codes. Both factors are always checked and failures share one message. Sessions are random 256-bit tokens in a `__Host-` cookie (HttpOnly, Secure, SameSite=Strict); only their SHA-256 is stored. They end after 7 idle days or 30 days total, and `POST /api/auth/logout-all` kills every device. Five failures lock an IP out for 15 minutes, and 100 failures an hour lock everyone out. Every mutating request must carry the right `Origin`. Passkeys would beat TOTP but WebAuthn refuses bare IP addresses, so they need a domain.

**Deploy.**

```
secondbrain auth-setup        # locally: prompts for a password, enrols the authenticator, prints the env lines
app/deploy/deploy.sh          # ships source, installs Node/Postgres+pgvector/Caddy, builds, migrates, restarts
ssh <your server> 'nano /etc/secondbrain/env && systemctl restart secondbrain'   # first time only: paste the lines + TOGETHER_API_KEY
```

`deploy.sh` reads its settings from your vault `.env` (or the environment): `DEPLOY_HOST` (ssh destination with root), `DEPLOY_PUBLIC_HOST` (domain or IP), `DEPLOY_VAULT_DIR` (vault checkout on the server), and optionally `DEPLOY_APP_USER`, `DEPLOY_APP_DIR`, `DEPLOY_HERMES_HOME`, `EXTRA_CADDY_IMPORT` (comma separated), `DEPLOY_REDIRECT_FROM` (e.g. the bare IP, redirected to the public host), `DEPLOY_PAUSE_FILE`, `DEPLOY_EMBED=1` and `DEPLOY_DB_BACKUP=1`. `DEPLOY_MODULES` (else `MODULES`) decides which timers it installs; keep it the same as `MODULES` in the server's env file. See the header of `deploy/deploy.sh`, and [docs/deployment.md](../docs/deployment.md).

Editing: the Edit button on any text file saves through `PUT /api/file/source`. It uses an optimistic lock (the file's sha256 when you opened it), so a change the Hermes agent, Obsidian or the git sync made meanwhile comes back as a 409 and is never overwritten. The write goes to a temp file and is then renamed into place, and the file is reindexed immediately.

## Design invariants

These are enforced by tests and hold across the codebase.

- **Only the editor writes to a note**, through `PUT /api/file/source` with an optimistic lock (below). Scans, embeds and every other route are read-only over vault content.
- **A no-change re-scan issues zero writes** to `vault_files`, `vault_links`, `vault_tags` — and a no-change re-embed issues zero writes to `vault_chunks` and makes zero API calls.
- **The index is the allowlist.** `/api/raw` and `/api/file` reject `..`, absolute paths and null bytes, resolve inside `VAULT_ROOT`, *and* require the path to exist in `vault_files`. Credentials (`.env*`, `*.pem`, `*.key`, …) are filtered during the walk, outside the configurable skip list, so they can never be indexed and therefore never served.
- **The scanner prunes directories by name at any depth**, never filtering files after walking. A leading slash anchors a rule to the vault root.
- **Snowflake IDs are `text`, never `bigint`** — they exceed JavaScript's safe integer range.
- **Search snippets are escaped before highlighting.** `ts_headline` splices markers into raw note text; the highlight is marked with control characters, escaped, and only then turned into `<b>`.
- **No secret reaches a log line, an API response, or a note.** Provider error text is scrubbed of anything credential-shaped before it is surfaced.

## Layout

| Path | |
|---|---|
| `server/src/connectors/vault/` | `walk` → `parse` → `scan` → `resolve` |
| `server/src/embeddings/` | `chunk` → `provider` → `embed` |
| `server/src/search.ts` | Keyword ranking |
| `server/src/semantic.ts` | Vector KNN and RRF fusion |
| `server/src/paths.ts` | The three-step path guard |
| `web/src/routes/` | Browse, Search, Sources |
| `db/migrations/` | Plain SQL |
| `bin/secondbrain` | The CLI — the single implementation of all launcher logic |
