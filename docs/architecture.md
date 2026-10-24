# Architecture

How the pieces fit: the engine and your vault, the app and its index, the agent harness, and where each kind of data lives.

## 1. Two repos: the engine and your vault

| | Engine (this repo) | Your vault |
|---|---|---|
| Holds | The app, the vault template, the agent hooks, shared skills, the vault CLI, add-ons | Your notes, your settings and keys, your agent rules, your own skills |
| Visibility | Public, MIT | Private, always |
| Where | Inside the vault as a git submodule at `.secondbrain/`, pinned to one commit | Wherever you keep it: your laptop, a server checkout, a private remote |
| Knows about the other? | No. It reads its settings from the vault at run time | Yes: it pins an engine version |

```
my-vault/                         private git repo
├── .secondbrain/                 the engine, a submodule pinned to one commit
│   ├── app/                      web app + CLIs
│   ├── harness/hooks/            guard.py, devlog_gate.py
│   ├── skills/                   shared skills
│   ├── vault-template/           what `init` copied
│   └── bin/secondbrain-vault     init, rules, link-skills
├── .env                          keys and per-machine settings (gitignored)
├── secondbrain.json              structured settings, no secrets (committed)
├── AGENTS.local.md               your agent rules
├── AGENTS.md                     generated: engine base rules + yours
├── CLAUDE.md                     @AGENTS.md
├── .claude/                      Claude Code settings (hooks), agents, skills link
├── .agents/skills/               your skills + links to the shared ones
├── .agents/guard.local.json      your extra guard rules
└── Projects/ Areas/ Research/ Archives/
```

The rule that keeps this clean: **every value that differs between two users is read from the vault at run time**, with a default that works for a stranger, or the feature is off. Nothing about you is compiled into the engine. See [privacy.md](privacy.md).

## 2. The app

```
                 ┌──────────────── your vault (markdown on disk) ────────────────┐
                 │                                                                │
  scan ──────────┤ walk → parse → upsert vault_files, vault_links, vault_tags     │
  embed ─────────┤ chunk → (context) → embed → vault_chunks (pgvector + tsvector)   │
                 └────────────────────────────────────────────────────────────────┘
                                         │
                               Postgres (the index)
                                         │
                    Express API (/api/*) ── React web UI (Vite build)
                                         │
                       modules: extra tables, routes, pages, CLIs, timers
```

| Layer | What | Where |
|---|---|---|
| Source of truth | Markdown files in the vault | Your disk and your git remote |
| Index | Postgres: `vault_files` (full text, weighted title + body), `vault_links`, `vault_tags`, `vault_chunks` (pgvector, HNSW, cosine) | `app/db/migrations/` |
| Connectors | `{ id, configSchema, run(ctx) }`. `vault` (scan) and `embeddings` (embed) ship today; runs go through an in-process serial queue and are logged in `ingest_runs` | `app/server/src/connectors/` |
| Search | `keyword` (Postgres full text), `semantic` (vector KNN), `hybrid` (reciprocal rank fusion, k=60) | `app/server/src/search.ts`, `semantic.ts` |
| Retrieval for questions | Chunk-level hybrid search fused in SQL, optional condensing, reranking and neighbour expansion; the `chat` module answers from it. See [rag.md](rag.md) | `app/server/src/rag/`, `llm/` |
| API | Express 5, JSON, loopback only in `local` mode | `app/server/src/routes/` |
| Web | React 19, TanStack Query, React Router, Tailwind; wikilinks become in-app links | `app/web/src/` |
| Launcher | `bin/secondbrain`: the single implementation of start, stop, scan, embed and the module CLIs | `app/bin/secondbrain` |

**The index is disposable.** Drop the database, rescan, re-embed, lose nothing. The only things in Postgres that are not derived from markdown are module records (tracker rows, board messages, usage, ring data). Back those up if you use them; `app/deploy/secondbrain-db-backup.sh` is one way.

**The index is also the allowlist.** `/api/file` and `/api/raw` serve a path only if it resolves inside the vault, has no `..`, absolute or null-byte tricks, *and* is in `vault_files`. Credential files (`.env*`, `*.pem`, `*.key` and similar) are dropped during the walk, so they are never indexed and never served.

**Editing.** The editor saves through `PUT /api/file/source` with an optimistic lock: the file's sha256 when you opened it. If an agent, Obsidian or a git sync changed the file meanwhile, the save comes back as a 409 and nothing is overwritten. Writes go to a temp file and are renamed into place.

