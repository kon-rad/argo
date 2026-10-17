# Your vault

The vault is yours: a private git repo of markdown, organised with PARA. This page covers what the template gives you, the `secondbrain-vault` CLI, how agent rules and skills are layered, and how to take engine updates.

## The template

`secondbrain-vault init <dir>` copies `vault-template/` into an empty folder and wires it up. What you get is listed in [getting-started.md](getting-started.md#2-make-a-vault). The parts that matter later:

| File | You edit it? | Notes |
|---|---|---|
| `AGENTS.local.md` | Yes | Your rules for agents: folder conventions, your projects, your voice, your no-go zones |
| `AGENTS.md` | No | Generated. `rules` rewrites it; `rules --check` fails if someone hand-edited it |
| `CLAUDE.md` | Rarely | `@AGENTS.md` plus anything Claude-Code-only |
| `.agents/guard.local.json` | Yes | Your extra guard rules ([agent-harness.md](agent-harness.md#your-own-rules-guardlocaljson)) |
| `.agents/skills/` | Yes | Your own skills; the engine's are symlinked in |
| `.env` | Yes | Keys and per-machine settings; gitignored ([configuration.md](configuration.md)) |
| `secondbrain.json` | Yes | Structured settings for modules; committed ([configuration.md](configuration.md#secondbrainjson)) |
| `PARA Guide.md` | Optional | How to decide between Projects, Areas, Research and Archives |

Template files that would act on the engine repo itself are stored without their leading dot (`gitignore`, `env.example`) and renamed by `init`.

## `secondbrain-vault`

```
.secondbrain/bin/secondbrain-vault init [DIR]          start a new vault in DIR
.secondbrain/bin/secondbrain-vault rules [--check] [--force]
                                                       AGENTS.md = AGENTS.base.md + AGENTS.local.md
.secondbrain/bin/secondbrain-vault link-skills         symlink the engine's skills into .agents/skills/
```

The vault it acts on is `--vault`, else the folder that holds the engine as `.secondbrain/`, else the current directory. It is Python 3.9+, standard library only.

- `rules --check` exits non-zero if `AGENTS.md` is stale or was edited by hand. Useful in a pre-commit hook.
- `rules --force` overwrites a hand-edited `AGENTS.md`.
- `link-skills` never replaces a real folder: if you have your own skill with the same name as a shared one, yours wins.

## Rules for agents, in layers

| Layer | File | Who changes it |
|---|---|---|
| Shared rules every vault gets | `.secondbrain/vault-template/AGENTS.base.md` | A pull request to the engine |
| Your rules | `AGENTS.local.md` | You |
| What agents read | `AGENTS.md` (generated) | `secondbrain-vault rules` |
| Per-folder rules | An `AGENTS.md` (and a `CLAUDE.md` that imports it) inside a folder | You |

The base rules cover: markdown as the deliverable format, where files go, the house style for research notes, how to handle credentials, copy-ready text, completion contracts for long tasks, what the guard blocks, and the dev-log requirement. Read `AGENTS.base.md` once; it is short.

## Skills

A skill is a folder with a `SKILL.md` (YAML frontmatter with `name` and `description`, then instructions). Claude Code finds them through `.claude/skills` (a symlink to `.agents/skills`); Hermes through `skills.external_dirs` ([agent-harness.md](agent-harness.md#hermes)).

Shared skills in the engine today:

| Skill | Pairs with |
|---|---|
| `fact-check` | The `fact-checker` subagent: verifies a finished note against its sources |
| `ingest` | Any vault: turns a link (article, video, paper) into a summarised note tied to your goals |
| `company-report` | The `projects` module: reads and updates the tracker with `cli-projects` |
| `org-member` | The `org` module: how a named agent works on the message board |
| `livestream-x` | The `livestream` module: adds an X stream by link |

## Updating the engine

```bash
git -C .secondbrain fetch origin
git -C .secondbrain checkout origin/main          # or a tag, or a specific commit
.secondbrain/bin/secondbrain-vault rules          # AGENTS.base.md may have changed
.secondbrain/bin/secondbrain-vault link-skills    # new shared skills
secondbrain restart                               # the launcher rebuilds and migrates as needed
git add .secondbrain AGENTS.md .agents/skills && git commit -m "engine: update"
```

The pin is just a commit hash in your vault, so rolling back is checking out the previous one. Migrations only move forward, though: rolling the app back past a migration it has already run means the old code meets a newer schema. Check the release notes or the diff of `app/db/migrations/` before rolling back.

On a server, take the same pin and redeploy ([deployment.md](deployment.md)).

## Changing the engine from inside your vault

Don't edit the pinned `.secondbrain/` checkout in place: your next pin move would discard it, and it mixes your vault work with engine work. Use a worktree:

```bash
git -C .secondbrain worktree add ../secondbrain-my-fix -b fix/my-fix origin/main
# work in ../secondbrain-my-fix, then push the branch and open a PR
```

Once it's merged, move your pin. [`../CONTRIBUTING.md`](../CONTRIBUTING.md) has the rest.
