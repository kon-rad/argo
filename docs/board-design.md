# The board: a kanban in the engine (design proposal)

Status: **built as the `board` module** (see [modules.md](modules.md#board)): the migration, the `board_*` functions, the API with its three doors, `cli-board`, the page, a legacy file importer for old Hermes exports, and zen-agent's `board` backend and `lane` loop. Stages 0 to 3 below are done (cutover 2026-10-26; the Hermes projection and the old surfaces were removed afterwards). This page stays the architecture. It is grounded in what the engine already has: the `org` module's schema and row-level security (`app/db/migrations/1756000012200_org.sql`, `…12400_org-rls.sql`, `…14000_bot-powers.sql`), the card links in `task_links` (`…12600`, `…12700`, `…12800`), the `hub` proxy (`app/server/src/routes/hub.ts`), the old Board page (`app/web/src/routes/agents/Board.tsx`, since removed), zen-agent's kanban tools (`zen-agent/src/tools/kanban.ts`) and the self-improvement proposal's sections 5.3 and 10.

## 1. What it has to be

The brief, in the owner's words: *very simple; easy to use by any agent; easy to connect from any device, securely and privately; connected to the org, the projects and the message board; the same features and usability as the current Hermes kanban board.* Each of those becomes a design rule here:

| Brief | Rule in this design |
|---|---|
| Very simple | One table of cards, one append-only event log, one set of SQL functions that are the only write path. No proxy, no SSH, no second process to keep alive. |
| Easy for any agent | Seven verbs (`list`, `show`, `create`, `comment`, `assign`, `move`, `claim`/`finish`) with the same names and arguments in HTTP, in the CLI and as SQL functions. An agent that can send JSON over HTTPS, or run a binary, or open a Postgres connection, can use the board. |
| Any device, securely, privately | Three doors, one identity: the app's login for browsers, a per-machine bearer token mapped to a roster name for everything else, the `sb_org` role for processes on the server. Tokens are hashed at rest and revocable. Nothing new leaves the server. |
| Connected to org, projects, message board | Foreign keys instead of conventions: a card's assignee and every author is an `org_agents` row, its project and feature are tracker rows, finishing a card can write the `verifications` row, creating one writes the team mention and the wakeup in the same transaction. |
| Parity with the Hermes board | Section 6 is a feature-by-feature table. Statuses, card ids (`t_` + hex), boards, comments, dependencies, results and events are kept as they are so the page, the skills and the messages that already name cards keep working. |

## 2. The decision: the record moves in, the execution stays behind a lane

The board is two halves wearing one name.

- **The record**: cards, comments, events, dependencies, run history. Every human, page and report needs it. It belongs in Postgres next to `teams`, `projects`, `features` and `org_agents`, where the org module's write path and row-level security already are.
- **The execution**: the atomic claim, the crash reclaim, spawning a worker, its workspace, its budget, review dispatch, notifications, the tool set the worker's model sees. Only the thing that runs work needs it. Today Hermes does this (its `kanban_db.py` is some four thousand lines over seven tables, of which the org uses a tenth).

Nobody should rebuild the second half to get the first. So the engine takes the record, and anything that runs work is a **lane**: a value of `org_agents.runtime` plus an adapter that claims cards, runs them and reports back. Hermes is the first lane. Claude Code (the `cc-*` dispatcher) is the second. zen-agent (in this repo since [#38](https://github.com/kon-rad/argo/pull/38)) is the third, and the reason the seam is a *runtime* value: a lane needs a roster value and a few hundred lines of adapter, not a board.

The split also answers robustness without a proxy: one writer, real transactions, `SELECT … FOR UPDATE SKIP LOCKED` for claims (SQLite has no equivalent), `pg_notify` behind the server's SSE instead of a five-second poll, no root SSH keys, no per-call subprocess.

## 3. The record

### 3.1 Vocabulary

| Word | Meaning | Today |
|---|---|---|
| Board | A named list of cards (`exo`, a team's own, the loop's). Cards live on exactly one board | Hermes `--board` |
| Card | One unit of work for one assignee. Id `t_` + hex, unchanged | Hermes task |
| Status | Where the card is: `triage`, `todo`, `scheduled`, `ready`, `running`, `review`, `blocked`, `done`, `archived`. The same nine values the page's columns already map | Hermes status |
| Contract | The card's Objective, Returns, Budget, Scope and Verification, as JSON the dispatcher reads, not prose it parses | Headings in the body |
| Comment | A note on the card by a roster member. Not a message: messages live in channels | Hermes comment |
| Event | An append-only line: who did what to the card and when. Written only by the functions | Hermes events |
| Dependency | Card A waits for card B. When B finishes and A has no other open dependency, A moves from `todo` to `ready` | Hermes `link` + `block --kind dependency` |
| Lane | A runtime that claims and runs cards: `hermes`, `claude-code`, `zen-agent`. `human` and `session` are not lanes: nothing wakes them | The dispatcher, cc-dispatcher |
| Run | One claim of a card by a lane: lease, heartbeats, outcome, tokens | Hermes claim with PID |

### 3.2 Tables

All in one migration, `board`. Names start with `card_` so they never collide with the org's `org_` or the tracker's bare names. `task_links` is folded into `cards` (its columns were already the card's record) and dropped in the last stage; until then a view named `task_links` keeps the `usage_facts` join and the CLI working.

```sql
CREATE TABLE boards (
  slug        text PRIMARY KEY CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,40}$'),
  name        text NOT NULL,
  team_slug   text REFERENCES teams(slug) ON UPDATE CASCADE ON DELETE SET NULL,  -- NULL: the company board
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cards (
  id            text PRIMARY KEY CHECK (id ~ '^t_[0-9a-f]{6,32}$'),
  board_slug    text NOT NULL REFERENCES boards(slug) ON UPDATE CASCADE,
  title         text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body          text CHECK (length(body) <= 20000),
  contract      jsonb NOT NULL DEFAULT '{}',          -- {objective, returns[], budget{turns,tokens,minutes,wakes}, scope[], verification}
  status        text NOT NULL DEFAULT 'todo' CHECK (status IN ('triage','todo','scheduled','ready','running','review','blocked','done','archived')),
  priority      smallint NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
  assignee      text REFERENCES org_agents(name) ON UPDATE CASCADE,   -- NULL: unassigned
  created_by    text NOT NULL REFERENCES org_agents(name) ON UPDATE CASCADE,
  project_slug  text REFERENCES projects(slug) ON UPDATE CASCADE ON DELETE SET NULL,
  feature_slug  text,
  kind          text NOT NULL DEFAULT 'work' CHECK (kind IN ('work','spec','build','review','verify','doc','status','improve','revert')),
  work_type     text CHECK (work_type IN ('research','coding','design','media','writing','sales','education','ops')),
  needs         text CHECK (needs IN ('code','review','merge','deploy','m1','web')),
  ship_now      boolean NOT NULL DEFAULT false,
  repo          text,
  graph         text,
  node          text,
  rounds        integer NOT NULL DEFAULT 0,
  scheduled_for timestamptz,                        -- status 'scheduled': becomes ready at this time
  block_kind    text CHECK (block_kind IN ('dependency','needs-owner','missing-input','tool-error','budget','review-changes','other')),
  block_reason  text,
  result        text,                               -- the one-line Returns when done
  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  completed_at  timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  tsv           tsvector GENERATED ALWAYS AS (to_tsvector('simple', title || ' ' || coalesce(body, ''))) STORED
);
CREATE INDEX cards_board_status_idx ON cards (board_slug, status, priority, created_at);
CREATE INDEX cards_assignee_idx     ON cards (assignee) WHERE status NOT IN ('done','archived');
CREATE INDEX cards_project_idx      ON cards (project_slug, feature_slug);
CREATE INDEX cards_tsv_idx          ON cards USING gin (tsv);

CREATE TABLE card_comments (
  id          bigserial PRIMARY KEY,
  card_id     text NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  author      text NOT NULL REFERENCES org_agents(name) ON UPDATE CASCADE,
  body        text NOT NULL CHECK (length(body) BETWEEN 1 AND 8000),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE card_events (                           -- append-only; the functions write it, nobody else
  id          bigserial PRIMARY KEY,
  card_id     text NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  kind        text NOT NULL,                         -- created, assigned, moved, commented, claimed, heartbeat, finished, blocked, reclaimed, linked, flagged
  actor       text REFERENCES org_agents(name) ON UPDATE CASCADE,  -- NULL: the board itself (promotion, reclaim)
  payload     jsonb,
  at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE card_deps (                             -- card_id waits for depends_on
  card_id     text NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  depends_on  text NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  PRIMARY KEY (card_id, depends_on),
  CHECK (card_id <> depends_on)
);

CREATE TABLE card_runs (                             -- one claim of a card by a lane
  id            bigserial PRIMARY KEY,
  card_id       text NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  agent_name    text NOT NULL REFERENCES org_agents(name) ON UPDATE CASCADE,
  runtime       text NOT NULL,                        -- the lane: org_agents.runtime at claim time
  wakeup_id     bigint REFERENCES org_wakeups(id),
  run_id        text,                                 -- the archive's / usage ledger's run id, once known
  claimed_at    timestamptz NOT NULL DEFAULT now(),
  lease_until   timestamptz NOT NULL,
  heartbeat_at  timestamptz,
  finished_at   timestamptz,
  outcome       text CHECK (outcome IN ('done','blocked','partial','lost','budget')),
  tokens        bigint,
  turns         integer
);
CREATE UNIQUE INDEX card_runs_open_idx ON card_runs (card_id) WHERE finished_at IS NULL;   -- one live run per card

CREATE TABLE board_tokens (                          -- a device or agent process that reaches the board over HTTPS
  id            bigserial PRIMARY KEY,
  agent_name    text NOT NULL REFERENCES org_agents(name) ON UPDATE CASCADE ON DELETE CASCADE,
  label         text,
  token_hash    text NOT NULL UNIQUE,                -- sha256 of the bearer token; shown once
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz,
  revoked_at    timestamptz
);
```

Two things to notice. `org_agents.runtime` gains `zen-agent` and `session` (the vault session, which today is a pseudo-agent in TypeScript) so that *every* assignee is a roster row and the FK holds; the Claude Code lanes and the Hermes profiles become roster rows on import too, with no team and `runtime` `claude-code` or `hermes`. And `org_messages.task_id` gets a foreign key to `cards` in the last stage, after orphan ids are backfilled, so a status post about a card and the card can never disagree.

### 3.3 The status machine

```
triage ──▶ todo ──▶ ready ──▶ running ──▶ review ──▶ done ──▶ archived
             │        ▲          │   ▲
             ▼        │          ▼   │
          scheduled ──┘        blocked
```

| Move | Who | How |
|---|---|---|
| `triage` → `todo` | owner, lead, `dispatch` | `move` |
| `todo` → `ready` | the board, when the card has no open dependency and no `scheduled_for` in the future; a person with `move` | trigger on `card_deps` and `cards.status` |
| `ready` → `running` | a lane, for its own runtime, for the card's assignee | `claim` |
| `running` → `review` | the assignee, when the card's `kind` has a review node after it | `finish --outcome done` on a graph card |
| `running` → `done` | the assignee | `finish --outcome done` |
| `running` → `blocked` | the assignee, with a `block_kind` | `block` |
| `running` → `ready` | the board, when the lease expires with no heartbeat | reclaim job (`card_runs.outcome = 'lost'`) |
| `blocked` → `ready` | a person, or the board when a `dependency` block's cards finish | `move`, trigger |
| `review` → `done` | the reviewer | `finish` on the review card |
| `review` → `todo` (new round) | the reviewer | `redo`, as today: a new build card, the review card blocked on it, two rounds then the lead |
| `done` → `archived` | the owner, or a nightly sweep after 30 days | `move` |

Card status and feature stage stay separate things and join explicitly. One is work state, one is product state. The only automatic bridge is in `finish`: a card of kind `verify` (or any card whose contract carries a `verification` and whose caller passes `--verified`) writes a `verifications` row for its feature, and the tracker's existing rule ("live only after a passing verification") does the rest. Nothing moves a feature's stage from the board directly.

### 3.4 The write path: functions, one rule each

Every write is a `SECURITY DEFINER` function, as `org_dm_channel`, `org_task_flags` and `org_ship_request` already are. Each checks `org_me()`, enforces one rule, writes the row, appends a `card_events` row and calls `pg_notify('board', card_id)`. The HTTP API and the CLI are thin: they parse arguments and call the function. That is how the rules live once and are the same through every door.

| Function | Rule it enforces |
|---|---|
| `board_card_create(board, title, body, contract, assignee, project, feature, kind, work, needs, repo, priority, deps[])` | Who may give whom a card (today's `assertMayAssign`: a human anyone; `dispatch` any bot; a lead its team; a member itself). The assignee has the needed capability (`assertCapable`). A coding card names a repo the bots reach (`checkRepo`). The project and feature exist. Writes the card, its dependencies, and in the same transaction the team-channel mention and the `org_wakeups` row (reason `task`, with today's hold and backoff). |
| `board_card_assign(card, assignee, project, feature)` | Same give-rule. An assigned card that was `running` cannot be reassigned until its run is finished or reclaimed. |
| `board_card_comment(card, body)` | The author is the caller. Always. No `--author`. |
| `board_card_move(card, status, note)` | The table in 3.3: a person may move within it; a bot may not move its card to `done` by `move` (it must `finish`). |
| `board_card_claim(runtime, agent?)` → card | `SELECT … FROM cards WHERE status = 'ready' AND assignee IN (roster rows of this runtime[, this agent]) ORDER BY priority, created_at FOR UPDATE SKIP LOCKED LIMIT 1`. Sets `running`, `started_at`, opens a `card_runs` row with `lease_until = now() + the agent's max_runtime_minutes`. The caller must be a lane (`runtime` not `human`/`session`). |
| `board_card_heartbeat(card, tokens?, turns?)` | Extends the lease; the caller is the run's agent. |
| `board_card_finish(card, outcome, result, verification?)` | The caller is the card's assignee. `done` sets `completed_at` and `result`; `blocked` needs a `block_kind`; `budget` is `blocked` with kind `budget`. Closes the run. Writes the `verifications` row when asked. Promotes dependants. |
| `board_card_link(card, depends_on)` | No cycles (walk up at most 64 steps). A `todo` card with a new open dependency stays `todo`; a `ready` one goes back to `todo`. |
| `board_card_flags(card, ship_now, needs)` | `ship_now` only from a human: the owner marks ship-now, by construction. |
| `board_reclaim()` | For every open run past its lease with no heartbeat in the last lease period: outcome `lost`, card back to `ready`, event `reclaimed`. Called by a timer; cheap. |

Reads are plain `SELECT`s under row-level security. Cards are company work, so, as `task_links` today, every roster member reads every card on boards whose `team_slug` is NULL or their own team. A board with a team is that team's and the owner's. That is the whole privacy model for the board; DMs stay in the org module.

## 4. Three doors, one identity

```
 browser (phone, laptop, TV)      an agent on any machine           a process on the server
 ───────────────────────────      ───────────────────────            ────────────────────────
 login session (TOTP)             Authorization: Bearer <token>      psql / cli-board as sb_org
 acts as ORG_OWNER                board_tokens → agent_name          SET org.agent = <name>
            │                               │                                  │
            └──────────────┬────────────────┘                                  │
                           ▼                                                   ▼
                 /api/board/* (Express)  ── SET LOCAL org.agent ──▶  board_* functions, RLS
```

1. **Browser.** The app's existing login (`auth.requireSession`, origin check). The server acts as `ORG_OWNER`, as `/api/org` does today. The page can also "act as" another roster member only if the owner chooses to; the default is the owner, and that is a later feature, not this design.
2. **Any device over HTTPS.** A bearer token from `board_tokens`, minted by the owner with `cli-org token create <agent> --label "<where it runs>"`, shown once, hashed at rest, revocable. The server resolves it to `agent_name`, opens a transaction, `SET LOCAL org.agent`, and every function and policy sees that caller. This is the same pattern as the usage ledger's `ingest_devices` (one token decides whose rows get written; a machine can never write another machine's rows). The token router is mounted before the session gate, like `/api/ingest`. An agent that holds a token can be anywhere: a laptop, a server, a phone running a script.
3. **On the server.** The `sb_org` role with `org.agent` in the connection, as `cli-org` already connects. No change.

What this removes: the hub bearer token in the app's env, the hub's own allowlist, the SSH keys the remote kanban skills used, and the rate-limited port 22 path. What it does not add: any new outbound connection. The board is reachable only where the app is, behind the same login and origin check.

The CLI picks its door by environment: `SB_ORG_DB_URL` set means door 3; `BOARD_URL` and `BOARD_TOKEN` set means door 2. Same binary, same verbs, same output.

## 5. The API, the CLI and the tools

### 5.1 HTTP, module `board`

Mounted only when `board` is in `MODULES`; off by default like every module. Ids keep the `t_` form so links in messages, dev logs and the archive stay valid.

| Verb | Route | Body / query |
|---|---|---|
| GET | `/api/board/boards` | |
| GET | `/api/board/cards` | `board`, `status`, `assignee`, `project`, `feature`, `kind`, `q`, `limit` |
| GET | `/api/board/cards/:id` | card, comments, events, deps (both directions), runs |
| POST | `/api/board/cards` | `board`, `title`, `body`, `contract`, `assignee`, `project`, `feature`, `kind`, `work`, `needs`, `repo`, `priority`, `deps` |
| POST | `/api/board/cards/:id/comment` | `body` |
| POST | `/api/board/cards/:id/assign` | `assignee`, `project`, `feature` |
| POST | `/api/board/cards/:id/move` | `status`, `note` |
| POST | `/api/board/cards/:id/link` | `depends_on` |
| POST | `/api/board/cards/:id/flags` | `ship_now`, `needs` |
| POST | `/api/board/claim` | `runtime`, `agent` → the card, or 204 |
| POST | `/api/board/cards/:id/heartbeat` | `tokens`, `turns` |
| POST | `/api/board/cards/:id/finish` | `outcome`, `result`, `verification` |
| GET | `/api/board/events` | SSE: `pg_notify('board')` fanned out as `{card_id, kind}` lines; the page refetches what changed instead of polling every 5 s |
| GET | `/api/board/cards/:id/log` | the worker's log for the live run: from the lane's log file while running, from the archive once stored |

Errors use the app's `{ error: { message } }` shape. Nothing here is new machinery: `wrap`, `parseOr400`, zod schemas and the SSE pattern are already in `app/server/src/routes/`.

### 5.2 CLI: `cli-board` (also `secondbrain board`)

```
cli-board list [--board b] [--status s] [--assignee a] [--project p] [--json]
cli-board show <card> [--json]
cli-board create "<title>" --to <agent> --project p [--feature f] [--kind k] [--type work] [--needs cap] [--repo r] [--priority N] [--after t_…]... [--body "..."] [--contract file.json] [--ship-now] [--json]
cli-board comment <card> "<body>"
cli-board assign <card> <agent> [--project p --feature f]
cli-board move <card> <status> ["<note>"]
cli-board link <card> --after <card>
cli-board claim --runtime <r> [--agent a] [--json]
cli-board heartbeat <card> [--tokens N --turns N]
cli-board finish <card> --done "<result>" | --blocked <kind> "<why>" | --budget
cli-board watch [--board b]                       SSE to stdout, one JSON line per event
cli-board token create <agent> --label "..." | list | revoke <id>     (owner)
```

`cli-org task create|assign|list|redo` and `cli-org graph apply` keep their names and flags and call the same functions, so the `org-member` skill changes two lines: `hermes kanban show` becomes `cli-board show`, `hermes kanban complete` becomes `cli-board finish --done`.

### 5.3 Agent tools

zen-agent's `KanbanBackend` interface already has the right shape (`list`, `show`, `create`, `comment`, `assign`, `complete`, `block`). A third backend, `kind: 'board'`, speaks 5.1 with a token from the environment; the model's tools (`board_list`, `card_show`, `card_create`, `card_comment`, `card_assign`, `card_complete`, `card_block`) do not change. The `hub` and `cli` backends were deleted after the cutover. Claude Code agents use `cli-board` through Bash, as they use `cli-org` today.

## 6. Parity with the Hermes board

| Hermes kanban has | In this design | Where |
|---|---|---|
| Several boards (`--board`) | Yes | `boards` |
| `list`, `show`, `create`, `comment`, `assign`, `complete`, `block` | Same verbs; `complete` is `finish --done`, `block` is `finish --blocked <kind>` (free text kept) | 3.4, 5.2 |
| Statuses `triage todo scheduled ready running review blocked done archived` | The same nine, same meaning | 3.3 |
| Priority | 1 to 5, default 3 | `cards.priority` |
| `result` and `latest_summary` | `result`; the last comment by the assignee serves as the summary | `cards.result` |
| `link` parent/child, dependency blocks, promotion to ready | `card_deps` and the promotion trigger | 3.3 |
| Events per card | `card_events`, append-only, written by every function | 3.2 |
| Comments with author | `card_comments`; the author is always the caller | 3.4 |
| `--created-by` | Always the caller | 3.4 |
| `--json` on every read | Yes, and on `create` and `claim` | 5.2 |
| Atomic claim with TTL, crash reclaim by PID | `board_card_claim` with `FOR UPDATE SKIP LOCKED`, lease plus heartbeat, `board_reclaim()`. No PIDs: a lane on another machine has none the server can see | 3.4 |
| Budgets | `contract.budget` on the card; the run reports `tokens` and `turns`; `finish --budget` is the stop | 3.2, zen-agent's `wake` already parses the same line |
| Worker spawn, workspaces, review dispatch, notify subscriptions, the worker's tool set | **Not in the record.** These are the lane's. Hermes keeps them for its own bots; cc-dispatcher and zen-agent have their own | 7 |
| Attachments | Vault paths and URLs in the body, resolved by the page as today (`collectVaultRefs`); a `card_files` table is a later addition if a card ever needs a blob | Board page |
| Worker log on the card (Claude lanes) | `GET /cards/:id/log`, same event-feed component | 5.1 |
| Five-second refresh | SSE on `pg_notify`; refetch only the card named | 5.1 |
| New-task form: lanes, profiles, bots, project and feature | Same form; one list, from the roster, grouped by runtime | Board page |
| Comments as the owner from the page | Same | Board page |
| Reassign from the panel | Same, plus `move` and `link` | Board page |

New, because the record is now next to the tracker: filter by project, feature, team or kind; a swimlane for `improve` cards (self-improvement 5.3); the contract rendered as sections; run history with tokens per run on the panel; the Projects page lists a feature's cards from the same table with no hub call.

## 7. Lanes: how work still gets done

A lane is a runtime value and an adapter with four duties: get a card, run the agent, keep the lease, report. Everything else about running is the lane's own business.

| Runtime | Who claims | Runs the card with | Reports |
|---|---|---|---|
| `hermes` | Stage 0 to 1: nobody here; Hermes claims in its own SQLite and the projection keeps the two in step (section 8). Stage 2: a small adapter in the Hermes dispatcher calls `claim` and `finish` over door 2 or 3 | Hermes, unchanged | `finish`, with the Hermes session id as `run_id` |
| `claude-code` | cc-dispatcher, replacing its 30 s poll of the hub with `claim --runtime claude-code` | `claude -p` as today | `finish`; the stream-json log path is what `/log` serves while running |
| `zen-agent` | A `zen-agent lane` loop (or the dispatcher) calls `claim --runtime zen-agent`, then `zen-agent wake <card> --json` | zen-agent | `finish` from the run's trace totals; the trace file is the log |
| `session` (the vault session) | Nobody. A card for it waits in `ready` until a person's Claude Code session takes it; its "claim" is `move running` from the CLI | The person's session | `finish --done` |
| `human` | Nobody. Cards for the owner are the stand-up's business, as today | | |

The lane contract is small on purpose: claim, heartbeat, finish, plus "write your log somewhere `/log` can read". A new runtime (Codex, a cron script, a Hermes replacement) is a roster value and that adapter. This is the "one the zen-agent can use natively" answer: `runtime: zen-agent` in the roster, the `board` backend in `kanban.ts`, and a loop of some fifty lines.

## 8. Staged so nothing breaks

Each stage is a pull request or two and has a measurable "done". **Stages 0 to 3 are done:** the cutover was 2026-10-26 (cc-dispatcher claims, runs and finishes cards through `cli-board`), and the Hermes projection (`hermesProjection`, `KanbanRunner`, `BOARD_HERMES_PROJECTION`, `ORG_KANBAN_CMD`, `cli-board import --hermes`) and the old surfaces (the hub's board routes and allowlist, `agents/Board.tsx`, zen-agent's `hub` and `cli` backends) were removed afterwards. The table below is the plan as it was staged. One item of stage 3 is still open: the `task_links` view and its two patch migrations stay, because `listTasks`, the dispatch store, `routes/usage.ts` and the `usage_facts` views still read the view.

| Stage | What lands | Done when |
|---|---|---|
| **0. Mirror, read-only** | The `board` migration (tables, functions, RLS, grants). An importer, `secondbrain board import --from hermes-json`, that reads `hermes kanban list --json` and `show --json` and upserts cards, comments, deps and status. The Board and Projects pages read `/api/board` behind a flag (`BOARD_SOURCE=engine`), falling back to the hub. | The engine's cards match the Hermes CLI's count and statuses for 24 hours; the page shows the same board from either source. |
| **1. Engine writes, Hermes still runs** | `cli-board` and the token door. `cli-org task create|assign|redo` and `graph apply` write to the engine first and project the card into Hermes (`hermes kanban create` with the same id in the body header, so the two agree). The Hermes dispatcher keeps working untouched. zen-agent gets the `board` backend and `runtime: zen-agent` in the roster schema. | A card created from a laptop over door 2 is in Hermes and claimed by its bot within one dispatcher tick; no card exists on one side only after a day. |
| **2. Record authoritative** | Claim, heartbeat, finish and reclaim go live. cc-dispatcher and the Hermes dispatcher claim through the engine; Hermes keeps a projection for its own runner. `task_links` becomes a view. The hub router loses its board routes; the page's 5 s poll becomes SSE. | Seven days with zero drift between the engine and the Hermes projection; the hub's board routes see no traffic. |
| **3. Runtime optional** | `runtime: zen-agent` carries real work. Hermes becomes one lane among three, or is retired for bots. Delete: the hub's board half, the board allowlist in `hub.ts`, the remote kanban skills and their SSH keys, the polling, the `task_links` view and its two patch migrations, the `hub` and `cli` backends in zen-agent. | Judged on the self-improvement proposal's metrics (10.4): tokens per finished card, first-wake finish rate, trace completeness, against the `claude -p` bots on the same graph nodes. |

Tests first, per `AGENTS.md`: the migration's functions get a suite like `org-powers.test.ts` (who may assign, who may finish, claim under contention with two connections, reclaim after an expired lease, promotion on dependency completion, ship-now only from a human). The importer gets a fixture of fake cards. The route gets the token door tested with a revoked and a live token.

## 9. What is deliberately not here

- **No second board for humans.** The owner's own to-dos are notes; this board is where agents' commitments live. The owner uses it to give work and read status.
- **No comments-as-messages.** A comment is on the card; a message is in a channel. "Ask the owner from a card" is `cli-org ask-owner --task <card>`, as today.
- **No attachments table yet.** Paths and URLs in the body cover what the cards carry today.
- **No per-card ACL.** Boards are company-wide or a team's. Finer than that is a `compartments` column later, mirroring `org_channels`.
- **No reimplementation of Hermes's runner.** Workspaces, review dispatch, notify subscriptions and the worker tool set stay in the lanes.

## 10. Open questions

1. **Roster rows for lanes and profiles.** The design makes every assignee an `org_agents` row, which means `cli-org import` creates rows for the Claude Code lanes (`cc-writer`, …) and the Hermes profiles with no team. Alternative: a nullable FK and a `lane` column. The FK is cleaner; the import is one loop more.
2. **Where the Hermes projection lives in stage 1 and 2.** In the engine (`cli-org task create` shells out to `hermes kanban` as it does today, so the server needs the binary) or in Hermes (a small Hermes plugin that polls `/api/board/cards?board=…` and mirrors). The second keeps the server sandbox as it is; the first is less code. Proposed: the first for stage 1, the second if the sandbox blocks it.
3. **`org_messages.task_id` foreign key.** Wanted; needs a backfill of ids that never existed as cards. Stage 2 or 3.
4. **Review as a status versus a card.** Today review is a card of kind `review` *and* Hermes has a `review` status. The design keeps both (status for the reviewed card, kind for the reviewer's card) because the page's columns and `redo` rely on them. Collapsing to one is possible later.
5. **Lease length.** The agent's `max_runtime_minutes` (already in the roster's caps) plus a margin, or a board-wide default. Proposed: the agent's, default 60.

## 11. How this changes the engine

| Place | Change |
|---|---|
| `app/db/migrations/…_board.sql` | Section 3.2 and 3.4; `runtime` check gains `zen-agent`, `session`; grants and policies for `sb_org` |
| `app/server/src/board.ts`, `routes/board.ts`, `cli-board.ts` | The module: functions called, routes, CLI, token auth, SSE |
| `app/server/src/org.ts` | `createTask`, `assignTask`, `redoTask`, `applyGraph` call `board_card_*` instead of `hermes kanban`; `KanbanRunner` was the stage-1 projection and is gone |
| `app/server/src/routes/hub.ts` | Board routes removed in stage 2; chats and the Telegram toggle stay until they have their own home |
| `app/web/src/routes/agents/Board.tsx`, `Projects.tsx`, `org/Org.tsx` | Read `/api/board`; SSE; filters; contract and runs on the panel |
| `zen-agent/src/tools/kanban.ts`, `zen.example.json` | `kind: 'board'` backend; `runtime: zen-agent` |
| `skills/org-member/SKILL.md` | Two lines: `cli-board show`, `cli-board finish` |
| `docs/modules.md`, `docs/configuration.md`, `docs/architecture.md`, `app/deploy/env.example` | The `board` module, `BOARD_URL`, `BOARD_TOKEN`, `BOARD_SOURCE`, `BOARD_LEASE_MINUTES` |
| `scripts/check-public.sh` | Nothing new to deny: no hosts, no names |
