# zen-agent on the server: launch, talk, count

### How zen-agent instances run on the always-on box, how the app talks to them, and how every token they spend lands in the usage ledger

**Status:** design, not built. Everything it builds on is on `main`: the `zen-agent/` package ([zen-agent.md](zen-agent.md)), the board module's lanes ([board-design.md](board-design.md) section 7), the usage ledger and the agent archive (`app/server/src/usage/`, `app/server/src/archive/`).
**Written:** 2026-10-24
**Goal:** A bot on the roster with `runtime: zen-agent` works its cards on the server without anyone starting it; the owner can open a conversation with any persona from the app and watch it work; and `/usage` shows a zen run with the same labels as a Claude Code or Hermes run (bot, card, project, model, host).
**Companion pages:** [zen-agent.md](zen-agent.md) (the runtime), [board-design.md](board-design.md) (lanes, tokens), [deployment.md](deployment.md) (the server), [modules.md](modules.md) (the `usage` and `chat` modules this sits next to).

---

## TL;DR

1. **One new module, `zen`, off by default.** It owns a systemd lane service, an API under `/api/zen`, a page at `/zen`, and the trace collector. Nothing else in the engine learns about zen-agent beyond a `source` value.
2. **The lane is already written; the server only has to start it.** `zen-agent lane --agent <name>` is one systemd template instance per zen bot (`secondbrain-zen-lane@<name>.service`), each with its own board token, so the trace, the card run and the token all carry the same name. `deploy.sh` installs the package next to the app and enables an instance for every roster bot whose runtime is `zen-agent`.
3. **Talking to it is one process per turn.** The app spawns `zen-agent run --stream`, resuming the conversation's session id, and relays the run's events to the browser as server-sent events. The same code path serves a one-off "wake this card with zen" button. No daemon, no socket, no second hub.
4. **The trace is the ledger's input.** A run's JSONL trace already holds every message, tool call and the totals. A pure parser turns one trace file into archive rows, `usage_calls` rows and a `usage_runs` row; the existing `usage-sync` timer reads the sessions folder the way it reads `cc-runs/`. The `/usage` page then needs no new code: runtime `zen-agent` is a value in a filter that exists.
5. **One token, one identity.** The board token a lane already holds also authenticates the knowledge tools (`/api/search`, `/api/file/source`) once those routes accept a board token read-only. A bot never holds the owner's cookie.

---

## 1. Where things stand

| Piece | Exists | Missing |
|---|---|---|
| The runtime: personas, providers, tools, budget, guard, trace | `zen-agent/` | A streaming output mode for a UI (`--json` prints only the end), a SIGTERM that releases the card, the card id in the trace's `meta` line |
| Claiming cards for the `zen-agent` runtime | `zen-agent lane`, `board_card_claim`, `card_runs.runtime` | A process that runs the loop on the server, a token for it, the deploy step |
| A page to run and watch an agent | `/agents/chat` does it for Claude Code through agent-hub; `/chat` does retrieval-only conversations in process | Anything for zen-agent |
| Usage attribution: calls, runs, bots, cards, projects, hosts | `usage_calls`, `usage_runs`, `usage_facts`, `/usage`, the Agent sessions viewer | A parser for the zen trace format and a sync path that reads the sessions folder |
| An archive of every transcript, with steps | `archive_sessions`, `archive_messages`, `steps.ts` | The same parser, plus a `zen-agent` branch in the step classifier |
| A bot's identity on the knowledge base | The owner's session cookie in `ZEN_SB_HEADERS` | A token for agents on the search routes (listed as "what is left" in zen-agent.md section 7) |

## 2. The shape

