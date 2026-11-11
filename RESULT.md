# Core v2 phase 0: docs status pass and personal scrub (RESULT)

Card `t_f90cb751` (engine-core-v2 phase 0). Repo `kon-rad/argo`, engine worktree on branch `card/t_f90cb751-core-v2-phase-0-engine-docs-status-pass`, based on `origin/main` (`170d9fc`).

Goal: a one-line Status at the top of every `docs/` page, the proposal pages out of `docs/` and the mkdocs nav, the module lists reconciled, and the owner's personal residue out of the public engine (`docs` and `app`) with no behaviour change beyond a default value.

## 1. Docs pages removed (4)

Each path was deleted from `docs/` and its entry removed from the `mkdocs.yml` `nav`. Every inbound link was retargeted (see section 3); `mkdocs build --strict` reports no dangling link.

- `docs/self-improvement.md` (a proposal; not built)
- `docs/zen-runtime.md` (a proposal/pilot description; the shipped runtime is documented on `zen-agent.md`)
- `docs/org-routing.md` (pilot/experimental; config lives on `org-yaml.md`)
- `docs/memory-golden-set.md` (the recall test method folds into `memory.md`)

`docs/board-design.md` is kept for now: it carries its own Status line and is the board's architecture page, referenced by `kanban-board.md` and `architecture.md`. Folding it into `kanban-board.md` (review item 11) is deferred, see section 6. `docs/getting-started.md` is likewise kept; folding it into `onboarding/02-set-up-your-vault.md` is deferred.

## 2. Status lines added (every remaining `docs/` page)

Format, as the first content line: `Status: **<works|pilot|proposal>** - <one sentence>.` All 34 pages that lacked one now have one; `board-design.md` already had a compatible line and was left. Verdicts:

