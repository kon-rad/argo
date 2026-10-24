# What you get, and what to borrow

secondbrain is two things in one repo: a **knowledge base** you own outright, and an **agent orchestrator** that works inside it under rules you write. This page is for someone deciding whether it fits, and for someone who wants to steal the good parts for their own notes, app or company without installing any of it.

## The knowledge base

| You get | How |
|---|---|
| Notes that outlive every tool | Plain markdown in a git repo, organised with [PARA](https://github.com/kon-rad/secondbrain/blob/main/vault-template/PARA%20Guide.md) (Projects, Areas, Research, Archives). Open it in Obsidian, VS Code, a phone editor or `cat` |
| Search that finds things you forgot the words for | Keyword search (Postgres full text), semantic search (embeddings in pgvector) and a hybrid of both. Semantic search can run fully local with Ollama |
| Links both ways | `[[wikilinks]]` become in-app links, and every note shows its backlinks |
| Questions in plain language | The database page turns a question into read-only SQL over the index and the module tables |
| The shape of your work | A 3D map of notes, projects, divisions and goals, with your own metrics on top |
| Safe editing | An editor with an optimistic lock, so a note an agent changed while you had it open is never silently overwritten |
| Nothing to lose | Postgres is a disposable index. Drop the database, rescan, lose nothing |

## The agent orchestrator

The agents are not in the app. They are Claude Code, Hermes or any other harness you already use, pointed at the vault. What the engine adds is the **operating rules** they all share:

| You get | How |
|---|---|
| One rulebook for every agent | `AGENTS.md` is compiled from the engine's shared base plus your own `AGENTS.local.md`. `CLAUDE.md` is one line that imports it, so Claude Code, Hermes, Codex and others read the same text |
| A guard before every tool call | A stdlib Python hook that blocks reading secret files, force pushes, `rsync --delete` without a dry run, and whatever you add: protected folders, no-delete paths, read-only files |
| A record before "done" | A second hook that sends an agent back once if it changed skills, scripts or config without writing a dev log today |
| Shared skills | Folders with a `SKILL.md` that both Claude Code and Hermes load from the same place. The engine ships `ingest`, `fact-check`, `company-report`, `org-member` and `livestream-x` |
| A read-only reviewer | A fact-checker subagent that verifies a finished note against its sources and returns an evidence table, never an edit |
| Contracts for long tasks | The base rules ask for an outcome, a verification, constraints, boundaries and a stop condition before a long task starts, and `BLOCKED: <reason>` instead of a partial result presented as done |
| A context budget | Rules that keep headless runs cheap: capped output, one task per run, steps written to a file rather than held in context |
| A project tracker (module `projects`) | Projects and features with stages, where a feature goes live only after a passing verification is recorded. Agents update it through a CLI, and the `company-report` skill reads it back |
| A company of agents (module `org`) | Named agents with roles and teams on a message board: channels, DMs, questions waiting on you, cards. Row-level security per agent in Postgres, and wake backoff so a stuck card cannot burn your budget |
| What it all costs (module `usage`) | A ledger of every run by bot, task and project, with plan percentages and API credit balances. A per-machine agent ledger captures each turn locally, redacts secrets, and syncs when it can |

## The infrastructure around it

| You get | How |
|---|---|
| Public engine, private data | The engine is a git submodule inside your private vault, pinned to one commit. Updating is moving the pin |
| One command to run it | `secondbrain` installs, migrates, builds and starts. `scan`, `embed`, `status`, `logs`, `dev`, and a subcommand per module CLI |
| A server you can trust from a phone | `deploy.sh` turns an Ubuntu box into Postgres + Caddy + systemd units, with a mandatory password + authenticator login, and puts the previous build back when a deploy does not come up |
| Optional everything | Every feature past browse, search and the database page is a module that is off by default. Off means no routes, no nav link, no timers |
| Privacy enforced by CI | A leak check for IPs, emails and chat IDs, gitleaks over the full history, and a private denylist for your own names and hosts |
| A screen on the wall | An add-on that flashes a Raspberry Pi into a kiosk showing the app on a TV |

## What to borrow right away

You can adopt these one at a time, in any codebase or note folder, with no dependency on the rest. They are listed in the order most people get value from them.

1. **Split the engine from the data.** Keep code public and reusable, keep the data (notes, keys, rules about you) in a private repo that includes the code as a pinned submodule. Updating is moving a pin, and the code can never leak what it never contained. Pattern: [architecture.md](../architecture.md#1-two-repos-the-engine-and-your-vault).

2. **One `AGENTS.md`, compiled from a shared base and a local override.** Teams, templates and products can ship the base. Each person or repo adds a local file. `CLAUDE.md` is one line, `@AGENTS.md`. A `rules --check` command fails CI if someone hand-edits the generated file. Pattern: [vault.md](../vault.md#rules-for-agents-in-layers).

3. **A guard hook that fails open.** A short standard-library script in front of every tool call catches the mistakes that are expensive and boring: a secret printed into a transcript, a force push, a destructive sync. It matches text, so it is a guardrail and not a sandbox, and it allows anything it cannot parse so a hook bug never stops work. Copy `harness/hooks/guard.py` and its tests as they are. Pattern: [agent-harness.md](../agent-harness.md#the-guard).

4. **A dev-log gate.** "Done" means a human-readable entry exists: what changed, why, how it was tested. The gate only asks once, and the `Resume` block at the top of each project's dev-log README is the handoff between sessions and agents. Pattern: [agent-harness.md](../agent-harness.md#the-dev-log-gate) and the "Dev logs" section of [`AGENTS.base.md`](https://github.com/kon-rad/secondbrain/blob/main/vault-template/AGENTS.base.md).

5. **Completion contracts.** Outcome, verification, constraints, boundaries, stop condition. Written before the task, printed at the end. This is the single cheapest improvement to headless agent runs. Pattern: "Long tasks" in `AGENTS.base.md`.

6. **A context budget in the rules.** Cap output, read with offsets, never dump JSON to scan for a field, one task per run. Headless runs re-send the whole conversation every turn, so this is most of the bill. Pattern: "Context budget" in `AGENTS.base.md`.

7. **Skills as `SKILL.md` folders, shared between harnesses through a symlink.** One folder, both agents. A private skill with the same name as a shared one wins. Pattern: [vault.md](../vault.md#skills).

8. **Markdown as the source of truth, a database as a disposable index.** Rescans with no changes issue zero writes. The index is also the allowlist: a file is served only if the scanner saw it, and credential-shaped files are dropped during the walk. Pattern: [architecture.md](../architecture.md#2-the-app) and the app README's design invariants.

9. **Modules off by default, and nothing personal in code.** Every optional feature is behind one env list. Every value that would differ between two users is read at run time with a default that works for a stranger. CI runs a leak check and gitleaks; you keep a private denylist of your own names. Pattern: [privacy.md](../privacy.md).

10. **No "auth off" on a server.** Loopback is the boundary on a laptop. On a server the app refuses to start without a password hash, a TOTP secret and a public origin. Pattern: [deployment.md](../deployment.md#the-login).

11. **Deploys that put the previous build back.** Keep the running build aside, deploy, poll the health route, restore on failure, report distinct exit codes. Pattern: [deployment.md](../deployment.md#when-a-deploy-does-not-come-up).

12. **Agents that verify before they claim.** In the tracker a feature cannot be `live` without a recorded passing check. On the board a card that keeps waking its agent without finishing is held after a few retries. Pattern: [modules.md](../modules.md#projects) and [modules.md](../modules.md#org).

13. **Measure what agents cost, per run.** Tokens by bot, task, project, host and reason for waking. Decisions about which work to automate get much easier with that table. Pattern: [modules.md](../modules.md#usage) and "Agent ledger" in the app README.

## Who it is for

| You are | Start with | Skip |
|---|---|---|
| Someone with an Obsidian or markdown folder who wants search and an agent that respects it | Pages 1 and 2 of this onboarding | Every module, the server |
| A developer who wants safer coding agents in any repo | Borrow items 2 to 7 above into your repo today; the vault is optional | The app |
| A small business or solo founder who wants a staff of agents with a paper trail | Pages 1, 2, 8, then the `projects`, `org` and `usage` modules | `tv`, `ring`, `livestream` unless they apply |
| A startup building its own agent product | Items 1, 9, 10, 11 above as architecture, the harness as a reference implementation | Running the app for its own sake |

The recipes for each are in [Adapt it](10-adapt-it.md).

## What it is not

- **Not a hosted service.** You run it. There is no account, no sync server, no telemetry.
- **Not a sandbox.** The hooks check the text of tool calls. A script an agent writes can read whatever its Unix user can read. Dangerous things live under a different user.
- **Not multi-user.** One owner, one login. A team shares a vault the way it shares a repo.
- **Not finished.** It runs one person's second brain every day, on a laptop and a server. Expect rough edges and open an issue when you hit one.
