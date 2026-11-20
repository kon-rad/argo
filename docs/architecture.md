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

Module tables are created by migrations whether or not the module is on, so turning one on later needs no migration step. Per-module detail: [modules.md](modules.md). The core features are each described by one manifest (`app/server/src/features/<name>/manifest.ts`: nav, commands, timers, wrappers, env, docs) that `app.ts`, `/api/meta`, the launcher and `deploy.sh` read, so a feature is wired in one place. A wrapper the manifest lists in `remoteWrappers` also runs on a client machine: `secondbrain-vault clis install` reads the generated `app/bin/agent-clis.json` and installs it there as a bundled HTTPS client (today `cli-board`, door 2 of the [board](kanban-board.md#2-the-three-doors)), and every other wrapper as a one-line server-only notice.

## 5. The agent harness

AI agents (Claude Code, Hermes, others) work *inside the vault*, not inside the app. They share:

| Piece | What | Where |
|---|---|---|
| Rules | `AGENTS.md` = the engine's `AGENTS.base.md` + the vault's `AGENTS.local.md`, compiled by `secondbrain-vault rules`. `CLAUDE.md` imports it | `vault-template/AGENTS.base.md` |
| Guard hook | Runs before every tool call; blocks reading secrets, keys written into command lines or sent over ssh, force pushes, unsafe `rsync --delete`, and whatever the vault's `guard.local.json` adds | `harness/hooks/guard.py` |
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

The board's database trigger intercepts coding completion and runner review handoff when owner-managed review policy is enabled. `review_jobs` and append-only `review_attempts` retain submissions, original builders, revision-bound verdicts and shipping receipts. A dedicated database login, separate from org identities and builder logins, coordinates a read-only Codex reviewer with GitHub, an atomic Git base/head comparison and an owner-registered serialized deployment target. Only exact merged-revision deployment and health release dependent work, or an owner-only reconciliation (`cli-review reconcile-owner-merge`, refused for the worker login and limited to the gate's owner-merge blocks and unassigned cards) that records an attested `review_owner_merges` receipt for a PR merged outside the gate. Existing approval wrappers refuse gated cards. See [automatic review](automatic-review.md) for commands, host isolation, evidence staging and failure recovery.

Native Codex rollouts join the existing usage SSH wire/import transaction path
as `codex` complete-prefix envelopes. The collector hashes complete prefixes,
redacts them locally and advances its cursor only on import acknowledgement.
The parser derives disjoint token deltas from cumulative high-water snapshots,
with stable host/session/counter IDs. The forward migration includes Codex in
`usage_facts`; archives remain the transcript store. No provider pricing is
inferred. Recent Codex sessions are observations with a 20-minute stale window.

Verification sits between building and review ([verification](verification.md)). The repository declares capabilities and checks in `verification/contract.json`; `scripts/verify.mjs` is the one entry point, and it executes only on a disposable GitHub-hosted VM (the CI `app` job), never on a workstation, coordinator or self-hosted runner. There it is a supervisor: every repository check runs as a separate unprivileged user with loopback-only egress, dependencies arrive through a registry-only proxy with lifecycle scripts disabled, and an adversarial probe proves that boundary before any check starts. The trusted side, `app/server/src/verification/`, never imports that runner: `contract.ts` admits a contract against the owner's installation policy (every field of each required check pinned), `github.ts` checks that the verifier backend is usable before a builder launches and fetches the configured run, job and artifact itself, `zip.ts` reads that artifact in memory under member, type and size limits, and `evidence.ts` judges exact-commit evidence, recomputes test counts from the runner's report and types each failure (assertion, infrastructure, dependency, unknown, evidence, verifier-trust, contract, external-contract). When a repository's host policy has `verification`, the review gate verifies before independent review and before merge, returns typed assertions to the builder while retaining other blockers for their own routes, requires the deployment target to attest merge-disabled flags are off before merge and deploy, and keeps merge-disabled and activation-pending releases open after deployment and health.

Laptop zen-agent traces travel the same wire as `zen` whole-file envelopes. Every
ingest path (usage-sync, usage-import, the ledger's batches, agents-sync, the
archive) ends by calling `archive/bot.ts`, which sets `archive_sessions.bot` (a
foreign key to `org_agents`) from what the harness recorded: Claude Code's
`agent-setting` record, a Codex or Hermes first message that opens with the
compiled persona, a zen-agent persona. `usage_facts` labels a call with the
run's agent when it is in a run (surface `bot`), else with the session's bot
(surface `owner-chat`), so wakes and the daily token cap are unchanged.

PR size is never a reason the gate rejects: the worker keeps the whole diff and every source, and `review/passes.ts` splits a snapshot too large for one reviewer call into passes and merges their verdicts. `review/policy.ts` holds the per-call budget and the planning budgets of the offline admission CLI, as one versioned, hashed policy. `review/scope.ts` selects changed reviewable paths and immediate imports for both GitHub and local Git objects. `review/plan.ts` validates acceptance/test/dependency mappings and bounded uncertainty; `review/preflight.ts` supplies read-only forecast and actual-diff checkpoints through `cli-review scope`. This adds no database state or shipping authority. The actual worker still gathers and verifies its own complete revision-bound evidence, and tells the owner through the host policy's optional `notify` program when a review is rejected or blocked. See [the public CLI contract](automatic-review.md#scope-checkpoints-before-building-and-submitting).

### Instagram metrics authorization

The optional social addon mounts an app-owned Unified Login connect page and a callback before SPA routing. A dedicated ten-minute Lax cookie bridges the cross-site return while the main auth cookie stays Strict. Hashed one-time state is tied to an existing auth session, intended account and fixed public callback; one atomic delete validates and consumes it before code exchange. Session revocation cascades to pending states. Typed encrypted metrics credentials separate Facebook USER and business-integration SYSTEM_USER tokens and their asset IDs from legacy Instagram Login tokens and publishing credentials. USER tokens prove the asset through a managed Page; SYSTEM_USER tokens through the asset ID in their granular-scope targets. Facebook collection uses asset-node endpoints and never legacy refresh. Other token types fail closed. See [social metrics](social-metrics.md#unified-login) for limitations and setup.

## Skills management

The optional `skills` addon (`app/server/src/addons/skills/`) is one service behind `/api/skills` and `secondbrain skills`. Package files and the assignment policy (`.agents/skills-policy.yaml`) are the authority and live in Git; the catalog is read from the configured roots on demand (no index), with a full-package digest, Git revision and dirty state per candidate. Postgres holds operational machine acknowledgements (`skill_view_acks`, `skill_ack_log`) and exact owner policy approval receipts (`skill_policy_approvals`), never a second editable package or assignment policy. Device-token routes report host state and verify canonical plans; only the authenticated owner or a privileged operator can record a policy approval. Pack and sync require online HTTPS authorization against the server's clean committed reviewed policy and exact plan before producing or activating a deployment. Lifecycle writes go only to a drafts folder and a proposed-changes folder; `skills apply` commits a change on a review branch through a temporary worktree. `skills sync` deploys verified packages into a content-addressed store under a machine-local managed root and switches each agent's generated view atomically; zen-agent reads that view and pins a per-run snapshot. Legacy behaviour is the default until the policy enables management. See [Skills](skills.md).

## Observatory evidence and replay

The optional `observatory` addon reads existing source tables through the owner-session boundary and effective database role. Bounded repeatable-read exports feed the pure versioned reducer in `app/shared/observatory.ts`. Archive steps supply tool evidence; usage rows remain usage measurements. Recorded execution intervals govern visibility, while missing lifecycle and sender provenance remain unknown. Five-minute per-session exports pin pagination and revalidate visibility. See [API and replay contract](observatory.md) and [coordinator audit queries](audits/observatory.sql). The optional `/observatory` browser route loads a complete pinned snapshot into deterministic replay, with a lazy fixed-position Three.js workspace and equivalent HTML inspection. Range and filter changes abort obsolete requests; event/cache/display bounds and idle rendering cleanup limit work. Source detail remains lazy and authorization is rechecked. No new collectors or LLM processing are involved.

### Launch provenance boundary

`usage_launches` is a durable, versioned producer envelope keyed by host, native
source, runtime and run ID, with a single nullable-to-native session binding.
It exists independently of wake accounting and token identity. `usage_session_tasks`
unites strict existing run evidence, validated launch task snapshots and the additive
`archive_session_tasks` historical associations. Session list/detail and persona
facets use the same attribution functions as `usage_facts`; unknown launch/native
persona evidence is retained without later roster reassignment. The dispatcher writes
before spawning and captures native identity before finalisation. Transport contracts,
replay and rollback are in [Usage provenance](usage-provenance.md).
### Recorded tool result derivation

Codex and Hermes archives use `archive/toolResult.ts` for structured output and nullable success/failure, shared by import and detail expansion. `archive/store.ts` derives persisted fields and records a parser version independent of raw SHA. `archive/replayResults.ts` reuses that derivation for scoped dry-run/replay without rewriting raw, source identity, timestamps or token records. List counts and detail use the same invocation rendering predicate. Explicit run lifecycle failures remain separate from tool failures. See [operator replay](tool-result-replay.md).

Collection health uses additive Postgres `collection_attempts` and
`collection_streams`, keyed independently by host, collector instance, runtime and
path. Device authentication supplies host. Attempt receipt does not update source
activity. SSH v2 acknowledgements distinguish accepted positions from durable
`usage_import_quarantine` entries; failed acknowledgements retain local source
cursors. See [collection health](collection-health.md) for compatibility and bounds.


### Collection supervision and source health

Session collectors run synchronous scanning, Hermes snapshot/parsing and import in
supervised child process groups. A parent deadline covers the whole attempt and
owns temporary snapshot cleanup. Committed per-file cursors survive; in-flight
transactions roll back on termination. A separate bounded child reports timeout
health. Source event timestamps and explicit pending byte/record units travel to
Postgres independently of receipt time. Inactive attempt expiry is globally bounded;
quarantine has explicit supported-importer replay and no automatic deletion.
See [collection health](collection-health.md) for compatibility and operator commands.

### Local model usage addon

The optional `localai` addon imports local gateway export pages transactionally with their cursors. Its manifest registers the protected read-only `/api/local-ai` API, five-minute pull timer and `secondbrain local-ai-pull` command. The Usage ledger renders its separate local-call summary only when enabled; cloud usage facts stay independent.

Brain Map replay at `/map?activity=1` shares Observatory's replay component and URL state. A separate read/write overlay uses exact scoped note references on one pinned stored layout. Optional version selection on `/api/map/graph` never substitutes the newest layout for an unavailable pin. The original graph retains its coordinates and zero simulation ticks while the overlay changes. Current topology and historical activity remain explicitly distinct; unresolved paths retain source evidence and repository targets stay separate. Raw absolute tool paths are scoped only beneath the configured vault root, without guessing relative working directories or historical moves. Both map and Observatory modules must be enabled; ordinary map and kiosk behavior remain available without Observatory. See [Brain Map activity](observatory.md#brain-map-activity-observatory-3).
