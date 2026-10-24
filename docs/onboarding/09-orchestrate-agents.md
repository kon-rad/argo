# Orchestrate agents

How work gets done by agents in a vault, from one Claude Code session to a company of named bots with a tracker, a board and a bill. The pieces are independent: take the first three for any vault, add the modules when you want a paper trail.

## The model in one picture

```
   you ──── rules (AGENTS.md) ──┐
            skills (SKILL.md) ──┤
                                ▼
   a wake ──▶ one agent run ──▶ guard before every tool call
   (you, a cron,                │
    a board card)               ├──▶ notes, code, cards, posts
                                │
                                └──▶ dev log + Resume block ──▶ the next run starts here
                                     verification recorded
                                     usage recorded
```

Three properties make this hold together:

- **Every run starts cold and reads the file.** Headless runs re-send the whole conversation on every turn, so the base rules say one task per run, and the handoff between runs is a file: the project's dev-log README with its `Resume` block, or a card on the board.
- **Nothing is "done" without evidence.** A completion contract states the verification up front. The tracker will not mark a feature live without a passing check recorded. The dev-log gate will not let a session that changed skills or config finish without an entry.
- **Budget is a rule, not a hope.** The context-budget rules, the session run cap and the wake backoff each bound a loop that would otherwise grow.

## Layer 1: rules, skills and contracts (any vault, any harness)

| Piece | Where | What to write |
|---|---|---|
| Your rules | `AGENTS.local.md` | How you name things, which folders hold what, your projects, your voice, what is off limits. Regenerate with `secondbrain-vault rules` |
| A skill per repeatable job | `.agents/skills/<name>/SKILL.md` | The trigger phrases in `description`, then the procedure, its inputs, its output path and format, and the check it ends with. Look at `skills/ingest/SKILL.md` for the shape |
| A contract per long task | The prompt | Outcome (files or message), Verification (command and expected result), Constraints, Boundaries, Stop when (a turn budget or `BLOCKED: <reason>`) |
| A reviewer | `.claude/agents/fact-checker.md` and the `fact-check` skill | Run it as the last step of any skill whose output you read without checking. It reports; it never edits |

A first skill most people write: a weekly review that reads the week's dev logs and the tracker, and writes one note. A second: an inbox processor that turns links in a note into `ingest` notes.

## Layer 2: a paper trail (dev logs and the `projects` module)

**Dev logs** are the record humans read. Per project, under `Projects/<project>/`: a design note, a `dev-log/README.md` that starts with the six-field `Resume` block, and one dated entry per session that says what changed, why, what broke, how it was tested, which commits. The format is in the "Dev logs" section of [`AGENTS.base.md`](https://github.com/kon-rad/secondbrain/blob/main/vault-template/AGENTS.base.md); the gate enforces the entry, not the quality, so read them.

**The tracker** (`MODULES=projects`) is the record agents update. Projects and features with stages (`idea`, `designing`, `building`, `testing`, `live`, `parked`, `done`), and verifications: a feature goes `live` or `done` only after a passing check is recorded. Agents use `cli-projects` (`report`, `list`, `add`, `set`, `verify`, `render`), and the `company-report` skill teaches them when: at the end of any build session, and whenever you ask "how are the projects?" or "what's blocked on me?". `cli-projects render` writes a markdown report into the vault, so the tracker is searchable like everything else, and a goals table in `goalsFile` ties features to goals.

Turn it on, then ask your agent for a company report. The first one is empty; `cli-projects import` brings in what already exists.

## Layer 3: a company of agents (the `org` module)

When more than one agent works for you, give each a name, a role, a team and someone to report to. `MODULES=org` adds the board: channels, DMs, questions waiting on you, cards, and `cli-org` for agents to post, read, ask the owner, take and complete tasks. You are the human member, `ORG_OWNER`. The `org-member` skill is the heartbeat checklist a named agent follows when it wakes: read its channels, answer what it can, take the next card, report.

A **dispatcher** turns wakes into runs. It is not included, because it is the part that depends most on your machines and your harness, but it is small. Its loop:

1. Ask the board for open wakeups: `cli-org wakeups --all` lists them with the agent, the reason and the card.
2. For each agent with one, claim its wakeups with `cli-org wake-claim <agent> --by <run id>` and start one run of that agent with `ORG_AGENT=<name>`, for example `claude -p "You are <name>. Follow the org-member skill."`, in the vault, under the hooks.
3. Resume a remembered session only through `cli-org session`, which drops it after `ORG_SESSION_MAX_RUNS` runs so a resumed conversation cannot grow without bound.
4. When the run ends, `cli-org wake-done <ids> --run <run id> --exit <code>`; after a dispatcher restart, `cli-org wake-release` un-claims what died. Then let the backoff do its job: a card that keeps waking its agent waits `ORG_TASK_WAKE_BACKOFF_MINUTES`, doubling each time, and after `ORG_TASK_WAKE_RETRIES` re-wakes in a day it is held until you wake it yourself with `wake-add --reason owner`.

Row-level security in Postgres gives each agent its own view of the board through a dedicated `sb_org` role, so an agent cannot read another's DMs by writing SQL.

## Layer 4: the bill (the `usage` module and the agent ledger)

`MODULES=usage` adds a page of what your agents cost: tokens per run, by bot, why it woke, which card and project, the work type and which host, plus plan percentages and API credit balances. Each machine that runs agents feeds it through the agent ledger, which captures every turn locally, redacts the secrets you named and syncs when it can ([Connect servers and computers](06-connect-machines.md#shape-c-several-machines-running-agents)). Hermes gets per-request tokens from a small plugin ([Connect Hermes](04-hermes.md)).

With that table, the question "should this job be automated?" has a number next to it.

## A day in the life

| When | Who | Does |
|---|---|---|
| 06:00 | A cron on the server | Wakes the research agent for the "weekly reading" card. It runs `ingest` on three links, writes three notes, records a verification, posts a two-line summary in its channel, writes a dev log, stops |
| 09:00 | You, on a phone | Open the board, read two questions waiting on you, answer one, reassign the other. Ask the chief of staff agent "what's blocked on me?" and get a company report |
| 11:00 | You, in Claude Code | A design session in `Projects/x/`. A completion contract in the prompt. It ends with a dev log entry, because the gate asked |
| 14:00 | An engineer agent | Takes a card, builds, runs the tests named in the contract, pastes the real output, sets the feature to `testing`, asks you to verify |
| Later | You | The usage page says the research agent costs more than its notes are worth. You move it from daily to weekly |

Every row left a file in the vault or a record in a module table, and nothing in it was a screenshot.

## Where to start

1. Write five lines in `AGENTS.local.md` and one skill. Run it in Claude Code with a contract. Read the dev log it wrote.
2. Turn on `projects`. Make the agent record a verification before it may call anything done.
3. Only then, if you have more than one job running on a schedule, turn on `org` and write the dispatcher.
4. Turn on `usage` the day you stop being able to say what the agents cost.

Next: [Adapt it](10-adapt-it.md).
