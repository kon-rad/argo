# Contributing

Thanks for helping. This repo is the engine of a personal second brain; your notes stay in your own private vault, and this repo never sees them.

## Set up

1. Install Node 22+, Python 3.11+, and Postgres 15+.
2. Clone, then:

```bash
cd app && npm ci && npm test
python3 -m pytest harness tools
```

3. To try it against a vault, make one from the template:

```bash
bin/secondbrain-vault init ~/my-vault
```

## Making a change

1. Open an issue first for anything bigger than a bug fix, so we can agree on the shape.
2. Branch from `main` (`feat/…`, `fix/…`, `docs/…`, `skill/…`).
3. Write the test first for behaviour changes.
4. Run the app tests, the Python tests and `scripts/check-public.sh`.
5. Open a PR. Describe what changed, why, and what you ran. CI runs the same checks plus gitleaks.

## The privacy rule

Nothing personal goes in this repo: no real names, hosts, IPs, emails, paths from your machine, or real notes in fixtures. Personal values are read from env with a safe default. See `AGENTS.md` for the full table; it applies to humans too.

## Proposing a skill

A skill is a folder `skills/<name>/SKILL.md` with `name` and `description` frontmatter. It must work for anyone: no personal brands, accounts or folders. Say in the PR which agent you tested it with (Claude Code, Hermes, or both).

## Agents

AI coding agents are welcome contributors. They follow `AGENTS.md`, open PRs like anyone else, and never merge their own.
