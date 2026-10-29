# Connect Claude Code

`secondbrain-vault init` already wired Claude Code. This page is what that wiring does, how to check it, and how to make it yours. Reference: [agent-harness.md](../agent-harness.md).

## Start it

```bash
cd my-vault
claude
```

Claude Code reads `CLAUDE.md`, which is one line, `@AGENTS.md`, so it loads the same rules every other agent gets: the engine's shared base plus your `AGENTS.local.md`.

## What `init` wired

| File | Does |
|---|---|
| `.claude/settings.json` | Runs the guard before every `Bash`, `Read`, `Grep`, `Glob`, `Edit`, `Write`, `MultiEdit` and `NotebookEdit` call, and the dev-log gate on `Stop`. Denies reading or editing `.env`, `.env.*`, `auth.json` and `.credentials.json` at the Claude Code level too. Keeps `Read`, `Grep` and `Glob` out of `node_modules/`, `dist/`, build output, caches, minified bundles and database files. Caps a Bash result at 12,000 characters and an MCP result at 10,000 tokens |
| `.claude/agents/fact-checker.md` | A read-only subagent that verifies a finished note against its sources |
| `.claude/skills` | A symlink to `.agents/skills`, where your skills and the engine's shared ones live |
| `CLAUDE.md` | `@AGENTS.md` |

The hook commands use `$CLAUDE_PROJECT_DIR/.secondbrain/harness/hooks/`, so they follow your engine pin. Nothing is installed outside the vault.

## Check it in one minute

Inside Claude Code, ask it to `cat .env`. The answer should be a refusal whose reason starts with `guard:`. Every block is also appended to `~/.cache/agent-guard.log`.

Then ask it to edit a skill under `.agents/skills/` and finish. It should be sent back once to write a dev log entry under `Projects/<project>/dev-log/` before it can stop.

From a shell, the hooks' own tests:

```bash
python3 -m pytest .secondbrain/harness
```

## Make it yours

**Your rules.** Write them in `AGENTS.local.md` (folder conventions, your projects, your voice, what is off limits), then regenerate:

```bash
.secondbrain/bin/secondbrain-vault rules
```

`rules --check` fails if `AGENTS.md` is stale or was hand-edited, which makes a good pre-commit hook.

**Your guard rules.** `.agents/guard.local.json` adds protected directories, paths that must not be deleted, read-only files, extra dev-log roots and exempt paths. The format is in [agent-harness.md](../agent-harness.md#your-own-rules-guardlocaljson).

**Your skills.** A folder under `.agents/skills/<name>/` with a `SKILL.md` (frontmatter `name` and `description`, then instructions). Claude Code sees it through the symlink. A private skill with the same name as a shared one wins.

**Per-folder rules.** A code project inside the vault can carry its own `AGENTS.md` and a `CLAUDE.md` that imports it. The base rules tell agents to read it first when working there.

**Claude-only settings.** `CLAUDE.local.md` is gitignored by the template, for anything that should not be committed.

## Headless runs

The orchestration patterns later in this onboarding run Claude Code without a terminal:

```bash
claude -p "Follow the ingest skill for <url>. Stop when the note exists."
```

Headless runs re-send the whole conversation on every turn, which is why the base rules carry a context budget: capped output, one task per run, steps written to a file rather than held in context. Keep prompts to one task and let the next run read the file.

The base rules also ask for a completion contract on long tasks (outcome, verification, constraints, boundaries, stop condition). Put it in the prompt. Both the rules and the contract are in [`AGENTS.base.md`](https://github.com/kon-rad/argo/blob/main/vault-template/AGENTS.base.md).

## An existing vault, or a vault made before a harness change

`init` copies `harness/claude/settings.json` only into a new vault. To pick up a newer version, copy it over your `.claude/settings.json` again and re-add any lines of your own:

```bash
cp .secondbrain/harness/claude/settings.json .claude/settings.json
```

## When hooks do not fire

| Symptom | Cause |
|---|---|
| `cat .env` is not refused | Claude Code was started outside the vault, so `CLAUDE_PROJECT_DIR` points elsewhere. Start it in the vault root |
| `python3: command not found` in the hook output | Python 3 is not on the PATH Claude Code uses. Install it, or change the command in `.claude/settings.json` to a full path |
| A harmless command that mentions `.env` is blocked | By design: the guard matches text. Put the work in a script file instead of dodging the rule |
| The dev-log gate never asks | Nothing watched changed. It watches `.agents/`, `.claude/settings.json`, `.claude/agents/` and the Hermes skill, script, server and plugin folders. Add roots in `guard.local.json` under `devlog.roots` |

Next: [Connect Hermes](04-hermes.md), or skip to [Connect servers and computers](06-connect-machines.md).
