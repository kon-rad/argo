# Argo

### An agentic second brain, open source. Your vault, your agents, your keys.

[![CI](https://github.com/kon-rad/argo/actions/workflows/ci.yml/badge.svg)](https://github.com/kon-rad/argo/actions/workflows/ci.yml)
[![Docs](https://github.com/kon-rad/argo/actions/workflows/docs.yml/badge.svg)](https://kon-rad.github.io/argo/)
[![License: MIT](https://img.shields.io/badge/license-MIT-black.svg)](LICENSE)
[![Node 22+](https://img.shields.io/badge/node-22%2B-339933.svg)](docs/onboarding/02-set-up-your-vault.md)
[![PostgreSQL 15+ with pgvector](https://img.shields.io/badge/postgres-15%2B%20%2B%20pgvector-336791.svg)](docs/onboarding/02-set-up-your-vault.md)

> **Documentation: [kon-rad.github.io/argo](https://kon-rad.github.io/argo/)**
>
> [Onboarding](https://kon-rad.github.io/argo/onboarding/) · [Getting started](https://kon-rad.github.io/argo/onboarding/02-set-up-your-vault/) · [Architecture](https://kon-rad.github.io/argo/architecture/) · [Configuration](https://kon-rad.github.io/argo/configuration/) · [Modules](https://kon-rad.github.io/argo/modules/) · [Contributing](CONTRIBUTING.md)

Argo is an **exocortex you own**: your notes, your projects, your agents and your body's data in one private place. Plain markdown in a git repo you control, a web app that searches and maps it, and AI agents that work inside it under rules you write.

Computing is turning into an exocortex: memory, perception and judgment running partly outside your head. The open question is who holds the keys. If the exocortex belongs to an ad company, it is the most complete record of your inner life ever kept, and it isn't yours. If it belongs to you, it is the biggest upgrade to human agency since writing. This repo is the engine for the second kind.

- [What you get](#what-you-get)
- [Quick start](#quick-start)
- [How it fits together](#how-it-fits-together)
- [Modules](#modules)
- [Agents in your vault](#agents-in-your-vault)
- [Running it on a server](#running-it-on-a-server)
- [Updating](#updating)
- [Documentation](#documentation)
- [Exo: made to be worn](#exo-made-to-be-worn)
- [Status](#status)
- [Contributing](#contributing)
- [Security](#security)
- [License](#license)

## What you get

- **Remember your life, on your terms.** Everything is markdown in a [PARA](vault-template/PARA%20Guide.md) vault (Projects, Areas, Research, Archives). No proprietary format, no lock-in: it opens in any editor, syncs with git, and outlives the app.
- **Find anything, and see the shape of it.** Keyword, semantic and hybrid search over the whole vault, a chat that answers from your notes with citations, a database page you can ask questions in plain language, and a 3D brain map of how your notes, projects and goals connect.
- **Put agents to work without handing them the keys.** Claude Code, Hermes and other harnesses work in the vault under one rulebook (`AGENTS.md`), behind hooks that block reading your secrets, force pushes and other mistakes.
- **Run a company of agents, if you want one.** Optional modules add a project tracker, a kanban board, a message board where named agents report to you, memory and session summaries, and a ledger of what they cost.
- **Stay the author.** Agents take the overhead. The writing, the reflection and the decisions stay with you.

**Private by construction.** Your vault is your own private repo. This public repo plugs into it as a git submodule and never sees your notes. Details: [docs/privacy.md](docs/privacy.md).

## Quick start

You need git, Python 3.9+, Node.js 22+ and PostgreSQL 15+ with [pgvector](https://github.com/pgvector/pgvector) 0.8+. Install steps for macOS and Ubuntu are in [docs/onboarding/02-set-up-your-vault.md](docs/onboarding/02-set-up-your-vault.md), or run `curl -fsSL https://kon-rad.github.io/argo/install.sh | sh`.

**Or hand it to an agent.** The [`setup-vault`](skills/setup-vault/SKILL.md) skill asks four questions (where the vault lives, your OS, whether you want semantic search, which harness comes next) and then runs the steps below, checking each before the next. It is the same path, executed by something that can adapt when your machine differs from the one in these instructions.

```bash
mkdir my-vault && cd my-vault && git init
git submodule add https://github.com/kon-rad/argo.git .secondbrain
.secondbrain/bin/secondbrain-vault init .
cp .env.example .env
git add -A && git commit -m "new vault"

.secondbrain/app/bin/secondbrain        # installs, migrates, builds, starts, opens the browser
.secondbrain/app/bin/secondbrain scan   # build the index
```

The app runs on `http://127.0.0.1:5123` with no login. Optional next steps, each a few lines in the docs:

| Want | Read |
|---|---|
| Semantic search (a [Together AI](https://together.ai) key or local [Ollama](https://ollama.com)) | [onboarding 02, step 5](docs/onboarding/02-set-up-your-vault.md#step-5-turn-on-semantic-search-optional) |
| The chat module (Anthropic, OpenAI, Together, OpenRouter or Ollama) | [docs/rag.md](docs/rag.md) |
| Agents working in the vault ([Claude Code](https://claude.com/claude-code), Hermes, Codex, Cursor, your own) | [Onboarding: connect Claude Code](docs/onboarding/03-claude-code.md) |
| The whole path, from an empty folder to a company of agents | [Onboarding: from zero](docs/onboarding/00-from-zero.md) |

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

### What's in the box

| Path | What |
|---|---|
| [`app/`](app/README.md) | The web app: browse your vault with wikilinks and backlinks, search it (keyword, semantic, hybrid), edit notes safely, ask the database page questions in plain language. Runs on your laptop with no login, or on a server behind Caddy with password + authenticator login |
| [`vault-template/`](vault-template/) | A PARA vault with the shared agent rules (`AGENTS.base.md`), settings templates and folder READMEs, ready to fill |
| [`harness/`](docs/agent-harness.md) | Hooks Claude Code and Hermes both run: a guard against dangerous tool calls, and a gate that asks for a dev log before an agent finishes. Plus a read-only fact-checker subagent |
| [`skills/`](skills/) | Shared agent skills (`SKILL.md`, used by every harness): `setup-vault`, `fact-check`, `ingest`, `company-report`, `org-member`, `livestream-x` and more |
| [`zen-agent/`](docs/zen-agent.md) | A minimal headless agent runtime: personas, skills, any provider, the board and the knowledge base as tools, budgets and traces |
| `bin/secondbrain-vault` | Starts a vault, compiles its `AGENTS.md`, links the skills |
| [`addons/tv-kiosk/`](addons/tv-kiosk/README.md) | Flash a Raspberry Pi that shows the app full screen on a TV |
| [`docs/`](docs/README.md) | How it all works, how to set it up, every setting. Published at [kon-rad.github.io/argo](https://kon-rad.github.io/argo/) |

## Modules

The six core features (`projects`, `memory`, `org`, `board`, `usage`, `summaries`) are always on. Addons are off until listed in the vault's `secondbrain.json` `addons` array or the app process's `MODULES` environment variable:

| Module | Adds |
|---|---|
| `projects` | A project tracker with stages and verifications, a CLI for agents, a kiosk feed |
| `org` | A message board where a company of named AI agents reports to you |
| `board` | A kanban board agents and people share, with a CLI |
| `agents` | Agent chats and cron history |
| `usage` | What your agents cost, by bot, task and project |
| `summaries` | One model-written summary per finished agent session, with the facts it proposes for memory |
| `chat` | Ask your notes: answers built from retrieved passages with citations, any provider's model, your org's agents as personas |
| `map` | A 3D brain map of your notes, projects and goals, with metrics |
| `garden` | A nightly gardener that shelves, catalogs and archives stale notes, with a report |
| `tv` | Your own video channel, played from episodes in your vault |
| `voice` | Read notes aloud with a local speech server |
| `uploads` | Large files from the browser to your own object storage |
| `media` | A gallery of every image, video and audio file in the vault, with a player |
| `livestream` | Stream stats for YouTube, Twitch and Kick |
| `ring` | Wearable ring data, stored next to your notes |
| `fund` | A read-only page for an agentic fund: wallet balances, transactions, pending approvals, committee health |
| `desk` | Hiring desk under Work at `/desk`; operator actions require connected production services |

Details, settings and timers for each: [docs/modules.md](docs/modules.md).

### Enable Hiring desk after deploying

Deploying the merged code does not enable this addon. Add `"desk"` to the existing `addons` array in **the vault's `secondbrain.json` on the machine running the app**, preserving its other settings. For example:

```json
{ "addons": ["desk"] }
```

This is a minimal example, not a replacement for your settings file. On a server, restart with `sudo systemctl restart secondbrain`, then reload the browser. **Work → Hiring desk** should appear, and `/desk` should open. Check `/api/health`: its `modules` check must list `desk`.

`deploy.sh` ships app code, builds, migrates and restarts; it does **not** copy your laptop's vault settings to the server. Sync the settings through your vault's normal sync process or edit the server vault deliberately. A visible desk page verifies activation only: the merged integration still requires production operator/public adapters to be supplied before jobs, execution, publishing and payments work. See the [desk rollout and troubleshooting checklist](docs/deployment.md#hiring-desk-rollout) and [desk module reference](docs/modules.md#desk).

## Agents in your vault

Open the vault in Claude Code, or point Hermes or another harness at it, and they work under the same rules:

- **One rulebook.** `AGENTS.md` is the engine's shared rules plus your `AGENTS.local.md`, compiled by `secondbrain-vault rules`. `CLAUDE.md` imports it.
- **A guard before every tool call.** It blocks reading your secrets, force pushes and deploys without a dry run, plus whatever you add in `.agents/guard.local.json`.
- **A dev log before "done".** If an agent changed skills, scripts or config, it's sent back once to write down what it did.
- **A company, when you're ready.** Named agents with their own prompts, skills, memory and budgets, waking for cards, mentions and DMs, reporting to you on a board and over Telegram.

Setup for each harness: [docs/agent-harness.md](docs/agent-harness.md). The company: [docs/agent-company.md](docs/agent-company.md) and [Onboarding: orchestrate agents](docs/onboarding/09-orchestrate-agents.md).

## Running it on a server

`app/deploy/deploy.sh` turns an Ubuntu box into a private, logged-in copy of your second brain: Postgres with pgvector, Caddy with HTTPS, systemd units, and a timer for each module you enable. Run it from your laptop; the server needs no GitHub access. See [docs/deployment.md](docs/deployment.md), and [docs/sync.md](docs/sync.md) for keeping several checkouts in step.

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

The full documentation is a site with search and navigation: **[kon-rad.github.io/argo](https://kon-rad.github.io/argo/)**, built from [`docs/`](docs/README.md) on every change to `main`.

**Onboarding** (start here):

| Page | Read it when |
|---|---|
| [From zero to an agent company](docs/onboarding/00-from-zero.md) | You want the whole path on one page, with a check at every stage |
| [What you get, and what to borrow](docs/onboarding/01-what-you-get.md) | You are deciding whether it fits, or want the patterns without installing anything |
| [Set up your vault](docs/onboarding/02-set-up-your-vault.md) | You want a vault and the app, step by step. The [`setup-vault`](https://github.com/kon-rad/argo/blob/main/skills/setup-vault/SKILL.md) skill runs it for you |
| [Connect Claude Code](docs/onboarding/03-claude-code.md), [Hermes](docs/onboarding/04-hermes.md), [another harness](docs/onboarding/05-other-harnesses.md) | You want an agent working in the vault under the guard |
| [Connect servers and computers](docs/onboarding/06-connect-machines.md) | You want a server behind a login, several agent machines, a screen on the wall |
| [Privacy](docs/onboarding/07-privacy.md), [Configuration and secrets](docs/onboarding/08-config-and-secrets.md) | You want to know what leaves your machine, and where every key lives |
| [Orchestrate agents](docs/onboarding/09-orchestrate-agents.md), [Adapt it](docs/onboarding/10-adapt-it.md), [Connect Telegram](docs/onboarding/11-telegram.md) | You want rules, skills, contracts and a board working together, for your notes, codebase or startup |

**Reference:**

| Doc | |
|---|---|
| [Set up your vault](docs/onboarding/02-set-up-your-vault.md) | From nothing to a running vault, with troubleshooting |
| [Architecture](docs/architecture.md) | Engine and vault, the app and its index, the harness, data flow |
| [Your vault](docs/vault.md) | The template, `secondbrain-vault`, rules and skills, updating |
| [Configuration](docs/configuration.md) | Every env variable and `secondbrain.json` key |
| [Modules](docs/modules.md) | Each optional feature: pages, CLIs, settings, timers |
| [Retrieval and chat](docs/rag.md) | Chunking, embedding, hybrid retrieval, reranking, providers |
| [Memory](docs/memory.md) | Agent memory, and how to check it works |
| [Kanban board](docs/kanban-board.md) | Statuses, doors, every board command |
| [Agent harness](docs/agent-harness.md) | The guard, the dev-log gate, Claude Code and Hermes wiring |
| [Agent company](docs/agent-company.md) | Named agents on a board that wake for cards, DMs and mentions |
| [zen-agent](docs/zen-agent.md) | The headless agent runtime |
| [Deployment](docs/deployment.md) | A server behind a login |
| [Privacy](docs/privacy.md) | How the engine stays free of personal data |
| [The app](app/README.md) | Tech stack, search design, invariants |

## Exo: made to be worn

The second brain is half of a pair. The other half is **Exo**, a modular wearable computer: display glasses, earbuds and a few keys on a sling, built around a Raspberry Pi, that you hold a button and talk to. Details and the waitlist: https://exo.myargoquest.com <!-- public-ok -->

| Exo (on you) | Argo (your vault and server) |
|---|---|
| Push-to-talk to your own agents, wherever you are | The agents' memory, skills and rules live here |
| A ring and body sensors capture what your body is doing | The `ring` module stores that data next to your notes |
| A small screen for glanceable views | The projects feed, and the map and tv kiosk views (`?kiosk=1`) |
| Thin client: it carries nothing worth stealing | Everything lives in your vault and your database |

You don't need Exo to use Argo: it runs the same on a laptop or a small server. Exo is where it's heading, an exocortex that leaves the screen. The project home is [myargoquest.com](https://myargoquest.com). <!-- public-ok -->

## Status

Early and moving fast. It runs one person's second brain every day, on a laptop and a server, with a company of agents working in it. Expect rough edges for anyone else's setup, and please [open an issue](https://github.com/kon-rad/argo/issues) when you hit one: what you ran, what you expected, what happened, your OS, Node and Postgres versions, with paths and note contents scrubbed.

Every push to `main` runs the app tests against a real Postgres, the harness and tooling tests, the zen-agent tests, a public-content scan and a secrets scan ([ci.yml](.github/workflows/ci.yml)). There is no release cadence yet: pin the engine to a commit and move the pin when you want to.

## Contributing

Bug reports, fixes, docs and skills are welcome. Read **[CONTRIBUTING.md](CONTRIBUTING.md)** first; it covers the dev setup, the repo layout, the privacy rule and guides for the common changes (a setting, a module, a migration, a skill, the harness, an add-on, docs). AI coding agents read [AGENTS.md](AGENTS.md), which says the same things in the form agents read first.

The short version:

```bash
git clone https://github.com/kon-rad/argo.git && cd argo
cd app && npm ci && npm run build && npm test && cd ..     # needs a local Postgres
python3 -m pip install pytest && python3 -m pytest harness tools addons
cd zen-agent && npm ci && npm test && cd ..
```

- Branch from `main` (`feat/<slug>`, `fix/<slug>`, `docs/<slug>`, `skill/<name>`) and open a pull request. CI must be green.
- Open an issue first for anything bigger than a bug fix, so we agree on the shape before you build it. Optional features become modules, off by default.
- Never commit anything from a real vault: no paths with your name, no hostnames, no note contents. `scripts/check-public.sh` runs in CI and catches most of it.
- Develop against a throwaway vault (`bin/secondbrain-vault init /tmp/dev-vault`), never your real one.

## Security

Report vulnerabilities privately through GitHub's Security tab, never in a public issue. See [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). Built by [Konrad Gnat](https://github.com/kon-rad) and contributors. <!-- public-ok -->