```
                 the server (one box, one app user)
 ┌──────────────────────────────────────────────────────────────────────┐
 │  secondbrain.service (the app)                                       │
 │    /api/zen  ── ZenSupervisor ── spawn ── zen-agent run --stream ─┐  │
 │    /zen page  ◄── SSE (events) ◄───────── stdout (NDJSON)         │  │
 │    /api/board ◄── claim/heartbeat/finish ◄─┐                      │  │
 │    /api/search, /api/file/source ◄─ token ─┤                      │  │
 │                                             │                      │  │
 │  zen-lane unit, instance bolt  ── zen-agent lane --agent bolt  ────┤  │
 │  zen-lane unit, instance atlas ── zen-agent lane --agent atlas ────┤  │
 │                                                                    ▼  │
 │                                      $VAULT/.zen/sessions/<id>.jsonl  │
 │                                                    │                  │
 │  secondbrain-usage-sync.timer ── cli-usage-sync ◄──┘ (reads traces)   │
 │       │  usage_calls, usage_runs, archive_sessions, archive_messages  │
 │       ▼                                                               │
 │    /usage, /usage/session/droplet/<id>, /board card runs              │
 └──────────────────────────────────────────────────────────────────────┘
```

Three processes write; one folder is the record; one timer reads it. A run started from the page and a run started by the lane are the same thing on disk, so the live view, the archive and the ledger treat them alike.

## 3. Launching instances on the server

### 3.1 The `zen` module

`MODULES=...,zen`. Off: no routes, no page, no units, the collector skips the sessions folder. On: everything below. Like every module it has a safe default for each setting, an entry in `app/deploy/env.example`, and a row in `modules.md`.

| Variable | Default | Says |
|---|---|---|
| `ZEN_AGENT_BIN` | `zen-agent` (on the PATH) | The CLI the app spawns. `deploy.sh` links it into `/usr/local/bin` |
| `ZEN_CONFIG` | `$VAULT_ROOT/zen.json` | The runtime's config; the vault owns it, as it owns `AGENTS.md` and the roster |
| `ZEN_SESSIONS_DIR` | `$VAULT_ROOT/.zen/sessions` | Where traces land. Must agree with `sessionsDir` in `zen.json`; the app reads, the runtime writes |
| `ZEN_MAX_RUNS` | `2` | Interactive runs the app will have in flight at once; a third request waits with a 429 and a retry hint |
| `ZEN_LANE_AGENTS` | (empty) | Roster bots to run a lane instance for. Empty: every live roster row with `runtime: zen-agent`, read at deploy time |
| `ZEN_LANE_INTERVAL` | `30` | Seconds between claims when nothing is ready |

The provider keys the runtime needs are the ones the `chat` module already documents (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `TOGETHER_API_KEY`); zen-agent reads the same names. Nothing new to store.

### 3.2 Installing the package

`deploy.sh` today rsyncs `app/` to `$APP_DIR` and builds it. With `zen` on it also:

