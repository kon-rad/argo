# Using the kanban board

The board is where work lives: a card is a commitment, a message is a conversation. It holds the cards you and your agents put on it, who each one belongs to, what state it is in, and what happened to it. This page is the practical guide: what the board is, the three ways in, every command, tokens, how an agent is told to use it, and the traps that have already cost us a day.

The architecture (why the record moved into Postgres, the table definitions, the status machine, the staged rollout) is [board-design.md](board-design.md). Read that one before changing board code; read this one before using the board.

---

## 1. What the board is

**The record is in Postgres; the execution is a lane.** The board keeps cards, comments, events, dependencies and run history next to the tracker and the org. Anything that actually *runs* work is a lane: a value of `org_agents.runtime` plus a small adapter that claims a card, runs the agent, keeps the lease alive and reports back. Hermes is one lane, a Claude Code dispatcher is another, `zen-agent` is a third. The board itself never spawns anything.

That split is why a card can be given to a runtime that does not exist yet, and why "who ran this" is a row in `card_runs`, not a process id.

| Thing | Where it lives |
|---|---|
| Cards, comments, events, dependencies, runs | Postgres, tables `boards`, `cards`, `card_comments`, `card_events`, `card_deps`, `card_runs` |
| Who may do what | `board_*` SQL functions, `SECURITY DEFINER`, one rule each: the only write path |
| Devices that reach it | `board_tokens`, hashed at rest, revocable |
| The page | `/board` (module `board` in `MODULES`) |
| The CLI | `cli-board` (also `secondbrain board`) |

**Every write goes through a function**, never through a table. The functions check who is calling and enforce the rule: who may give whom a card, whether the assignee has the capability the card needs, whether a coding card names a repo the bots can reach, whether a card may be moved to `done` rather than finished. The HTTP API and the CLI are thin: they parse arguments and call the same functions. So the rules are the same whichever door you came through, and they are enforced in one place.

### The nine statuses

| Status | Means |
|---|---|
| `triage` | Filed but not yet accepted as work |
| `todo` | Accepted, waiting on another card (`card_deps`) or a future `scheduled_for` |
| `scheduled` | Parked until a time, not until a person |
| `ready` | Waits for its assignee's lane to claim it. A ready card wakes its bot through the org's wakeups |
| `running` | A lane claimed it; there is an open `card_runs` row with a lease |
| `review` | The builder finished; the review card decides |
| `blocked` | Stuck, with a `block_kind` (`dependency`, `needs-owner`, `missing-input`, `tool-error`, `budget`, `review-changes`, `other`) and a reason |
| `done` | Finished, with a one-line `result` |
| `archived` | Off the columns; kept for the record |

Two transitions happen by themselves: `todo → ready` the moment a card has no open dependency and no future `scheduled_for`, and `running → ready` when a lease expires with no heartbeat (`board_reclaim()`, run by the `board-reclaim` timer). Nobody polls for either.

**A card's status is not a feature's status.** Card status is work state; a feature's stage is product state in the tracker. The only bridge is finishing a card with a verification, which writes the tracker's `verifications` row. Nothing on the board moves a feature's stage directly.

---

## 2. The three doors

One identity model, three ways to reach it. `cli-board` picks its door from the environment, so you usually do not think about it.

```
 browser (phone, laptop, TV)      an agent on any machine           a process on the server
 ───────────────────────────      ───────────────────────            ────────────────────────
 login session                    Authorization: Bearer <token>      psql / cli-board as sb_org
 acts as the owner                board_tokens → agent_name          ORG_AGENT=<name>
            │                               │                                  │
            └──────────────┬────────────────┘                                  │
                           ▼                                                   ▼
                 /api/board/* (Express) ── SET LOCAL org.agent ──▶  board_* functions, RLS
```

| Door | Who uses it | How it is set up | Identity |
|---|---|---|---|
| **1. Browser session** | You, from the page at `/board` on any device | Nothing: the app's own login | The owner (`ORG_OWNER`) |
| **2. HTTPS bearer token** | Any machine that is not the server: a laptop, another agent host, a script on a phone | `BOARD_URL` and `BOARD_TOKEN` in the machine's environment, token minted with `cli-board token create` | The roster member the token names |
| **3. Direct database** | A process on the server itself, including every bot and the dispatcher | `SB_ORG_DB_URL` (the `sb_org` row-level-security role) plus `ORG_AGENT=<name>` | That roster name, under RLS |

