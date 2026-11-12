# Architecture

Status: **works** - the end-to-end picture of the engine, your vault, the app, its index and the agent harness as built today.

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

Module tables are created by migrations whether or not the module is on, so turning one on later needs no migration step. Per-module detail: [modules.md](modules.md). The core features are each described by one manifest (`app/server/src/features/<name>/manifest.ts`: nav, commands, timers, wrappers, env, docs) that `app.ts`, `/api/meta`, the launcher and `deploy.sh` read, so a feature is wired in one place.

## 5. The agent harness

AI agents (Claude Code, Hermes, others) work *inside the vault*, not inside the app. They share:

| Piece | What | Where |
|---|---|---|
| Rules | `AGENTS.md` = the engine's `AGENTS.base.md` + the vault's `AGENTS.local.md`, compiled by `secondbrain-vault rules`. `CLAUDE.md` imports it | `vault-template/AGENTS.base.md` |
| Guard hook | Runs before every tool call; blocks reading secrets, force pushes, unsafe `rsync --delete`, and whatever the vault's `guard.local.json` adds | `harness/hooks/guard.py` |
| Dev-log gate | Runs when an agent tries to finish; sends it back once if it changed skills, scripts, hooks or config without writing a dev log today | `harness/hooks/devlog_gate.py` |
| Skills | `SKILL.md` folders; the engine's shared ones are symlinked into `.agents/skills/` | `skills/` |
| zen-agent | A headless runtime of our own for bot wakes: the same rules, skills, guard rules and hook scripts, run by a minimal loop (pi agent core) with the context assembled as code, a budget per run and a JSONL trace per run. Any provider; the board and the retrieval API are tools, and `zen-agent lane` claims cards from the board. The plan for moving the bots onto it is [zen-agent.md](zen-agent.md) | `zen-agent/` |
| The board | The kanban record in Postgres (`cards`, comments, events, dependencies, runs), written only through `board_*` SQL functions that check the caller; Hermes, a Claude Code dispatcher, zen-agent and the subscription-only Codex adapter are lanes that claim cards. The Codex adapter hands successful work to `review` for a person to finish. Any machine reaches the board over HTTPS with a per-device token ([board-design.md](board-design.md)) | `app/server/src/board.ts`, `app/server/src/addons/dispatch/`, `app/db/migrations/*_board.sql` |

Both hooks fail open: a payload they can't parse is allowed, so a bug in a hook never stops an agent. They are guardrails, not a sandbox. Details: [agent-harness.md](agent-harness.md).

## 6. Where each kind of data lives

| Kind | Lives in | Write path |
|---|---|---|
| Prose: notes, plans, research, dev logs | Markdown in the vault | Edit the file (you, an agent, or the app's editor) |
| The search index | Postgres `vault_*` tables | Only the scanner and embedder. Never by hand |
| Module records | Postgres module tables | The module's CLI or page, never raw SQL |
| Secrets and per-machine settings | Vault `.env` (laptop), `/etc/secondbrain/env` (server) | By hand. Never committed, never printed |
| Structured settings | `secondbrain.json` in the vault | By hand; committed to your private vault |
| Sync state (last run, ahead/behind, conflicts) | `~/.local/state/secondbrain/sync.json` on each machine | Only `secondbrain-vault sync` ([sync.md](sync.md)) |
| Big media | Your vault, or object storage with a stub note | Optional object-storage file server + `B2_SERVE_URL` |

## 7. How a change flows

- **Your notes and settings:** commit to your vault, as usual.
- **The engine:** a branch and a pull request on this repo. CI runs the app suite, the Python suite and the leak checks; `main` is protected. Once merged, each vault moves its pin when it wants the change. See [vault.md](vault.md) and [`CONTRIBUTING.md`](https://github.com/kon-rad/argo/blob/main/CONTRIBUTING.md).

### Usage quota boundary

`secondbrain.json` selects subscription providers, credit cards and Usage page sections. The server returns only that presentation configuration and sanitized quota data. Codex limits are read through its authenticated CLI app-server with bounded requests and a shared cache, separate from dispatcher model turns. Claude retains its existing snapshot pipeline. UI meters live on `/usage`; header and profile links do not run duplicate collectors. Disabled providers are not queried by the subscription endpoint, and hidden sections do not start their browser polling. See [Usage configuration](configuration.md#usage-page-providers-and-sections).

## Automatic review and shipping boundary

The board's database trigger intercepts coding completion and runner review handoff when owner-managed review policy is enabled. `review_jobs` and append-only `review_attempts` retain submissions, original builders, revision-bound verdicts and shipping receipts. A dedicated database login, separate from org identities and builder logins, coordinates a read-only Codex reviewer with GitHub, an atomic Git base/head comparison and an owner-registered serialized deployment target. Only exact merged-revision deployment and health release dependent work. Existing approval wrappers refuse gated cards. See [automatic review](automatic-review.md) for commands, host isolation, evidence staging and failure recovery.

Native Codex rollouts join the existing usage SSH wire/import transaction path
as `codex` complete-prefix envelopes. The collector hashes complete prefixes,
redacts them locally and advances its cursor only on import acknowledgement.
The parser derives disjoint token deltas from cumulative high-water snapshots,
with stable host/session/counter IDs. The forward migration includes Codex in
`usage_facts`; archives remain the transcript store. No provider pricing is
inferred. Recent Codex sessions are observations with a 20-minute stale window.

Review capacity lives in `review/policy.ts`: one versioned, hashed policy and evaluator serves the source adapter, context collector, worker and offline admission CLI. `review/scope.ts` selects changed reviewable paths and immediate imports for both GitHub and local Git objects. `review/plan.ts` validates acceptance/test/dependency mappings and bounded uncertainty; `review/preflight.ts` supplies read-only forecast and actual-diff checkpoints through `cli-review scope`. This adds no database state or shipping authority. The actual worker still gathers and verifies its own complete revision-bound evidence. See [the public CLI contract](automatic-review.md#scope-checkpoints-before-building-and-submitting).

### Instagram metrics authorization

The optional social addon mounts an app-owned Unified Login connect page and a callback before SPA routing. A dedicated ten-minute Lax cookie bridges the cross-site return while the main auth cookie stays Strict. Hashed one-time state is tied to an existing auth session, intended account and fixed public callback; one atomic delete validates and consumes it before code exchange. Session revocation cascades to pending states. Typed encrypted metrics credentials separate Facebook USER and business-integration SYSTEM_USER tokens and their asset IDs from legacy Instagram Login tokens and publishing credentials. USER tokens prove the asset through a managed Page; SYSTEM_USER tokens through the asset ID in their granular-scope targets. Facebook collection uses asset-node endpoints and never legacy refresh. Other token types fail closed. See [social metrics](social-metrics.md#unified-login) for limitations and setup.
