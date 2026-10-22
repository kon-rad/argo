# secondbrain

**An exocortex you own.** Your notes, your projects, your agents and your body's data in one private place: plain markdown in a git repo you control, an app that searches and maps it, and agents that work inside it under rules you write.

Computing is turning into an exocortex: memory, perception and judgment running partly outside your head. That is happening either way. The open question is who holds the keys. If the exocortex belongs to an ad company, it is the most complete record of your inner life ever kept, and it isn't yours. If it belongs to you, it is the biggest upgrade to human agency since writing. This repo is the engine for the second kind.

## What it's for

- **Remember your life, on your terms.** Everything is markdown in a [PARA](vault-template/PARA%20Guide.md) vault (Projects, Areas, Research, Archives). No proprietary format, no lock-in: it opens in any editor, syncs with git, and outlives the app.
- **Find anything, and see the shape of it.** Keyword and semantic search over the whole vault, a database page you can ask questions in plain language, and a 3D brain map of how your notes, projects and goals connect.
- **Put agents to work without handing them the keys.** Claude Code and Hermes work in the vault under one set of rules (`AGENTS.md`), with hooks that block reading your secrets, force pushes and other mistakes, and that ask for a dev log before an agent calls a job done.
- **Run a company of agents, if you want one.** Optional modules add a project tracker, a message board where named agents report to you, and a ledger of what they cost.
- **Stay the author.** Agents take the overhead. The writing, the reflection and the decisions stay with you.

Private by construction: the engine never sees your notes. Your vault is your own private repo, and this public repo plugs into it as a submodule.

## Made to be worn: Exo

The second brain is half of a pair. The other half is **Exo**, a modular wearable computer: display glasses, earbuds and a few keys on a sling, built around a Raspberry Pi, that you hold a button and talk to. Details and the waitlist: https://exo.myargoquest.com <!-- public-ok -->

The two share one design rule: the agents are yours, the data is yours, and nothing important moves without you. Together they make a loop:

| Exo (on you) | secondbrain (your vault and server) |
|---|---|
| Push-to-talk to your own agents, wherever you are | The agents' memory, skills and rules live here |
| A ring and body sensors capture what your body is doing | The `ring` module stores that data next to your notes |
| A small screen for glanceable views | The projects feed, and the map and tv kiosk views (`?kiosk=1`) |
| Thin client: it carries nothing worth stealing | Everything lives in your vault and your database |

You don't need Exo to use secondbrain: it runs the same on a laptop or a small server. Exo is where it's heading, an exocortex that leaves the screen.

## What's in the box

| Path | What |
|---|---|
| [`app/`](app/README.md) | The web app: browse your vault with wikilinks and backlinks, search it (keyword, semantic, hybrid), edit notes safely, and ask the database page questions in plain language. Runs on your laptop with no login, or on a server behind Caddy with password + authenticator login |
| [`vault-template/`](vault-template/) | A PARA vault with the shared agent rules (`AGENTS.base.md`), settings templates and folder READMEs, ready to fill |
| [`harness/`](docs/agent-harness.md) | Hooks Claude Code and Hermes both run: a guard against dangerous tool calls, and a gate that asks for a dev log before an agent finishes. Plus a read-only fact-checker subagent |
| [`skills/`](skills/) | Shared agent skills (`SKILL.md`, used by both Claude Code and Hermes): `fact-check`, `ingest`, `company-report`, `org-member`, `livestream-x` |
| `bin/secondbrain-vault` | Starts a vault, compiles its `AGENTS.md`, links the skills |
| [`addons/tv-kiosk/`](addons/tv-kiosk/README.md) | Flash a Raspberry Pi that shows the app full screen on a TV |
| [`docs/`](docs/README.md) | How it all works, how to set it up, every setting |

### Modules

Everything beyond browse, search and the database page is an optional module, off until you list it in `MODULES`:

| Module | Adds |
|---|---|
| `projects` | A project tracker with stages and verifications, a CLI for agents, a kiosk feed |
| `org` | A message board where a company of named AI agents reports to you |
| `agents` | A kanban board, agent chats and cron history |
| `usage` | What your agents cost, by bot, task and project |
| `map` | A 3D brain map of your notes, projects and goals, with metrics |
| `tv` | Your own video channel, played from episodes in your vault |
| `voice` | Read notes aloud with a local speech server |
| `livestream` | Stream stats for YouTube, Twitch and Kick |
| `ring` | Wearable ring data, stored next to your notes |
| `fund` | A read-only page for an agentic fund: wallet balances, transactions, pending approvals, committee health |

Details for each: [docs/modules.md](docs/modules.md).

## How it fits together

