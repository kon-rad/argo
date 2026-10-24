# Adapt it to your notes, app, business or startup

Four recipes. Each says what to take, what to leave, and the first concrete step. None of them needs the whole thing.

## Your notes

You have a folder of markdown (Obsidian, Logseq exports, plain files) and you want search that understands meaning, and an agent that helps without wrecking the folder.

**Take:** the vault template, the app with no modules, the harness.

**Leave:** every module, the server, the ledger.

**Steps:**

1. Make a new vault ([Set up your vault](02-set-up-your-vault.md)) and move your notes into it. Keep your folder names if you like; PARA is a suggestion, the index does not care.
2. Turn on semantic search with Ollama if you want nothing to leave your machine, or Together if you want it fast and do not mind the chunks going out.
3. Write five rules in `AGENTS.local.md`: where new notes go, how you name them, what the agent must never touch. Regenerate `AGENTS.md`.
4. Use the `ingest` skill as your first automation: hand the agent a link, get a note tied to what you are working on.
5. Keep using your editor. The app's editor has an optimistic lock, so you, Obsidian and an agent can all write without silent overwrites.

What you will notice: the wikilinks and backlinks you already have become the map, and the guard stops the one thing agents in note folders tend to do, which is to grep your `.env` while "looking for context".

## Your app or codebase

You run coding agents in a repository and want them safer and more accountable, without changing how you work.

**Take:** the layered rules, the guard, the dev-log gate, skills, completion contracts. None of this needs the vault or the app.

**Leave:** the app, the vault template, the modules.

**Steps:**

1. Copy `harness/hooks/guard.py`, `devlog_gate.py` and their tests into your repo (MIT). Copy `harness/claude/settings.json` to `.claude/settings.json` and fix the paths. Hermes: the block in `harness/hermes-hooks.example.yaml`. Anything else: [Connect another harness](05-other-harnesses.md).
2. Write an `AGENTS.md` and make `CLAUDE.md` one line, `@AGENTS.md`. If several repos share rules, keep the base in one place and compile it the way `secondbrain-vault rules` does: base plus a local file, with a `--check` in CI so nobody hand-edits the output.
3. Add a `.agents/guard.local.json` with the folders that are off limits in this repo: generated code, fixtures, a sibling checkout.
4. Put the "Context budget" and "Long tasks: completion contracts" sections of [`AGENTS.base.md`](https://github.com/kon-rad/secondbrain/blob/main/vault-template/AGENTS.base.md) in your rules as they are. They are the two sections with the best ratio of words to saved money.
5. Decide where dev logs live (`docs/dev-log/` is fine) and tell the gate with `devlog.roots`.

What you will notice: force pushes and secret reads stop; "done" starts to come with a written record you can read on Monday; headless runs get cheaper.

## Your business

You are a solo founder or a small company and you want a staff of agents that report to you, with a paper trail you could show an accountant.

**Take:** everything in the two recipes above, the server, and the `projects`, `org` and `usage` modules.

**Leave:** `tv`, `ring`, `livestream`, `fund`, `social` unless they describe your business.

**Steps:**

1. One vault per company, private, with `Areas/` for the standing functions (finance, customers, product) and `Projects/` for the work with an end date. Agents and people share it.
2. Put it on a server ([Connect servers and computers](06-connect-machines.md)) so it works from a phone and runs while laptops sleep. The login is built in and cannot be turned off.
3. Turn on `projects`. Make the rule: a feature is `live` when its verification is recorded, by whoever did it. The report `cli-projects render` writes is your weekly status, searchable.
4. Turn on `org`. Name your agents by role (research, engineering, finance, chief of staff), give each a team and a lead, and write the dispatcher ([Orchestrate agents](09-orchestrate-agents.md#layer-3-a-company-of-agents-the-org-module)). Questions agents cannot answer land in one place, waiting on you.
5. Turn on `usage` and install the ledger on every machine that runs agents. The first month's table will change which jobs you keep.
6. Secrets by role: the agents' machines hold the keys the agents need, under their own Unix user. Signing keys, banking and anything that moves money stay on a device agents do not run on. The `fund` module is an example of that split: it reads a fund's state and never signs.

What you will notice: the vault becomes the company's memory, and the board becomes the place you manage from. People who join read `AGENTS.md` too.

## Your startup

You are building a product that includes agents, memory or a knowledge base for your users, and you want an architecture that will not leak your users' lives.

**Take:** the architecture, not the code. Specifically:

| Pattern | Why it transfers |
|---|---|
| Public engine, private data, joined by a pinned submodule | Your product code can be open or audited, your users' data never touches it, and an update is a pin move your users control |
| Nothing personal in code, enforced by CI | A leak check on every PR, gitleaks over all history, a private denylist per developer. Make it a rule on day one; it is far harder to add later |
| Modules off by default | Every feature past the core is behind one list. Off means no routes, no nav, no timers. Your surface area is what the user asked for |
| Source of truth in files, database as a disposable index, index as the allowlist | Your users can leave with their data, you can rebuild the index after any bug, and a path is served only if the indexer saw it |
| No "auth off" on anything internet-facing | The server refuses to start without both factors and an origin. Make the unsafe configuration impossible, not discouraged |
| Deploys that restore the previous build | Keep the running build, deploy, health-check, restore on failure, exit codes a script can read |
| A guard that fails open and a gate that asks once | Guardrails that never block legitimate work are guardrails people keep on |
| A per-run ledger with redaction at the edge | Measure agents from the start; redact secrets on the machine where they are known, not on the server that does not know them |

**Steps:**

1. Read [architecture.md](../architecture.md) and [privacy.md](../privacy.md) once, as a design review of your own plan.
2. Fork the harness into your product's agent layer first. It is the smallest piece with the largest effect.
3. Run a vault for your own company (the recipe above). You will find the rough edges in the patterns before your users do, and your company's agents will have a memory.
4. When you contribute something generic back, it goes through a pull request, with a default that works for a stranger. That rule is what keeps the engine usable by the next startup.

## What to leave out, whoever you are

- **The Exo wearable and the hardware modules** (`ring`, `tv` on a Pi) are one person's direction for the project. They are optional and they stay optional.
- **Running every module.** Each one is a surface, a timer and a thing to understand. Turn one on when you can say what it is for.
- **Editing the engine in place.** Your vault pins it. Changes go to a worktree and a pull request, and your pin moves when they merge. [vault.md](../vault.md#changing-the-engine-from-inside-your-vault) shows the two commands.

That is the end of the onboarding. The reference docs start at [the documentation index](../README.md), and [CONTRIBUTING.md](https://github.com/kon-rad/secondbrain/blob/main/CONTRIBUTING.md) is where to go when you want to send a change back.
