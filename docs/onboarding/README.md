# Onboarding: your own second brain

A guided path from "I have notes somewhere" to a private knowledge base with agents working in it under your rules. Each page is short, builds on the one before, and links to the reference docs for every detail.

You do not need all of it. The first three pages give you a vault, the app and one agent. The rest you add when you want it.

| Step | Page | You get | Time |
|---|---|---|---|
| 0 | [What you get, and what to borrow](01-what-you-get.md) | The idea in ten minutes, and the parts worth copying into your own notes, app or company even if you never install this | 10 min |
| 1 | [Set up your vault](02-set-up-your-vault.md) | A private git repo of markdown, the web app, search | 15 to 30 min |
| 2 | [Connect Claude Code](03-claude-code.md) | Claude Code working in the vault, with the guard and the dev-log gate | 5 min |
| 3 | [Connect Hermes](04-hermes.md) | Hermes working in the same vault under the same rules | 10 min |
| 4 | [Connect another harness](05-other-harnesses.md) | Codex, Cursor, OpenCode, a cron script or your own agent, on the same rules | 10 to 30 min |
| 5 | [Connect servers and computers](06-connect-machines.md) | A server behind a login, a laptop that uses it, a TV, several agent machines | 1 to 2 hours |
| 6 | [Privacy](07-privacy.md) | What stays on your machine, what leaves it and when, and how to keep it that way | 10 min |
| 7 | [Configuration and secrets](08-config-and-secrets.md) | Where every setting and key lives, on each machine | 10 min |
| 8 | [Orchestrate agents](09-orchestrate-agents.md) | Rules, skills, contracts, dev logs, a tracker and a board: the orchestration model | 20 min |
| 9 | [Adapt it to your notes, app, business or startup](10-adapt-it.md) | Recipes for four kinds of users, and what to leave out | 10 min |

## Before you start

Three things to know, because everything else follows from them:

1. **Your notes are plain markdown in a git repo you own.** The app is an index over them, and the agents work in them. Delete the app and you still have your notes.
2. **The engine is public and your vault is private.** This repo plugs into your vault as a git submodule at `.secondbrain/`. Nothing about you is ever in the engine.
3. **Agents take the overhead, you stay the author.** They read one rulebook, every tool call goes through a guard, and they write a dev log before they can call a job done.

## If you only have five minutes

```bash
mkdir my-vault && cd my-vault && git init
git submodule add https://github.com/kon-rad/secondbrain.git .secondbrain
.secondbrain/bin/secondbrain-vault init .
cp .env.example .env
git add -A && git commit -m "new vault"
.secondbrain/app/bin/secondbrain          # installs, migrates, builds, starts, opens the browser
.secondbrain/app/bin/secondbrain scan     # builds the index
```

That needs git, Node 22, Python 3.9 and PostgreSQL with pgvector. The install steps for those are in [Set up your vault](02-set-up-your-vault.md).