Your notes live in **your own vault**, a private git repo. This repo is the **engine**, added to the vault as a git submodule at `.secondbrain/`. You pull engine updates by moving the pin; the engine never sees your notes.

```
my-vault/                      private
├── .secondbrain/              this repo, pinned
├── AGENTS.local.md            your rules for agents
├── AGENTS.md                  generated: shared rules + yours
├── CLAUDE.md                  @AGENTS.md
├── .agents/skills/            your skills + links to the shared ones
├── .agents/guard.local.json   your extra guard rules
├── secondbrain.json           optional: metrics, map folders, channels
├── .env                       your settings and keys (gitignored)
└── Projects/ Areas/ Research/ Archives/
```

| | The engine (this repo) | Your vault |
|---|---|---|
| Visibility | Public, MIT | Private |
| Holds | Code, template, hooks, shared skills | Notes, settings, keys, your rules and skills |
| Changes by | Pull request | Your own commits |

Markdown is the source of truth. Postgres is an index over it: drop the database, rescan, lose nothing. More in [docs/architecture.md](docs/architecture.md).

## Requirements

- git, Python 3.9+
- Node.js 22+
- PostgreSQL 15+ with [pgvector](https://github.com/pgvector/pgvector) 0.8+
- Optional: a [Together AI](https://together.ai) key or a local [Ollama](https://ollama.com) for semantic search
- Optional: [Claude Code](https://claude.com/claude-code) or Hermes, for agents

## Quick start

```bash
mkdir my-vault && cd my-vault && git init
git submodule add https://github.com/kon-rad/secondbrain.git .secondbrain
.secondbrain/bin/secondbrain-vault init .
cp .env.example .env
git add -A && git commit -m "new vault"

.secondbrain/app/bin/secondbrain        # installs, migrates, builds, starts, opens the browser
.secondbrain/app/bin/secondbrain scan   # build the index
```

The app runs on `http://127.0.0.1:5123`. The full walk-through, with installing Postgres and pgvector on macOS and Linux: [docs/getting-started.md](docs/getting-started.md).

## Agents in your vault

Open the vault in Claude Code, or point Hermes at it, and they work under the same rules:

- **One rulebook.** `AGENTS.md` is the engine's shared rules plus your `AGENTS.local.md`, compiled by `secondbrain-vault rules`. `CLAUDE.md` imports it.
- **A guard before every tool call.** It blocks reading your secrets, force pushes and deploys without a dry run, plus whatever you add in `.agents/guard.local.json`.
- **A dev log before "done".** If an agent changed skills, scripts or config, it's sent back once to write down what it did.

Setup for each agent: [docs/agent-harness.md](docs/agent-harness.md).

## Running it on a server

`app/deploy/deploy.sh` turns an Ubuntu box into a private, logged-in copy of your second brain: Postgres with pgvector, Caddy with HTTPS, systemd units, and a timer for each module you enable. Run it from your laptop; the server needs no GitHub access. See [docs/deployment.md](docs/deployment.md).

## Updating

```bash
git -C .secondbrain fetch origin
git -C .secondbrain checkout origin/main        # or a tag, or a commit
.secondbrain/bin/secondbrain-vault rules        # refresh AGENTS.md
.secondbrain/bin/secondbrain-vault link-skills  # pick up new shared skills
git add .secondbrain AGENTS.md .agents/skills && git commit -m "engine: update"
```

The launcher rebuilds and runs new migrations on the next start. More in [docs/vault.md](docs/vault.md#updating-the-engine).

## Documentation

| Doc | |
|---|---|
| [Getting started](docs/getting-started.md) | From nothing to a running vault |
| [Architecture](docs/architecture.md) | Engine and vault, the app and its index, the harness, data flow |
| [Your vault](docs/vault.md) | The template, `secondbrain-vault`, rules and skills, updating |
| [Configuration](docs/configuration.md) | Every env variable and `secondbrain.json` key |
| [Modules](docs/modules.md) | Each optional feature: pages, CLIs, settings, timers |
| [Agent harness](docs/agent-harness.md) | The guard, the dev-log gate, Claude Code and Hermes wiring |
| [Deployment](docs/deployment.md) | A server behind a login |
| [Privacy](docs/privacy.md) | How the engine stays free of personal data |
| [The app](app/README.md) | Tech stack, search design, invariants |

## Status

Early and moving fast. It runs one person's second brain every day, on a laptop and a server, with a company of agents working in it. Expect rough edges for anyone else's setup, and please open an issue when you hit one.

## Contributing

Bug reports, fixes, docs and skills are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first; AI coding agents read [AGENTS.md](AGENTS.md). Security issues: [SECURITY.md](SECURITY.md), privately.

## License

[MIT](LICENSE)
