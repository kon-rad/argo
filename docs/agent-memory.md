# Agent persona memory

Each bot of the `org` module gets a memory of its own: written after every finished wake from the bot's point of view, bounded, inspectable on `/org/agents/<name>`, and the one path by which a bot may ask for a change to itself. Nothing here lets a bot widen what it is: a self-change is a card a person applies, or closes.

This page is the engine side. The vault side (the `memory:` block in `org.yaml`, the compiler that writes it into `org-agents.json`, the dispatcher that passes a run's turns and cost to `wake-done`, and the ledger that measures a shipped proposal) lives with the vault and the dispatcher, not here.

## Three tiers, not one file

| Tier | Holds | Where | Written by | Read |
|---|---|---|---|---|
| **Episodic** | One row per finished wake: what woke it, the card, how it ended (`done`, `blocked`, `request_changes`, `no_report`, `error`), whether a reviewer sent it back, turns, cost, duration, a one-line first-person summary, the log path | `org_agent_episodes` | `cli-org wake-done` (or `cli-org reflect`), mechanically, no model call | `cli-org memory episodes`, the agent page, the reflect step |
| **Semantic** | First-person lessons, anti-patterns, preferences and frictions, one claim each, with how often it recurred and which episodes produced it. Closed (superseded or retired), never deleted | `org_agent_memory` | The reflect step (one cheap-model call), corrected by the owner or the bot's lead with `cli-org memory edit\|retire` | `cli-org memory <agent>`, `cli-org recall`, the agent page |
| **Core** | The active semantic rows rendered under a token budget: the block the wake prompt can inject without a search | `.agents/org/memory/<name>/core.md` in the vault, generated | `cli-org reflect` after every write, `memory edit\|retire` | The dispatcher (at wake), `cli-org recall`, the agent page |

The hand-written `.agents/org/memory/<name>.md` keeps working next to the generated block: `recall` searches both, and the agent page shows both.

## The write pipeline

```
cli-org wake-done <ids> --run R --exit N --result "…" [--turns N] [--cost USD] [--duration S] [--log path] [--transcript path]
  ├─ as before: closes the wakeups, posts a fallback status if the run left none
  └─ then, never before and never fatal to it:
       1. one org_agent_episodes row (mechanical; a second wake-done for the same run is a no-op)
       2. if the agent's config allows and the run had at least min_turns turns and the day's cap is not spent:
          one cheap-model call with the episode, an excerpt of the run's tool calls and results, and the bot's
          active memory → a list of AUDN operations (add / update / delete / none)
       3. the operations applied in one transaction: a repeat bumps the row's count, new wording supersedes
          it, a delete closes it with the reason; most wakes produce none
       4. core.md re-rendered: rows by times seen, then recency, until the budget is spent
       5. a friction or anti-pattern seen repeat_threshold times becomes one self-improvement card (below)
```

The model never sees another bot's run: the input is this agent's episode and this agent's rows, and a line that names another agent other than to describe a handoff is dropped. A failed or slow model call is logged and skipped; the episode stays, and the next `cli-org reflect <agent> --run R` can retry it.

`cli-org reflect` is the same step without a wakeup to close: the dispatcher's chat end, a Hermes session, or a backfill call it directly with `--reason chat|task|…`.

## Config: the `memory:` block

Per agent, in the vault's compiled `.agents/org/org-agents.json` under `agents.<name>.memory` (the vault's compiler writes it from `org.yaml`, where `defaults.memory` is inherited and overridden per agent). Every key has a default that works when the block is missing.

```json
{
  "tiers": ["core", "episodic", "semantic"],
  "core_budget_tokens": 1500,
  "reflect": { "enabled": true, "trigger": ["wake_done", "chat_end"], "model": "cheap", "min_turns": 2 },
  "self_improvement": { "enabled": true, "max_proposals_per_week": 1, "repeat_threshold": 2, "targets": ["own_prompt", "own_skills"], "requires_ship_gate": true }
}
```

The engine enforces what no block may set: `core_budget_tokens` above 4000 is refused, `repeat_threshold` below 2 is refused, `requires_ship_gate` is `true` or the block is invalid, and `targets` may name only the agent's own prompt and its own skill files. An agent's `knowledge` list (same file) says which files `own_skills` means.