1. Rsyncs `zen-agent/` to `$ZEN_DIR` (default `/opt/secondbrain-zen`, a sibling of the app, never inside it: the app's rsync uses `--delete`).
2. Runs `npm ci && npm run build && npm prune --omit=dev` there, as the app user.
3. Writes `/usr/local/bin/zen-agent` as a two-line wrapper (`exec /usr/bin/node $ZEN_DIR/dist/src/cli.js "$@"`), the way `secondbrain-usage-import` is rendered today.
4. Copies `zen.example.json` to `$VAULT/zen.json` only if the vault has none, so the owner's edits survive.

The package keeps importing nothing from `app/`. The app never imports it either: the seam is the executable and the trace format, which is what lets `zen-agent/` leave for its own repository later without touching the engine.

### 3.3 The lane service

One systemd template unit, `secondbrain-zen-lane@.service`, instantiated per bot:

```ini
[Unit]
Description=Second Brain: zen-agent lane for %i
After=network-online.target secondbrain.service
Wants=secondbrain.service

[Service]
Type=simple
User=@APP_USER@
Group=@APP_USER@
WorkingDirectory=@VAULT_DIR@
EnvironmentFile=/etc/secondbrain/env
EnvironmentFile=/etc/secondbrain/zen-lane-%i.env
Environment=ZEN_PERSONA=%i
Environment=BOARD_URL=http://127.0.0.1:${PORT}
ExecStart=/usr/local/bin/zen-agent lane --agent %i --interval ${ZEN_LANE_INTERVAL} --json
Restart=always
RestartSec=15
KillSignal=SIGTERM
TimeoutStopSec=90
Nice=10
PrivateTmp=true
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=@VAULT_DIR@ @APP_DIR@/data
```

Why one instance per bot rather than one loop for the runtime: `board_card_claim` lets a non-human caller without the `dispatch` capability claim only its own cards, so a shared loop would need a dispatch-capable pseudo-member on the roster. Per-bot instances need nothing special, give each process exactly one identity, and let the owner stop one bot (`systemctl stop secondbrain-zen-lane@bolt`) without stopping the others. The cost is one idle Node process per bot, which is small. A shared loop stays possible later (`--runtime zen-agent` with a `dispatch` token) if the roster grows past what that costs.

`deploy.sh` enables `secondbrain-zen-lane@<name>` for each name in `ZEN_LANE_AGENTS`, or for every row `cli-org agents --json` reports with `runtime: zen-agent`; it disables instances whose bot left the roster. The dispatcher pause that already waits for `claude -p` before a build also stops the lane instances first and starts them after the migration, so a bot never wakes into a half-built CLI.

### 3.4 Identity: the token

Every instance reaches the board over HTTP as its bot, with a board token (`cli-board token create <bot> --label "zen lane on the server"`). `deploy.sh` mints one per instance on first run and writes it to `/etc/secondbrain/zen-lane-<bot>.env` (`BOARD_TOKEN=sbb_...`, root:app-user, 640), the way it already writes `SB_ORG_DB_URL` and `PROJECTS_FEED_TOKEN`. The token is revocable from `/org` or the CLI like any other.

The same token should authenticate the knowledge tools. Today `/api/search` and `/api/file/source` sit behind the session gate, so a bot on the server needs the owner's cookie in `ZEN_SB_HEADERS`. Proposed: the gate accepts `Authorization: Bearer sbb_...` on those three read-only routes (`/api/search`, `/api/search/global`, `/api/file/source`), resolved by `findToken` to a live roster member, and stamps `last_seen_at` as the board does. Then the instance env sets `ZEN_SB_HEADERS={"Authorization":"Bearer $BOARD_TOKEN"}` and a bot never holds a cookie. This closes the "a token for agents on the search routes" item in zen-agent.md section 7.

### 3.5 What changes in zen-agent for the lane

Small, and all in the package:

- **SIGTERM releases the card.** `lane` installs a handler that calls `abort()` on the running agent, waits for the trace's `end` line, releases the card (`release`, outcome partial) and exits 0. Today a stopped service leaves the card running until `board-reclaim` takes the lease back, which is correct but slow.
- **The card in the trace.** The `meta` line gains `task: { card, board, wakeup }` for `wake` and `lane` runs, and `kind: 'run' | 'chat' | 'wake' | 'lane' | 'delegate'` for every run. The collector in section 5 reads both; without them a zen run on `/usage` would have no card and no project.
- **Writable paths under the sandbox.** `guard.log` defaults to `~/.cache/agent-guard.log`, which `ProtectHome=read-only` refuses. `zen.example.json` keeps its default; the server's `zen.json` (step 4 of 3.2) sets `guard.log` to `.zen/guard.log` in the vault. No code change, a documented value.

## 4. Interfacing from the app

### 4.1 Process model: one process per turn, one session per conversation

The `chat` module runs the model in process because a retrieval answer is one request. A zen turn is an agent loop with tools, a budget and a guard; it belongs in its own process, as `claude -p` does under agent-hub. The app spawns:

```
zen-agent run --stream --persona <name> [--model <p/m>] [--resume <session id>] --max-turns N --max-tokens T --max-minutes M "<the message>"
```

`--resume` keeps the session id (zen-agent's `resume` reuses the id and appends to the same trace file), so a conversation is one trace file with one `meta` and one `end` line per turn. The next turn replays the file's messages. The page's history is the trace; the database only groups turns into a conversation with a title.

A run started this way is the same on disk as a lane run, so the live view in 4.3 and the collector in section 5 do not know which process started it.

### 4.2 What changes in zen-agent for the UI

- **`--stream`.** Prints one JSON object per line on stdout: every `AgentEvent` the loop emits (`message_start`, `message_update` with text deltas, `message_end`, `tool_execution_start`, `tool_execution_end`), the trace's own lines as they are written (`meta`, `blocked`, `compaction`, `end`), and the `RunResult` last. Human output stays on stderr. This is the `printer` that already exists, with JSON instead of prose.
- **Stdin as steer.** With `--stream`, each line read from stdin is passed to `steer()`, which the library has and the CLI does not expose. The page's "send while running" input writes there.
- **SIGINT aborts.** Already the case for `run`; the trace gets `end` with `stopped: aborted`. The page's Stop button sends it.

### 4.3 The API: `/api/zen`

| Method | Route | Does |
|---|---|---|
| GET | `/options` | Personas (`zen-agent personas --json`), models with a key (`zen-agent models --available --json`), the effective config (`zen-agent config`), the budget defaults. Cached for a minute; the CLI is the source so the page and the lane agree |
| GET, POST | `/conversations` | List; create with `{ persona, model?, title? }`. A row in `zen_conversations` |
| GET, PATCH, DELETE | `/conversations/:id` | The conversation and its turns, read from the trace (`Session.load` shape, parsed by the section 5 parser so the page and the archive render the same steps) |
| POST | `/conversations/:id/messages` | One turn: spawns the run, answers as server-sent events (`event: meta`, `delta`, `message`, `tool`, `blocked`, `compaction`, `end`, `error`), then stores nothing but `updated_at` and the session id. A dropped browser does not kill the run: the process finishes, the trace holds the answer, and reopening the page replays it |
| POST | `/runs/:sessionId/steer` | `{ text }` to the running process's stdin |
| POST | `/runs/:sessionId/stop` | SIGINT to the process; 404 when the app does not own it (a lane run is stopped with its service) |
| GET | `/runs` | Live runs: the app's own children, plus lane runs from `card_runs WHERE runtime = 'zen-agent' AND finished_at IS NULL` (the run id is the session id), plus the last N finished from the sessions folder |
| GET | `/runs/:sessionId/events` | Server-sent events that tail the trace file (`fs.watch` plus a byte cursor). This is how the page watches a lane run it did not start, and how it reattaches to its own run after a reload |
| POST | `/wake` | `{ card }`: one-off `zen-agent wake <card> --stream` as the card's assignee, for a "wake with zen" button on a card. Same supervisor, same events |

A `ZenSupervisor` (`app/server/src/zen/supervisor.ts`) owns the children: a map from session id to process, the `ZEN_MAX_RUNS` cap, an allowlist of environment variables passed down (the provider keys, `ZEN_CONFIG`, `ZEN_SB_HEADERS`, `BOARD_URL`, `BOARD_TOKEN` for the persona when one exists; never the whole app environment), and a shutdown hook that SIGINTs every child so a redeploy ends runs cleanly. Deploy's pause also waits for `zen-agent` processes the way it waits for `claude -p`.

One table, module data, not derived from markdown:

```sql
CREATE TABLE zen_conversations (
  id          serial PRIMARY KEY,
  title       text NOT NULL DEFAULT 'New conversation',
  persona     text NOT NULL,
  model       text,
  session_id  text NOT NULL UNIQUE,     -- the trace file's id; every turn appends to it
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
```

### 4.4 The page: `/zen`

Left: conversations, and under them the live runs (lane runs with their card, interactive runs with their persona). Centre: the run as steps, the way the Agent sessions viewer renders them, streaming: assistant text as it arrives, each tool call with its arguments and duration, a blocked call in red with the guard's reason, a compaction as a one-line notice. Above: persona and model chips, a budget meter (turns, tokens, minutes used against the `meta` line's budget), Stop and a steer input while running. Below a finished run: a link to its archive page (`/usage/session/droplet/<session id>`) once the sync has run, and to its card on `/board` when it had one.

The page reuses the terminal-style components `/agents/chat` has for tool calls; the events differ in shape, not in kind.

Two links elsewhere, both behind the module flag: a card run on `/board` whose runtime is `zen-agent` links to `/zen/runs/<run id>`; an agent's page under `/org/agents/<name>` gets "Talk to <name>" when the bot's runtime is `zen-agent`, which opens `/zen` with the persona chosen.

### 4.5 Not the `chat` module

The `chat` module answers from retrieved passages with no tools and stays that way: it is the "ask my notes" surface, cheap and safe to leave open. `/zen` is "work with an agent", with a shell and the board. Offering a persona's zen run as a choice inside the chat panel is possible later (the panel already lists org personas), but merging them would give the retrieval chat a shell.

## 5. Usage and the archive: reading the trace

### 5.1 The parser

`app/server/src/usage/zenTrace.ts`, pure, tested against a fixture trace with fake data. One trace file (one or more runs, since a resumed session appends) → `{ session: SessionInput, messages: ParsedMessage[], calls: UsageCall[], runs: RunRecord[] }`.

| Trace line | Becomes |
|---|---|
| `meta` (first) | `archive_sessions`: `source = 'zen-agent'`, `external_id = id`, `parent_external_id = parent`, `model`, `started_at = at`, `title` = the first user message's first line, `meta = { persona, kind, task, parts, budget, tools, skills, workdir, billing_provider: <provider part of model> }`. The generated `provider` column reads `billing_provider`, so the Agent sessions filter shows `anthropic`, `openrouter`, `ollama` as it does for Hermes |
| `message` (user) | `archive_messages` row, `step = 'prompt'` |
| `message` (assistant) | One row; `step = 'response'` (or `thinking` when only thinking blocks), `tool_names` = its tool calls, `tool_call_id` = the first; plus one `usage_calls` row (below) |
| `tool` | `archive_messages` row, `step = 'tool_result'`, `tool_call_id`, `is_error`, `raw = { name, args, durationMs }` |
| `blocked` | `step = 'system'` row with the reason |
| `compaction` | `step = 'meta'` row with before/after/dropped |
| `end` | Closes the `usage_runs` row; `ended_at = at` on the session when it is the file's last `end` |

The `usage_calls` row per assistant message:

| Column | From |
|---|---|
| `source` | `zen-agent` |
| `call_id` | The message's provider id when pi-ai carries one; else `z:` plus a hash of session id, run ordinal and message index, the way Hermes calls fall back to `h:`. Stable, so re-reading a file changes nothing |
| `session_external_id` | The trace id |
| `ts`, `model` | The line's `at`; the message's model, else `meta.model` |
| `entrypoint` | `meta.kind`: `lane`, `wake`, `chat`, `run`, `delegate`. `usage_facts.headless` is `entrypoint <> 'cli'`, so every zen run counts as headless, which it is |
| `cwd` | `meta.workdir` |
| `is_sidechain` | `meta.parent` is set (a `delegate` child) |
| tokens | `usage.input`, `usage.cacheWrite`, `usage.cacheRead`, `usage.output`; thinking stays 0 unless pi-ai reports it |
| `tool`, `action` | The first tool call's name, mapped to the Claude names the guard already maps (`bash` → Bash, `write_file` → Write, `org_post` → `post`, `org_dm` → `dm`, `card_*` → `card`, `search_notes` → `read`), then through the existing `actions.ts` classifier |
| `provider` | The provider part of the model |
| `run_id` | `<session id>` for the file's first run, `<session id>#n` for a resumed turn, the convention `runLog.ts` uses for a log with several runs |

The `usage_runs` row per `meta`..`end` pair:

| Column | From |
|---|---|
| `run_id`, `session_id` | As above |
| `agent_name` | `meta.persona` |
| `team_slug`, `work_type` | Left null; `usage_facts` already fills them from `org_agents` and `task_links` |
| `task_id`, `board` | `meta.task.card`, `meta.task.board` |
| `lane` | `zen-agent` |
| `wakeup_ids`, `reasons` | `[meta.task.wakeup]` when present; reasons from `org_wakeups` through the view's lateral join |
| `resumed` | `meta.resumed` is set |
| `started_at`, `ended_at`, `duration_ms` | `meta.at`, `end.at`, the difference |
| `num_turns`, `subtype`, `is_error` | `end.turns`; `end.stopped` (`done`, `budget`, `error`, `aborted`); `stopped = 'error'` |
| `total_cost_usd`, `usage` | `end.usage.cost`, `end.usage`. A real API cost, unlike the Claude Code rows the page hides |
| `log_path` | The trace path |

Nothing here needs a new table. One view change: `usage_facts.surface` says `bot` for any droplet call with an agent name, which is right for a lane run and wrong for a conversation the owner is having. A forward-only migration replaces the view with one more branch: `WHEN c.source = 'zen-agent' AND c.entrypoint = 'chat' THEN 'zen-chat'`. Everything else on `/usage` (runtime filter, bot, card, project, model, host, the runs table, the wakes table) works on the values the parser writes.

### 5.2 The sync path

`usage/sync.ts` gets a fourth input next to the transcripts, the run logs and the plan log: `zenSessionsDir`. Traces are small and one run each, so they take the run-log path (re-read a changed file whole, cursor by size), not the append-only path, which keeps the parser simple: it always sees the `meta` line. Every write is the same idempotent upsert the other collectors use.

- `cli-usage-sync.ts` reads `ZEN_SESSIONS_DIR`; `secondbrain-usage-sync.service` sets it to `@VAULT_DIR@/.zen/sessions` when the `zen` module is on (the unit is rendered per module list already).
- The `steps.ts` classifier gets a `zen-agent` branch, so `secondbrain archive-steps` can fill older rows the way it did for Hermes.
- `cli-usage-backfill.ts` learns the folder, so a sessions directory copied from a laptop can be imported once.

A laptop running zen-agent reports through the agent ledger later: `ledger.json` gains `zenSessionsDirs`, `collect.ts` calls the same parser and ships `session`, `message` and `call` rows through the wire that exists. Runs are not a ledger row kind today (the cc-runs logs are server-only too); adding a `run` kind is the one wire change, and it is the same change Claude Code lanes on a second machine would need. Out of scope here, named so it is not forgotten.

### 5.3 What the usage page shows

- **Tokens by runtime**: `zen-agent` next to `claude-code` and `hermes`, with the existing filter.
- **Runs (bots and lanes)**: a zen run with its bot, card, project, turns, duration and outcome. This is the table the pilot's metrics come from (tokens per finished card, first-wake finish rate: `usage_runs` by `source`, `task_id` and `subtype`), so judging zen against the `claude -p` bots on the same cards is a filter, not a script.
- **Agent sessions**: a zen session with its steps, blocked calls and compactions visible, since each is a row.
- **API credits**: the `credits-sync` balance for a provider already moves when zen spends on it; nothing to add.
- **Cost**: `usage_runs.total_cost_usd` is hidden because Claude Code's is a subscription estimate. A zen run's is what pi-ai priced from the provider's catalogue. Showing it for `source <> 'claude-code'` is one condition in the runs table, and worth doing: it is the first place the page can put a dollar figure next to a card.

## 6. Security, and the one rule

- **Nothing personal.** Bot names, tokens, model choices and the sessions path come from the roster, `/etc/secondbrain/env`, the per-instance env files and `zen.json` in the vault. The engine holds the template unit, the defaults and the parser.
- **The lane runs as the app user**, like `claude -p` and Hermes do today, under the same `ProtectSystem=strict` sandbox with the vault and the app's data dir writable. zen-agent.md section 8 says a dedicated user is better; that is a server-wide change (the vault's ownership, the git sync) and is not made here. The guard runs in process on every call as before.
- **Tokens name one member and are revocable.** A lane's token can claim only its bot's cards. The supervisor passes a persona's token to an interactive run only when one exists for it; otherwise the run has the board tools off, and the page says so.
- **The page acts as the owner**, behind the session gate like every page. Steer and stop reach only processes the app started.
- **Child environment is an allowlist**, so a provider key the app has for the chat module reaches the agent only when zen-agent needs that provider's name.
- **Traces are redacted on the way in**, by the same `redactor()` every collector runs (secret-named values from the environment and `REDACT_ENV_FILES`).

