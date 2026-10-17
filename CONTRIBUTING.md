# Contributing

Thanks for helping. This repo is the engine of a personal second brain: the people who use it keep their notes in their own private vaults, and this repo never sees them. That shapes most of the rules below.

AI coding agents are welcome contributors. They follow [AGENTS.md](AGENTS.md), which says the same things in a form agents read first.

- [Ways to help](#ways-to-help)
- [Set up a development environment](#set-up-a-development-environment)
- [Repo layout](#repo-layout)
- [Run the tests](#run-the-tests)
- [The privacy rule](#the-privacy-rule)
- [Making a change](#making-a-change)
- [Pull requests and review](#pull-requests-and-review)
- [Guides for common changes](#guides-for-common-changes): a setting, a module, a migration, a skill, the harness, an add-on, docs

## Ways to help

| | |
|---|---|
| **Report a bug** | Open an issue: what you ran, what you expected, what happened, your OS, Node and Postgres versions. Paste errors, but **scrub them first**: no paths with your name, no hostnames, no note contents |
| **Fix a bug** | Small fixes can go straight to a PR. Add a test that fails without the fix |
| **Improve the docs** | Anything in `docs/`, the READMEs or this file. Docs-only PRs are very welcome |
| **Add a skill** | A generic skill that helps anyone's vault ([below](#a-skill)) |
| **Add a feature** | Open an issue first for anything bigger than a bug fix, so we agree on the shape before you build it. Optional features become modules |
| **Report a vulnerability** | Privately, through GitHub's Security tab. See [SECURITY.md](SECURITY.md). Never in a public issue |

## Set up a development environment

You need git, Node.js 22+, Python 3.9+ (3.11+ recommended), and PostgreSQL 15+ with pgvector built for that Postgres. [docs/getting-started.md](docs/getting-started.md#1-install-the-prerequisites) has install steps for macOS and Ubuntu.

```bash
git clone https://github.com/kon-rad/secondbrain.git
cd secondbrain/app
npm ci
npm run build
npm test
cd ..
python3 -m pip install pytest
python3 -m pytest harness tools addons
```

The app tests run against a **real** Postgres: they connect with the standard `PG*` variables (`PGHOST`, `PGUSER`, `PGPASSWORD`) and rebuild a `secondbrain_test` database (override with `SB_TEST_DB`) from the migrations on every run. No mocked `pg`. Your user needs permission to create databases.

To work against a vault, make a throwaway one. Don't develop against your real vault:

```bash
bin/secondbrain-vault init /tmp/dev-vault
VAULT_ROOT=/tmp/dev-vault app/bin/secondbrain dev    # server + web UI in watch mode
```

Put a few fake notes in it. If you want a realistic shape, write fake notes in that shape; never copy real ones.

## Repo layout

| Path | What | Language |
|---|---|---|
| `app/server/` | Express API, connectors (scan, embed), search, module routes, CLIs | TypeScript (ESM, strict) |
| `app/web/` | React UI | TypeScript, React 19, Tailwind |
| `app/db/migrations/` | Schema, forward-only | SQL (node-pg-migrate) |
| `app/deploy/` | `deploy.sh`, systemd units, Caddy template, server env example | Bash |
| `app/bin/secondbrain` | The launcher CLI | Bash |
| `harness/hooks/` | `guard.py`, `devlog_gate.py` and their tests | Python, stdlib only |
| `harness/claude/` | Claude Code settings and agents copied into new vaults | JSON, markdown |
| `tools/sbvault.py`, `bin/secondbrain-vault` | `init`, `rules`, `link-skills` | Python, stdlib only |
| `vault-template/` | What `init` copies into a new vault | Markdown, JSON |
| `skills/` | Shared skills | Markdown (`SKILL.md`) |
| `addons/` | Optional extras that run outside the app, each with a README and tests | Mixed |
| `scripts/check-public.sh` | The leak check | Bash |
| `docs/` | User and architecture docs | Markdown |

## Run the tests

| What | Command | In CI |
|---|---|---|
| App typecheck and build | `cd app && npm run build` | `app` job |
| App tests (Vitest + Supertest, real Postgres with pgvector) | `cd app && npm test` | `app` job |
| Python tests (harness, vault CLI, add-ons) | `python3 -m pytest harness tools addons` | `python` job |
| Leak check | `scripts/check-public.sh` | `leaks` job |
| Secret scan over all history | `gitleaks detect --source . --log-opts=--all --redact` | `leaks` job |

Run all of them before you open a PR, and say in the PR what you ran and what it printed. `main` is protected: a PR can't merge until all three CI jobs pass.

## The privacy rule

**Nothing personal goes in this repo.** Not your name, not your hosts, IPs, emails, chat IDs, wallet addresses, usernames or home-directory paths, not your accounts or channel handles, and no real notes, even as test fixtures.

The test for any value: *would it differ between two users?* If yes, it is read from the vault at run time (env or `secondbrain.json`) with a default that works for a stranger, or the feature is off. The full table is in [docs/privacy.md](docs/privacy.md).

Before every push:

1. Set your commit email for this repo to your GitHub noreply address: `git config user.email "<id>+<user>@users.noreply.github.com"`.
2. Keep a private denylist of your own identifying strings at `~/.config/secondbrain/denylist.txt`. It is never committed, so CI can't check it for you.
3. Run `scripts/check-public.sh`. It must print nothing and exit 0.

Use example values in docs and tests: `brain.example.com`, `my-server`, `/srv/vault`, `owner`, the RFC 5737 IP ranges (`192.0.2.x`, `198.51.100.x`, `203.0.113.x`). A line that is a reviewed public value can end in `# public-ok`; say why in the PR.

## Making a change

1. **Branch from `main`:** `feat/<slug>`, `fix/<slug>`, `docs/<slug>`, `skill/<name>`. Never commit to `main`.
2. **Working from inside a vault?** Don't edit the pinned `.secondbrain/` checkout. Make a worktree: `git -C .secondbrain worktree add ../secondbrain-<slug> -b feat/<slug> origin/main`.
3. **Write the test first** for any behaviour change. Bug fixes come with a test that fails without the fix.
4. **Keep it small.** One PR does one thing. A refactor and a feature are two PRs.
5. **Match the code around you:** naming, comment density, structure. Comments say *why*, not what.
6. **Update the docs** in the same PR when behaviour, settings or commands change (see [Docs](#docs)).
7. **Commit messages:** `type(scope): what changed`, then why in the body. Types: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `skill`. Example: `fix(deploy): read the deploy settings literally, never source the vault env file`.

## Pull requests and review

Open the PR with `gh pr create` or on GitHub. The description says:

- **What** changed and **why** (link the issue if there is one).
- **How you tested it:** the commands you ran and their real results.
- **Anything a user must do:** a new setting, a migration, a renamed command.
- For a skill or harness change: **which agent** you tried it with (Claude Code, Hermes, or both).

Then:

- CI must be green. If a job fails for a reason unrelated to your change, say so in the PR.
- A maintainer reviews. Expect questions about defaults for strangers, privacy and tests.
- **Agents never merge their own PRs**, and neither do humans merge PRs they haven't read.
- Squash or merge commits are both fine; keep the PR title in commit-message form.

## Guides for common changes

### A setting

1. Add it to the Zod schema in `app/server/src/config.ts` with a **default that works for a stranger**, or make it optional and switch the feature off when unset.
2. Add it, commented, to `vault-template/env.example` (laptop) and/or `app/deploy/env.example` (server).
3. Add a row to [docs/configuration.md](docs/configuration.md).
4. If `deploy.sh` needs it, read it in the script's settings block (literally, never by sourcing the env file) and document it in the script header and [docs/deployment.md](docs/deployment.md).

Structured settings (lists, maps, accounts) go in `secondbrain.json` through `app/server/src/settings.ts`, with an empty default and an example in `vault-template/secondbrain.example.json`.

### Adding a module

A new optional feature is a new module, **off by default**.

1. Add its name to `MODULE_NAMES` in `app/server/src/config.ts`.
2. Mount its routes only when it is on: `if (modules.has('<name>'))` in `app/server/src/app.ts`.
3. Show its nav link and routes only when it is on (`app/web/src/App.tsx` reads the module list from `/api/meta`).
4. Tables go in a new migration. They exist whether or not the module is on.
5. Timers: add the `.service` and `.timer` to `app/deploy/`, and install them in `deploy.sh` only when the module is in `DEPLOY_MODULES`.
6. A CLI: add a subcommand to `app/bin/secondbrain` and an entry point in `app/server/src/cli-<name>.ts`.
7. Tests: the module on, and the module off (routes return 404, nothing in the nav).
8. Docs: a section in [docs/modules.md](docs/modules.md), its settings in [docs/configuration.md](docs/configuration.md), and a row in the module tables of `README.md` and `app/README.md`.

### A migration

- Migrations live in `app/db/migrations/` as plain SQL, named `<timestamp>_<slug>.sql`, with a timestamp later than every existing one.
- **Forward only.** Never edit or delete a migration that has been merged: people's databases have already run it. Add a new one.
- node-pg-migrate refuses to run when a database has a migration the code doesn't have, so a renumbered or deleted migration breaks every existing install.
- Keep names neutral: no owner names in tables, columns, roles or enum values.

### A skill

A skill is `skills/<name>/SKILL.md` (plus any `scripts/` or `references/` it needs), with YAML frontmatter:

```markdown
---
name: my-skill
description: One or two sentences: what it does and when an agent should use it, with the phrases that should trigger it.
---
```

- It must work for **anyone**: no personal brands, accounts, folders, machines or bots. Read anything personal from `secondbrain.json` or env.
- If it pairs with a module, say so at the top, and make it fail clearly when the module is off.
- Third-party skills can't be added unless their license allows redistribution under MIT.
- Say in the PR which agents you tested it with.

### The harness (guard and dev-log gate)

- `guard.py` and `devlog_gate.py` are **stdlib-only** Python and must **fail open**: any exception allows the call.
- Every new rule gets tests in `harness/hooks/test_guard.py` or `test_devlog_gate.py`: one call it blocks, and the nearest harmless call it must not block.
- Built-in rules apply to every vault, so they must be things nobody wants (reading secrets, force pushes). Anything owner-specific belongs in a vault's `guard.local.json` instead.
- Keep both output formats working: Claude Code (exit 2, reason on stderr) and Hermes (`{"decision": "block", ...}` on stdout).
- Changes to the shared agent rules go in `vault-template/AGENTS.base.md`. Vaults pick them up with `secondbrain-vault rules`.

### An add-on

An add-on runs outside the app (a device, a separate service). It lives in `addons/<name>/` with its own `README.md` (what it is, what it needs, how to install, how to remove) and tests that run under `python3 -m pytest addons`, or a note in the README on how to test it by hand.

### Docs

| You changed | Update |
|---|---|
| Install or first-run behaviour | [docs/getting-started.md](docs/getting-started.md) |
| A setting | [docs/configuration.md](docs/configuration.md) and the `.example` files |
| A module | [docs/modules.md](docs/modules.md) |
| The guard, the gate, or agent wiring | [docs/agent-harness.md](docs/agent-harness.md) |
| `deploy.sh` or server units | [docs/deployment.md](docs/deployment.md) |
| The template or `secondbrain-vault` | [docs/vault.md](docs/vault.md) |
| How the parts fit together | [docs/architecture.md](docs/architecture.md) |

Write plainly, use tables for options and settings, use example values (never real ones), and make every command copy-pasteable.

## Code of conduct

Be kind, be specific, and assume good intent. Critique code, not people. Maintainers may close issues or PRs that ignore that, or that ask the project to collect people's data.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
