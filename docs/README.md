# Documentation

These pages are also published as a site at **https://kon-rad.github.io/secondbrain/**, built from this folder on every change to `main`.

New here? Start with the [onboarding path](onboarding/README.md): ten short pages from "I have notes somewhere" to a private knowledge base with agents working in it. Want it running right now? [getting-started.md](getting-started.md). Want to know how it fits together before you change it? [architecture.md](architecture.md).

## Onboarding

| Page | Read it when |
|---|---|
| [What you get, and what to borrow](onboarding/01-what-you-get.md) | You are deciding whether it fits, or want the patterns for your own notes, app or company without installing anything |
| [Set up your vault](onboarding/02-set-up-your-vault.md) | You want a vault and the app, step by step with a check after each step |
| [Connect Claude Code](onboarding/03-claude-code.md) | You want Claude Code working in the vault under the guard and the dev-log gate |
| [Connect Hermes](onboarding/04-hermes.md) | You run Hermes and want it on the same rules |
| [Connect another harness](onboarding/05-other-harnesses.md) | You use Codex, Cursor, OpenCode, a cron script or your own agent |
| [Connect servers and computers](onboarding/06-connect-machines.md) | You want a server behind a login, a laptop that uses it, several agent machines, a screen on the wall |
| [Privacy](onboarding/07-privacy.md) | You want to know what stays on your machine, what leaves it and when |
| [Configuration and secrets](onboarding/08-config-and-secrets.md) | You want to know where every setting and key lives, on each machine |
| [Orchestrate agents](onboarding/09-orchestrate-agents.md) | You want rules, skills, contracts, dev logs, a tracker and a board working together |
| [Adapt it](onboarding/10-adapt-it.md) | You want a recipe for your notes, your codebase, your business or your startup |

## Reference

| Doc | Read it when |
|---|---|
| [getting-started.md](getting-started.md) | You want a vault and the app running on your laptop, from nothing |
| [architecture.md](architecture.md) | You want the big picture: engine vs. vault, the app, the index, the harness, where data flows |
| [vault.md](vault.md) | You want to understand the vault template, `secondbrain-vault`, `AGENTS.md`, skills, and how to update the engine |
| [configuration.md](configuration.md) | You need a setting: every env variable and every `secondbrain.json` key |
| [sync.md](sync.md) | You work in the vault from more than one computer, or a server runs agents in it, and want every checkout committed, pulled and pushed on a timer without losing a note or leaking a key |
| [modules.md](modules.md) | You want an optional feature (tracker, org board, kanban board, map, TV, usage, voice, livestream, ring, agents, chat) |
| [rag.md](rag.md) | You want to know how notes become searchable passages and how the chat answers from them: chunking, embedding, hybrid retrieval, reranking, providers |
| [agent-harness.md](agent-harness.md) | You run Claude Code or Hermes in the vault and want to know what the guard and the dev-log gate do |
| [deployment.md](deployment.md) | You want the app on a server behind a login |
| [privacy.md](privacy.md) | You want to know how the engine stays free of personal data, and how to keep your fork that way |
| [zen-agent.md](zen-agent.md) | You want to run a roster persona headlessly on any model with the board and the knowledge base as tools: what zen-agent is, how to use it, its architecture and design, and how it compares to Claude Code, Hermes and pi |
| [self-improvement.md](self-improvement.md) | You want to see the proposal (not built yet) for a self-improving loop over the rules, skills, board, org, cron jobs and engine: traces, evaluation, memory, and a possible headless runtime of our own |

Also, in the repository:

- [`app/README.md`](https://github.com/kon-rad/secondbrain/blob/main/app/README.md): the app's tech stack, search design and invariants.
- [`addons/tv-kiosk/README.md`](https://github.com/kon-rad/secondbrain/blob/main/addons/tv-kiosk/README.md): a Raspberry Pi that shows the app on a TV.
- [`zen-agent/README.md`](https://github.com/kon-rad/secondbrain/blob/main/zen-agent/README.md): zen-agent, the minimal headless agent runtime (pi agent core) that runs a roster persona with skills, the board and the knowledge base as tools, under a budget, with a trace per run.
- [`CONTRIBUTING.md`](https://github.com/kon-rad/secondbrain/blob/main/CONTRIBUTING.md): how to send a change.
- [`AGENTS.md`](https://github.com/kon-rad/secondbrain/blob/main/AGENTS.md): the rules AI coding agents follow when they change this repo.

## Working on the docs

The site is MkDocs with the Material theme; `mkdocs.yml` at the repository root holds the navigation. Preview locally with `pip install mkdocs-material && mkdocs serve`, and run `mkdocs build --strict` before you push: the `docs` workflow runs the same command on every pull request that touches `docs/`, and a broken link fails it. Links to files outside `docs/` are written as full GitHub URLs so they work on the site as well as on GitHub.
