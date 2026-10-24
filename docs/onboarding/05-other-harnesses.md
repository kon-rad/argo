# Connect another harness

Claude Code and Hermes ship wired. Any other agent can work in the vault on the same rules, because the rules are a plain file and the hooks are plain scripts with a small JSON contract. This page covers three layers, from the one every harness gets for free to the one that needs a few lines of glue.

## Layer 1: the rules (every harness)

`AGENTS.md` is an open convention that a growing list of coding agents read from the working directory without configuration: OpenAI Codex, Cursor, GitHub Copilot's coding agent, OpenCode, Amp and others. The current list is kept at [agents.md](https://agents.md). For those, opening the vault folder is the whole setup.

For a harness that reads a different filename, make that file a one-line import or a copy:

| Harness reads | Do |
|---|---|
| `CLAUDE.md` | Already there: `@AGENTS.md` |
| `GEMINI.md` | Point its context filename setting at `AGENTS.md`, or copy `CLAUDE.md`'s approach: a file that says to read `AGENTS.md` first |
| `.cursorrules`, `.windsurfrules`, a system prompt field | Paste "Read and follow `AGENTS.md` in the vault root before anything else." Many of these also read `AGENTS.md` directly now |
| Your own script around an API | Put the contents of `AGENTS.md` in the system prompt, or tell the model to read it with its first tool call |

Regenerate `AGENTS.md` with `secondbrain-vault rules` whenever `AGENTS.local.md` or the engine changes. It is the same text for every agent, which is the point.

## Layer 2: the skills (most harnesses)

Skills are folders under `.agents/skills/` with a `SKILL.md`: YAML frontmatter with `name` and `description`, then instructions. The format is the one Claude Code uses; Hermes loads the same folders through `skills.external_dirs`. For another harness:

- If it loads skills from a configurable folder, point it at `<vault>/.agents/skills`.
- If it only reads rule files, the skills are still useful as documents: tell the agent "follow `.agents/skills/ingest/SKILL.md`" in the prompt.

## Layer 3: the hooks (a harness with pre-tool and pre-finish hooks)

The guard and the dev-log gate are stdlib Python scripts that read one JSON object on stdin and answer on stdout or by exit code. Any harness that can run a command before a tool call, and pass it what the tool is about to do, can use them.

### The guard's contract

Input, one JSON object on stdin:

```json
{
  "hook_event_name": "pre_tool_call",
  "tool_name": "terminal",
  "tool_input": { "command": "cat .env" },
  "cwd": "/path/to/vault"
}
```

| Field | Meaning |
|---|---|
| `hook_event_name` | `PreToolUse` selects Claude Code's answer format (exit 2, reason on stderr). Anything else gets Hermes's format: `{"decision": "block", "reason": "guard: ..."}` on stdout, or `{}` to allow |
| `tool_name` | One of the shell tools (`Bash`, `terminal`), read tools (`Read`, `Grep`, `Glob`, `read_file`, `search_files`) or write tools (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`, `write_file`, `patch`). Any other name is allowed through untouched |
| `tool_input.command` | For a shell tool: the command text |
| `tool_input.file_path`, `.path` or `.notebook_path` | For a read or write tool: the target path |
| `cwd` | Where the agent is working. Used to find `.agents/guard.local.json` when the engine is not at `<vault>/.secondbrain/` |

If your harness names its tools differently, map them in a wrapper before calling the guard. A ten-line shell wrapper with `jq` is enough:

```bash
#!/usr/bin/env bash
# my-guard.sh: translate this harness's payload into the guard's, then call it.
# Here the harness sends {"tool": "shell", "args": {"cmd": "..."}, "dir": "..."}.
jq '{hook_event_name: "pre_tool_call",
     tool_name: (if .tool == "shell" then "terminal" elif .tool == "read" then "read_file" else "write_file" end),
     tool_input: {command: .args.cmd, file_path: .args.path},
     cwd: .dir}' \
  | python3 /path/to/vault/.secondbrain/harness/hooks/guard.py
```

Treat a `{"decision": "block", ...}` answer as a refusal and show the agent the reason. The reason always starts with `guard:`, and the base rules tell agents not to work around it.

### The dev-log gate's contract

```json
{
  "hook_event_name": "pre_verify",
  "cwd": "/path/to/vault",
  "extra": { "changed_paths": [".agents/skills/x/SKILL.md"], "attempt": 0 }
}
```

`changed_paths` is the list of files the session (or turn) changed; `attempt` greater than zero means the agent was already sent back once, and the gate lets it finish. The answer format follows `hook_event_name` the same way the guard's does. Claude Code's `Stop` event is handled natively, with the changed files read from its transcript.

### Testing the glue

Pipe a payload by hand and read the answer:

```bash
printf '%s' '{"hook_event_name":"pre_tool_call","tool_name":"terminal","tool_input":{"command":"cat .env"},"cwd":"."}' \
  | python3 .secondbrain/harness/hooks/guard.py
# {"decision": "block", "reason": "guard: ..."}
```

The tests in `harness/hooks/test_guard.py` and `test_devlog_gate.py` are the full set of worked examples, in both formats.

## When a harness has no hooks

The guard is a guardrail, not a sandbox, and a harness without hooks gets no guardrail. What still works:

- **The rules.** `AGENTS.md` tells the agent how to load keys (`set -a; . ./.env; set +a`, never `cat`) and what never to do.
- **The app's own defences.** Credential-shaped files are never indexed or served; only the editor route writes notes, with an optimistic lock.
- **Unix.** Run the agent as a user that cannot read `.env` or anything else it should not have. This is the one measure that holds against an agent that writes its own scripts, hooks or not.
- **Review.** Run the `fact-check` skill as the last step of anything you will read without checking.

Next: [Connect servers and computers](06-connect-machines.md).