## 7. Staged, so each step pays for itself

| Stage | Builds | Test | Touches |
|---|---|---|---|
| 1. Count it | The trace parser, the `zen-agent` steps branch, `ZEN_SESSIONS_DIR` in `usage-sync`, the `surface` view migration | Fixture trace (fake persona, fake card) → expected calls, runs, steps; a sync test that reads a folder twice and writes once | `app/server/src/usage/zenTrace.ts`, `usage/sync.ts`, `archive/steps.ts`, `cli-usage-sync.ts`, `deploy/secondbrain-usage-sync.service`, a migration |
| 2. Run it | The `zen` module flag, `deploy.sh` install and the template unit, token minting, `ZEN_*` in `env.example`, SIGTERM release and `meta.task`/`meta.kind` in zen-agent | zen-agent's own tests for the new meta fields and the signal path (faux provider); `check-public.sh` | `config.ts`, `deploy.sh`, `deploy/secondbrain-zen-lane@.service`, `zen-agent/src/{cli,agent,session}.ts` |
| 3. Reach it | Board tokens on the three read-only knowledge routes; `ZEN_SB_HEADERS` from the token in the instance env | Route tests: a live token reads, a revoked one gets 401, a token cannot write | `routes/search.ts`, `routes/file.ts`, the gate in `app.ts` |
| 4. Talk to it | `--stream` and stdin steer in zen-agent; the supervisor; `/api/zen`; `zen_conversations` | Supervisor test with a fake binary that prints a scripted stream; route tests over it | `zen-agent/src/cli.ts`, `app/server/src/zen/`, `routes/zen.ts`, a migration |
| 5. See it | The `/zen` page, the card-run link on `/board`, "Talk to" on `/org/agents`, docs | Vitest for the event reducer; a `run` skill screenshot | `app/web/src/routes/zen/`, `board/`, `org/`, `modules.md`, `configuration.md`, `deployment.md`, `zen-agent.md` section 7 |

Stage 1 alone makes every zen run anyone has already done on the server visible on `/usage` after the next sync, before a single lane runs. Stage 2 is the pilot zen-agent.md asks to judge. Stages 3 to 5 are the owner's experience and can wait for the numbers.

## 8. Open questions, with a recommendation each

1. **Per-bot instances or one loop?** Per bot (3.3). Revisit if the roster passes a dozen zen bots.
2. **Should the interactive run hold a board token?** Only when the persona has one, and then its own (6). A conversation that needs the board is a bot's conversation; the owner's own runs keep the shell and the knowledge base.
3. **Show dollar cost for zen runs?** Yes, for non-Claude-Code sources only (5.3).
4. **Should `/zen` fold into `/agents`?** No: `/agents` is a view over agent-hub, which is a separate service and may be off. `/zen` stands on the engine alone.
5. **Where does the daemon go if process-per-turn is too slow?** A `zen-agent serve` subcommand on a Unix socket, speaking the same NDJSON. The supervisor's interface (start, steer, stop, events) is written so that swap stays inside `app/server/src/zen/`.