`reflect.model` is `cheap`, `off`, or `<provider>/<model>`. `cheap` resolves through `ORG_REFLECT_MODEL`: the local Ollama first, then the default chat provider that has a key here; `ORG_REFLECT_MODEL=off` turns the model step off everywhere (episodes are still recorded). `ORG_REFLECT_MAX_PER_DAY` caps the model calls across every bot.

## Self-improvement: propose, never apply

When a row of kind `friction` or `anti_pattern` has been seen `repeat_threshold` times, the reflect step (or `cli-org propose-improvement <agent> --memory-id <id>`) asks the cheap model for the smallest change to one of the bot's own files that would stop it, against the exact current text of that file, and validates the answer:

- the target is the agent's own block in `.agents/org/org.yaml` or a markdown file under its `knowledge` paths; the harness and the owner's files (`AGENTS.md`, `CLAUDE.md`, `.claude/`, the guard, hooks, `CURRENT/`, `.env`) are refused whatever the config says;
- in the org.yaml block only prose may change (`personality`, `goal`, `perspective`, `style`, `voice`, `principles`, `description`); a diff that touches `tools`, `permission_mode`, `model`, `wakes_per_day`, `capabilities` or any other key is refused and the refusal names the key;
- at most 40 changed lines: a rewrite is refused.

What passes becomes one card of kind `improve` on the owner's backlog, authored by the bot and assigned to nobody, with the diff, the first-person rationale and the evidence episodes. A person applies it the way any org.yaml or skill edit ships today, or closes it. There is no ship-now path, and `requires_ship_gate` is not a setting a bot can change. The memory row records the card (`promoted_to_proposal`, `proposal_task_id`), so a denied friction re-proposes only after fresh evidence; `max_proposals_per_week` caps the rest.

## Measuring it

`cli-org memory stats <agent> [--days N]` prints the two numbers a shipped proposal is judged by, computed from the episodes: corrections per completed card (episodes marked corrected over episodes that finished `done`; `cli-org task redo` marks the builder's latest episode on the reviewed card) and cost per completed card. The ledger and the two-week revert check that use them follow the ratchet pattern in [self-improvement.md](self-improvement.md) and live with the vault.

## Commands

| Command | Who | What |
|---|---|---|
| `cli-org memory <agent> [--all]` | anyone on the roster (a bot sees only its own rows) | The active lines, most seen first; `--all` includes closed ones |
| `cli-org memory episodes <agent>` | same | The finished wakes |
| `cli-org memory stats <agent> [--days N]` | same | Corrections and cost per completed card, memory counts, proposals filed |
| `cli-org memory edit <id> "<text>"` | the owner, or the bot's lead | Closes the row and inserts the correction as a new one that supersedes it; re-renders core.md |
| `cli-org memory retire <id> "<why>"` | the owner, or the bot's lead | Closes the row with the reason |
| `cli-org reflect <agent> --run R …` | the dispatcher, the owner | The write pipeline for one run (`--dry-run` prints the operations without writing) |
| `cli-org propose-improvement <agent> --memory-id <id> [--dry-run]` | the dispatcher, the owner | One card from one recurring row; exit 3 with the reason when refused |

## Security

- `org_agent_episodes` and `org_agent_memory` have row-level security: the `sb_org` role reads only rows where `agent_name` is the connection's agent and cannot insert or update either table. Writes come from the owner's connection: the dispatcher's `wake-done`, the app, the owner's CLI.
- The reflect prompt is scoped to one agent's episode; `CURRENT/`, `Areas/Finance/` and `.env` stay outside everything here as they are outside `recall`.
- A generated `core.md` is bounded by `core_budget_tokens`; a superseded line stays in the table for audit but leaves the block.
- No proposal is applied by code. The validator is in `app/server/src/org-memory.ts` (`validateProposal`), not in configuration.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `ORG_REFLECT_MODEL` | `cheap` | What the reflect step calls: `cheap` (local Ollama, then the default keyed provider), `off`, or `<provider>/<model>` |
| `ORG_REFLECT_MAX_PER_DAY` | `200` | Model calls allowed per day across every bot; past it, wakes still record their episode |
