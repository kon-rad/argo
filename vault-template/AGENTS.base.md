# AGENTS.md - rules for agents working in this vault

This vault is a plain-markdown second brain organised with PARA (see `PARA Guide.md`). These are the shared rules every agent follows here (Claude Code, Hermes, Codex and others). Rules specific to this vault's owner follow in the second half of this file, from `AGENTS.local.md`.

**This file is generated.** Edit `AGENTS.local.md` (your rules) and run `.secondbrain/bin/secondbrain-vault rules`. The shared half comes from the engine (`.secondbrain/vault-template/AGENTS.base.md`); change it with a pull request to the engine, never here.

---

## Output format: markdown only

**Every deliverable in this vault is a `.md` file.**

- No HTML pages, no published web pages, no JSON sidecars or scratch copies next to notes. A note that isn't markdown can't be searched, linked or edited on a phone.
- One markdown file per deliverable unless asked for more.
- If a rendered or shareable version is genuinely needed, ask first.

Code projects that live in the vault and have their own `AGENTS.md` are the exception for their code: read that file first when you work in one.

---

## Where files go

Top-level buckets are `Projects/`, `Areas/`, `Research/`, `Archives/`. Actionability decides the bucket, not topic (see `PARA Guide.md`).

- Resolve a folder against the real tree before writing. The target directory usually exists already; run `find` on the branch first and create intermediate folders only when they're genuinely missing.
- Filenames are lowercase kebab-case, descriptive, no dates in the name unless the file is inherently dated (e.g. `week-09_2026-07-27_to_08-02.md`). Research files often end in `-research.md`.

---

## House style for research and reference documents

Before writing, **read a neighbouring file in the target folder** and match it. The default pattern:

```markdown
# Title of the Research
### One-line subtitle naming the specific project or context

**Researched:** YYYY-MM-DD
**Goal:** What this research is meant to answer, concretely.
**Scope:** Jurisdiction, timeframe, or boundary if relevant.

---

## TL;DR - the five things that matter

1. **Bolded claim.** Then the reasoning.
```

- **Lead with a TL;DR of about five items**, each opening with a bolded claim. Flag which finding is most likely to change the plan.
- **Use tables** for comparisons, options, dates, thresholds and pricing.
- **Separate confirmed from inferred.** Close long research docs with a `## What's confirmed vs. inferred` section, plus open questions not yet researched.
- **Link sources at the end**, grouped by theme. Prefer primary sources and say which is which.
- **Cross-reference sibling notes** with `[[wikilinks]]`.

---

## Credentials

**`.env` in the vault root holds the keys.** It is gitignored, and its values never belong in a note, a commit, or terminal output.

- Load it in a shell, never into context: `set -a; . ./.env; set +a` (or `python-dotenv` inside a script). To check a key exists, test the variable after sourcing: `[ -n "$SOME_KEY" ] && echo set`.
- The guard hook blocks reading `.env` with file tools or `cat`/`grep`/`head` (see "Guardrails").

---

## Copy-ready text

Text the owner will paste somewhere else (emails, replies, posts, form answers) must be plain text they can select and copy as-is, in notes and in chat:

- No indentation, no `>` quotes, no code blocks.
- No markdown inside it: no bold, italics, headings or `[links](url)`. Write URLs out in full. Plain `- ` list lines are fine.
- Blank lines between paragraphs, exactly as it should look when sent.
- Label it with a line before it, and put commentary after it.

---

## General working notes

- Don't launch subagents, workflows or deep-research skills unless asked. A skill may run the `fact-check` procedure as one of its own steps.
- Convert relative dates to absolute ones; notes outlive the conversation.
- State currencies and units explicitly.
- Never fabricate a figure to fill a table cell. Mark it unknown and list it as an open question.

---

## Long tasks: completion contracts

A task that takes more than a few steps gets a completion contract before it starts (Claude Code `/goal`, Hermes `/goal`, task specs and cron prompts):

| Field | Says |
|---|---|
| **Outcome** | The files that must exist, or the message that must be delivered, when done |
| **Verification** | The command, test or check that proves it, and its expected result |
| **Constraints** | What must not change or regress |
| **Boundaries** | Folders, machines and tools in scope |
| **Stop when** | A turn budget, or a blocker. When blocked, report `BLOCKED: <reason>` and stop; never present a partial result as done |

Finish by printing the output paths and the verification results in the conversation. Both `/goal` judges only see the conversation, not the disk.

```
/goal Outcome: Projects/x/dev-log/2026-10-12_y.md and Projects/x/x-design.md exist and the feature runs.
Verification: `python3 test_y.py` passes; paste its output. Constraints: don't touch prod config.
Boundaries: Projects/x/, .agents/skills/x/. Stop when: 20 turns, or BLOCKED: <reason>.
```

---

## Guardrails: what the hooks block

Every agent runs the same guard, `.secondbrain/harness/hooks/guard.py`, before shell and file tool calls. When it blocks, the reason starts with `guard:`. Don't work around a block with a script or another tool; tell the owner what you were trying to do.

| Rule | Blocked |
|---|---|
| Secrets into context | Printing or copying `.env` files; file-tool reads of `.env`, `auth.json`, `.credentials.json` |
| Deploy without a dry run | `rsync --delete` without `-n`/`--dry-run`, unless `.agents/guard.local.json` has `"disable": ["rsync_dry_run"]` |
| Force push | `git push --force`, `-f`, `--force-with-lease`, `+branch` |
| Vault-specific rules | Whatever `.agents/guard.local.json` lists: protected directories, paths that must not be deleted, read-only files. Its `devlog` section adds dev-log roots beyond `Projects/*`, paths the dev-log gate ignores, and an optional experience library that harness changes must add an entry to |

The guard covers agent tools only; a script you write can still read what the Unix user can.

A second hook, `devlog_gate.py`, runs when an agent tries to finish: if the session changed skills, scripts, server config or hooks without a dev-log entry dated today, it sends the agent back once to write one.

---

## Dev logs and feature docs: required for every build

**Any agent that builds a feature or changes code, infrastructure, a skill, a cron job or a server leaves a dev log and documentation in the vault before calling the work done.**

For each project, under `Projects/<project>/`:

| File | What goes in it |
|---|---|
| `<project>-design.md` | What it does, the architecture (components, data flow, where it runs, failure handling), and what is out of scope |
| `dev-log/README.md` | Starts with the `## Resume` block, then live status and an index of entries |
| `dev-log/YYYY-MM-DD_<slug>.md` | One entry per session: what changed and why, what broke and the cause, how it was tested (real results), commits, open questions. Never rewrite old entries |

**The Resume block** is the handoff between sessions and agents. Exactly these six fields, right under the README's title:

```markdown
## Resume
- **Task:** what this project is doing right now, in one line
- **Outputs:** the paths that hold the current work
- **Completed:** finished stages and the checks that passed
- **Decisions:** confirmed choices, each with where it was decided
- **Open issues:** missing evidence, blockers, unanswered questions
- **Next action:** one concrete step the next agent can start on
```

Docs that live only in code folders, `SKILL.md` files, comments or commit messages don't count. No secrets in dev logs. Say what was verified and what wasn't.

---

## The engine and this vault

`.secondbrain/` is the public engine (app, template, hooks, shared skills), pinned as a git submodule. **Never commit changes inside it from vault work.** To change the engine, work in a separate worktree of it on a branch and open a pull request (see `.secondbrain/AGENTS.md`), then move the pin once it's merged. Personal rules go in `AGENTS.local.md`, personal guard rules in `.agents/guard.local.json`, personal skills in `.agents/skills/<name>/` (a private skill with the same name as a shared one wins).
