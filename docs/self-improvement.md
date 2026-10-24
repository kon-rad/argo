# Self-improving agent orchestration: a proposal

### How the harness, the skills, the board, the org, the cron jobs and the engine itself could learn from their own runs

**Status:** proposal; two of its pieces have since shipped outside the `improve` module itself. The headless-runtime pilot it asks for in section 10 is built as [`zen-agent/`](https://github.com/kon-rad/secondbrain/blob/main/zen-agent/README.md) ([zen-agent.md](zen-agent.md)); the kanban board it asks to bring into the engine in section 5.3 is built as the `board` module ([board-design.md](board-design.md)). Everything else — the stamp, `run_outcomes`, mining, the eval tiers, the harness-engineer bot, memory curation, the outer loop — is still a suggestion, not built, unless listed under "What exists today".
**Written:** 2026-10-24 · **Updated:** 2026-10-25, after zen-agent and the board module landed
**Goal:** Decide how to add a bounded, auditable self-improvement loop to the second brain: one that mines the traces the system already keeps, proposes changes to its own mutable surfaces, evaluates them before anything is promoted, and leaves a record a person can read and revert.
**Scope:** The engine (this repo) and the vault files it reads. Model weights are out of scope: the models stay frozen behind Claude Code, Hermes and their APIs.

---

## TL;DR: the five things that matter

1. **We already have most of the expensive half.** Traces (`archive_*`, `usage_calls`, `llm_exchanges`), outcome labels (`usage_runs.verify_*`, review rounds, held cards, `is_error`), a dependency-aware kanban, a human approval gate for shipping, a sourced fact memory and a dev-log discipline all exist. What is missing is the loop that joins them: no run is stamped with the version of the rules and skills it ran under, nothing clusters failures, nothing proposes a change, nothing evaluates a proposal before it goes live.
2. **Treat every instruction file as a harness version and stamp it on every run.** One hash over `AGENTS.md`, the skills, `guard.local.json`, `graphs.json`, the org roster, the cron prompts and the engine pin, recorded with each run, is the single change that turns the existing ledger into an evaluation dataset. Everything else in this proposal builds on that stamp.
3. **Improvement is a pull request, never a live edit.** The improver proposes a diff to one surface, attaches an improvement record (hypothesis, trace evidence, eval plan, results) and opens a PR. The existing rules hold: agents never merge their own PR, nothing ships without the owner's yes, and a change is promoted only with zero regressions on the static checks and the replay suite. This is what keeps the loop bounded.
4. **Evaluate with behavioural contrast on recorded tasks, not with a judge's opinion.** The eval compares a candidate harness against the current one on the same recorded cards: verification pass rate, review rounds, held rate, tokens and turns per finished card, guard blocks, owner interventions. An LLM judge is used only for pairwise preference on open-ended outputs, with a written rubric, and never decides promotion alone.
5. **Most likely to change the plan: a smaller headless runtime.** The bots' headless wakes (`claude -p` under the dispatcher) are where context cost, missing traces and weak control over compaction hurt most. A thin runtime built on a minimal agent core (the pi packages, formerly pi-mono, are the leading candidate; see sections 10 and 14) would give in-process hooks, deterministic context assembly and session files as traces. It is a pilot, not a replacement: the owner keeps Claude Code interactively, and Hermes keeps its cron.

---

## 1. The frame: the system as a mutable program

The research the owner shared describes an agent system at iteration $t$ as a tuple $x_t = (M_t, H_t, D_t, T_t, \text{Imp}_t)$: the model, the harness, the data and trajectories, the trainer or evaluator, and the improvement mechanism. The second brain maps onto it cleanly, and the mapping shows where the gaps are.

| Symbol | In the research | In the second brain today | Mutable by the system? |
|---|---|---|---|
| $M$ | The foundation model | Claude (via Claude Code) and whatever Hermes is configured with. Frozen, reached over an API or a subscription | No, and this proposal keeps it that way |
| $H$ | Prompts, tool wrappers, memory layout, subagent configs, middleware | `AGENTS.base.md` + `AGENTS.local.md` (compiled to `AGENTS.md`), `CLAUDE.md`, `.claude/settings.json`, `guard.py` + `guard.local.json`, `devlog_gate.py`, the skills (`SKILL.md`), the fact-checker subagent, the org roster (`org.yaml`), the graph templates (`graphs/*.yaml`), the bots' memory files, the cron job prompts, the dispatcher's wake prompt, the kanban card bodies, `secondbrain.json`, the env | Only by a person, or by an agent in a session that a person reviews. Nothing measures a change |
| $D$ | Trajectories and datasets | `archive_sessions` / `archive_messages` (every Claude Code and Hermes turn), `usage_calls` (tokens per call), `llm_exchanges` + `llm_blobs` (exact API requests when the capture proxy is on), `usage_runs` (one row per `claude -p` run with its wake reasons), `org_messages`, `org_wakeups`, `cron_runs` / `cron_outputs`, `task_links`, `memory_facts`, the dev logs | Collected, searchable on `/usage` and `/search`. Not joined to the harness version that produced them |
| $T$ | Trainer and evaluator | The `projects` module's verifications (a feature goes live only with a passing check), the `cc_verify` line the dispatcher can append to a run, review cards and `task redo`, the `fact-check` skill, the engine's own test suites, CI | Each exists in isolation. There is no suite that re-runs a task under a different harness |
| $\text{Imp}$ | The improvement mechanism | A person reading dev logs and stand-ups, then editing a file | Not represented in the system at all |

The proposal is to give $\text{Imp}$ a home: a module that reads $D$, uses $T$, proposes edits to $H$, and keeps its own policy in a file that goes through the same review as everything else. The research calls the last part bounded recursive self-improvement: the improver can change how it improves, but only through the same gate as any other change.

### What the research adds, in our terms

| Idea from the literature | What it means here |
|---|---|
| Harness as readable, evaluatable code | Every file in the $H$ row above is already text in git. The missing piece is a version identity for the whole set, so a run can say which version it ran under |
| Trace mining and error localisation | A nightly job that reads the week's runs, finds the ones that failed, were held, needed a second review round or burned tokens without finishing, and asks what they have in common: a tool, a skill, a graph node, a cron job, a rule |
| Prompt and tool ergonomics refinement | Rewriting a `SKILL.md`, a graph node body, a cron prompt or a `cli-*` help text, then showing on the same tasks that the agent now needs fewer turns or fewer corrections |
| Skill compilation and memory libraries | Turning a recovery procedure that worked three times into a skill or a playbook bullet, with a source link, instead of leaving it in a transcript |
| Propose / probe / compose with behavioural contrast, and retention only with evidence ("zero-regression promotion" in the owner's summary) | The eval design in section 6: candidate vs. baseline on the same recorded cards, promoted only if nothing got worse |
| An outer loop that tunes the improver | `.agents/improve/policy.json` (clustering thresholds, eval budget, promotion thresholds) is itself a surface the loop may propose edits to, measured on how many of its proposals survived |
| Contract-based subagent interfaces | Cards and graph nodes get explicit fields: objective, scope, the artifact to return, a token and turn budget. The dispatcher enforces the budget; the reviewer checks the artifact |
| Graph handoffs as mutable programs | `graphs/*.yaml` is already a DAG in a file. Proposals can add a verifier node, drop a node that never changes the outcome, or change who a node is assigned to |
| Macro / micro separation | Leads and graphs learn delegation (which nodes, in which order, with what budget); members learn single-domain execution (skills, memory). The two are evaluated separately so a bad decomposition is not blamed on a bot and a bad bot is not blamed on the graph |

---

## 2. What exists today, and what is missing

This section is the inventory the rest of the proposal builds on. Paths are real.

### 2.1 Mutable surfaces (the harness, $H$)

| Surface | Lives in | Loaded by | Changed by | Versioned? | Signal that would tell you a change helped |
|---|---|---|---|---|---|
| Shared agent rules | `vault-template/AGENTS.base.md` (engine) | Every agent, at session start, through the vault's compiled `AGENTS.md` | Engine PR | Engine commit | None today |
| Owner's rules | `AGENTS.local.md` (vault) | Same | The owner, by hand | Vault commit | None |
| Claude Code wiring | `harness/claude/settings.json`, copied to `.claude/settings.json` | Claude Code | Engine PR, then a manual copy into existing vaults | Engine commit, but vaults drift | Guard log, `BASH_MAX_OUTPUT_LENGTH` effects on tokens |
| Guard rules | `harness/hooks/guard.py` (built-in), `.agents/guard.local.json` (vault) | `guard.py` before every tool call | Engine PR / the owner | Yes / vault commit | `~/.cache/agent-guard.log` (blocks, never synced anywhere) |
| Dev-log gate | `harness/hooks/devlog_gate.py` | Claude `Stop`, Hermes `pre_verify` | Engine PR | Yes | Nothing records how often it fires |
| Shared skills | `skills/<name>/SKILL.md` | Claude Code via `.claude/skills`, Hermes via `skills.external_dirs` | Engine PR | Engine commit | None: no skill has a test or an eval |
| Private skills | `.agents/skills/<name>/` (vault) | Same | The owner or an agent (the dev-log gate watches it) | Vault commit | None |
| Fact-checker subagent | `harness/claude/agents/fact-checker.md` | Claude Code | Engine PR | Yes | The tables it produces are not stored |
| Org roster | `.agents/org/org.yaml` in the vault, compiled to `org.json`, imported with `cli-org import` | `org_agents`, `teams`, `org_channels` | The owner; the compiler lives in the vault, not the engine | `org_version` hash on each agent row | Per-bot activity on `/org` and `/usage` |
| Graph templates | `.agents/org/graphs/*.yaml` → `.agents/org/graphs.json` (`loadGraphs` in `org.ts`) | `cli-org graph apply` | The owner; compiler in the vault | Vault commit; `task_links.graph` and `.node` tag every card | Rounds, time to done and tokens per node are derivable but nobody derives them |
| Cards and their bodies | The `board` module in the engine (migration, `board_*` functions, API, `cli-board`; see [board-design.md](board-design.md)), stage 0 still mirroring Hermes's own kanban while the rollout runs | The dispatcher's wake prompt, zen-agent's `board` backend | Leads, members, the owner, graphs | Not versioned; the contract fields (5.3) are not yet filled in by `task create` | `redo` rounds, `held:` statuses, `block` reasons, `wake-done` fallback statuses, and now `card_events`/`card_runs` once stage 1+ writes land |
| Bot memory files | `.agents/org/memory/<bot>.md` | `cli-org recall` (line-level word match) | The bot, in its weekly reflection | Vault commit | None |
| Shared facts | `memory_facts` (Postgres), `cli-org remember / recall / forget` | Any runtime | Any agent, with a source | Supersession chain | None: a fact is never scored on whether it was used or was right |
| Cron jobs | Hermes `cron/jobs.json`, prompt per job; synced into `cron_jobs` | Hermes | The owner, in Hermes | `cron_jobs.raw`, `first_seen_at` | `cron_runs.status`, `cron_outputs` content. No grading |
| Server timers | `app/deploy/*.timer` | systemd | Engine PR | Engine commit | `systemctl list-timers`, surfaced on `/cron` |
| Dispatcher wake prompt and `cc_dispatch` framing | The dispatcher (`cc-dispatcher`, outside the engine) | `claude -p` | The owner | Not versioned | `usage_runs` rows, `verify_*` columns |
| Context budget settings | `ORG_SESSION_MAX_RUNS`, `ORG_TASK_WAKE_RETRIES`, `ORG_TASK_WAKE_BACKOFF_MINUTES`, `BASH_MAX_OUTPUT_LENGTH`, `MAX_MCP_OUTPUT_TOKENS` | `config.ts`, Claude Code | The owner | Env, unversioned | Tokens per run on `/usage` |
| The engine code | `app/`, `harness/`, `tools/` | Everything | PR with CI | Git | The test suites |

Two things stand out. First, half of the surfaces that drive the agent company (the roster and graph compiler, the dispatcher) still live outside the engine, so the engine cannot validate, version or test them — though the kanban itself moved in as the `board` module (5.3, [board-design.md](board-design.md)), and the headless runtime those surfaces feed exists as zen-agent (10.4, [zen-agent.md](zen-agent.md)). Second, no surface has a signal attached to it. The signals exist (right column) but are never joined to the surface they would judge.

### 2.2 Trajectories ($D$) and outcome labels ($T$)

| Table or file | What it holds | Attribution it carries | Attribution it lacks |
|---|---|---|---|
| `archive_sessions`, `archive_messages` | Every Claude Code and Hermes session, every message, classified into steps (`prompt`, `response`, `thinking`, `tool_call`, `tool_result`, `system`, `meta`) by `archive/steps.ts` | host, harness, profile, parent session (subagents fold into parents) | Which card, which bot, which rules version, which skills were loaded |
| `usage_calls` | Tokens per API call, the first tool it invoked, its action class | session, model, entrypoint, sidechain | Same |
| `usage_runs` | One row per `claude -p` run: wake reasons, card, lane, bot, team, turns, duration, `subtype` (`success`, `error_max_turns`, …), `is_error`, and a `verify_*` block if the dispatcher appended `cc_verify` | run id, card, agent, work type | Harness version; the graph node; the card's budget |
| `llm_exchanges`, `llm_blobs` | With the capture proxy: each exact Messages request, with the system prompt, tools and messages stored once by hash | session, model | Everything above. But the `system_sha` and `tools_sha` are already a de-facto harness fingerprint for Claude Code calls |
| `org_messages` | Statuses, decisions, hand-offs, questions for the owner, stand-ups, reflections | author, run id, card, project, feature | Nothing missing for its purpose |
| `org_wakeups` | Why a bot ran and whether it finished | reason, ref, claimed_by, result | |
| `task_links` | Card ↔ project, feature, assignee, graph, node, kind, rounds | | When the card finished, how many wakes it took |
| `memory_facts` | Sourced claims with confidence and supersession | author, via, project | Whether it was ever recalled, whether it turned out true |
| `cron_runs`, `cron_outputs` | Hermes cron executions and their outputs | job, profile | Whether the owner found the output useful |
| Verifications (`verifications` table, `projects` module) | A named check, pass or fail, evidence, per feature | project, feature, who recorded it | Which run produced it |
| Dev logs | What changed, why, how it was tested | Project folder, date | Nothing; they are the human-readable trace and should stay so |
| `~/.cache/agent-guard.log` | Every guard block | tool, reason | Never leaves the machine, never joined to a run |

The labels we need are nearly all present: a run either produced a passing verification or it did not; a card either finished in one wake or was held; a review either passed or asked for a round; a cron output was either delivered or errored. What is missing is cheap: a harness version per run, a card budget per card, a guard-block count per run, and a place to record the owner's reaction to a cron output.

### 2.3 Gaps, in one list

- **No harness version on a run.** Without it, no before/after comparison is possible.
- **No failure clustering.** The `/usage` page shows runs one at a time; nothing groups the week's `error_max_turns` runs by card type, skill or graph node.
- **No proposal mechanism.** An agent that notices a bad rule has no sanctioned way to propose a fix except a dev-log line a person may read.
- **No evaluation of instruction files.** Skills, rules, graph templates and cron prompts have no tests, no examples, no replay.
- **No contract on a card.** A card body is prose; nothing states the budget, the artifact to return or the scope. The dispatcher cannot enforce what is not written down.
- **Memory is a flat file and a fact table.** Recall is a word match over `memory/<bot>.md` lines and a full-text query over facts. Nothing is scored, decayed, curated or promoted to a rule.
- **Cron is outside the loop.** Hermes cron outputs are synced and displayed but never graded, and the prompts are not versioned by anything the engine sees.
- **The orchestration surfaces are split across repos, less than before.** The kanban moved into the engine as the `board` module ([board-design.md](board-design.md)); the roster and graph compiler and the dispatcher are still outside it, and the engine imports their outputs and cannot test them.
- **Guard blocks and gate nudges are invisible.** Both hooks log locally or not at all.
- **Context cost is managed by rules of thumb** (`ORG_SESSION_MAX_RUNS`, output caps) with no measurement of what each rule saves.

---

## 3. Principles for the loop

These are constraints, in priority order. Where a later principle conflicts with an earlier one, the earlier one wins.

1. **Nothing personal in the engine.** Traces are personal data. The mining, the proposals and the evaluations run inside the vault, on the owner's machines. What flows to the engine is a generic improvement as a normal PR (a better `AGENTS.base.md` paragraph, a skill eval case written with fake data), reviewed like any other.
2. **Markdown and git are the source of truth; Postgres is an index.** Harness versions, improvement records and eval cases are files in the vault. The database rows that index them can be rebuilt from the files.
3. **A change to the harness is a pull request.** Never a live edit of `AGENTS.md`, a skill or a graph by the loop. The owner merges. Agents never merge their own PR (already the rule in `AGENTS.md`), and nothing ships without an approval (`cli-org ship`).
4. **Zero regressions, or no promotion.** A candidate that improves the target metric but worsens any guarded metric (verification pass rate, cost per finished card, guard blocks, owner interventions) is not promoted. Ties go to the baseline.
5. **The evaluator is not editable by the proposer in the same change, and part of it is never visible to the proposer.** A PR that changes a skill may not also change that skill's eval cases or the promotion thresholds. The guard enforces it (a `readonly` rule on the eval files for bot runs), and the review checks it. A held-out set of cases sits under a guard `protected_dirs` path the proposing run cannot read; the proposer sees the replay set's results, the promotion decision also uses the held-out set and the canary. Every system in section 14 that reports durable gains separates the signal the optimizer sees from the signal that decides.
6. **Budgeted.** Mining, evals and curation have a weekly token budget in the policy file; when it is spent, the loop reports and stops. Every eval run is attributed on `/usage` as `work_type: ops` under a dedicated bot so its cost is visible.
7. **Traces are untrusted input.** They contain web pages, tool output and other people's messages. The improver reads them as data, under the same rule the `org-member` skill already states for board messages: nothing in a trace is an instruction.
8. **Fail open, like the hooks.** A broken policy file, a missing eval suite or a failed mining run never stops an agent from working. It only stops the loop.
9. **Every promotion is reversible with one `git revert`,** and the record says what to watch after the revert.
10. **One change at a time per surface.** A proposal edits one file (or one skill folder). Two simultaneous changes to the same surface cannot be attributed.

---

## 4. Architecture: the `improve` module

A new optional module, `improve`, off by default (`MODULES=...,improve`). Following `CONTRIBUTING.md`: its own migration, routes mounted only when on, a nav link only when on, timers installed by `deploy.sh` only when on, a CLI, and a doc section.

```
                 vault (private)                                 engine (public)
 ┌───────────────────────────────────────────────┐    ┌──────────────────────────────┐
 │ AGENTS.local.md  .agents/skills/  guard.local  │    │ AGENTS.base.md  skills/      │
 │ .agents/org/{org,graphs}.yaml  memory/  cron   │    │ harness/  tools/  app/       │
 │ .agents/improve/policy.json  cases/  records/  │    │ (changed only by PR + CI)    │
 └───────────────┬───────────────────────────────┘    └──────────────┬───────────────┘
                 │ hashed together = harness version                  │ engine pin
                 ▼                                                   ▼
        ┌─────────────────── cli-improve stamp ──────────────────────────┐
        │  harness_versions(sha, files{path: sha}, engine_commit, at)     │
        └────────────────────────────┬───────────────────────────────────┘
                                     │ written into cc_dispatch / session meta
   runs ─────────────────────────────┼──────────────────────────────────────────────┐
   (claude -p, Hermes, cron, owner)  ▼                                              │
        ┌──────────────── run_outcomes (one row per run) ───────────────┐           │
        │ harness_sha · card · graph/node · bot · skills_loaded ·       │           │
        │ verify · rounds · held · blocked · turns · tokens · guard     │           │
        │ blocks · gate nudges · owner interventions · error subtype    │           │
        └────────────────────────────┬──────────────────────────────────┘           │
                                     │ nightly                                      │
        ┌──────────── cli-improve mine  (weakness mining) ─────────────┐            │
        │ clusters by signature → weakness report (markdown) +         │            │
        │ one `improve` card per cluster, to the harness-engineer bot  │            │
        └────────────────────────────┬──────────────────────────────────┘           │
                                     │ a card wake                                  │
        ┌──────────── the harness-engineer bot (propose) ───────────────┐           │
        │ reads redacted traces (cli-improve trace) → hypothesis →      │           │
        │ one diff to one surface → improvement record → branch        │           │
        └────────────────────────────┬──────────────────────────────────┘           │
                                     │                                              │
        ┌──────────── cli-improve eval  (probe) ────────────────────────┐           │
        │ tier A static checks · tier B replay of recorded cases in a   │           │
        │ scratch vault + worktree · tier C behavioural contrast        │           │
        │ baseline vs candidate → eval_runs row + results in the record │           │
        └────────────────────────────┬──────────────────────────────────┘           │
                                     │ zero regressions                             │
        ┌──────────── PR + cli-org ship request  (compose / promote) ───┐           │
        │ owner merges → secondbrain-vault rules → new stamp → canary   │◀──────────┘
        │ window → auto `revert` card if guarded metrics regress        │
        └───────────────────────────────────────────────────────────────┘
                                     │ weekly
        ┌──────────── outer loop: cli-improve report ───────────────────┐
        │ proposals made / promoted / reverted, time-to-fix, escapes;   │
        │ proposes edits to policy.json through the same path           │
        └───────────────────────────────────────────────────────────────┘
```

### 4.1 Harness versions: the stamp

`cli-improve stamp` (also run by `secondbrain-vault rules` and by the dispatcher before each wake) hashes the set of files the policy names as surfaces and writes one row:

| Column | Holds |
|---|---|
| `sha` | sha256 over the sorted `(path, file sha)` pairs |
| `files` | `jsonb` of `{ "AGENTS.md": "…", ".agents/skills/ingest/SKILL.md": "…", ".agents/org/graphs.json": "…", ".agents/guard.local.json": "…", ".agents/improve/policy.json": "…", "cron:<profile>/<job_id>": "<prompt sha>" }` |
| `engine_commit` | The `.secondbrain` pin |
| `first_seen_at`, `last_seen_at` | |

Default surface list (overridable in `secondbrain.json → improve.surfaces`): `AGENTS.md`, `CLAUDE.md`, `.claude/settings.json`, `.agents/guard.local.json`, `.agents/skills/**/SKILL.md` (following symlinks into the engine), `.claude/agents/*.md`, `.agents/org/org.json`, `.agents/org/graphs.json`, `.agents/org/memory/*.md`, `.agents/improve/policy.json`, and each Hermes cron job's prompt as read from `cron_jobs`.

The stamp travels with the run three ways, so every harness gets it:

- The dispatcher adds `harness_sha` to its `cc_dispatch` line; `usage/runLog.ts` already parses that line and would gain one field.
- For sessions without a dispatcher (the owner's interactive Claude Code, Hermes chats), the archive run looks up the stamp whose `first_seen_at ≤ session start < next first_seen_at` on that host. A `SessionStart` hook that writes the sha into the transcript as a `meta` line is more exact and is proposed for Claude Code (`harness/claude/settings.json` gains a `SessionStart` entry calling `cli-improve stamp --print`).
- With the capture proxy on, `llm_exchanges.system_sha` identifies the exact system prompt, which is finer than the file hash and catches drift the files do not show (a Claude Code update changing its own preamble).

### 4.2 Run outcomes: one row per run, every label in one place

`run_outcomes` is a materialised join, rebuilt by `cli-improve outcomes` (idempotent, runs after `usage-sync` and `agents-sync`). One row per run (a `usage_runs` row, a Hermes session, or a cron execution):

| Group | Columns | Source |
|---|---|---|
| Identity | `run_id`, `harness_sha`, `host`, `harness` (`claude-code`, `hermes`), `bot`, `team`, `work_type`, `started_at`, `ended_at` | `usage_runs`, `archive_sessions`, stamp |
| Task | `card`, `graph`, `node`, `kind`, `project`, `feature`, `wake_reason`, `cron_job` | `task_links`, `org_wakeups`, `cron_runs` |
| Context | `skills_loaded text[]`, `rules_sha`, `resumed`, `session_runs` | Transcript (`Skill` tool uses and skill file reads), stamp, `cc_dispatch` |
| Cost | `turns`, `input_tokens`, `cache_read`, `cache_write`, `output_tokens`, `duration_ms`, `tool_calls`, `tool_errors` | `usage_calls`, `archive_messages` steps |
| Outcome | `finished` (card completed in this run), `verify_passed`, `verify_name`, `rounds_after` (review rounds the card needed later), `held`, `blocked_reason`, `error_subtype`, `is_error`, `status_posted` (did the bot post a status, or did `wake-done` post the fallback) | `usage_runs`, `task_links.rounds`, `org_messages` |
| Hooks | `guard_blocks int`, `guard_reasons text[]`, `gate_nudged bool` | A new `agent-hooks.jsonl` the hooks append to under the vault's `.agents/improve/log/` (replacing the `~/.cache` log), synced like usage |
| Owner | `questions_asked`, `redo_requested`, `ship_denied`, `owner_rating` | `org_messages` kinds, `org_approvals`, a new `ratings` table (section 7) |

The guard and gate changes are small: today `guard.py` writes to `~/.cache/agent-guard.log`; the proposal is one more line into the vault's `.agents/improve/log/hooks-YYYY-MM-DD.jsonl` with the run id from `ORG_RUN` when set. Both hooks stay stdlib-only and fail open.

### 4.3 Weakness mining

`cli-improve mine [--since 7d]` runs nightly. It computes, per harness version and per surface, the metrics in section 6 and looks for clusters:

| Signature | Example | Points at |
|---|---|---|
| `error_subtype` × `kind` | 6 of 9 `review` cards this week ended `error_max_turns` | The review node body or the reviewer's turn budget |
| `held` × `graph.node` | `feature-build.test` held 4 times | The node's instructions, or the node needs splitting |
| `guard_reason` × `bot` | One bot hit the secrets rule 11 times | A skill that tells it to `grep .env`, or a rule it never read |
| `tool_errors` × `tool` × `skills_loaded` | `cli-projects set` failed in 70 % of runs that loaded `company-report` | The skill's command table is stale |
| `rounds_after` × `assignee` | Cards built by one bot need 1.8 rounds on average, others 0.4 | The bot's memory file or its role text |
| `tokens / finished` × `cron_job` | One cron job costs 40 % of the week's tokens and its outputs are never rated up | The cron prompt, or the job's schedule |
| `verify_passed = false` × `verify_name` | The same check fails after every deploy card | The deploy skill or the check itself |
| `status_posted = false` | Runs that end without a report | The wake prompt's closing instruction |

Each cluster above a threshold (policy: `minRuns`, `minLift`) becomes:

1. A section in `.agents/improve/reports/YYYY-MM-DD.md` (markdown, in the house research style, so it reads like any other note and is searchable).
2. One kanban card, kind `improve`, assigned to the harness-engineer bot (a role in the vault's `org.yaml`; the engine only requires the `review` capability and a `dispatch`-free team), with the card body generated from a template that carries the contract (section 5.3): the cluster, the runs, the surface suspected, the metric to move, the budget.

Mining is deterministic SQL over `run_outcomes`, no model call. That keeps it cheap, reproducible and immune to the traces' content.

### 4.4 Propose: the harness-engineer bot

The bot works an `improve` card like any other card, under the `org-member` skill plus a new `improve` skill. The procedure:

1. `cli-improve trace <run_id> [--steps tool_call,tool_result] [--max-chars 20000]`: a redacted, compacted view of the run (the redactor in `archive/redact.ts` already exists), so the bot does not read raw transcripts. Then `cli-improve records --surface <path>`: every earlier record for the surface, promoted or not. The records folder is the loop's experience library; a hypothesis already tried and not promoted is not tried again without new evidence.
2. Form one hypothesis naming one surface and one mechanism ("the `company-report` skill's `verify` row omits `--kind`, so the bot retries the command three times").
3. Make the change in a worktree, never in the live file (the `readonly` guard rule for bot runs covers `AGENTS.md`, `.agents/skills/`, `.agents/org/`, `.agents/improve/cases/` and `.agents/improve/policy.json`; the worktree path is exempt).
4. Write `.agents/improve/records/YYYY-MM-DD_<slug>.md`: the record (section 8).
5. Run `cli-improve eval --record <path>` (section 4.5). Attach the results to the record.
6. If tiers A and B pass with zero regressions: push the branch, open the PR, `cli-org ship request <card> "<summary>" --pr <url>`, post a status, complete the card. Otherwise: record the negative result (negative results are the cheapest thing the loop produces and prevent re-proposing), block the card with the reason, and stop.

Budget per card: `policy.proposeBudget` (default 150 000 tokens, 30 turns). The dispatcher enforces it as it enforces any card budget (section 5.3).

For generic findings (a fix to `AGENTS.base.md` or a shared skill), the bot writes the same record and opens the PR against the engine from a worktree of `.secondbrain`, as `AGENTS.md` already instructs, with fake data in any new eval case and `scripts/check-public.sh` run first.

### 4.5 Probe: `cli-improve eval`

Three tiers, cheapest first, each a gate for the next.

**Tier A: static checks** (seconds, no model):

| Check | On |
|---|---|
| `secondbrain-vault rules --check` compiles; `AGENTS.md` under the policy's size cap (tokens, counted with the same tokenizer the ledger uses) | Rules |
| Frontmatter has `name` and `description`; description under 1 024 characters; every command the skill names resolves on `PATH` or in the engine; every `[[wikilink]]` or path it names exists; no personal values (the leak check) | Skills |
| `graphs.json` validates: known assignees or `role:` specs, acyclic `after`, every node's `kind` has a capability the assignee holds (`nodeNeed` in `org.ts`) | Graphs |
| `guard.local.json` parses; `python3 -m pytest harness` passes against the candidate rules; the readonly rules still cover the eval files | Guard |
| Prompt under the job's token cap; delivery target set | Cron |
| `policy.json` validates against its schema; thresholds within allowed ranges | The improver itself |

**Tier B: replay of recorded cases** (minutes to an hour, budgeted):

A case is a recorded task with a check. Cases come from history, which is the point of having the ledger:

- A card whose run produced a `verify_passed` row, with the card body, the project state before the run (a git commit of the vault or the repo) and the verification command.
- A cron job output the owner rated up, with its prompt and the inputs available at that time.
- A fact-check table with at least one `incorrect` row: the output and its sources.
- A hand-written case in `.agents/improve/cases/<slug>/` (`case.json`: setup, prompt, check, budget; fake data only if it ever goes to the engine).

Cases are split into a **replay set** the proposer may read and a **held-out set** under `.agents/improve/cases-heldout/`, which the policy lists in `guard.local.json` `protected_dirs` for bot runs (the guard blocks any command or file tool naming the path). Held-out cases are drawn from the same history by `mine`, rotated monthly, and their results are shown to the proposer only after the promotion decision.

`cli-improve eval` makes a scratch vault (`secondbrain-vault init` into a temp dir, the case's fixture files copied in, the candidate harness files overlaid), runs the case under baseline and candidate with the same model and the same budget, and records both trajectories as `eval_runs` rows that `/usage` shows like any other run (host `eval`, bot `harness-engineer`). The suite is `policy.replay.cases` (default: the 20 most recent passing cases plus every case tagged `regression`), capped by `policy.replay.budgetTokens`.

Runs are not deterministic, so each case runs `policy.replay.repeats` times (default 2) and the comparison uses pass counts, not single runs.

**Tier C: behavioural contrast** (no ground truth needed):

For every case, baseline and candidate trajectories are diffed on the metrics in section 6: tool calls, tool errors, turns, tokens, guard blocks, whether a status was posted, whether the artifact named in the contract exists. For open-ended outputs (a research note, a stand-up) a pairwise judge is used with a rubric file (`.agents/improve/rubrics/<kind>.md`) and position swapping; its preference is reported, never used alone to promote.

**Promotion rule** (policy, defaults):

- Tier A: all pass.
- Tier B: candidate pass count ≥ baseline on every replay case and every held-out case; strictly greater on at least one, or equal with cost (tokens per pass) down by ≥ 10 %.
- Tier C: no guarded metric worse by more than the noise band (policy `noiseBand`, default 5 % relative, estimated from baseline-vs-baseline repeats).
- Total eval cost within the card's budget.

Anything else is "not promoted", recorded with the numbers.

### 4.6 Compose and promote

1. The PR merges (owner). For the vault: `secondbrain-vault rules`, `cli-improve stamp` runs, a new harness version exists.
2. `cli-improve promote <record>` writes the `improvements` row (section 8) with `promoted_at` and the sha pair, and opens a **canary window** (`policy.canaryDays`, default 7).
3. During the window, `mine` compares the guarded metrics of the new sha against the previous sha on live runs. If any guarded metric regresses beyond the noise band with at least `policy.minRuns` runs, it creates a `revert` card (kind `improve`, priority high) with the exact `git revert` and the numbers. A person decides; the loop never reverts on its own.
4. After the window the record is marked `confirmed` or `regressed`.

### 4.7 The outer loop

`cli-improve report` runs weekly and writes `.agents/improve/reports/weekly-YYYY-Www.md`:

| Metric of the improver | Why |
|---|---|
| Proposals made, evaluated, promoted, confirmed, reverted | Yield |
| Median time from first cluster to promotion | Speed |
| Regressions that the canary caught but the eval did not ("escapes") | The eval suite is too thin where escapes happen |
| Eval tokens per promotion | Cost |
| Clusters re-proposed after a negative result | The mining signature is too coarse |

When yield is low or escapes are high, the report ends with a proposal to `policy.json`: a new signature, a tightened threshold, a case added to the regression set, a bigger `repeats`. That proposal goes through exactly the same propose → eval → PR path, and its eval is Tier A plus a dry run of `mine` on the last four weeks showing what the new policy would have flagged. This is the bounded recursion: the improver edits how it improves, through the same gate.

---

## 5. Each surface, in detail

### 5.1 The org config files: roster and graphs

**Today:** `org.yaml` and `graphs/*.yaml` are compiled by a script in the vault into `org.json` and `graphs.json`; the engine imports one and reads the other.

**Proposal:**

- Move the compiler into the engine: `secondbrain-vault org compile` (Python, stdlib, in `tools/sbvault.py`), with a schema the engine owns and tests (`tools/test_sbvault.py`). The template ships an example `org.yaml` and one graph with fake names. The roster and graphs become engine-validated surfaces: `graph apply --dry-run` already plans a graph; the compiler adds `--check`.
- Add contract fields to a graph node, all optional with defaults from the template:

```yaml
nodes:
  - id: build
    assign: role:engineer
    kind: build
    title: "Build {feature}"
    objective: "Implement the feature as designed in {design_doc}."
    returns: ["a PR URL", "the test command and its output"]
    budget: { turns: 40, tokens: 400000 }
    after: []
  - id: verify
    assign: role:qa
    kind: review
    returns: ["a verification recorded with cli-projects verify"]
    budget: { turns: 15, tokens: 120000 }
    after: [build]
```

  `applyGraph` fills them into the card body under fixed headings so the dispatcher and the reviewer can parse them.
- **What the loop may propose** on a graph: add a node (a verifier before review, a "read the design doc" node before build), remove a node whose cards never change the outcome (same pass rate without it, fewer tokens), reassign a node (`role:qa` instead of `lead`), change an edge, change a budget. Each is one diff to one yaml file.
- **How it is evaluated:** graph-level metrics from `run_outcomes` joined on `task_links.graph`: features finished per graph application, total tokens per finished feature, rounds, held nodes, wall time from first card to last. Tier B replays a whole graph on a recorded feature in the scratch vault only when the budget allows (it is the most expensive case type); Tier A plus live canary is the usual path for graph edits.
- **Roster proposals** are restricted to text and capability fields (`role`, `expertise`, `capabilities`, `reports_to`), never to adding `merge` or `deploy` to a bot; those two stay owner-only by policy and the eval refuses the diff.

### 5.2 The skills layer

**Today:** five shared skills and whatever the vault adds, none with a test. A skill's quality is only visible when someone notices an agent misusing it.

**Proposal:**

- Every skill folder may have `evals/`: `cases.jsonl` (one case per line: a prompt or card body, fixture paths, the check, optional `expect_trigger: true|false`) and `rubric.md` for open-ended outputs. The template shows one case per shared skill, with fake data. The engine's CI runs Tier A on `skills/` (frontmatter, commands resolve, no leaks); Tier B runs only in vaults, because it costs model calls.
- Two eval kinds, as the skill-creator practice distinguishes: **trigger accuracy** (given 20 prompts, does the agent load this skill on the ones that should and not on the ones that should not: the description is the surface) and **task quality** (given the skill, does the agent finish the case within budget with the check passing).
- Skill versions: a `version:` field in frontmatter is not needed; the file sha in the harness version is the version. The record names the sha pair.
- **What the loop may propose:** a tighter description (trigger failures), a corrected command table (tool errors), an added "when this fails, do X" paragraph (a recovery that worked in three traces), a split of a long skill into two, removal of a paragraph nobody's trajectory ever used (dead instruction text is paid for on every turn). Deletions are proposals too and need the same zero-regression eval.
- **Skill compilation** (section 7.4): when mining finds the same multi-step recovery in several successful traces that no skill describes, it files an `improve` card whose expected output is a new private skill with an eval case, not an edit.
- **Private over shared:** a vault's `.agents/skills/<name>/` already wins over the engine's symlink. A proposal that improves a shared skill lands first as a private override in the vault (fast, personal data allowed), and only becomes an engine PR once it has run a canary window and been rewritten with fake data.

### 5.3 The kanban board

**Today:** the kanban is the `board` module in the engine — migration, `board_*` SECURITY DEFINER functions, three auth doors, `cli-board`, the page, a Hermes importer and projection, and zen-agent's `board` backend and `lane` loop (built; see [board-design.md](board-design.md) for the full design and the staged rollout in its section 8). Stage 0 (mirror, read-only) is what's running: the engine's cards mirror Hermes's own kanban while the Hermes dispatcher still claims and runs cards in its own SQLite. Cards still carry prose bodies — the contract fields below are not yet filled in by `task create` — and the dispatcher still wakes a bot with a prompt that says "follow the org-member skill".

**Proposal (on top of the built board module):**

- **A card contract**, written into the body under fixed headings by `cli-org task create`, `graph apply` and `redo`, parsed by the dispatcher and by `cli-improve`:

```
## Objective
One paragraph: what done means.
## Returns
- a path, a PR URL, a verification, a message id
## Budget
turns: 30 · tokens: 300000 · wakes: 3
## Scope
Folders, repos, tools in scope. Everything else is out.
## Verification
The command or check and its expected result.
```

  This is the `AGENTS.base.md` completion contract (Outcome, Verification, Constraints, Boundaries, Stop when) made machine-readable. The dispatcher passes `--max-turns` from the budget and stops the run at the token cap; `wake-done` records whether the returns exist. A card without a contract gets the policy's defaults and is flagged in the weekly report.
- **Card kinds** gain `improve` and `revert`. The board shows them in their own swimlane on `/agents` so the owner sees the loop's work apart from the company's.
- **Outcome labels on the card**: `task_links` gains `finished_at`, `wakes`, `tokens`, `result` (`done`, `blocked`, `held`, `escalated`), filled by `wake-done`. These are the per-card labels `run_outcomes` aggregates.
- **Held and blocked reasons become structured**: `block <id> "<why>"` keeps the free text but the dispatcher's `held:` status and the review `redo` carry a reason code (`budget`, `missing-input`, `tool-error`, `needs-owner`, `review-changes`) that mining can cluster.
- **What the loop may propose about the board**: default budgets per kind, the wake prompt text (once the dispatcher's prompt is a file the stamp covers), the review-round limit, the backoff settings. All become `policy.json` or env values with a record, not magic numbers.
- **The board module's own rollout is the remaining work, not an open question.** [board-design.md](board-design.md) section 8 stages it: stage 0 (mirror, read-only, done) → stage 1 (engine writes, Hermes still runs) → stage 2 (record authoritative; `task_links` becomes a view) → stage 3 (runtime optional: `zen-agent` lanes carry real work, the hub's board routes and the old `task_links` table are deleted). The `cards` table, the functions and RLS already exist; what's left is pointing `cli-org task create`, `graph apply` and the dispatchers at it instead of at Hermes, and judging stage 3 by this proposal's metrics (10.4).

### 5.4 The project and org structure

**Today:** PARA folders; the `projects` module with stages and verifications; dev logs per project with a Resume block; the org with teams, leads and channels; the fund, social and other modules as consumers.

**Proposal:**

- **Verifications are the ground truth of the loop.** `cli-projects verify` rows are the clearest outcome label the system has. The proposal adds `run_id` to a verification (the dispatcher sets `ORG_RUN`; `cli-projects` reads it) so a passing check is attributable to the run and the harness version that produced it. No schema change to the vault.
- **Dev logs stay the human trace.** The loop writes its own records in the same shape (section 8) and the `devlog_gate` continues to require one for any change to `.agents/`. Improvement records satisfy the gate because they live under a dev-log root (`.agents/improve/records/` is added to the default roots).
- **The Resume block is the inter-session memory contract**, and mining checks it: a project whose Resume block has not changed in 30 days while cards for it finished is a signal that bots skip the handoff. That becomes a cluster ("Resume block stale") pointing at the `org-member` skill's step 5 or the dev-log gate.
- **Division and team metrics**: per team, tokens per finished card, rounds, held rate and owner questions per week, shown on `/org` next to the stand-ups. Leads see their own numbers in the daily routine (`org-member` step 10 gains "read `cli-improve team-report`"), which is the macro level of the macro/micro split: a lead's delegation choices are judged on team outcomes, a member's execution on card outcomes.
- **Owner interventions as a first-class metric.** Questions for the owner, `redo`, `ship deny`, and the new ratings are the cost the owner pays; the loop's job is to reduce them without reducing verifications.

### 5.5 Cron jobs

**Today:** Hermes cron jobs with prompts, synced into `cron_jobs`, runs and outputs shown on `/cron`; server timers for modules; nothing grades an output.

**Proposal:**

- **Prompts become stamped surfaces.** `cron_jobs.prompt` is hashed into the harness version (one entry per job), so an output is attributable to a prompt version.
- **Rate an output.** A `ratings` table (`kind`, `ref`, `rating` ∈ {up, down, skip}, `note`, `by`, `at`) with two write paths: a button on `/cron` and `/org`, and a Telegram reply the notifier already supports for ship approvals ("rate <job> up|down <note>"). The owner's thumbs are the only cheap label a daily briefing can have.
- **Cron hygiene mining**: tokens per job per week against rating rate; jobs whose outputs are never opened (the `/cron` page can record a view) or always `skip`; jobs whose prompt duplicates another's; jobs that fail on schedule. Proposals: rewrite the prompt, merge two jobs, retire a job, reschedule to when its inputs exist. Retiring is a proposal with a canary (the owner can rate the absence).
- **Fact-check as a cron grader.** For cron jobs that produce claims (a briefing, a report), the `fact-check` skill's table is stored (`fact_checks` table: output ref, claims, verified, incorrect, unresolved) and its incorrect rate is a guarded metric for that job's prompt.
- **Claude-side routines**: the `org` module already has `routine` wakeups. The proposal gives them a file in the vault (`.agents/org/routines.yaml`: name, schedule, bot, prompt, budget) compiled with the roster, so Claude Code routines are versioned and graded exactly like Hermes cron. Today they live wherever the dispatcher keeps them.
- **The engine's own timers** (`map-build`, `metrics`, `usage-sync`, …) are not model-driven and stay out of the loop, but `/cron` shows their last status already and mining counts a failing timer as an ops cluster.

### 5.6 The engine code

The engine is the one surface with a complete evaluation already: the Vitest suite against a real Postgres, the Python suite, the build, the leak check, CI on every PR. The loop does not need to invent anything here; it needs to use it.

- Engine proposals from the loop are ordinary PRs: branch, tests first, `check-public.sh`, the PR body saying what ran. The harness-engineer bot has the `code` capability for the engine repo only when the owner gives it (`--repo`), as `botRepos()` already enforces.
- Two additions make the engine a better subject of the loop: a `test:skills` CI step running Tier A over `skills/` and `vault-template/`, and a `harness/evals/` folder with the guard's and gate's own replay cases (payloads that must block, payloads that must pass) so the hooks' behaviour on real-world call shapes is a regression suite, not only unit tests.
- Engine changes are promoted by the merge; the canary is each vault moving its pin, which already happens by hand. The weekly report lists engine PRs by the loop and their state.

---

## 6. Evaluation design

### 6.1 Metrics

| Metric | Definition | Role | Direction |
|---|---|---|---|
| Verification pass rate | Finished cards whose feature has a passing verification recorded by the run, over finished cards | Target | ↑ |
| First-wake finish rate | Cards finished in one wake, over cards started | Target | ↑ |
| Rounds per reviewed card | `task_links.rounds` at completion | Target | ↓ |
| Held rate | Cards that hit the wake cap, over cards started | Guarded | ↓ |
| Tokens per finished card | Sum of all runs' tokens for the card, over finished cards; cache reads weighted at their price ratio | Guarded | ↓ |
| Turns per run | | Guarded | ↓ |
| Tool error rate | `tool_result` steps marked error, over tool calls | Guarded | ↓ |
| Guard blocks per run | | Guarded | ↓ |
| Status posted rate | Runs that posted a `status` with their run id, over runs | Guarded | ↑ |
| Owner interventions per week | Questions for the owner + redo + ship denies + down ratings | Guarded | ↓ |
| Fact-check incorrect rate | Incorrect claims over checked claims, per output kind | Guarded | ↓ |
| Memory hit rate | Runs where a recalled fact or memory line appears in the trajectory, over runs that called `recall` | Diagnostic | ↑ |
| Repeated-mistake rate | Clusters re-appearing after a promoted fix for them | Diagnostic (outer loop) | ↓ |
| Improver yield, escapes, eval cost per promotion | Section 4.7 | Outer loop | |

A "target" metric is the one a proposal says it will move. "Guarded" metrics may not get worse. Every metric is computed per harness version and per surface-of-interest (bot, graph node, skill, cron job).

### 6.2 Why behavioural contrast, and its limits

Ground truth is scarce: most of what the agents produce (a note, a stand-up, a design) has no answer key. What we can always do is run the same recorded task under two harnesses and compare the trajectories. Fewer tool errors, fewer turns, the contract's artifact present, the verification passing: these are observable without a judge. The literature's "behavioural contrast" is this.

Limits, and what the design does about them:

| Limit | Mitigation |
|---|---|
| Runs are stochastic | Repeats per case; compare pass counts and medians; estimate the noise band from baseline-vs-baseline |
| Small samples | `minRuns` before any cluster or canary verdict; the weekly report shows confidence as a range, not a point; the loop prefers a longer canary to a bigger eval |
| Recorded cases drift from reality (the repo moved on, the API changed) | Cases carry a fixture commit; a case that fails under baseline is marked `stale` and dropped from the gate, listed in the report |
| Teaching to the test | The replay set is the recent 20 plus tagged regressions, rotating; the held-out set is unreadable to the proposer; the canary on live runs is the real test |
| The judge's bias | Pairwise, position-swapped, rubric-driven, reported but never sufficient for promotion |
| The proposer games the eval | Principle 5: eval files are read-only to the proposing run; a PR touching both a surface and its eval is refused by the policy check |
| Cost | A weekly budget; Tier A before B before C; graph replays only when budget allows |

### 6.3 What a regression is

A guarded metric worse than baseline by more than the noise band, on the replay set or in the canary window, with at least `minRuns` runs. A single bad run is never a regression. A new guard block pattern that did not exist before is a regression regardless of count, because it means the change made an agent try something the rules forbid.

### 6.4 Evaluating the improver

The outer loop's own metrics (section 4.7) are the evaluation of `policy.json`. A policy change is promoted when a dry run over the last four weeks would have produced at least as many later-confirmed proposals and no more escapes. Since this is backtesting, the canary window for a policy change is longer (default 21 days).

---

## 7. Memory

Memory is where the loop's gains accumulate between runs, so it deserves its own design. Today there are five memories with no relationship: the fact table, the per-bot files, the archive, the skills and the Resume blocks.

### 7.1 Layers and their contract

| Layer | Holds | Written by | Read by | Lifetime |
|---|---|---|---|---|
| **Episodic**: the archive and ledger | What happened, verbatim | Collectors | `cli-improve trace`, the `/usage` session view, mining | Forever (it is the index of the transcripts) |
| **Semantic**: `memory_facts` | Sourced claims, confirmed or inferred, superseded when wrong | Any agent, `cli-org remember` | `cli-org recall` | Until retired |
| **Procedural**: skills | How to do a kind of task | PR | Agents, by trigger | Until replaced |
| **Working**: the bot's playbook `.agents/org/memory/<bot>.md` | Lessons for this role, short | The bot (reflection), the curator | `recall`, and read in full at wake | Curated |
| **Persona** (built, [agent-memory.md](agent-memory.md)): `org_agent_episodes`, `org_agent_memory`, the generated `.agents/org/memory/<bot>/core.md` | One row per finished wake; first-person lessons with counts; the active rows under a budget | `cli-org wake-done` (mechanical) and its reflect step (one cheap-model call); the owner or a lead corrects a line | The wake prompt (core block), `recall`, `/org/agents/<name>` | Closed, never deleted |
| **Handoff**: the Resume block | Where a project stands | The agent finishing a session | The next agent | Overwritten each session |

The rule that connects them: **a lesson moves up when it recurs**. A recovery seen in three episodes becomes a playbook bullet; a bullet marked helpful ten times with no harmful mark becomes a proposal for a skill paragraph or an `AGENTS.local.md` rule; a fact cited by several runs is promoted to a confirmed fact with the runs as sources. Each promotion is a proposal with a record, not an automatic write.

### 7.2 Playbooks instead of flat memory files

The flat memory file has a known failure: an agent rewriting it wholesale compresses away detail and loses lessons (the literature calls this context collapse). The proposal gives `memory/<bot>.md` a fixed structure of **itemised bullets with ids and counters**, and only ever appends or edits one bullet at a time:

```markdown
# atlas: playbook

## Delegation
- [m-014 · +7 −0 · 2026-10-02] A review card needs the PR URL in its body, or the reviewer spends its first ten turns finding it. Source: t_3f9a, t_41c0.

## Tools
- [m-021 · +3 −1 · 2026-10-15] `cli-projects verify` wants `--kind test|deploy|manual`; without it the command fails and the bot retries. Source: run org-atlas-20261015-061200.
```

`+7 −0` are helpful and harmful marks: the bot adds `+1` when a bullet it read changed what it did and the card finished; the curator adds `−1` when a bullet was read in a run that failed in the way the bullet addresses. `cli-org recall` ranks bullets by score and recency; bullets at `−3` or 90 days unused are proposed for retirement in the weekly report. The structure is enforced by Tier A (a bullet without id, counters and source fails the check), and an edit that removes more than one bullet is refused for a bot run.

### 7.3 Facts that are measured

`memory_facts` gains `recalled_count`, `last_recalled_at`, and `cited_in_runs text[]` (filled when a run's trajectory quotes the fact's claim or id). A `fact_checks` table stores the `fact-check` skill's tables, and a fact contradicted by a fact-check is flagged for `forget` with the check as source. The curator's weekly pass: merge duplicates (same subject, same claim modulo whitespace), propose supersession for conflicting facts (both shown to the owner), and promote facts cited in five or more runs to the playbook of the bots that cited them.

Recall itself gets two improvements the engine can ship today: the fact table gets an embedding column (the vault's embeddings provider already exists) so `recall` is hybrid like `/search`, and `recall` gains `--sources facts,memory,vault,devlog,records` so improvement records and dev logs are searchable by the bots.

### 7.4 Skill compilation

Mining has one signature for success too: a sequence of tool calls (normalised: tool name, command head, argument shape) that appears in ≥ 3 finished runs across ≥ 2 bots, is ≥ 4 steps long, and matches no existing skill's command table. That is a procedure nobody wrote down. The `improve` card for it asks the harness-engineer bot to write the skill (name, description with trigger phrases, the steps, the failure modes seen in the traces, one eval case) as a private skill in the vault. If the skill then shows a Tier B improvement on cases that previously lacked it, it is promoted; after a canary it may be proposed to the engine with fake data.

### 7.5 Compaction as a measured surface

For headless runs, what enters the context is the biggest cost lever (`AGENTS.base.md`'s "Context budget" section exists because of it). Today the levers are `ORG_SESSION_MAX_RUNS` and output caps. The proposal makes the wake prompt assembly explicit and measurable: the dispatcher (or the runtime in section 10) builds the wake context from named parts (`rules`, `card`, `playbook`, `recall(card title)`, `thread`, `resume block`), logs the token count of each part in `cc_dispatch`, and the policy sets each part's cap. Mining then answers "did runs with the playbook part finish more often" with real numbers, and a proposal can be "drop the thread part for `review` cards, it never changes the outcome".

---

## 8. Tracing the changes: the improvement record

Every proposal, promoted or not, is one markdown file and one row.

**The file** `.agents/improve/records/YYYY-MM-DD_<slug>.md`:

```markdown
# Record: company-report verify row omits --kind
### Surface: .agents/skills/company-report/SKILL.md

**Opened:** 2026-10-22 · **Card:** t_8b2e · **By:** harness-engineer (claude-code@server)
**Cluster:** tool_errors × cli-projects × company-report, 9 runs, 2026-10-15 to 2026-10-21
**Hypothesis:** The skill's table shows `verify --pass --kind test ...` once but the "At the end of a build session" list omits `--kind`; bots copy the list. Expected: tool error rate on `cli-projects verify` from 70 % to under 10 %, turns per build card −2.
**Change:** one line added to step 2 of "At the end of a build session". Diff: <PR url>
**Harness:** 3f1c…(baseline) → 9a07…(candidate)

## Evaluation
| Tier | Result |
|---|---|
| A | pass |
| B | 6 cases × 2 repeats: baseline 9/12 pass, candidate 12/12; tokens per pass −18 % |
| C | tool errors 14 → 1; turns median 22 → 19; guard blocks 0 → 0; status posted 12/12 both |

## Decision
Promoted 2026-10-23 (merge <PR url>). Canary to 2026-10-30.

## Canary
2026-10-30: 31 live runs. Tool error rate 4 %. Confirmed.

## Watch after revert
If reverted: expect `cli-projects verify` errors to return within a week on build cards.
```

Records are also the library the proposer reads before proposing (section 4.4), which is the role the Harness² paper gives its per-harness experience notes: a situation, the lesson, the evidence. A record with `state: not-promoted` is as valuable as a promoted one.

**The row** in `improvements`: `id`, `record_path`, `surface`, `surface_path`, `cluster_signature`, `baseline_sha`, `candidate_sha`, `pr_url`, `card`, `state` (`proposed`, `not-promoted`, `promoted`, `confirmed`, `regressed`, `reverted`), `eval jsonb`, `opened_at`, `promoted_at`, `closed_at`. The row is an index of the file; `cli-improve outcomes` rebuilds it from the files.

**The page** `/improve` (module on): the list of records by state; one record with its before/after metrics drawn from `run_outcomes`; the harness version timeline (each sha, which files changed, which records); the weekly report. Everything read-only; the writes happen through git and the CLI, as everywhere else in the app.

**Dev logs**: a promotion also appends one line to the project's dev-log README Resume block ("Decisions: skill X changed per record Y") when the record names a project. The gate is satisfied by the record itself.

---

## 9. Settings and files this adds

All optional, all with defaults that work for a stranger, per `CONTRIBUTING.md`.

| Where | Name | Default | Purpose |
|---|---|---|---|
| env | `MODULES` gains `improve` | off | Mounts `/api/improve`, the `/improve` page, installs the two timers |
| env | `IMPROVE_WEEKLY_BUDGET_TOKENS` | `2000000` | Hard cap on mining, eval and curation tokens per ISO week |
| env | `IMPROVE_CANARY_DAYS` | `7` | Canary window after a promotion |
| env | `IMPROVE_MIN_RUNS` | `20` | Runs before a cluster or canary verdict counts |
| `secondbrain.json` | `improve.surfaces` | the list in 4.1 | Files hashed into the harness version |
| `secondbrain.json` | `improve.bot` | `harness-engineer` | The roster name that gets `improve` cards |
| `secondbrain.json` | `improve.exclude` | `["CURRENT/", "Areas/Finance/"]` (same as recall) | Vault paths `cli-improve trace` never shows |
| vault | `.agents/improve/policy.json` | shipped by the template | Signatures and thresholds, replay set, repeats, noise band, budgets, canary days |
| vault | `.agents/improve/cases/`, `rubrics/`, `records/`, `reports/`, `log/` | empty | Cases, judge rubrics, records, reports, the hooks' log |
| vault | `.agents/org/routines.yaml` | example | Claude-side routines (5.5) |
| engine | `skills/*/evals/` | one case each | Tier A in CI |
| engine | `harness/evals/` | the hooks' replay payloads | Tier A in CI |
| timers | `secondbrain-improve-mine.timer` (daily 04:30 UTC), `secondbrain-improve-report.timer` (weekly, Monday 05:30 UTC) | installed with the module | |
| CLI | `cli-improve stamp | outcomes | mine | trace | eval | record | promote | report | team-report` | | |
| migration | `harness_versions`, `run_outcomes`, `improvements`, `eval_runs`, `ratings`, `fact_checks`; columns on `task_links`, `memory_facts`, `verifications` | | Forward-only, as always |

Guard additions (built-in, every vault, because nobody wants the alternative): a bot run (`ORG_RUN` set) may not write to `.agents/improve/policy.json`, `.agents/improve/cases/`, or any `evals/` folder. Owner sessions are unaffected.

---

## 10. A harness of our own?

The owner asked whether a runtime of our own, with a minimal agent core such as the pi packages (the repo formerly known as pi-mono) at its centre, would cut bloat and complexity. The honest answer is: for one of the three ways agents run here, probably yes; for the other two, no.

### 10.1 Three ways agents run today

| Mode | Runtime | Who drives | What hurts |
|---|---|---|---|
| Interactive | Claude Code in the vault | The owner | Little. The hooks, skills and subagents work; the ledger records it |
| Headless bot wakes | `claude -p` under the dispatcher, resumed up to `ORG_SESSION_MAX_RUNS` times | The board | Every turn re-sends the whole conversation; the system prompt and tool list are Claude Code's, not ours; compaction is opaque; the trace needs a proxy to be complete; the dispatcher, the wake prompt and the budget live outside the engine |
| Cron and chat | Hermes | The clock, Telegram | Hermes owns its loop; the engine syncs its outputs |

The headless mode is where the loop's levers (context assembly, budgets, tool contracts, traces) are weakest, and it is also the mode with the highest token bill. It is the right place for a pilot.

### 10.2 What a minimal runtime would give the loop

- **Context assembly as code.** The wake context is built from named parts with caps (section 7.5), so every part is a measured surface and compaction is a policy, not a surprise.
- **In-process hooks.** The guard and the dev-log gate run as functions on `tool_call` and `session_end` events instead of subprocesses parsing JSON, with the same rule files; the Python hooks stay for Claude Code and Hermes, and share the test payloads in `harness/evals/`.
- **Traces for free.** A session file per run, with every message and tool call, in a format the archive collector reads directly; no capture proxy needed for the system prompt.
- **Tools as contracts.** `cli-org`, `cli-projects`, `cli-improve` become typed tools with schemas the eval can lint and the model sees exactly, instead of shell commands described in a skill.
- **Budgets enforced where they are counted.** Turn and token caps from the card contract stop the loop in the runtime.
- **Subagents with contracts.** A reviewer or a verifier spawned with an objective, a return schema and a budget, which is the contract-based interface the research describes and which today exists only as a card body.
- **Provider freedom.** Headless work can use whichever model the policy names, and the eval can run a case under two models as easily as under two prompts.

### 10.3 What it would cost

- A new thing to maintain, in TypeScript, in the engine (`app/server/src/agent/` or a sibling package), with tests, against providers that change.
- Feature loss against Claude Code: its tool set, its subagent and skill loading, its permission model, its session resume and compaction, its first-party support for the Claude subscription. Some of this the runtime must re-implement; some it must do without.
- Two harnesses to keep in parity for the shared rules and hooks (three, counting Hermes). The stamp and the shared eval payloads are what make parity testable.
- Risk that the pilot becomes the project. The phase plan bounds it: the pilot is judged by the same metrics as any other proposal.

### 10.4 Recommendation

Pilot a thin headless runtime for bot wakes only, built on a minimal, well-maintained agent core rather than written from scratch, behind a per-bot switch in the roster (`runtime: zen-agent` next to `claude-code` and `hermes`, which `org_agents.runtime` already models). Keep Claude Code for the owner and Hermes for cron. Judge the pilot at the end of phase 5 on tokens per finished card, first-wake finish rate and trace completeness against the `claude -p` bots on the same graph nodes. The concrete candidate cores and their trade-offs are in section 14, which also records what could and could not be verified about them.

**Status (2026-10-25):** the pilot runtime exists as [`zen-agent/`](https://github.com/kon-rad/secondbrain/blob/main/zen-agent/README.md) (described in [zen-agent.md](zen-agent.md)), a standalone package on `@earendil-works/pi-agent-core`: personas from the roster, skills, any provider, the board and the retrieval API as typed tools, the guard in process, budgets in the loop, context assembled from capped named parts, compaction as policy and one JSONL trace per run. It already has a `board` backend and a `lane` loop against the engine's `board` module ([board-design.md](board-design.md) section 7). What is not yet done: the `runtime: zen-agent` switch in the roster schema and the dispatcher calling `zen-agent wake`, and the archive collector reading its traces — so bots still run under `claude -p` today, and the pilot's comparison in 10.4 has not been run yet.

---

## 11. Phases

Each phase has a completion contract in the `AGENTS.base.md` sense. No phase depends on the pilot in section 10.

| Phase | Delivers | Done when |
|---|---|---|
| **0. Stamp and outcomes** | `improve` module skeleton; `harness_versions`, `run_outcomes`; `cli-improve stamp | outcomes`; `cc_dispatch.harness_sha`; `SessionStart` stamp hook; hooks log into the vault; `/improve` page read-only with the version timeline | Every run of the last 7 days on `/usage` shows a harness sha; `run_outcomes` has one row per run; `npm test` covers the join |
| **1. Mining and reports** | `cli-improve mine`, the signatures in 4.3, the weekly report, `improve` cards to a roster bot; ratings table and the `/cron` rate button; `fact_checks` table | A week of nightly reports exists; at least one cluster became a card a person acted on; no model tokens spent by mining |
| **2. Static checks and skill evals** | Tier A for rules, skills, graphs, guard, cron, policy; `skills/*/evals/` with one case each; `harness/evals/`; CI step `test:skills`; the org and graph compiler moved into `secondbrain-vault` | CI runs Tier A on the engine; `cli-improve eval --tier A` passes on the template vault and fails on a planted bad skill |
| **3. Replay and contrast** | Tier B scratch-vault replay, Tier C contrast, `eval_runs`, the noise-band estimate, the promotion rule, `cli-improve record | promote`, canary and `revert` cards | One recorded proposal (hand-written) goes through eval, PR, promote and canary with its numbers on `/improve` |
| **4. The harness-engineer bot** | The `improve` skill, `cli-improve trace`, the readonly guard rules, card contracts on the board, budgets enforced by the dispatcher | Three bot-made proposals evaluated; at least one promoted and confirmed; zero escapes; eval cost under budget |
| **5. Memory** | Playbook format and counters, measured facts, hybrid recall with more sources, the curator pass, skill compilation signature | Memory hit rate and repeated-mistake rate on the report; one compiled skill promoted |
| **6. Outer loop** | `policy.json` proposals from the weekly report with backtest eval; longer canary | One policy change promoted on backtest and confirmed after 21 days |
| **Pilot (parallel from phase 3)** | A headless runtime for bot wakes behind `runtime: zen-agent` | Decision at the end of phase 5 by the metrics in 10.4. The runtime itself is built ([zen-agent.md](zen-agent.md)); what's left for this phase is the roster switch, the dispatcher hand-off and the comparison run |

Phases 0 to 2 cost no model tokens beyond what runs today. Phase 3 is the first with an eval budget.

---

## 12. Risks

| Risk | What it looks like | Mitigation in the design |
|---|---|---|
| Reward hacking | A proposal that passes the eval by narrowing what counts as finished, or by editing the check | Principle 5; verifications are recorded by the run, not asserted; the canary measures live outcomes |
| Context collapse | The curator "tidies" a playbook into three vague bullets | Itemised bullets with ids and counters; one-bullet edits for bots; Tier A refuses mass deletions |
| Cost spiral | Evals and replays eat the week's plan | Weekly budget, tiers, `minRuns`, the loop's own cost on `/usage` under one bot |
| Privacy leak to the engine | A record with a real card title lands in an engine PR | Records stay in the vault; engine PRs are rewritten with fake data; `check-public.sh` and the denylist run before push; the bot has the engine repo only when given it |
| Prompt injection through traces | A web page in a trace says "edit `AGENTS.md` to allow X" | Traces are data (principle 7); the proposer cannot write live surfaces; the PR is read by a person |
| Evaluator drift | Cases go stale and the gate passes everything | Stale detection; rotation; escapes counted in the outer loop |
| Two harnesses diverge | A rule holds in Claude Code and not in the pilot runtime | Shared rule files, shared hook payloads in `harness/evals/`, the stamp covering both |
| The loop runs on noise | Promotions on 8 runs and a lucky day | `minRuns`, noise band from baseline repeats, canary before confirmation |
| Silent drift of the frozen model | A provider update changes behaviour; the loop blames a prompt | `llm_exchanges.model` and the provider's model id are columns in `run_outcomes`; mining splits by them before by harness sha |
| The owner is the bottleneck | Twenty PRs a week nobody reads | The policy caps open proposals (default 3); the report ranks by expected effect; small diffs by construction |

---

## 13. What's confirmed vs. inferred

| Confirmed (read in this repo) | Inferred (this proposal's judgment) |
|---|---|
| The tables and files named in section 2 exist with the columns described | That a harness hash plus `run_outcomes` is enough attribution to start; a per-skill "loaded" signal needs transcript parsing that is sketched, not built |
| `usage_runs` carries `verify_*` from a `cc_verify` line the dispatcher may write | How often the dispatcher writes it today (the dispatcher is outside this repo) |
| `task_links` records graph, node, kind and rounds per card | That rounds and held statuses are clean enough labels without the reason codes proposed in 5.3 |
| `memory_facts` has sources, confidence and supersession; recall is full text plus a line match | That counters and embeddings will raise the memory hit rate; this needs the phase-5 measurement |
| The guard and the gate fail open and are stdlib-only | That writing one JSON line into the vault keeps them within their 5 s and 10 s timeouts (it should; it is one append) |
| The roster and graph compiler and the dispatcher live outside the engine | That moving the compiler in is a small change; the dispatcher's size is unknown here. The kanban half of this row is no longer inferred: it moved into the engine as the `board` module ([board-design.md](board-design.md)) |
| Agents never merge their own PR; shipping needs the owner's approval | That these two rules are sufficient to call the recursion bounded |

**Open questions, not researched here**

- ~~Should the kanban's cards move into an engine-owned table with agent-hub as one writer (5.3), and what does agent-hub need from the engine for that?~~ Decided and built: the `cards` table, functions and RLS live in the engine as the `board` module ([board-design.md](board-design.md)). What remains is the staged rollout (its section 8) and the open questions it lists on its own section 10 (roster rows for lanes, where the Hermes projection lives mid-rollout, the `org_messages.task_id` foreign key, review as a status versus a card, lease length).
- What is the right noise band? It can only be estimated once phase 3 has baseline-vs-baseline repeats.
- How should cases that need a real repo state (a build card) be fixtured without copying personal code into the scratch vault? A per-case `fixture` commit in the owner's own repos is the current assumption.
- Does the Claude subscription allow a third-party runtime to use it, and under what terms? This decides whether the pilot runs on the subscription or on API credits.
- How does Hermes expose per-job prompt versions beyond `jobs.json`? If it does not, the engine hashes the synced prompt, which lags by one sync interval.

---

## 14. Related work and candidate runtimes

Checked against primary sources on 2026-10-24. Where a figure is a vendor's own, it says so. The three systems the owner's summary named (Harness², Meta-Harness, MASS) exist under those names; two of them are a few weeks old and have no independent replication yet.

### 14.1 Harness and scaffold self-improvement

| Work | Mechanism | How it avoids regressions | What this proposal takes from it |
|---|---|---|---|
| **Harness²** (Google Research, arXiv 2610.14224, Oct 2026; code `google-research/harness2`, Apache 2.0) | Eight editable harness components around a frozen executor (system prompt, guardrails, memory, tool guidance, subagents, skills, scripts, plugins). Per task: a reference run, then two candidate edits (one for a recurring agentic weakness, one domain-specific), probed on the same task and compared to the reference as a *behavioural contrast*; a composer merges supported changes or keeps the current harness. An outer "harnessing-level recursion" keeps a library of harnesses, each with an experience note (situation, lessons, evidence), consulted on the next task | No answer key: contrasts inform composition rather than verify correctness, and a lesson is kept only when a contrast supports it. The paper does not use the phrase "zero-regression"; that is a paraphrase of this evidence-gated retention | The propose/probe/compose shape of sections 4.4 to 4.6; contrast on the same task (Tier C); records as the experience library; the authors' own caveat that stochastic runs limit the evidence, which is why this proposal adds repeats, `minRuns` and a canary. Reported gains of 4 to 12 points on three benchmarks are Google's numbers |
| **Meta-Harness** (Stanford, arXiv 2603.28052, Mar 2026) | A coding agent proposes a new harness after reading a filesystem holding every prior candidate's source, traces and scores; candidates kept on a score-versus-tokens Pareto frontier; about 60 harnesses over 20 iterations | The proposer never sees the test set; final test on held-out tasks and held-out models | Expose raw traces to the proposer rather than a compressed summary (`cli-improve trace`); keep cost on the frontier (tokens per pass is a promotion criterion); hold out |
| **AIDE / AIDE²** (Weco; arXiv 2502.13138 and 2609.26457, blog Jul 2026) | AIDE: tree search over candidate code with evaluated metrics. AIDE²: an outer agent rewrites the inner agent's code; each candidate runs under a fixed dollar budget; each task has a public score the inner agent sees and a private score it cannot; a candidate survives only if it beats the previous best (about 9 in 10 rejected). Reward hacking fell during the run without being an objective | Public versus private score; strict budget; keep only strict improvements | The held-out set under a protected path (principle 5); a weekly budget; counting negative results as output. No public AIDE² code was found; the numbers are Weco's |
| **MASS** (Sakana AI, arXiv 2610.12176, Oct 2026) | One model as solver (orchestrator plus subagents), evaluator and workflow optimiser. Candidate workflows (roles, instructions, output contracts, hop order) are compared pairwise against a champion, scores from Bradley-Terry, the optimiser revises from the feedback history. Output contracts carry required checks. An outer loop fine-tunes on kept trajectories (out of scope here) | External judges withheld from the loop decide the final measurement; the authors note a same-family judge may overfit to its own criteria | Output contracts on cards and graph nodes (5.1, 5.3); pairwise, position-swapped judging as a diagnostic, never as the sole gate. Note: a 2025 Google paper is also called MASS (Multi-Agent System Search) and is a different thing |
| **Darwin Gödel Machine** (Sakana / UBC, arXiv 2505.22954) | An archive of coding agents; each rewrites its own code; children evaluated on coding benchmarks and kept in an open-ended archive, not only the best | Human review caught agents faking test logs | Expect verifier gaming; keep a person on the merge; keep an archive of not-promoted records so the search does not collapse to one line |
| **ADAS / Meta Agent Search** (arXiv 2408.08435) | A meta agent writes new agents in code from a growing archive, evaluated on held-out tasks | Held-out evaluation; transfer across domains and models | Hold out across models too: `run_outcomes` splits by model before by harness |
| **GEPA** (arXiv 2507.19457) and **MIPROv2** (arXiv 2406.11695) | Reflective prompt evolution over full traces with a Pareto frontier of candidates; Bayesian search over instructions and demonstrations | Frontier, not single best | Traces, not scores, as the proposer's input; small sample sizes handled by keeping several candidates alive |
| **Promptbreeder** (arXiv 2309.16797) | Evolves task prompts and the mutation prompts that mutate them | | The outer loop editing `policy.json` is this idea applied to mining signatures and thresholds |
| **AlphaEvolve** / **OpenEvolve** (DeepMind blog May 2025; `codelion/openevolve`) | Prompt sampler, model ensemble, automated evaluators, evolutionary program database; needs automatically verifiable problems | Automatic evaluators | Where a verifiable check exists (the `projects` module's verifications, the engine's tests), use it and nothing softer |
| **Trace / OPTO** (arXiv 2406.16218), **TextGrad** (arXiv 2406.07496) | Optimisation over execution traces of compound systems; textual feedback propagated through a graph | | The graph and its node bodies as the thing being optimised, with per-node metrics |

### 14.2 Memory and skill libraries

| Work | Mechanism | Lesson taken |
|---|---|---|
| **ACE: Agentic Context Engineering** (Stanford / SambaNova / Berkeley, arXiv 2510.04618) | Context as a playbook of structured bullets with helpful and harmful counters; a Generator produces trajectories, a Reflector distils lessons, a Curator applies small delta updates. Names two failure modes of rewriting memory wholesale: brevity bias and context collapse | Section 7.2 is this design applied to `memory/<bot>.md`: itemised bullets, counters, one-bullet edits, a curator pass |
| **Agent Workflow Memory** (arXiv 2409.07429), **Voyager** (arXiv 2305.16291), **SkillWeaver** (arXiv 2504.07079) | Induce reusable workflows or executable skills from past trajectories, store them, reuse by retrieval | Skill compilation (7.4): a recurring successful procedure becomes a skill with an eval case |
| **Reflexion** (arXiv 2303.11366), **Dynamic Cheatsheet** (arXiv 2504.07952) | Verbal self-reflection stored in episodic memory; self-curated test-time snippets | The weekly reflection already in `org-member` step 11, given a structure and counters |
| **Mem0** (arXiv 2504.19413), **A-MEM** (arXiv 2502.12110), **Letta / MemGPT** | Extract, consolidate, retrieve; linked notes; paged memory | Hybrid retrieval and consolidation for `memory_facts` (7.3). Mem0's benchmark figures are disputed by third-party reimplementations, so none are relied on here |
| **Self-evolving agents survey** (arXiv 2507.21046) | Evaluation axes: adaptivity, generalisation, efficiency, safety | The metric table in 6.1 covers each axis |

### 14.3 Topology search

**AFlow** (arXiv 2410.10762, Monte Carlo tree search over code-represented workflows), **MaAS** (arXiv 2502.04180, a cost-aware supernet that samples an architecture per query) and **MAS-GPT** (arXiv 2503.03686, a model that emits a multi-agent system per query) all treat the graph as the object of search. For this repo the graph is a yaml file applied per feature, so topology proposals are diffs to that file (5.1), evaluated on graph-level metrics. Per-query dynamic switching, as in the owner's summary, is out of scope until there is more than one graph per kind of work to switch between.

### 14.4 Anthropic's guidance and the Claude Code surfaces

- *Building effective agents* (Dec 2024): prefer simple workflows (chaining, routing, parallelisation, orchestrator-workers, evaluator-optimiser) over open-ended agents; design the tool interface so mistakes are hard to make. The graph templates are the workflow layer; the card contract is the interface.
- *How we built our multi-agent research system* (Jun 2025): token use explained most of the quality variance; evaluation started with about 20 queries, an LLM judge with a rubric and pass/fail, human review of edge cases, and end-state evaluation for agents that change state. Twenty cases, end-state checks and a rubric judge as a diagnostic is the shape of Tiers B and C.
- *Effective context engineering* (Sep 2025): an attention budget, just-in-time retrieval, compaction, structured notes, subagents that return short summaries. Section 7.5 measures these levers instead of guessing them.
- Claude Code **hooks** (`SessionStart`, `PreToolUse`, `PostToolUse`, `SubagentStart`/`Stop`, `PreCompact`/`PostCompact`, `Stop`, `SessionEnd`, with JSON decisions and `additionalContext`) and **subagents** (markdown with frontmatter in `.claude/agents/`, separate context, own tools and hooks) cover what phase 0 needs from the interactive harness: the stamp on `SessionStart`, hook counts on `PreToolUse`, compaction events on `PreCompact`. A `PreCompact` hook that records the context size is a cheap addition to `harness/claude/settings.json`.
- The **Agent Skills** standard (agentskills.io, Dec 2025): `SKILL.md` with `name` (lowercase, hyphens, equal to the folder) and `description` (≤ 1 024 characters), optional `license`, `compatibility`, `metadata`, and a `skills-ref validate` tool. The engine's skills already follow it; Tier A should run the reference validator.

### 14.5 Trace and evaluation tooling

- **OpenTelemetry GenAI semantic conventions** name agent spans `create_agent`, `invoke_agent`, `execute_tool` and `chat`. The conventions moved to a separate repository and their stability level could not be confirmed from the primary spec; if the archive ever exports spans, pin the SDK version and map `run → turn → tool call` to those names.
- **Phoenix** (OTel-native, open source), **Langfuse** (self-hosted tracing, prompt management, evals) and **Braintrust** (eval datasets, judges, CI gating) are the usual hosted or self-hosted choices. This proposal keeps traces in the vault's Postgres, which already has them; an exporter is an option, not a dependency.
- **LLM-as-judge**: position bias, verbosity bias and self-enhancement bias are documented (arXiv 2306.05685); the swap test (arXiv 2406.07791) accepts only position-consistent verdicts. Tier C follows both and avoids a same-family judge where a second provider is configured.
- **Regression suites**: Terminal-Bench 2.0 (89 tasks, pinned dependencies, container images, a canary string against contamination), SWE-bench Verified, TheAgentCompany (a simulated company with checkpoint partial credit) and "Best practices for rigorous agentic benchmarks" (arXiv 2507.02825) are the reference for how to build a case: pinned fixtures, an executable check, partial credit by checkpoint, a contamination marker. Golden cases in `.agents/improve/cases/` should carry all four.

### 14.6 Candidate runtimes for the headless pilot

| Option | What it is | For | Against |
|---|---|---|---|
| **Keep `claude -p`** (status quo plus hooks) | Claude Code headless, driven by the dispatcher | Nothing new to maintain; the owner's interactive setup and the bots share one harness; hooks and subagents exist | Context assembly and compaction are not ours; a complete trace needs the capture proxy; the system prompt and tool list are large and fixed; budgets are enforced from outside |
| **pi** (`earendil-works/pi`, formerly `badlogic/pi-mono`; npm `@earendil-works/pi-agent-core`, `pi-ai`, `pi-coding-agent`; MIT) | A minimal agent core (`pi-agent-core`: about 2 600 lines, two runtime dependencies) over a unified provider layer (`pi-ai`, about 40 providers including Anthropic, OpenAI, Google, OpenRouter, Together, Ollama and any OpenAI-compatible endpoint), plus a coding agent with an SDK, an RPC mode, a JSONL event mode, session trees in JSONL files, built-in compaction with a replaceable summary, and an extension API with `tool_call` (mutate or block), `tool_result` (redact), `session_start`, `before_agent_start` (replace the system prompt and tools), `context`, `session_before_compact` and more. Skills follow the Agent Skills standard and are read from `.agents/skills`, which this repo already uses. Supports Anthropic prompt caching and OAuth login for Claude subscriptions. Version 1.4.0 on 2026-10-21, weekly releases, large community | Everything in 10.2 maps to an existing hook or SDK call: the guard as a `tool_call` extension, the stamp on `session_start`, context assembly in `before_agent_start`, compaction as policy, session files as traces, typed tools for `cli-org` and `cli-projects`. Same language as the app. Reads `AGENTS.md` natively. Sub-agent extensions exist (`pi-subagents` packages) and spawn isolated sessions | No permission system by design (the author calls it security theatre and says to run in a container): the guard would be the only gate, so bot runs need a sandbox (a container or a dedicated Unix user, which the deploy already uses). Extensions run in-process with full OS rights. Ownership moved to a company (Earendil) in 2026 with planned paid layers above the MIT core. Whether Claude subscription use through a third-party runtime is within Anthropic's terms, and whether it bills as extra usage, is unverified; the pilot should assume API credits. Features Claude Code has natively (plan mode, permissions, sub-agent tool) are extensions here |
| **Claude Agent SDK** | Anthropic's SDK exposing the Claude Code harness programmatically | First-party; keeps Claude Code's tools, hooks, subagents and skills | Not researched for this document; it is the Claude Code harness, so it would not change the context-assembly and tool-list concerns that motivate the pilot |
| **Hermes** | Already runs cron and chat here, with hooks and a skills directory | Already deployed; the usage-ledger plugin exists | Its loop is its own; the engine syncs its outputs rather than driving it |
| **Our own loop on `pi-ai` only** | Use the provider layer, write the loop | Total control | Reinvents `pi-agent-core` for no gain; rejected |

**Status (2026-10-25):** this recommendation was acted on. `zen-agent` is built on `@earendil-works/pi-agent-core` and `pi-ai` (not the full coding agent), as a standalone package in this repo's `zen-agent/` (own `package.json`, tests, README — extractable with `git subtree split`), with: the four pi tools plus typed `cli-org`, `kanban` (now including a `board` backend against the engine's `board` module) and knowledge-base tools; the guard and the dev-log gate as in-process checks that read the same rule files, tested against the Python suite's cases; context assembly from capped named parts; the card's `## Budget` line enforced in the loop; one JSONL session file per run. See [zen-agent.md](zen-agent.md) for the full design and what is still open (the roster switch, the dispatcher hand-off, the archive collector, and the subscription-billing question, which remains unresolved — budget it on API credits). It has not yet replaced `claude -p` for any bot's live wakes, so it is still run "under the deploy's app user in a container or a restricted Unix user" only in the sense that nothing has run it against real card traffic yet.

---

## 15. Sources

Primary sources were opened on 2026-10-24. Vendor figures are marked as such in the text.

**Harness and scaffold self-improvement**
- Harness²: https://arxiv.org/abs/2610.14224 · https://github.com/google-research/harness2
- Meta-Harness: https://arxiv.org/abs/2603.28052 · https://yoonholee.com/meta-harness/
- AIDE: https://arxiv.org/abs/2502.13138 · https://github.com/WecoAI/aideml · AIDE²: https://arxiv.org/abs/2609.26457 · https://www.weco.ai/blog/first-evidence-of-recursive-self-improvement
- MASS (Sakana): https://arxiv.org/abs/2610.12176 · https://github.com/SakanaAI/mass
- Darwin Gödel Machine: https://arxiv.org/abs/2505.22954 · ADAS: https://arxiv.org/abs/2408.08435
- GEPA: https://arxiv.org/abs/2507.19457 · MIPROv2: https://arxiv.org/abs/2406.11695 · Promptbreeder: https://arxiv.org/abs/2309.16797
- AlphaEvolve: https://deepmind.google/discover/blog/alphaevolve-a-gemini-powered-coding-agent-for-designing-advanced-algorithms/ · OpenEvolve: https://github.com/codelion/openevolve
- Trace/OPTO: https://arxiv.org/abs/2406.16218 · TextGrad: https://arxiv.org/abs/2406.07496

**Memory and skills**
- ACE: https://arxiv.org/abs/2510.04618 · Agent Workflow Memory: https://arxiv.org/abs/2409.07429 · Voyager: https://arxiv.org/abs/2305.16291 · SkillWeaver: https://arxiv.org/abs/2504.07079
- Reflexion: https://arxiv.org/abs/2303.11366 · Dynamic Cheatsheet: https://arxiv.org/abs/2504.07952
- Mem0: https://arxiv.org/abs/2504.19413 · A-MEM: https://arxiv.org/abs/2502.12110 · Letta/MemGPT: https://www.letta.com/blog/memgpt-and-letta/
- Self-evolving agents survey: https://arxiv.org/abs/2507.21046

**Topology search**
- AFlow: https://arxiv.org/abs/2410.10762 · MaAS: https://arxiv.org/abs/2502.04180 · MAS-GPT: https://arxiv.org/abs/2503.03686

**Anthropic**
- https://www.anthropic.com/engineering/building-effective-agents · https://www.anthropic.com/engineering/multi-agent-research-system · https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Hooks: https://code.claude.com/docs/en/hooks · Subagents: https://code.claude.com/docs/en/sub-agents · Agent Skills: https://agentskills.io/specification

**Evaluation and tracing**
- LLM-as-judge: https://arxiv.org/abs/2306.05685 · https://arxiv.org/abs/2406.07791 · https://arxiv.org/abs/2412.05579
- Terminal-Bench 2.0: https://arxiv.org/abs/2601.11868 · TheAgentCompany: https://arxiv.org/abs/2412.14161 · AgentBench: https://arxiv.org/abs/2308.03688 · Rigorous agentic benchmarks: https://arxiv.org/abs/2507.02825 · SWE-bench Verified: https://openai.com/index/introducing-swe-bench-verified/
- OpenTelemetry GenAI: https://github.com/open-telemetry/semantic-conventions-genai

**pi**
- Repository and docs: https://github.com/earendil-works/pi (the former `badlogic/pi-mono` redirects here) · https://pi.dev/ · https://pi.dev/news/2026/5/7/pi-has-a-new-home
- Design posts: https://mariozechner.at/posts/2025-11-30-pi-coding-agent/ · https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/ · https://earendil.com/posts/pi-1-0/

**This repo, since this document was written**
- zen-agent (the headless-runtime pilot this document's section 10 asked for): [zen-agent.md](zen-agent.md) · [kon-rad/secondbrain#38](https://github.com/kon-rad/secondbrain/pull/38) · [#40](https://github.com/kon-rad/secondbrain/pull/40)
- The board module (the kanban-in-the-engine design this document's section 5.3 asked for): [board-design.md](board-design.md) · [kon-rad/secondbrain#39](https://github.com/kon-rad/secondbrain/pull/39)
