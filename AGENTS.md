# AGENTS.md: rules for agents changing the secondbrain engine

This repo is the **public engine** of a personal second brain: the web app, the vault template, the agent harness (hooks) and generic skills. It is used by people who keep their own notes in a **private vault** that includes this repo as a git submodule at `.secondbrain/`. Read this file before changing anything here. Humans: see `CONTRIBUTING.md`.

## The one rule: nothing personal in this repo

Everything here must work for a stranger. Before you write a value, ask: would it differ between two users? If yes, it does not belong in the code.

| Kind of value | Where it goes |
|---|---|
| Secrets (keys, tokens, password hashes) | The user's vault `.env`, or `/etc/secondbrain/env` on a server. Add the variable name to `app/deploy/env.example` or `vault-template/.env.example` |
| Personal settings (hosts, origins, names, paths, enabled modules) | Same env files, read in `app/server/src/config.ts` with a default that works for a stranger, or the feature off |
| Personal rules for agents | The vault's `AGENTS.local.md` (never `vault-template/AGENTS.base.md`) |
| Personal guard rules | The vault's `.agents/guard.local.json` |
| Personal skills | The vault's own `.agents/skills/<name>/` |
| Notes, media, real data | The vault and its backups. Never here, not even as test fixtures: write fake data |

Never add: real names, hostnames, IP addresses (other than `127.0.0.1` and the RFC 5737 documentation ranges), email addresses, chat IDs, wallet addresses, or paths from someone's machine. `scripts/check-public.sh` and gitleaks run in CI and fail the PR if you do.

## Layout

| Path | What |
|---|---|
| `app/` | The web app: `server/` (Express, TypeScript), `web/` (React, Vite), `db/migrations/` (node-pg-migrate, SQL), `deploy/` (systemd, Caddy, deploy script), `bin/` (launcher CLI) |
| `vault-template/` | What `secondbrain-vault init` copies to start a new vault: PARA folders, `AGENTS.base.md`, `CLAUDE.md`, `.gitignore`, `.env.example` |
| `harness/` | Hooks shared by Claude Code and Hermes: `hooks/guard.py` (blocks dangerous tool calls), `hooks/devlog_gate.py` (asks for a dev log before finishing), Claude settings and the fact-checker agent |
| `skills/` | Generic skills in `SKILL.md` format, linked into a vault's `.agents/skills/` by `secondbrain-vault link-skills` |
| `tools/`, `bin/secondbrain-vault` | The vault CLI: `init`, `rules`, `link-skills` |
| `addons/` | Optional extras that run outside the app, each with its own README and tests. `tv-kiosk/`: a Raspberry Pi that shows the app full screen on a TV |
| `scripts/check-public.sh` | The leak check |
| `docs/` | Architecture docs |

## Build and test

| What | Command |
|---|---|
| App tests (needs a local Postgres) | `cd app && npm ci && npm test` |
| App typecheck and build | `cd app && npm run build` |
| Python tests (harness, CLI, add-ons) | `python3 -m pytest harness tools addons` |
| Leak check | `scripts/check-public.sh` (add your own private denylist at `~/.config/secondbrain/denylist.txt`) |

Run all of them before you open a PR. Say in the PR which ones you ran and what they printed.

## Workflow: branch, PR, never main

1. **Never commit to `main` directly.** It is protected; CI must pass.
2. Branch from `main`: `feat/<slug>`, `fix/<slug>`, `docs/<slug>`, `skill/<name>`.
3. If you are working inside someone's vault, do not edit their pinned `.secondbrain/` checkout in place. Make a worktree: `git -C .secondbrain worktree add ../secondbrain-<slug> -b feat/<slug>`.
4. Tests first for behaviour changes. Every new setting gets a safe default, an entry in the right `.example` file, and a line in the docs.
5. Commit messages: `type(scope): what`, then why in the body.
6. Push the branch and open a PR with `gh pr create`. **Agents never merge their own PR.**
7. Migrations only move forward. Never edit a migration that has shipped; add a new one.

## Modules

Optional features sit behind `MODULES` (comma list in env). A module that is off must not mount its API routes or show its nav link. Today: `ring` (wearable ring data pushed by a client) and `agents` (Agents and Cron pages over an agent-hub). A new optional feature is a new module, off by default.

## Docs

User-facing behaviour changes update `README.md` or `docs/`. Architecture changes update `docs/architecture.md`.