| Page | Verdict |
|---|---|
| all `docs/onboarding/*.md` (13) | works |
| README.md, architecture.md, configuration.md, deployment.md, modules.md, privacy.md, rag.md, sync.md, uploads.md, vault.md, summaries.md, garden.md | works |
| agent-company.md, agent-harness.md, agent-memory.md, memory.md, kanban-board.md | works |
| zen-agent.md | pilot (the roster `runtime: zen-agent` switch and dispatcher hand-off were still to do at the page's last update) |
| getting-started.md, org-yaml.md | works |
| board-design.md | works (pre-existing line, "built as the `board` module") |

`docs/modules.md`: the module list was checked against `app/server/src/features/` (dirs `board`, `org`, `projects`, `summaries`, `usage`, matching `registry.ts` `MANIFESTS`) and against the modules table. No mismatch found; the page already names the five core features as `projects, org, board, usage, summaries` and describes the older modules as not-yet-moved to `addons/`. Left unchanged.

## 3. Docs personal residue scrub + link retargets

Retarget map applied everywhere a deleted page was linked:

| Deleted page | Retarget |
|---|---|
| `self-improvement.md` | link dropped, prose kept (or `zen-agent.md` where the sentence is about the headless runtime) |
| `zen-runtime.md` | `zen-agent.md` |
| `org-routing.md` | `org-yaml.md` |
| `memory-golden-set.md` | `memory.md` |

Residue removed from `docs/`:

| Page(s) | Was | Now |
|---|---|---|
| onboarding/00, agent-memory, memory | `CURRENT/`, `Areas/Finance/` exclusions named as defaults | "a private folder"/"private folders" |
| onboarding/00, 06, configuration, deployment, uploads, architecture | `b2store`/B2 as a hard dependency | "if you configure object storage..."/"object-storage client" |
| configuration, README, modules | `Jev`, `TypeSafe` brand, `openrouter/typesafe/jev-1.14` default, `CLASSIFY_PROVIDER` prose | generic provider/model wording |
| summaries | `qwen3.6:35b-a3b`, `qwen3.6:27b` | "a local model" |
| configuration, garden | `CURRENT/catalog.md` (stale) | `garden/catalog.md` (matches the real code default) |
| privacy | `my-droplet` denylist example | `my-server` |
| org-yaml | avatar example `sol.jpg` | `atlas.jpg` |
| onboarding/11 | `"persona": "sol"` | `"persona": "assistant"` |
| kanban-board | "a Mac", host `m4` | "your laptop", `<host>` |

## 4. App personal residue scrub (behaviour-preserving)

Shipped defaults / config:
- `app/config/summaries.json` - dropped the home-server entry `{"provider":"ollama","model":"qwen3.6:35b-a3b","baseUrlEnv":"SUMMARIES_M1_URL"}`; the shipped chain is now Together then OpenRouter.
- `SUMMARIES_M1_URL` -> `SUMMARIES_LOCAL_URL` across `features/summaries/manifest.ts`, `summaries/config.ts`, `deploy/env.example` (the tests already expected the new name).
- `app/deploy/deploy.sh` - `ZEN_BOARD_AGENT` default `sol` -> `owner`.
- `app/deploy/secondbrain-db-backup.sh` + `.service` - `DB_BACKUP_HOST` default `droplet` -> `server` (note: an install that relied on the default moves its backup prefix from `.../droplet/` to `.../server/`; the retention windows are keyed by prefix, no data is lost).

Comments and user-facing strings naming the owner's machines (`droplet`, `Mac`/`M4`, "the owner's ...") were rewritten to neutral wording across ~55 `server`/`web`/`deploy`/`bin` files; `hub.ts`'s route message changed and `hub.test.ts` was updated to match.

Pre-existing in the working tree when this phase started (left as-is): `classify/index.ts` (settings model default removed -> `no-model` fallthrough), `org-powers.ts` (`RECALL_EXCLUDE` from `['CURRENT/','Areas/Finance/','.env']` to `['.env']`), `settings.ts` (`classify.model` default `openrouter/typesafe/jev-1.14` -> optional; garden `catalogFile` `CURRENT/catalog.md` -> `garden/catalog.md`), and their tests.

## 5. Residual `droplet` mentions in `app` (justified)

`grep -rni droplet app | grep -v /migrations/ | grep -v node_modules` -> 148 lines (168 with gitignored `app/server/dist/`), in three justified groups:

a. **Test-only fixtures and helper names** (not shipped): e.g. `test/usage-api.test.ts`, `test/usage-sync.test.ts`, `test/zen-trace.test.ts`, `test/archive-run.test.ts` (`dropletFails`, `pullDroplet` fakes), and `test/usage-schema.test.ts` which asserts the seeded host slugs are `['droplet','mac']`.
b. **Identifiers and values pinned by an applied migration**: the host slugs `'droplet'`/`'mac'` are the only rows seeded in `usage_hosts` by `1756000012900_usage-attribution.sql`, with a FK and `CHECK (host IN ('mac','droplet'))` in `1756000012000_usage.sql`. Changing a writer's default would cause FK violations on a real install; the neutral fix needs a new migration (out of scope here). This covers `cli-usage-sync.ts`, `cli-agents-sync.ts`, `dispatch/store.ts`, `archive/ingest.ts`, `archive/run.ts` (`pullDroplet`/`DROPLET_HOME`/`opts.droplet`) and the two `secondbrain-*-sync.service` units.
c. **Generated build output** (`app/server/dist/**`), gitignored and not shipped.

Also intentionally kept (accurate, test-asserted engine vocabulary): the `m1` capability and the `m4` legacy vault-assignee slug (`LEGACY_VAULT_ASSIGNEE`, `SYSTEM_SESSIONS`), the `m1` value in `board-design.md`'s `needs` CHECK list, the `sb_agent`/`sb_org`/`sb_app` DB role names, and macOS/`Macintosh` strings (they name the OS/browser, not the owner's machine).

## 6. Deferred (not done in this pass)

- Folding `docs/board-design.md` into `docs/kanban-board.md`, and `docs/getting-started.md` into `docs/onboarding/02-set-up-your-vault.md` (review item 11 "cheap merges"). Both pages are otherwise compliant (Status line, scrubbed).
- "The proposals come to this vault": parking the prose of `self-improvement.md` / `zen-runtime.md` as notes under the vault's engine-review folder. Their content is preserved in this repo's git history for now.
- Neutralising the migration-pinned host slugs (needs a new migration).

## 7. Verification

```
cd <engine worktree>
mkdocs build --strict -f mkdocs.yml        # exit 0, no warnings
cd app && npm -w server run build          # tsc, exit 0
npx tsc -p web/tsconfig.json --noEmit      # exit 0
SB_TEST_DB=secondbrain_phase0_verify_test npm test
#   Test Files  143 passed (143)
#   Tests       1311 passed (1311)
```

Baseline on `origin/main` (`170d9fc`) had 2 failing: `summaries.test.ts` "ships a default chain that needs no home server" (fixed here by the shipped-config change) and one flaky `board.test.ts` socket hang-up (passes on re-run). No new failures. `scripts/check-public.sh` over the changed files reports only the pre-existing denylist hit on `app/server/src/org-powers.ts:7` (unchanged line, also on `main`).