Which to use from where:

- **On your laptop, browsing:** door 1. Nothing to configure.
- **On a Mac or another machine running agents or scripts:** door 2. This is the door that saves you SSH, and the one worth fixing first when it breaks (section 6).
- **On the server, as a bot or a timer:** door 3, which is what the users' wrappers do already. `cli-org` and `cli-board` on the server source the env file themselves, so it just works.

A write is attributed to the identity the door supplies. There is no `--author`: a comment is always the caller's. That is deliberate, and it is why door 2 asks the token to name a real roster member.

---

## 3. Command reference

`cli-board` is the board's own CLI; `cli-org task …` is the same board plus the company layer (capability checks, who may give whom work, the work-graph templates). Both call the same `board_*` functions, so a card made by either is the same card. Use `cli-board` for day-to-day touching of a card, `cli-org task` when you are giving someone work.

### 3.1 Reading

```bash
cli-board boards                                   # every board and its open-card count
cli-board list --board exo
cli-board list --status ready --assignee rune
cli-board list --project secondbrain-app --feature board
cli-board list --q "vault token"                   # full-text search over title and body
cli-board list --all                               # include done and archived
cli-board list --board exo --json
cli-board show t_abc123                            # card, comments, events, dependencies, runs
cli-board show t_abc123 --json
```

`show` is the one to read before touching a card: it is the body, every comment, the event history, both directions of the dependency edges and each run with its runtime, lease, outcome and token count. Remarks live there, not in your memory.

Card ids are `t_` plus hex and stay stable, so a link or an id in an old message still resolves.

### 3.2 Creating

```bash
cli-board create "Add a cli-board token check to the smoke test" \
  --board exo --to sable --project secondbrain-app --feature board \
  --kind build --type ops --needs deploy --repo secondbrain \
  --body "What, why, and the one check that proves it."
```