## 3. Deployment modes

| | `DEPLOYMENT=local` (default) | `DEPLOYMENT=server` |
|---|---|---|
| Binds | `127.0.0.1` | `127.0.0.1`, behind Caddy on 443 |
| Login | None: loopback is the boundary | Password (scrypt) + TOTP, `__Host-` session cookie, origin check on writes |
| Rescans | When you ask | Every `SCAN_INTERVAL_MINUTES` |
| Local-only routes (voice, robot launcher, HTTP shutdown) | Mounted if configured | Never mounted |
| Refuses to start | | Without `AUTH_PASSWORD_HASH`, `AUTH_TOTP_SECRET` and `PUBLIC_ORIGIN` |

One machine can also be a **client** of another's database: set `SECONDBRAIN_DB_URL` and the launcher starts the app with `INDEXER=off`, so it never scans or embeds. Only one machine (the one whose vault checkout is authoritative) should write the index. Details in [deployment.md](deployment.md).

## 4. Modules

Everything beyond browse, search, the database page and the editor is a module: `ring`, `agents`, `projects`, `org`, `board`, `usage`, `map`, `tv`, `voice`, `livestream`, `media`, `social`, `fund`, `chat`. A module that is not listed in `MODULES`:

- mounts no API routes (`app/server/src/app.ts`),
- shows no nav link,
- gets no systemd timers from `deploy.sh`.

Module tables are created by migrations whether or not the module is on, so turning one on later needs no migration step. Per-module detail: [modules.md](modules.md).

## 5. The agent harness

AI agents (Claude Code, Hermes, others) work *inside the vault*, not inside the app. They share:

| Piece | What | Where |
|---|---|---|
| Rules | `AGENTS.md` = the engine's `AGENTS.base.md` + the vault's `AGENTS.local.md`, compiled by `secondbrain-vault rules`. `CLAUDE.md` imports it | `vault-template/AGENTS.base.md` |
| Guard hook | Runs before every tool call; blocks reading secrets, force pushes, unsafe `rsync --delete`, and whatever the vault's `guard.local.json` adds | `harness/hooks/guard.py` |
| Dev-log gate | Runs when an agent tries to finish; sends it back once if it changed skills, scripts, hooks or config without writing a dev log today | `harness/hooks/devlog_gate.py` |
| Skills | `SKILL.md` folders; the engine's shared ones are symlinked into `.agents/skills/` | `skills/` |
| zen-agent | A headless runtime of our own for bot wakes: the same rules, skills, guard rules and hook scripts, run by a minimal loop (pi agent core) with the context assembled as code, a budget per run and a JSONL trace per run. Any provider; the board and the retrieval API are tools, and `zen-agent lane` claims cards from the board | `zen-agent/` |
| The board | The kanban record in Postgres (`cards`, comments, events, dependencies, runs), written only through `board_*` SQL functions that check the caller; Hermes, a Claude Code dispatcher and zen-agent are lanes that claim and finish cards. Any machine reaches it over HTTPS with a per-device token ([board-design.md](board-design.md)) | `app/server/src/board.ts`, `app/db/migrations/*_board.sql` |

Both hooks fail open: a payload they can't parse is allowed, so a bug in a hook never stops an agent. They are guardrails, not a sandbox. Details: [agent-harness.md](agent-harness.md).

## 6. Where each kind of data lives

| Kind | Lives in | Write path |
|---|---|---|
| Prose: notes, plans, research, dev logs | Markdown in the vault | Edit the file (you, an agent, or the app's editor) |
| The search index | Postgres `vault_*` tables | Only the scanner and embedder. Never by hand |
| Module records | Postgres module tables | The module's CLI or page, never raw SQL |
| Secrets and per-machine settings | Vault `.env` (laptop), `/etc/secondbrain/env` (server) | By hand. Never committed, never printed |
| Structured settings | `secondbrain.json` in the vault | By hand; committed to your private vault |
| Big media | Your vault, or object storage with a stub note | Optional `b2store serve` + `B2_SERVE_URL` |

## 7. How a change flows

- **Your notes and settings:** commit to your vault, as usual.
- **The engine:** a branch and a pull request on this repo. CI runs the app suite, the Python suite and the leak checks; `main` is protected. Once merged, each vault moves its pin when it wants the change. See [vault.md](vault.md) and [`CONTRIBUTING.md`](https://github.com/kon-rad/secondbrain/blob/main/CONTRIBUTING.md).
