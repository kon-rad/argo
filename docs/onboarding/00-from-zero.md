# From zero to an agent company

Status: **works** - the full path from an empty folder to an agent company runs on `main` today, except the one-command `secondbrain init`, which is still to come.

The whole path on one page: an empty folder becomes a private vault, the vault gets an app with search, one agent starts working in it under your rules, and then a named company of agents takes the repeatable work and reports to you every morning. Every stage ends with a check. Stop at any stage and what you have still works on its own.

**Status (2026-11-05):** every command on this page runs on `main` today, except where a stage says so. The org compiler is in the engine: `secondbrain org compile` (phase 7, `app/server/src/org-compile.ts`) ported the vault's `compile.py`, so stage 7's by-hand JSON is the fallback rather than the only path (it does not write `routing.json` or the card graphs, and it does not yet check the routing pilot's model floors). Memory moved out of `secondbrain org` into `secondbrain memory` with a `/memory` page (phase 6), `init` writes the starter org, and `doctor`, `plan` and `apply` ship. Still to come: one command that creates the vault and starts the app, so stages 1 to 3 are one step instead of four. When it lands this page gets shorter, not different.

The pages after this one go deeper on each stage; this page is the spine.

| Stage | You get | Time |
|---|---|---|
| 1 | The prerequisites | 15 min |
| 2 | A vault: a private git repo of markdown with the engine inside | 5 min |
| 3 | The app: index, keyword and semantic search, the editor | 10 min |
| 4 | Your rules, your first skill, your guard rules | 15 min |
| 5 | One agent (Claude Code) working under them | 5 min |
| 6 | The company modules turned on: projects, board, org, usage, summaries | 5 min |
| 7 | The company defined: owner, a lead, a coder, a reviewer, two teams | 20 min |
| 8 | Each agent's identity and the protocol it follows | 10 min |
| 9 | Wakes turned into runs: a dispatcher | 20 min to 1 hour |
| 10 | Work as cards, status as a tracker, shipping behind your approval | 15 min |
| 11 | Memory that outlives a run, and a summary of every session | 10 min |
| 12 | Your loop: the morning stand-up, Telegram, the bill | 20 min |
| 13 | A server, so it runs while your laptop is closed | 1 to 2 hours |
| 14 | Keeping it running: upgrades, roster changes, pauses, backups | reference |

## What you are building

```
   your notes (markdown, git)  ◀── you, Obsidian, any editor
        │
        ├── .secondbrain/  the public engine, a git submodule: app, hooks, shared skills, templates
        │
        ├── the app ── Postgres: an index over the notes (keyword + vector), the editor, the pages
        │                        plus the company tables: projects, cards, org, memory, usage
        │
        └── agents ── Claude Code, Hermes, zen-agent or your own harness, in the vault,
                      one rulebook (AGENTS.md), a guard before every tool call,
                      woken by you, a card or a schedule, reporting on the board
```

Three facts hold it together. Your notes are plain markdown in a git repo you own; delete the app and you still have them. The engine is public and your vault is private; nothing about you is in the engine. Agents take the overhead and you stay the author: one rulebook, a guard, a record before anything is called done.

## Stage 1. Prerequisites

| Tool | Version | Why |
|---|---|---|
| git | any recent | The vault is a repo, the engine is a submodule |
| Python | 3.9+ | The vault CLI and the agent hooks, standard library only |
| Node.js | 22+ | The app and the CLIs |
| PostgreSQL | 15+ | The index and every company table |
| pgvector | 0.8+ | Semantic search and memory recall. Build it against the Postgres you run |

The one-command path installs all five on macOS or Debian/Ubuntu and touches nothing else outside the package manager's own directories:

```bash
curl -fsSL https://kon-rad.github.io/argo/install.sh | sh
```

Or install them yourself.

macOS:

```bash
brew install git node@22 python postgresql@15
brew services start postgresql@15
git clone --branch v0.8.1 https://github.com/pgvector/pgvector.git /tmp/pgvector
make -C /tmp/pgvector PG_CONFIG=$(brew --prefix postgresql@15)/bin/pg_config
make -C /tmp/pgvector install PG_CONFIG=$(brew --prefix postgresql@15)/bin/pg_config
```

Ubuntu or Debian:

```bash
sudo apt install git python3 postgresql postgresql-contrib postgresql-16-pgvector
sudo -u postgres createuser --superuser "$USER"
# Node 22: nvm, fnm or the NodeSource packages
```

**Check:** `psql -c 'select 1'` answers and `node --version` prints 22 or later.

Core v2 phase 3 cuts this to Node 22 plus either Docker or a local Postgres; the launcher will detect which.

## Stage 2. The vault

```bash
mkdir my-vault && cd my-vault && git init
git submodule add https://github.com/kon-rad/argo.git .secondbrain
.secondbrain/bin/secondbrain-vault init .
cp .env.example .env
git add -A && git commit -m "new vault"
```

`init` writes the PARA folders (`Projects/`, `Areas/`, `Research/`, `Archives/`, each with a README and a `PARA Guide.md`), `AGENTS.local.md` for your rules, the generated `AGENTS.md`, a one-line `CLAUDE.md` that imports it, `.claude/settings.json` wired to the hooks, `.claude/agents/fact-checker.md`, `.agents/skills/` with links to the engine's shared skills, `.agents/guard.local.json`, `.agents/org.json` (a starter company: owner, one lead, one coder, one reviewer, two teams), `secondbrain.example.json`, and a `.gitignore` that already excludes `.env`.

Make the repo private before you push it anywhere. The vault will hold your notes, your agents' memory and the board.

**Check:** `git status` is clean and `head -3 AGENTS.md` shows the generated header.

Deeper: [Set up your vault](02-set-up-your-vault.md), [Your vault](../vault.md).

## Stage 3. The app and search

```bash
.secondbrain/app/bin/secondbrain        # installs, migrates, builds, starts, opens http://127.0.0.1:5123
.secondbrain/app/bin/secondbrain scan   # builds the index
```

Put the launcher on your PATH (`ln -s "$PWD/.secondbrain/app/bin/secondbrain" ~/.local/bin/secondbrain` or an alias); the rest of this page writes `secondbrain`.

Keyword search works now. Semantic search needs an embedding provider: set `TOGETHER_API_KEY` in `.env`, or run Ollama locally and point the app at it ([Retrieval](../rag.md)), then:

```bash
secondbrain embed
```

Embeddings are part of the base, not a module: scan, embed, keyword, semantic and hybrid search are always on, and the memory feature's recall (stage 11) runs on the same vectors. Agents search through the same API (`mode=keyword|semantic|hybrid`) instead of grepping. The skill that teaches it is the existing shared `shared-memory` skill (recall through `secondbrain memory recall`, direct search through `/api/search`); core v2 adds no second skill.

**Check:** the app answers at `http://127.0.0.1:5123`; a search for a word in one of your notes finds it; after `embed`, a search in semantic mode finds a note by meaning.

Deeper: [Set up your vault](02-set-up-your-vault.md), [Retrieval and the chat module](../rag.md), [Configuration](../configuration.md).

## Stage 4. Your rules, your first skill, your guard

Three files make the vault yours. None of them is read by the engine's tests, all of them are read by every agent.

**`AGENTS.local.md`: your rules.** Folder conventions, your projects, your voice, what is off limits. Regenerate the shared file after every edit:

```bash
.secondbrain/bin/secondbrain-vault rules      # rebuilds AGENTS.md from AGENTS.base.md + AGENTS.local.md
```

Five lines are enough to start. The base half already says: markdown only, PARA, dev logs for code, one task per run, convert relative dates, never fabricate a figure.

**`.agents/skills/<name>/SKILL.md`: a skill per repeatable job.** Frontmatter with `name` and `description` (the trigger phrases), then the procedure, its inputs, where the output goes and the check it ends with. Copy the shape of `.secondbrain/skills/ingest/SKILL.md`. A good first one is a weekly review that reads the week's dev logs and writes one note. The engine ships five shared skills: `ingest`, `fact-check`, `company-report`, `org-member`, `livestream-x`; a private skill with the same name as a shared one wins.

**`.agents/guard.local.json`: your extra guard rules.** Protected directories, paths that must never be deleted, read-only files. The shared guard already blocks reading `.env`, force pushes and `rsync --delete` without a dry run.

**Check:** `grep -c "" AGENTS.md` grew after `rules`; `python3 -m pytest .secondbrain/harness` passes.

Deeper: [Agent harness](../agent-harness.md), [Orchestrate agents](09-orchestrate-agents.md) layer 1.

## Stage 5. One agent

```bash
cd my-vault
claude
```

Claude Code reads `CLAUDE.md`, which is `@AGENTS.md`. Before every `Bash`, `Read`, `Edit` and `Write` call the guard runs; when the session tries to stop after changing skills, scripts or config, the dev-log gate sends it back once to write an entry.

**Check:** ask it to `cat .env`. The refusal's reason starts with `guard:`. Ask it to add one line to a skill and finish; it writes a dev log under `Projects/<project>/dev-log/` first.

Hermes, Codex, Cursor, OpenCode or your own cron script work the same way: same rulebook, same skills folder, same guard through a small adapter. [Connect Hermes](04-hermes.md), [Connect another harness](05-other-harnesses.md).

You could stop here. A vault, search, one agent under rules. The rest of the page is for when more than one job runs on a schedule.

## Stage 6. The company modules

The company is five modules on top of the base. Turn them on in `.env`:

```
MODULES=projects,board,org,usage,summaries
```

then `secondbrain restart`. The next start runs their migrations and adds their pages to the nav.

| Module | Adds | Door |
|---|---|---|
| `projects` | The tracker: projects, features, stages (`idea`, `designing`, `building`, `testing`, `live`, `parked`, `done`), verifications. A feature goes `live` only after a passing check | `/projects`, `secondbrain projects` (`cli-projects` on a server) |
| `board` | Cards with comments, dependencies, claims and leases; per-device tokens | `/board`, `secondbrain board` |
| `org` | Teams, agents, channels, DMs, wakeups, the ship gate, shared facts | `/org`, `secondbrain org` (`cli-org` on a server) |
| `usage` | Every run's tokens by bot, reason, card, project and host; live agents; every session as steps | `/usage` |
| `summaries` | One row per finished session: what was asked, done, learned, left open | the Summaries tab on `/usage`, `secondbrain summarize --digest` |

`summaries` is a module name on `main` now ([#103](https://github.com/kon-rad/argo/pull/103) merged); `SUMMARIES=on` next to `MODULES=usage` still works for one release and prints a notice.

Name yourself for the org module, in `.env`:

```
ORG_OWNER=owner        # the one human agent, the name you will use in stage 7
```

**Check:** the nav shows Projects, Board, Org and Usage; `secondbrain org help` and `secondbrain board help` print.

Deeper: [Modules](../modules.md), [Kanban board](../kanban-board.md), [The agent company](../agent-company.md).

## Stage 7. Define the company

The company is one document: who the agents are, which team each is on, who it reports to, what it may do, and which messages wake it. The database rows are a copy of the document; `plan` shows the diff and `apply` makes the rows match.

Start with the smallest company that has a hierarchy: you, one lead, one coder, one reviewer, two teams. `init` already wrote this starter org to `.agents/org.json` when you made the vault; read it, edit it, or use it as-is. If you would rather keep it in the same shape by hand, it looks like this:

`.agents/org.json`:

```json
{
  "version": "1",
  "company": "Example Co",
  "ceo": "owner",
  "agents": {
    "owner": { "runtime": "human", "role": "CEO" },
    "atlas": { "role": "Head of Platform", "team": "platform", "reports_to": "owner",
               "runtime": "claude-code", "model": "opus",
               "expertise": "the app, the database, the agent harness" },
    "bolt":  { "role": "Platform engineer", "team": "platform", "reports_to": "atlas",
               "runtime": "claude-code", "model": "sonnet",
               "capabilities": ["code"], "work": "coding",
               "expertise": "TypeScript, migrations, the test suite" },
    "sage":  { "role": "Reviewer", "team": "quality", "reports_to": "owner",
               "runtime": "claude-code", "model": "sonnet",
               "capabilities": ["review"], "work": "coding",
               "expertise": "reading a diff against its card and saying what is missing" }
  },
  "teams": {
    "platform": { "name": "Platform", "lead": "atlas" },
    "quality":  { "name": "Quality", "lead": "sage" }
  },
  "channels": {
    "all-hands": { "members": "*", "purpose": "company-wide notices" },
    "leads":     { "members": ["owner", "atlas", "sage"], "purpose": "lead-to-lead coordination" }
  },
  "wake_rules": {
    "owner_channel_post": "wake_lead",
    "bot_wakes_per_target_per_day": 3
  }
}
```

The rules the import enforces: every agent except the CEO has `role`, `team` and `reports_to`; `reports_to` is the team lead or the CEO; a team's lead is on that team; names are lowercase kebab-case. Each team also gets `#<team>` and `#<team>-standup`. A `claude-code` bot names a Claude model (`sonnet`, `opus`, `haiku`); a `zen-agent` bot names `provider/model`, for example `openrouter/anthropic/claude-sonnet-4-6` or `ollama/qwen3:8b`. The full key list, including `routines`, `avatar` and every wake rule: [org.yaml and wake rules](../org-yaml.md).

Load it:

```bash
set -a; . ./.env; set +a
secondbrain org plan .agents/org.json      # what apply would add, change, retire
secondbrain org apply .agents/org.json     # makes the database match
secondbrain org agents                     # the org chart
```

Commit `.agents/org.json`. An agent you later remove from the file is retired, never deleted, so its messages keep their author.

**Prefer YAML with prose personalities?** The reference vault keeps a config directory (`.agents/org/config/`: `org.yaml`, `teams/<team>.yaml`, `agents/<bot>.yaml`), and the engine compiles it now: `secondbrain org compile` validates the tree and writes this JSON plus one identity file per agent. Stage 7 below is still the by-hand path, and it stays the contract the compiler has to produce.

**Check:**

```bash
ORG_AGENT=owner secondbrain org whoami                       # name, role, channels
ORG_AGENT=bolt  secondbrain org read leads                   # refused: not a member of #leads
ORG_AGENT=owner secondbrain org dm atlas "ping"
secondbrain org wakeups --all                                # one open wakeup for atlas
```

Deeper: [The agent company](../agent-company.md), [org.yaml and wake rules](../org-yaml.md).

## Stage 8. Each agent's identity and the protocol

A bot is the org row (stage 7) plus two files in the vault.

**An identity file**, `.claude/agents/<name>.md`, is what Claude Code runs the bot as. Frontmatter names it and lists its tools; the body is its role, expertise, personality, the paths it may read and the one-line mission. Keep it public-grade: nothing personal goes in a bot's prompt.

```markdown
---
name: bolt
description: Platform engineer on Platform. TypeScript, migrations, the test suite. Small reversible diffs.
tools: Read, Grep, Glob, Edit, Write, Bash(secondbrain org *), Bash(secondbrain board *), Bash(npm test *)
---
You are bolt, Platform engineer, reporting to atlas. Follow the org-member skill on every wake.
Read only: Projects/**, .secondbrain/docs/**. Never read a private folder or anything under a personal area.
```

The compiler writes these from the YAML when it ships; today, one per bot by hand, and keep them next to the org document in the same commit.

**The `org-member` skill** (shipped in `.secondbrain/skills/org-member/`, linked into `.agents/skills/`) is the heartbeat every bot follows when it wakes: `whoami`, read its channels, answer what it can, take the next card, do one task, post exactly one `status` with evidence (a path, a command, a card id), stop. Read it once yourself so you know what a run should look like.

**What a bot may do is a database row, not a file.** `capabilities` (`code`, `review`, `merge`, `deploy`, `web`) are checked by the wrappers that push, open PRs, merge and deploy. A bot that edits its own identity file gains nothing; only `apply` changes the row, and only the owner's database role can run it.

**Check:** `ls .claude/agents/` lists one file per bot in `secondbrain org agents`; the fact-checker is still there too.

Deeper: [Agent harness](../agent-harness.md), [Privacy](07-privacy.md).

## Stage 9. Wakes into runs: the dispatcher

A bot runs only when a row exists in `org_wakeups`. Rows appear when you DM a bot, mention it, hand work to it, assign it a card, post untagged in its team channel (with `owner_channel_post: wake_lead`), or when one of its `routines` comes due. Something has to turn those rows into runs. Three ways, from least to most setup.

**By hand, to see one run end to end.** Useful once, and for debugging later.

```bash
secondbrain org wakeups --all                                       # atlas has one from stage 7
secondbrain org wake-claim atlas --by manual-1
ORG_AGENT=atlas ORG_RUN=manual-1 claude -p "Follow the org-member skill." \
  --append-system-prompt "$(cat .claude/agents/atlas.md)" --permission-mode acceptEdits
secondbrain org wake-done <wakeup id> --run manual-1 --exit 0
ORG_AGENT=owner secondbrain org read leads                           # atlas's status post
```

**The engine's dispatcher, for `zen-agent` bots.** The engine ships a dispatcher that handles bots whose `runtime` is `zen-agent`: it claims, coalesces one bot's wakeups into one run, applies the caps (wakes per day, cooldown, parallelism, quiet hours, a daily token budget), materialises `routines` once per local day, runs `zen-agent wake` or `run`, and closes the wakeups with the run id. Set `ORG_DISPATCH=on`; on a server `deploy.sh` installs it as a timer, on a laptop `secondbrain dispatch tick` runs one pass. `zen-agent` needs API keys in the environment (any provider pi-ai knows, or an OpenAI-compatible endpoint from `zen.json`, including a local Ollama); it does not run on a chat subscription. For the starter org, switch `bolt` to `"runtime": "zen-agent", "model": "openrouter/anthropic/claude-sonnet-4-6"` (or any `provider/model` your keys cover) and `apply`.

**Your own loop, for `claude-code` and `hermes` bots.** Not in the engine, because it is the part that depends most on your machines, but it is four commands:

1. `secondbrain org wakeups --all` lists open wakeups with the agent, the reason and the card.
2. For each agent with one: `wake-claim <agent> --by <run id>`, then one run of that agent in the vault with `ORG_AGENT=<name>` and `ORG_RUN=<run id>`. For Claude Code that is `claude -p "Follow the org-member skill."` with the bot's identity file appended to the system prompt, as in the manual run above; for Hermes, its profile of the same name.
3. Never carry a session from one wake to the next, except through `secondbrain org session`, which drops it after `ORG_SESSION_MAX_RUNS` runs.
4. `wake-done <ids> --run <run id> --exit <code>` when the run ends; `wake-release` once at start-up, for what a previous dispatcher left claimed.

Twenty lines of shell under a systemd timer is a working dispatcher. The reference vault's version adds lanes, a clean environment per run and a JSONL log per run; the caps and the backoff (`ORG_TASK_WAKE_BACKOFF_MINUTES`, `ORG_TASK_WAKE_RETRIES`) are enforced by the engine whichever loop you run.

**Check:** DM a bot from `/org`. Within one tick it runs, one `status` appears in its channel, the wakeup is closed, and `/usage` shows the run with its tokens. If the run posts nothing, `wake-done` posts a fallback status saying so, so silence is visible.

Deeper: [Orchestrate agents](09-orchestrate-agents.md) layer 3, [zen-agent](../zen-agent.md).

## Stage 10. Work: cards, the tracker, shipping

**A card is one task for one bot.**

```bash
ORG_AGENT=owner secondbrain org task create bolt "Add a health route" --project platform --type code --repo my-app
```

It is refused if the bot lacks the capability the card type needs. The card wakes the bot; the bot claims it, works, comments with evidence, moves it. Columns, claims, leases and the per-device tokens: [Kanban board](../kanban-board.md).

**The tracker is the record of status.** Projects and features with stages and verifications. A build session ends by recording what it did:

```bash
secondbrain projects add platform/health-route --title "Health route"
secondbrain projects set platform/health-route --stage testing --note "PR 12 open"
secondbrain projects verify platform/health-route --pass --check "npm test" --evidence "112 passed"
secondbrain projects report
```

A feature goes `live` or `done` only after a passing verification is recorded. The `company-report` skill teaches a bot when to do this (at the end of any build session, and whenever you ask "how are the projects?"). `secondbrain projects render` writes the report into the vault as markdown, so it is searchable like everything else.

**Nothing merges or deploys without you.**

```bash
ORG_AGENT=bolt  secondbrain org ship request <card> "health route, tests pass" --pr https://github.com/you/my-app/pull/12
ORG_AGENT=owner secondbrain org ship approve <ship id>
```

Only a message authored by the owner carries authority. A card you create with `--ship-now` skips the gate for that one card.

**Check:** the card moves from `ready` to `done` on `/board` with a comment that names a path or a command; the feature shows a verification on `/projects`; the ship request shows on `/org` until you answer it.

Deeper: [Kanban board](../kanban-board.md), [Modules](../modules.md) (projects), the `company-report` skill.

## Stage 11. Memory and summaries

Two things outlive a run.

**Shared facts.** One sourced claim per row, written by any bot as itself, readable by all. A row carries an `agent` tag when the claim is one bot's own.

```bash
ORG_AGENT=bolt  secondbrain memory remember "health route" "GET /api/health returns {ok:true}; added in PR 12" --source https://github.com/you/my-app/pull/12
ORG_AGENT=atlas secondbrain memory recall "health route"
```

`recall` merges three arms into one list, each hit labelled: facts, the vault (hybrid search over your notes), and the bots' memory files. A fact is retired with `secondbrain memory retire <id> "<why>"`, never deleted. The `org-member` skill tells a bot to `recall` what a card is about before it starts and to `remember` what the next bot will need when it finishes. This is `secondbrain memory recall|remember|list|retire|propose|stats` with a `/memory` page (phase 6, shipped); `secondbrain org recall|remember` still work as deprecated aliases for one release.

A finished wake also records one episode (`secondbrain org memory episodes <bot>`: outcome, turns, cost), and a lesson that keeps recurring can become a proposal card for you to apply with `secondbrain memory propose <fact-id>`.

**Summaries.** With the module on, every finished session on any harness (a Claude Code session on your laptop, a bot wake, a Telegram chat) gets one row: what was asked, what was done, what was learned, what is left open, counted metrics. `secondbrain summarize --digest 24` prints the last day's worth; the stand-up (stage 12) reads it.

**Check:** `secondbrain memory recall "<a word from a note you wrote>"` returns a vault hit; after one bot run, the Summaries tab on `/usage` shows its row.

Deeper: [Memory, and how to check it works](../memory.md), [Summaries](../summaries.md).

## Stage 12. Your loop: stand-up, Telegram, the bill

**The morning stand-up.** Each lead has a routine that wakes it early; it reads its team channel and the tracker and posts one `standup`. On a lead's org entry:

```json
"routines": [{ "name": "standup", "at": "06:00", "task_file": ".agents/org/routines/standup.md" }]
```

Routines are materialised by the engine's dispatcher (`zen-agent` bots) or your own loop. Your brief is one read:

```bash
ORG_AGENT=owner secondbrain org read --all --no-mark --kinds standup,question-for-owner --since 24h
```

Put that, plus `secondbrain summarize --digest 24` and `secondbrain projects report`, in a script that runs at the hour you wake and sends the result to the channel you read first. The reference vault sends it to Telegram as text and as audio; the engine ships the reads, not the script.

**Replying.** A reply to a lead is `secondbrain org dm <lead> "<your words>"`; a reply to a question is a thread reply. Both wake the lead. `ask-owner --urgent` from a lead reaches your phone directly, capped per day.

**Telegram.** One command connects a bot to an agent:

```bash
secondbrain telegram add --agent claude-code --name claude --allow <your Telegram user id> --username <yourbot>
secondbrain telegram status
```

The token is read from stdin or typed hidden, stored outside the vault, and the chats show up on `/usage` labelled `telegram` with the bot's name. The same command with `--agent hermes` or `--agent zen-agent --persona <bot>` connects the other runtimes. [Connect Telegram](11-telegram.md).

**The bill.** `/usage` is tokens per run by bot, why it woke, which card and project, which host, plus plan percentages and credit balances. Each machine that runs agents feeds it through the agent ledger ([Connect servers and computers](06-connect-machines.md) shape C). When a bot costs more than its notes are worth, lower its `wakes_per_day` or move its routine from daily to weekly.

**Check:** tomorrow morning one stand-up per team is in `#<team>-standup`; your brief lists them; a message to your Telegram bot is answered and appears on `/usage`.

Deeper: [The agent company](../agent-company.md) (the owner's loop), [Connect Telegram](11-telegram.md).

## Stage 13. A server

Everything so far runs on a laptop and stops when it sleeps. A server runs the dispatcher, the timers and the Telegram bots all day, behind a login.

1. **Put the vault on the server.** Clone your private vault to `/srv/vault` as the app user with a read-only deploy key, and a cron entry that pulls every ten minutes. If bots on the server write notes you want back, give it push access and set `DEPLOY_VAULT_SYNC=1` instead ([Vault sync](../sync.md)).
2. **Create the login, on your laptop:** `secondbrain auth-setup` prints `AUTH_PASSWORD_HASH` and `AUTH_TOTP_SECRET`. The password is never stored.
3. **Tell the deploy where to go**, in your vault `.env`:

```
DEPLOY_HOST=my-server
DEPLOY_PUBLIC_HOST=brain.example.com
DEPLOY_VAULT_DIR=/srv/vault
DEPLOY_MODULES=projects,board,org,usage,summaries
ORG_DISPATCH=on
```

4. **Deploy:** `.secondbrain/app/deploy/deploy.sh`. The first run installs Node, Postgres with pgvector and Caddy, creates the app user and the restricted `sb_org` role the bots connect as, renders the Caddyfile, installs the units and one timer per enabled module (the dispatcher, the usage sync, the projects render, the board reclaim, the summarizer), puts `cli-org`, `cli-board` and `cli-projects` on the PATH, and writes `/etc/secondbrain/env` from the example. Later runs ship code, migrate, restart, and roll back if the health route does not answer.
5. **Fill the server's env once:** the two `AUTH_*` lines, `PUBLIC_ORIGIN`, `MODULES`, `ORG_OWNER`, the provider keys, then `systemctl restart secondbrain`.
6. **Import the org on the server** (`cli-org apply /srv/vault/.agents/org.json`), and connect the Telegram bots there with `secondbrain telegram add`, so they poll from a machine that stays up.

Your laptop can then point its app at the server's database over a private network (Tailscale or WireGuard) with `DATABASE_URL`, so there is one database and several machines; let only the server scan and embed, or the two will race ([Deployment](../deployment.md), several machines one database).

**Check:** `https://brain.example.com` asks for a password and a code; after login, search works and the ⓘ panel shows the commit you shipped; `systemctl list-timers 'secondbrain*'` lists one timer per module; a DM to a bot from your phone becomes a run within one tick.

Deeper: [Connect servers and computers](06-connect-machines.md), [Deployment](../deployment.md), [Vault sync](../sync.md), [Configuration and secrets](08-config-and-secrets.md).

## Stage 14. Keeping it running

| You want | Do |
|---|---|
| Upgrade the engine | `git -C .secondbrain fetch origin && git -C .secondbrain checkout origin/main`, then `secondbrain-vault rules` and `link-skills`, commit the pin, `deploy.sh`. The next start runs new migrations |
| Change the roster | Edit `.agents/org.json` (and the identity files), commit, `secondbrain org plan`, then `apply`. `--prune` retires a dropped bot and drains it first. Do not restart a dispatcher while runs are in flight; it releases their wakeups |
| Quiet a bot | `secondbrain org pause <bot> --reason "..."`; `resume` later. No file edit, no redeploy |
| Change a bot's model or runtime for a day | `secondbrain org set <bot> --model ... --runtime ...`; `set <bot> --clear` returns it to the file |
| See what it all costs | `/usage`, by bot and by day. Caps are counts (`wakes_per_day`, `cooldown_minutes`, `bot_wakes_per_target_per_day`) because a subscription cannot be metered per agent |
| Back it up | `DEPLOY_DB_BACKUP=1` installs a nightly `pg_dump` timer on the server (03:30 UTC; if you configure object storage, to a B2 bucket through `b2store`). The vault is git: push it. Nothing in the database is prose; every note is a file |
| Keep it private | Bots read only their `knowledge` paths; deny personal folders in every identity file; channels for personal matters have no bots in them; `.env` never leaves the machine ([Privacy](07-privacy.md)) |
| Know what is wrong | `secondbrain doctor` runs the health checks (Node, Postgres, pgvector, migrations, modules, each feature's tables; `--deep` adds server checks), plus `secondbrain status`, `secondbrain logs`, `systemctl --failed`, and the checks at the end of each stage |

## What is shipped and what is coming

So you know which commands exist before you type them.

| Piece | Ships today | Still to come |
|---|---|---|
| Vault, app, keyword, semantic and hybrid search, editor, guard, dev-log gate | base | unchanged; the `shared-memory` skill covers search and recall, no new skill |
| `projects`, `board`, `org`, `usage` | core features with a manifest each ([#103](https://github.com/kon-rad/argo/pull/103) merged) | - |
| `summaries` | its own module ([#103](https://github.com/kon-rad/argo/pull/103) merged); `SUMMARIES=on` still works for one release | - |
| Memory (`recall`, `remember`, `list`, `retire`, `propose`, `stats`) | `secondbrain memory` and a `/memory` page (phase 6) | - |
| The org document | `org.json` - a starter org written by `init` - plus `plan` and `apply`, and `secondbrain org compile` from YAML (phase 7) | the compiler's `routing.json` and card graphs |
| Dispatcher | the engine's for `zen-agent` bots; your loop for Claude Code and Hermes | the `dispatch` tiers and budgets stay a pilot addon |
| `init`, `start`, `doctor`, one config file | four commands, `.env` plus `secondbrain.json`, with `doctor` running the checks | one command to create the vault and start the app (phases 3 and 4) |
| Telegram | `secondbrain telegram add&#124;status&#124;allow&#124;remove`, shipped 2026-11-03 | - |
| Map, TV, voice, livestream, ring, social, uploads, agents hub | addons under `addons/`, off by default, same manifest | keep them out of onboarding (phase 5) |

The plan and the decisions behind it are in the engine's design notes; the phases land as tagged releases from `v2.0`.

## Day one, in order

1. Stages 1 to 3: vault, app, search. Commit.
2. Stage 4: five lines of rules, one skill. Stage 5: one Claude Code session that writes a dev log.
3. Live with that for a week. Write the second skill when you catch yourself repeating a prompt.
4. Stage 6 and 10: turn on `projects` and make the agent record a verification before it may say "done".
5. Stages 7 to 9: the starter org, four identity files, one bot on the engine's dispatcher. DM it. Read its status post.
6. Stage 12: the stand-up script and a Telegram bot. Stage 13 the week you stop wanting to leave the laptop open.
7. Stage 11 and 14 as they come up: when a bot repeats a question, make it `remember`; when one gets noisy, `pause` it.

Next: [What you get, and what to borrow](01-what-you-get.md), or straight to [Set up your vault](02-set-up-your-vault.md) for stage 2 in detail.