`--to` names the assignee (omit it and the card is unassigned, waiting in `ready` for anyone's lane). `--after t_one,t_two` sets dependencies, which is what holds a card in `todo`. `--ship-now` marks a card that may merge and deploy without asking you; only the owner can set it. `--contract file.json` attaches the structured Objective, Returns, Budget, Scope and Verification instead of writing them as prose headings.

The same card through the company layer, which adds the capability rule and the project's team channel:

```bash
cli-org task create sable "Fix the token check" --project secondbrain-app --feature board \
  --type ops --needs deploy --repo secondbrain --body "..."
```

`cli-org task create` refuses a card whose assignee lacks the capability the work needs, or a coding card that does not name a repo the bots can reach. If it refuses, that is the rule doing its job: name the right bot, or the right repo.

### 3.3 Commenting, assigning, moving

```bash
cli-board comment t_abc123 "Reproduced on the third try; logs in /tmp/run.log."
cli-board assign t_abc123 sable --project secondbrain-app --feature board
cli-board assign t_abc123 none                     # unassign, back into the pool
cli-board move t_abc123 ready
cli-board move t_abc123 scheduled "after the release"
cli-board link t_abc123 --after t_def456           # a dependency
```

A comment is always authored by the caller. `assign` re-points a card that already exists, which is how a card you find unassigned becomes someone's.

`move` is for the transitions a person makes by hand: `triage → todo`, `blocked → ready` once the reason is gone, `done → archived`. It is deliberately *not* how a bot finishes its own card (section 3.4).

### 3.4 Claiming and finishing (lanes)

A lane claims work, keeps the lease alive and reports the outcome. If you are not writing a lane adapter, you will read these commands in the lane's log far more often than you type them.

```bash
cli-board claim --runtime claude-code --json        # the next ready card for that runtime
cli-board claim --agent sable --task t_abc123       # this exact card
cli-board heartbeat t_abc123 --tokens 1200 --turns 8
cli-board finish t_abc123 --done "Shipped in #52; 992 tests pass."
cli-board finish t_abc123 --blocked needs-owner "Which board does the kiosk show?"
cli-board finish t_abc123 --budget "hit the token cap"
```

`finish --done` is how a card closes. `finish --blocked <kind> "<why>"` sets both the `block_kind` and the reason, and **the kind matters**: a `dependency` block is unblocked by the board when its parents finish, a `needs-owner` block is your business, and an untyped block is invisible to the stale-block diagnostics. If you are tempted to leave the kind off, pick `other` and say so in the reason.

Add `--verify "<check>" --evidence "<numbers>"` to record the tracker's verification row at the same moment:

```bash
cli-board finish t_abc123 --done "assign --repo vault works" \
  --verify "cli-org task assign t_x m4 --repo vault" --evidence "assignee m4, repo vault"
```

`--fail` before the evidence records a failing verification instead, which is how a feature stays out of `live`.

### 3.5 Watching

```bash
cli-board watch --board exo        # one JSON line per board event until you stop it
```

The page uses the same feed over SSE, so it refetches only the card that changed instead of polling on a timer.

---

## 4. Tokens

A token is how a machine that is not the server reaches the board over HTTPS (door 2). It is minted once, hashed at rest, shown once, and revocable. It names one roster member, so a token is also a statement of identity: a card created with it is that member's card.

```bash
cli-board token create sable --label "runepos"     # prints the token once; copy it then
cli-board token list                               # id, agent, label, created, last seen, revoked
cli-board token revoke 7                            # by id
```

Then on that machine, in its environment file:

```
BOARD_URL=https://your-app-host
BOARD_TOKEN=<the token you copied>
```

**Where the values live, per machine:**

| Machine | File | Holds |
|---|---|---|
| The server | the app's env file (for this engine, `/etc/secondbrain/env`) | `BOARD_URL` is not needed; the door-3 database URL is there, plus `MODULES` including `board` |
| Your laptop or another host | the vault's `.env` (gitignored) | `BOARD_URL`, `BOARD_TOKEN` |
| A server-side bot or timer | the same server env file | nothing extra: the wrapper scripts source it |

Rules that keep this from becoming an incident:

- **Never print a token** in a note, a message, a card, a dev log or a terminal you are recording. `cli-board token create` prints it once, on purpose; put it straight into the file.
- **One token per machine or per agent process**, with a label that says where it runs. Then revoking one does not silence everything, and `token list`'s `last seen` tells you which machines are actually alive.
- **Prefer a bot's own name** to the owner's for an agent host. A token naming `sable` can only do what `sable` may do.
- **The environment decides the door, and it is not always what you set in your shell.** The server's wrapper scripts source the server env file themselves, so unsetting a variable in your shell has no effect: the wrapper puts it back. If you need a different door, change the invocation, not the parent shell.

---

## 5. How an agent is told to use it

An agent does not need to know about doors. It needs the right command names in its rules and the ability to run them.

**Claude Code agents** run `cli-board` and `cli-org` through Bash. The tool allowlist that decides what an agent may actually run is the roster's `tools` list, so `Bash(cli-board *)` and `Bash(cli-org *)` are what make the board reachable at all: a rule in a prompt can name a command the agent is not allowed to execute.

**Hermes agents** are a lane of their own. The wake carries the identity; the card is read and closed with the same `cli-board` commands, run as the roster member named in `ORG_AGENT`.

**zen-agent** speaks the board as a backend: the same verbs as tools, a token from the environment, and `zen-agent lane` claiming cards for `runtime: zen-agent`.

Whichever runtime it is, the instruction to load before waking a bot for its first card is the `org-member` skill (`skills/org-member/SKILL.md`): the wake checklist, the card protocol, the rules on giving work, review cards and shipping, and the reference page for when a bot does not answer at all.

Whatever the runtime, the shape of the instruction is the same, and it is worth writing down once:

1. Read the card: `cli-board show <id>`.
2. Do the work.
3. Say what happened on the card: `cli-board comment <id> "…"`.
4. Close it: `cli-board finish <id> --done "<result>"`, or `--blocked <kind> "<why>"` if you are stuck. A run that ends without either is a failure, and the lane will block the card with your last output.
5. A status post in the team channel that names the card id, a path and the command you ran.

### The `hermes kanban` trap

The single most expensive confusion in this system: `hermes kanban` is **not this board**.

| | The engine board | `hermes kanban` |
|---|---|---|
| Backed by | Postgres, on the server | A SQLite file on *that one machine* |
| Seen by | the page, the kiosk, every dispatcher, every bot | only the Hermes instance on that machine |
| Written by | `cli-board`, `cli-org task …` | `hermes kanban …`, and the native `kanban_*` tools inside a Hermes session |

Both use board slugs and `t_` plus hex ids, so a card filed the wrong way reports success and is invisible to everyone else. This has already happened: nine cards, including a five-card epic, sat on one laptop's SQLite board for up to eight days. `--board exo` on the legacy path resolves to a local file *of the same name* rather than erroring, so passing the board name is not a guarantee either.

**The rule: file a card the board should hold only through `cli-board create` or `cli-org task create`, run somewhere with a working door. Never with the plain `hermes kanban` CLI or a native `kanban_*` tool.**

If a card does go missing, do not file it twice. Check whether it exists somewhere first:

```bash
cli-board list --board exo --q "<a distinctive phrase from the title>"
hermes kanban list --archived --json > /tmp/local-board.json     # on the machine that filed it
cli-board import /tmp/local-board.json --board exo --check       # reports "only on Hermes: N"
cli-board import /tmp/local-board.json --board exo               # upserts by id; safe to re-run
```

`import` upserts by the card's own id, so re-running it does not duplicate. It will *not* spot a card re-filed by hand under a different id with the same title: search by title after an import and archive the stale copy yourself. `cli-board import --hermes` does the same thing by calling the local Hermes CLI directly.

---

## 6. Troubleshooting

**`board 401: bad, revoked or missing board token`.** The token is wrong, revoked, or absent, and the request never reached an identity. Check three things in order: that `BOARD_TOKEN` is actually set in the environment of *this* process; that it has not been revoked (`cli-board token list`, which prints metadata and never the token); and that `BOARD_URL` points at the app that holds that token's database. A token from one server does not work on another. Mint a new one, put it in the machine's env file, and revoke the old id in the same sitting so you do not leave two live credentials behind.

**`board 403: <name> can't move <card>` (or "can't unassign").** The read succeeded and the write was refused, which means the door worked and the identity is the problem. The message names the identity the server resolved, so read it literally: if it is not who you think you are, the environment is supplying someone else's identity. The usual causes are a `BOARD_TOKEN` minted for a different roster member, or `ORG_AGENT` left set from an earlier command in the same shell. Note that `cli-org` and `cli-board` on the server source the server env file themselves, so a variable you unset in your shell can come straight back.

**A card that finished still shows `ready` or `running` on the board.** The two writers disagree. `cli-board finish` and `hermes kanban complete` write different records, and a card closed on one side can look open on the other. Check both, then close the stale one:

```bash
cli-board show <id>
hermes kanban --board exo show <id>
```

If the engine already has it `done`, the stale side is the projection: nothing to fix by hand, only the lane's projection step to look at.

**Column order looks wrong: is priority doing this?** Yes, and it is intentional. Cards sort by priority first, then by status bucket, then by creation time, so a priority-1 card in `todo` appears above a default card in `ready`. The board is a queue, and priority-1 means "this jumps". If a card looks like it is in the wrong place, read its priority before assuming the filter is broken.

**A card looks stale on a screen after the data is fixed.** A browser tab, a kiosk or a PWA session that was loaded before a deploy keeps running the old bundle and will not refetch itself; a soft navigation inside the app does not help. Reload it hard. Before re-auditing the database, check two things in this order: does the board actually have the card (`cli-board show <id>`), and when did the app last restart relative to when that screen last reloaded?

**A card is blocked and the reason is gone.** `block_kind` is the honest answer to why. A `dependency` block clears itself when the parent card finishes; everything else clears when a person decides it has. Re-read the reason before moving the card back to `ready`: if the underlying condition still holds, a lane will burn a run and block it again, and two transient blocks on one card is the pattern that triggers the board's auto-decomposer. Then look at what the decomposition produced: it splits the card into several children, and a child does not inherit the caution of its parent's body, so a card that asked for a review path can produce a child that does not have one. If the parent's work touched production, treat every new child as an incident, inspect it, and block the ones that would run on their own.

---

## 7. Where to go next

- [board-design.md](board-design.md) - the architecture: the record and the lanes, the tables, the status machine, the function-per-rule write path, the parity table against the legacy board, the staged rollout and what is deliberately out of scope.
- [modules.md](modules.md#board) - the `board` module: page, CLI, settings, timers, and how it sits next to the org and the tracker.
- [configuration.md](configuration.md) - `BOARD_URL`, `BOARD_TOKEN`, `BOARD_LEASE_MINUTES`, `BOARD_HERMES_PROJECTION`.
- [architecture.md](architecture.md) - where the board's record sits relative to the vault, the index and the other modules.
