# Running the agents on zen-agent: a token-budgeted headless runtime

A design for replacing Claude Code headless wakes and Hermes cron jobs on the server with [zen-agent](https://github.com/kon-rad/secondbrain/blob/main/zen-agent/README.md), with DeepSeek V4 Flash on OpenRouter as the default model, rules and a small calibrated classifier (Jev) in front of every wake, and every token and dollar on the `/usage` page.

Status (2026-10-24): the engine side is built and tested; the pilot (phases 2 to 5 of section 11) has not run. Figures marked "measured" come from one install's run logs over about 31 hours and are shaped to carry the point, not the install.

What exists in this repository:

| Piece | Where | Notes |
|---|---|---|
| Rules (section 4.1) | migration `1756000014800_zen-runtime.sql`, `org.ts` | `ack` message kind that wakes nobody; one `routine` wakeup per local day in `ORG_TZ`; roster `routines` |
| Classify step (4.2) | `app/server/src/classify/`, `secondbrain classify` | Jev through OpenRouter (`CLASSIFY_PROVIDER=openrouter`, the owner's choice) or TypeSafe directly; privacy allow list, cache, daily cap, fall-through; default schemas in `vault-template/.agents/classify/*.json` (JSON, not YAML: the server has no YAML dependency) |
| Context policy (5) | `zen-agent` flags `--tools`, `--task-file`, `--handoff-file`, `--thinking`, `--meta`; `handoff` part | Caps as in 5.1 are set in the vault template's `zen.example.json` |
| Model default (6.1) | `vault-template/zen.example.json` | `openrouter/deepseek/deepseek-v4.1-flash` to trial first (the owner's choice); V4 Flash named as the alternative |
| Ledger (7) | `usage/zenTrace.ts`, `usage-sync`, the usage routes and page | Trace `meta.version` 1; real cost on `zen-agent` rows, none on `claude-code` rows |
| Dispatcher (8) | `app/server/src/dispatch/`, `secondbrain org-dispatch`, `secondbrain-dispatch.timer` | `ORG_DISPATCH=on` installs it; only bots with roster `runtime: zen-agent` are run |
| Not built | `usage_runs.outcome` is not filled from the run-outcome decision yet (the decision row carries `run_id`); no Telegram transport (section 9, by design) | |

---

## TL;DR: the five things that matter

1. **The waste is structural, not in the model.** A headless `claude -p` wake resumes a long session (one measured first call read about 100K cached tokens before doing anything), carries Claude Code's fixed system prompt and tool list, and about one wake in eight ends with "nothing for me". None of that is fixed by a cheaper model; all of it is fixed by owning the loop. zen-agent already owns it: the context is assembled from capped parts, the budget is enforced in the loop, and every run writes one trace.
2. **Order of work: rules, then the ledger, then the runtime, then the model.** Two rules (an acknowledgement never wakes anyone; one routine per local day) remove about half the no-op wakes for free. Importing zen-agent traces into the ledger must land before any bot moves, or the move is unmeasured. Then one member bot moves to `runtime: zen-agent`, and only then does the default model change.
3. **DeepSeek V4 Flash costs about 2% of Opus per input token** (OpenRouter catalogue in pi-ai 1.4.0: 0.091 vs 4.00 USD per million input; 0.182 vs 20.00 output). Even if a zen-agent run needs twice the turns of a Claude run, a bot day costs cents. The open risk is quality on long tool-calling runs, which the pilot measures with first-wake finish rate and verify pass rate, with a per-persona `model` override and an escalation rule as the safety net.
4. **Subscription quota becomes cash.** Today's bot wakes spend Max-plan percentage, which the ledger never shows in dollars. zen-agent runs spend API credit, which pi-ai prices from the live OpenRouter catalogue into every trace. The `/usage` page therefore shows real cost for `zen-agent` rows and keeps hiding it for `claude-code` rows. The owner's interactive Claude Code stays on the subscription; nothing here touches it.
5. **One classify step, one table, three decisions.** `secondbrain classify <decision>` wraps Jev (pi-ai lists `typesafe/jev-1.14` on OpenRouter, 0.042 USD per million input, output free) behind a privacy gate and a fall-through, logs every decision to `classify_decisions`, and serves the wake gate, the card model tier and the run outcome label. Rules decide what rules can decide; Jev decides free-text intent; the model is never asked a yes/no question it does not need to reason about.

---

## 1. Goals and non-goals

| Goal | Measured by |
|---|---|
| Fewer tokens per finished card and per bot per day | `usage_runs` and `usage_calls`, grouped by `runtime`, before and after each phase |
| Finer control of what enters the context | Every system-prompt part's size in the trace `meta` line; compactions as trace lines; no silent resume |
| Everything on `/usage` | A `zen-agent` row for every run and every call, with agent, reason, card, project, work type, model, tokens and real cost; a row for every gate decision |
| A cheaper default model | `openrouter/deepseek/deepseek-v4-flash` as the default for bots, per-persona overrides in the roster |
| No personal data in the engine | Everything install-specific stays in the vault's `zen.json`, `org.yaml`, `secondbrain.json` and env files |

Non-goals: the owner's interactive Claude Code session (unchanged, still on the subscription); the Telegram chat transports (Hermes keeps them in every phase of this document; section 9 says what moving them would take); the eval loop of [self-improvement.md](self-improvement.md) (this runtime is the thing that loop measures, not the loop).

---

## 2. Where the tokens go today, and which lever removes each

| Cause | Mechanism | Measured shape | Lever |
|---|---|---|---|
| Resumed sessions | A bot resumes one `claude -p` session for up to `ORG_SESSION_MAX_RUNS` runs; every turn re-sends the whole conversation | First call of a resumed wake: about 100K cached input tokens; a 4-turn wake that changed nothing cost about as much as a productive one | zen-agent runs are fresh by default and carry a short *handoff* part instead of the transcript (section 5.3) |
| A fixed harness prompt | Claude Code's system prompt, tool descriptions and the vault's full `AGENTS.md` on every call | Not separable in the ledger today: a reason to move | Named parts with caps, a skills index instead of skill bodies, a tool set per wake reason (section 5) |
| Wakes that did nothing | DMs that were acknowledgements, two agents acknowledging each other in a loop, a routine fired twice across a day boundary | About 12% of wakes, about 16% of wake spend; half acknowledgements, half duplicate routines | Rules for the structural half (section 4.1); a Jev wake gate for the free-text half (section 4.2) |
| The same model for every card | Every card on a lane gets the lane's model and effort | Member bots on a mid-tier model averaged about a third of the lead bots' per-wake cost, with different work mixed in | Default to the cheap model; escalate by rule and by a card tier classifier (section 6) |
| Big tool outputs | A 12,000-character shell result costs again on every later turn | Shell was 72% of tokens over one measured week | `shell.maxOutput` already caps zen-agent's output; sub-agents return summaries; compaction is a policy with a trace line |

---

## 3. Target architecture

```
  org_messages / cards / routines
            │  (trigger, unchanged: org_wakeups rows)
            ▼
  secondbrain org-dispatch tick            ← engine CLI, systemd timer, replaces the external dispatcher
     1. claim open wakeups per agent (cli-org wake-claim)
     2. rules: drop acks, dedupe routines, batch per agent, caps      (free)
     3. gate:  secondbrain classify wake-gate → act | skip | fallthrough   (Jev, ~0.0001 USD)
     4. tier:  secondbrain classify card-tier → model + budget for a card  (Jev)
     5. run:   zen-agent wake <card> | run --task-file … --json --meta …    (DeepSeek V4 Flash by default)
     6. done:  cli-org wake-done <ids> --run <id> --result …
            │
            ├── .zen/sessions/<run>.jsonl         one trace per run (meta, messages, tools, blocks, compactions, end)
            │        │
            │        ▼
            │   secondbrain usage-sync   →  usage_runs (runtime='zen-agent'), usage_calls (source='zen-agent'),
            │                               archive_sessions (source='zen-agent'), archive_messages
            └── classify_decisions                one row per gate / tier / outcome decision, joined on run_id
                      │
                      ▼
                   /usage: facets runtime, gate; real cost for API runtimes; skipped wakes per agent
```

What moves where:

| Piece | Today | Proposed | Why |
|---|---|---|---|
| Dispatcher | A script outside the engine, driving `claude -p`, framing each run with a `cc_dispatch` line | `app/server/src/dispatch/` + `secondbrain org-dispatch`, a systemd timer installed by `deploy.sh` when `org` is on | Versioned with the engine; tested; one place for rules, gate and budget; no DB driver outside the app |
| Bot runtime | Claude Code headless (`claude -p`) | `zen-agent wake` or `zen-agent run`, chosen per bot by `org_agents.runtime` | Context as code, budget in the loop, trace per run, any provider |
| Routine wakes | Hermes cron jobs (stand-up, briefs) | `routines` in the roster, materialised as `routine` wakeups by `org-dispatch`, run by zen-agent with a task file | One scheduler, one runtime, one ledger |
| Usage | `cc-runs/*.jsonl` and Hermes `state.db` parsed by `usage-sync` and `agents-sync` | Plus a zen trace parser in `usage-sync` | Same tables, same page; one more source |
| Classification | None (the model decides everything in context) | `secondbrain classify` over Jev, behind rules | Cheap, calibrated, logged, falls through |
| Hooks | `guard.py`, `devlog_gate.py` as subprocesses | zen-agent's in-process guard reading the same `guard.local.json`, plus the same two scripts as `preToolUse` and `stop` hook commands | Already built; no parity work |

The engine never imports zen-agent and zen-agent never imports the engine: the dispatcher shells out to `zen-agent --json`, and the ledger reads trace files. That keeps zen-agent extractable with `git subtree split`.

---

## 4. Fewer wakes: rules first, then a classifier

### 4.1 Rules (free, exact, ship first)

| Rule | Where | What it removes |
|---|---|---|
| An acknowledgement never wakes anyone | `cli-org post|dm --kind ack`; the `org_messages` wakeup trigger skips `kind = 'ack'`; one line in the `org-member` skill: "reply to an acknowledgement with nothing" | The ack ping-pong between two bots |
| One routine per local day | `addWakeup` for `reason = 'routine'` judges "already woke today" in `ORG_TZ` (new setting, default `UTC`), the zone the routine is scheduled in | Duplicate stand-ups across a UTC/local day boundary |
| Batch per agent per tick | The dispatcher claims every open wakeup for an agent and passes all of them to one run (`reasons[]` in the trace meta, as the `cc_dispatch` header does today) | Three wakes for three DMs that one run reads at once |
| Quiet hours and caps | `ORG_DISPATCH_QUIET` (local hour range, default none) and a daily token cap per agent and per install (`ORG_DISPATCH_DAILY_TOKENS`, default 0 = off); a wake over the cap stays open with a `held: budget` status | Overnight runs nobody reads until morning; runaway days |
| FYI posts never wake members | A channel post with no mention and no handoff wakes the team lead only (already the trigger's shape; confirm and test) | Members woken by a lead's status |

### 4.2 The classify step

`secondbrain classify <decision> --state-file <path> --json` is one CLI in the app (`app/server/src/classify/`, `cli-classify.ts`), with the pattern `cli-org` set: callers shell out, the app owns the table and the migration.

| Piece | Design |
|---|---|
| Decision schemas | `.agents/classify/<decision>.json` in the vault: question text, primitive (`noul` yes/no, `choice`, `score`), options, `act` and `escalate` thresholds, privacy ceiling, schema version, model pin (`openrouter/typesafe/jev-1.14`). The engine ships defaults for `wake-gate`, `card-tier`, `run-outcome` in `vault-template/.agents/classify/` (copied by `secondbrain-vault init`); a vault edits thresholds, never code |
| Provider | pi-ai, which zen-agent already depends on, has a `typesafe-system-one` API and lists `typesafe/jev-1.14` under OpenRouter. The classify step uses the engine's `OPENROUTER_API_KEY`. No new vendor account is required; a direct TypeSafe key is an option, not a prerequisite |
| Table | `classify_decisions (id, decision, schema_version, input_hash, input_level, model, answer, probabilities jsonb, confidence, action, latency_ms, input_tokens, cost_usd, error, run_id, agent_name, created_at, label, labelled_by)`. `run_id` joins `usage_runs`; `label` is the owner's later verdict |
| Bands | Above `act`: do it. Between `escalate` and `act`: the old path (wake the agent, keep the default model). Below `escalate`, for decisions that touch the owner: queue for review. Thresholds are set from labelled decisions after shadow mode, not from intuition |
| Asymmetry | The wake gate skips only on a confident "nothing to do" (`P(act) < 0.10` to start). A false skip stalls a thread until the next real wake; a false wake costs one cheap run |
| Cache | Key `(decision, schema_version, sha256(state))`; a hit returns the logged answer |
| Fall-through | No key, Jev down, timeout (2 s, one retry), daily cap reached (`CLASSIFY_DAILY_TOKENS`), or privacy refusal: exit code 3 and `action: fallthrough`; every caller treats that as "do what you did before". Deleting the key switches the pilot off |
| Privacy gate | Only text whose level is shared or public leaves the server: board messages in non-confidential channels, card titles and bodies, notes under folders listed in `secondbrain.json` `classify.allow`. Everything else is refused with `error: privacy` and falls through. The default allow list is empty: a fresh install sends nothing until the owner says what may go |

Decisions, in build order:

| # | Decision | Question | Inputs | Saves |
|---|---|---|---|---|
| 1 | `wake-gate` | "Does this message ask `<agent>` to do, decide or answer something?" + choice `{act, answer, fyi, ack}` | message, kind, author, last 3 thread messages, the recipient's role line (1 to 2K tokens) | The whole run for free-text FYIs the rules miss. Never gated: owner-authored, `task` and `routine` wakes |
| 2 | `card-tier` | choice `{flash-low, flash-high, mid, strong}` + score "difficulty 1-5" | card title, body, lane, `verify:` line, parent titles | A strong model only where the card needs one; anything with `verify:` or a `cc-attempt` history keeps the lane default until the retry data says otherwise |
| 3 | `run-outcome` | choice `{did-work, no-op, blocked, failed}` over the run's final text | the trace `end` line and the last assistant text | Nothing directly: it is the measurement for 1 and 2, written to `usage_runs.outcome` |

Auto-tagging, stand-up item scoring and fact-check claim gating are the same CLI with new schemas; none of them changes a wake and none is in this plan's phases.

---

## 5. Smaller contexts: what enters a zen-agent run

zen-agent's `context.parts` caps already exist (rules 6000, persona 3000, playbook 2000, skills 1500, task 4000 tokens). This section is the policy on top.

### 5.1 Parts and their order

Stable parts first so a provider's prefix cache hits; what changes per run last.

| Order | Part | Source | Cap (tokens) | Note |
|---|---|---|---|---|
| 1 | identity | zen-agent's default or the persona's definition file | 600 | |
| 2 | rules | the vault's `AGENTS.md` | 4000 | 9 KB today, about 2300 tokens: fits. A vault that grows past the cap sees `truncated: true` in every trace and trims the file |
| 3 | persona | roster entry + definition | 1500 | |
| 4 | skills | the index: names and descriptions only | 1500 | Bodies load through `read_skill` on demand |
| 5 | playbook | `.agents/org/memory/<bot>.md` | 1500 | The weekly reflection keeps it a list, not a diary |
| 6 | handoff | the previous run's `end` line and final text, plus open `held:` statuses, rendered by the dispatcher | 500 | Replaces session resume (5.3) |
| 7 | task | the card (verbatim body and comments) or the wake's messages, plus standing orders | 4000 | The dispatcher writes it to a file; `--task-file` |
| 8 | environment | date, model, budget, working directory | 150 | Last, because it changes every run |

A run's `meta` line records every part's `chars`, `tokens` and `truncated`, so a part that never changes an outcome can be cut with numbers behind the decision.

### 5.2 Tool sets per wake reason

Tool descriptions are context too. zen-agent's `tools` list is per config today; the dispatcher passes a per-run list with `--tools`.

| Wake reason | Tool sets | Why |
|---|---|---|
| `dm`, `mention` | `org`, `skills`, `knowledge` | Reading and answering needs no shell |
| `handoff`, `task` (card) | all seven | The card is work |
| `routine` (stand-up, brief) | `org`, `knowledge`, `fs` read-only (`fs.roots` to the vault, no `write_file`) | Writing a brief needs reading, not editing |
| `owner` | all seven | The owner asked |

### 5.3 No resume by default

A resumed transcript is the biggest single cost in the measured sample. The replacement:

- every wake starts a fresh session with the handoff part (5.1) carrying what the previous run concluded;
- a card's own comments are the durable memory of its work, and the task part carries them;
- `--resume` stays for the dispatcher to use on one condition: the previous run on the same card ended with `stopped: budget` and the card is not held. Then one continuation, never a third;
- `ORG_SESSION_MAX_RUNS` and `cli-org session` keep working for bots still on `claude-code`.

### 5.4 Budgets by role and reason

Defaults in the engine's `vault-template/zen.example.json`; a roster entry's `budget` or a card's `## Budget` line overrides.

| Run | Turns | Tokens | Minutes |
|---|---|---|---|
| `dm` / `mention` answer | 8 | 60 000 | 5 |
| Card, member | 30 | 300 000 | 30 |
| Card, lead | 40 | 400 000 | 30 |
| Routine (brief, stand-up) | 12 | 120 000 | 10 |
| Sub-agent (`delegate`) | 15 | 150 000 | 10 |

A run that hits a budget ends with `stopped: budget` and exit code 3; the dispatcher comments the card and holds it after the second such run.

### 5.5 Compaction and output caps

Unchanged from zen-agent: `context.cap` 0.6 of the window, `keepTurns` 6, every compaction a trace line; `shell.maxOutput` 12 000 characters with head and tail kept. With a one-million-token window the compaction rarely fires on DeepSeek V4 Flash; the budget stops the run long before. The cap matters when a persona pins a small-window model.

---

## 6. Models: DeepSeek V4 Flash by default, routing by roster and tier

### 6.1 The default

`zen.json` `model: "openrouter/deepseek/deepseek-v4-flash"`. pi-ai 1.4.0's OpenRouter catalogue lists it with a 1 048 575-token window, reasoning support, and prices of 0.091 USD per million input, 0.182 output, 0.0182 cache read (catalogue snapshot; the provider refreshes prices from OpenRouter's model list at run time, so traces carry the live price). `thinking: "off"` for routine answers; `low` for cards. The owner's `OPENROUTER_API_KEY` is already a known engine variable.

Two things to decide from data, not now: whether `deepseek/deepseek-v4.1-flash` (0.0342 / 0.1368 in the same snapshot, newer) finishes cards as well, and whether `:nitro`-style or provider-pinned routing on OpenRouter is needed for stable latency. Both are a string in `zen.json`.

### 6.2 Routing

| Level | Mechanism | Default |
|---|---|---|
| Install | `zen.json` `model` | DeepSeek V4 Flash |
| Persona | roster `agents.<name>.model` (already in `org_agents.model`; zen-agent reads it) | unset: the install default. A lead can pin `openrouter/anthropic/claude-sonnet-5.5` for review-heavy work |
| Card | `classify card-tier` maps `{flash-low, flash-high, mid, strong}` to models and thinking levels named in `secondbrain.json` `dispatch.tiers` | all tiers DeepSeek V4 Flash until the owner names others; the classifier then changes only thinking level |
| Escalation | A card whose run failed `verify:` on the default model retries once on the next tier up; the retry is a new run with the failure in its handoff part | on, since a failed verify is the one signal that does not lie |
| Fallback | OpenRouter down or key over budget: the engine's `together` preset already names DeepSeek V4.1 Flash; `zen.json` `providers` can add it with its own key | off unless a second key exists |

### 6.3 Where Claude stays

The owner's interactive Claude Code: unchanged. Bots on `runtime: claude-code`: unchanged until flipped, one bot at a time. A persona may stay on Claude through OpenRouter (`openrouter/anthropic/claude-sonnet-5.5`) where the pilot shows the cheap model failing its cards, at API prices and with its cost in the ledger.

---

## 7. Tracking: every run, call and decision on `/usage`

### 7.1 From trace to ledger

`secondbrain usage-sync` gains one more source. It walks `zen.sessionsDir` (default `.zen/sessions`, read from the vault's `zen.json`, so the engine never hard-codes a path) with the same append-only cursor it uses for transcripts, and a pure parser `app/server/src/usage/zenTrace.ts` turns one trace into:

| Trace line | Ledger row |
|---|---|
| `meta` | `usage_runs`: `run_id` = session id, `agent_name` = persona, `model`, `started_at`, `parts` jsonb (sizes per part), `budget` jsonb, `resumed`, plus whatever the dispatcher put in `meta` through `--meta`: `reasons`, `wakeup_ids`, `task_id`, `board`, `work_type`, `tier`, `gate_decision_id` |
| `message` (assistant, with `usage`) | `usage_calls`: `source = 'zen-agent'`, `call_id` = the message's id or a hash of (session, index), `model`, input, output, cache read and write, `provider = 'openrouter'`, `cost_usd` from `usage.cost.total`, `tool` and `action` from the first tool call (the `actions.ts` classifier already maps `org_dm` → `dm`, `card_*` → `card`, `bash` → `shell`) |
| `tool` | `archive_messages` step `tool_call` / `tool_result` with `tool_names`, `durationMs`, `isError` |
| `blocked` | `archive_messages` step `system` with the reason; a count on the run |
| `compaction` | a count and the before/after sizes on the run |
| `end` | `usage_runs.ended_at`, `num_turns`, `subtype` = `stopped` (`done`, `budget`, `error`, `aborted`), `is_error`, `total_cost_usd` (real), `usage` jsonb |

The same parser feeds the archive (`archive_sessions.source = 'zen-agent'`, so `harness` reads `zen-agent` on the sessions page) and is the only code that reads the trace format; the trace is the contract between the two packages, and a fixture trace in `app/server/test/` pins it.

### 7.2 Schema (one migration, forward only)

| Change | Why |
|---|---|
| `org_agents.runtime` check gains `'zen-agent'`; `org.ts` roster schema too | The per-bot switch |
| `usage_runs.runtime text NOT NULL DEFAULT 'claude-code'`, `outcome text`, `parts jsonb`, `budget jsonb`, `tier text`, `compactions int`, `blocked int` | The runtime facet; the no-op rate; the context sizes; the tier |
| `usage_calls.cost_usd double precision` | Real dollars for API runtimes. `stripCost` on the routes keeps hiding cost where `source = 'claude-code'` and shows it elsewhere |
| `usage_facts` view: `WHERE c.source IN ('claude-code', 'zen-agent')`, a `runtime` column from `usage_runs`, `surface` = `'bot'` for any run with an `agent_name` | One more source on the same page. Hermes keeps its counters path, so nothing is counted twice |
| `classify_decisions` | Section 4.2 |
| `org_messages.kind` gains `ack`; the wakeup trigger skips it | Section 4.1 |

Down migrations drop what they add; the view is restored to its previous definition.

### 7.3 The page

| Addition | Where |
|---|---|
| `runtime` and `tier` facets; `gate` facet (`woken`, `skipped`, `fallthrough`) over `classify_decisions` joined to wakeups | filter bar and breakdown |
| Cost column and series for rows whose source is not `claude-code` | the chart, the runs table, the session view (Hermes already has `cost_usd`; zen-agent joins it) |
| "Skipped wakes" and "no-op runs" per agent, from `classify_decisions` and `usage_runs.outcome` | the org wakes table |
| Context parts per run (a small bar: rules, persona, skills, playbook, handoff, task) | the run detail |
| Credits: OpenRouter balance already on the page; the daily zen-agent spend next to it | the credits card |

Settings for the page stay in the URL as today.

---

## 8. The dispatcher, in the engine

`secondbrain org-dispatch` (module `org`; `app/server/src/dispatch/`), a systemd timer every `ORG_DISPATCH_TICK_SECONDS` (default 120), installed by `deploy.sh` when `org` is on and `ORG_DISPATCH` is `on` (default `off`, so existing installs keep their own dispatcher until they switch).

One tick:

1. `releaseClaimed()` for claims older than the max run time (a crashed run).
2. For each non-human, non-retired agent with open wakeups, in roster order, up to `ORG_DISPATCH_PARALLEL` (default 2) at a time:
   1. claim all open wakeups (`claimWakeups(agent, runId)`), `runId = <agent>-<stamp>`;
   2. apply rules (4.1): drop `ack` rows (done with result `ack`), collapse duplicate routines, check caps and quiet hours;
   3. for each remaining `dm`, `mention`, `handoff` row not authored by the owner: `classify wake-gate`; a `skip` finishes the row with `result: skipped by wake-gate p=…` and the message stays unread for the next real wake;
   4. nothing left: done. Otherwise look up `org_agents.runtime`:
      - `claude-code`: the current `claude -p` path, unchanged, with the `cc_dispatch` header line it writes today;
      - `zen-agent`: write the task file (5.1 part 7) and the handoff file (part 6); for a `task` wake with a card, `classify card-tier` picks model and thinking; run `ORG_AGENT=<agent> ORG_RUN=<runId> zen-agent wake <card> --json --tools … --model … --meta reasons=… --meta wakeup_ids=… --meta tier=…` or `zen-agent run --persona <agent> --task-file … --json …`;
   5. `wake-done <ids> --run <runId> --exit <code> --result <last line>`; exit 3 after a previous exit 3 on the same card: comment and hold;
   6. `classify run-outcome` on the result text; write `usage_runs.outcome` when the ledger imports the trace (the decision row carries `run_id`, so the join is free).
3. Materialise `routine` wakeups due in this tick from the roster's `routines` (`agents.<name>.routines: [{ name, cron, task_file }]`), one per local day per routine.

What zen-agent needs for this (small, in `zen-agent/`): `--meta key=value` (repeatable) written into the `meta` line; `--tools fs,org,…` per run; `--task-file`; a `handoff` part fed by `--handoff-file`; `wake` accepting `--model` and `--thinking` (it accepts `--model` today). None of it touches the engine.

The dispatcher runs as the deploy's service user, never as the owner, with `fs.roots` confined to the vault and the guard's `guard.local.json` protecting what the owner lists.

---

## 9. Hermes: what moves, what stays

| Hermes job today | Proposed | Phase |
|---|---|---|
| Lead stand-up routine (per lead, daily) | A `routine` in the roster, run by zen-agent with a stand-up task file; the one-per-local-day rule applies | 4 |
| Daily brief text | The same, as a routine of the chief-of-staff persona | 4 |
| Daily brief audio (TTS) | Unchanged: a script step after the text routine, not an agent | never |
| Other scheduled research or update jobs | Routines, each with a task file in the vault | 4, one at a time |
| Telegram chat (owner ↔ an agent) | Hermes and Claude Code keep their own bots. zen-agent has no transport by design; the [`telegram-bridge`](https://github.com/kon-rad/secondbrain/blob/main/addons/telegram-bridge/README.md) add-on is a separate process that calls `zen-agent run --resume …` per message, on its own bot | built |
| Hermes usage in the ledger | Unchanged (`hermes_usage_snapshots`, the usage-ledger plugin) | — |

Hermes's hooks and skills wiring in [agent-harness.md](agent-harness.md) stay for whatever still runs there.

---

## 10. Settings this adds

Every one has a default that works for a stranger, lands in `app/deploy/env.example` or `vault-template/env.example`, and gets a row in [configuration.md](configuration.md).

| Setting | Module | Default | Says |
|---|---|---|---|
| `ORG_TZ` | `org` | `UTC` | The local day for "one routine per day" and quiet hours |
| `ORG_DISPATCH` | `org` | `off` | `on` installs the `org-dispatch` timer |
| `ORG_DISPATCH_TICK_SECONDS` | `org` | `120` | Tick interval |
| `ORG_DISPATCH_PARALLEL` | `org` | `2` | Concurrent runs |
| `ORG_DISPATCH_QUIET` | `org` | unset | Local hour range with no wakes, e.g. `01-07` |
| `ORG_DISPATCH_DAILY_TOKENS` | `org` | `0` (off) | Per-install daily token cap across runtimes |
| `ORG_ZEN_COMMAND` | `org` | `zen-agent` | The runtime command on the PATH |
| `CLASSIFY_PROVIDER` | `org` | `none` | `openrouter` turns the classify step on with `OPENROUTER_API_KEY`; `typesafe` with `TYPESAFE_API_KEY` |
| `CLASSIFY_DAILY_TOKENS` | `org` | `2000000` | Jev daily cap; above it, fall through |
| `secondbrain.json` `classify.allow` | `org` | `[]` | Vault folders and channel slugs whose text may be classified off-box |
| `secondbrain.json` `dispatch.tiers` | `org` | all tiers = the `zen.json` model | Model and thinking per card tier |
| roster `agents.<name>.runtime` | `org` | `claude-code` | `zen-agent` flips one bot |
| roster `agents.<name>.routines` | `org` | `[]` | Scheduled wakes with task files |
| `zen.json` `model` | zen-agent | `anthropic/claude-sonnet-4-6` in zen-agent's own defaults; the vault template's `zen.example.json` sets `openrouter/deepseek/deepseek-v4-flash` | The install default for bots |

---

## 11. Phases, each with a gate

Every phase is one or two PRs, tests first, and is judged on the ledger before the next starts. A bot flips back by one roster line at any time.

| Phase | Ships | Gate to pass |
|---|---|---|
| 0. Rules | `kind: ack` and the trigger change; `ORG_TZ` and the one-per-day routine rule; the FYI test; `org-member` line | No-op wake rate drops from about 12% to under 7% over one week, from `org_wakeups.result` text, with the old dispatcher still running |
| 1. Ledger | `zenTrace.ts`, the migration, `usage-sync` over `.zen/sessions`, the `runtime` facet and cost column; `zen-agent --meta`, `--tools`, `--task-file`, `--handoff-file` | A hand-run `zen-agent wake` appears on `/usage` with agent, card, tokens, cost and parts |
| 2. One bot | `org-dispatch` behind `ORG_DISPATCH=on`, `zen-agent` runtime for one member bot, DeepSeek V4 Flash, no classify step yet | Two weeks: that bot's tokens per finished card and first-wake finish rate against its own previous two weeks and against a member still on `claude-code`; verify pass rate not lower |
| 3. Members and the gate | Half the members flipped; `classify wake-gate` in shadow for a week, then live; `run-outcome` labels | False skips: 0 confirmed in 40 labelled decisions; no-op rate under 4%; cost per member-day in cents, on the page |
| 4. Leads, tiers, routines | Leads flipped (a lead may pin a stronger model); `card-tier` in shadow then live; Hermes stand-up and brief jobs become routines | Retry rate per tier not above the lane default; routines fire once per local day; Hermes cron list down to chat only |
| 5. Decide | Keep, tune or stop per bot; write the dev-log with the before and after tables | The owner's call, with the numbers |

---

## 12. What is measured

| Measure | Source | Before | After |
|---|---|---|---|
| Tokens per finished card, per runtime | `usage_runs` joined to `task_links` where the card completed | the two weeks before each flip | the two weeks after |
| Cost per agent per day | `usage_calls.cost_usd` for API runtimes; API-equivalent for `claude-code`, never shown | | |
| No-op wake rate | `usage_runs.outcome = 'no-op'` / runs; spot-checked | about 12% measured | under 4% |
| First-wake finish rate | cards completed in their first run / cards | | not lower than the Claude baseline per lane |
| Verify pass rate by model tier | `verify_passed` by `tier` | | not lower |
| Gate errors | `classify_decisions.label` on every skip plus 20 random wakes | | false skips 0 |
| Context size per run | `usage_runs.parts` | a Claude run's size is unknown: that is the point | median system prompt under 12K tokens |
| Compactions and budget stops | `usage_runs.compactions`, `subtype = 'budget'` | | both rare; a bot that hits budget often gets a bigger budget or a smaller task, by the numbers |
| Classify spend | `classify_decisions.cost_usd` | 0 | under 1 USD a month |

---

## 13. Risks and open questions

| Risk | Mitigation |
|---|---|
| DeepSeek V4 Flash follows long tool-calling runs worse than Claude: wrong tool arguments, early "done", ignored standing orders | Phase 2 measures exactly this on one bot. The escalation rule and per-persona model pins cap the damage; `verify:` lines on cards catch false completions; the budget caps the cost of a flailing run |
| OpenRouter routes a model to several upstream providers with different latency and caching | Pin a provider in the model string if the traces show variance; the trace records latency per tool call and tokens per turn |
| Subscription versus cash: bot wakes stop spending a sunk-cost plan and start spending credit | The page shows the cash; the daily cap stops a runaway; at catalogue prices a bot day on DeepSeek V4 Flash is cents, and the plan's quota is freed for the owner's interactive work |
| Jev is early access; prices may be a launch subsidy; US hosting with no stated zero-retention option | Fall-through everywhere; privacy allow list empty by default; the classify step is deletable without touching a caller |
| Two dispatchers during the transition | `ORG_DISPATCH=off` by default; the engine dispatcher handles only bots whose `runtime` is `zen-agent` until the owner moves the rest, so the two never claim the same wakeups |
| pi-ai 1.4.0 pins; a catalogue change renames a model | The model is a string in `zen.json`; `zen-agent models --available` lists what resolves; the ledger stores the model string as run |
| Trace format drift between zen-agent and the engine | A fixture trace in the engine's tests; a `version` field in the `meta` line; the parser refuses a version it does not know and the sync reports it |

Open questions for the owner: whether the classify step goes through OpenRouter (one key, already budgeted) or a direct TypeSafe key; which vault folders and channels the privacy allow list names; the first bot to flip; whether `deepseek/deepseek-v4.1-flash` should be tried alongside V4 Flash in phase 2.

---

## 14. What's confirmed vs. inferred

Confirmed (read in this repository on 2026-10-24):

- zen-agent 0.1.0 on `@earendil-works/pi-agent-core` 1.4.0 and `pi-ai` 1.4.0: parts with caps, budget in `finishTurn`, compaction in `prepareRequest`, guard in `beforeToolCall`, one JSONL trace per run with `meta`, `message`, `tool`, `blocked`, `compaction`, `end` lines; `wake`, `run`, `--json`, `--model`, `--resume`; `ORG_AGENT` and `ORG_RUN` passed to `cli-org`.
- pi-ai 1.4.0's OpenRouter catalogue (`providers/data/openrouter.json`) lists `deepseek/deepseek-v4-flash` (window 1 048 575, reasoning, 0.091 / 0.182 / 0.0182 USD per million input / output / cache read), `deepseek/deepseek-v4.1-flash` (0.0342 / 0.1368), `deepseek/deepseek-v4-pro`, `typesafe/jev-1.14` (window 262 144, 0.042 input, output free), `anthropic/claude-opus-5.5` (4 / 20), `anthropic/claude-sonnet-5.5` (2 / 10), `anthropic/claude-haiku-5.5` (0.1 / 0.5). The OpenRouter provider refreshes window and prices from OpenRouter's model list at run time. pi-ai has a `typesafe-system-one` API entry.
- The ledger: `usage_runs` keyed by `(host, run_id)` with agent, reasons, wakeup ids, model, turns, `total_cost_usd` stored and never shown; `usage_calls` per model response with tool and action; `usage_facts` filtered to `source = 'claude-code'`; Hermes through `hermes_usage_snapshots` deltas; `archive_sessions.harness` derived from `source`.
- `org_agents.runtime` is checked against `('claude-code', 'hermes', 'codex', 'human')`; adding `zen-agent` is a migration and a roster schema change.
- `cli-org` has `wake-claim`, `wake-done`, `wake-add`, `wake-release`, `session`; `ORG_SESSION_MAX_RUNS` defaults to 3.
- Hooks: `harness/claude/settings.json` runs `guard.py` and `devlog_gate.py`; zen-agent runs both as hook commands and the guard in process.
- `AGENTS.base.md` is 9.3 KB; the five shared skills total about 23 KB.

Inferred:

- The measured shapes in section 2 come from one install's 31-hour sample of run logs and one week of a token report, scaled by eye; the no-op causes come from the agents' own result text, not from reading the old dispatcher.
- That DeepSeek V4 Flash completes the same cards: untested here; phase 2 exists to test it.
- That OpenRouter prefix caching applies to the stable parts: the catalogue lists a cache-read price, which implies it; whether pi-ai sends the request in a way that hits it is for the first traces to show.
- Budgets in 5.4 are starting points, not measurements.

Related: [self-improvement.md](self-improvement.md) (sections 10 and 14: why a runtime of our own, and the candidates), [agent-harness.md](agent-harness.md), [modules.md](modules.md) (`org`, `usage`), [configuration.md](configuration.md).
