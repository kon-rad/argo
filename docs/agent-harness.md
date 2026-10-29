# The agent harness

AI agents work in your vault the way you do: they read and write markdown, run commands, and edit skills and scripts. The harness gives every agent the same rules and the same two hooks, whichever agent it is.

| Piece | File | Runs |
|---|---|---|
| Shared rules | `AGENTS.md` (compiled from `vault-template/AGENTS.base.md` + your `AGENTS.local.md`) | Read by the agent at session start |
| Guard | `harness/hooks/guard.py` | Before every tool call |
| Dev-log gate | `harness/hooks/devlog_gate.py` | When the agent tries to finish |
| Fact-checker subagent | `harness/claude/agents/fact-checker.md` | When a skill or you ask for it |

Both hooks are Python 3 standard library, have their own tests (`harness/hooks/test_*.py`), and **fail open**: a payload they can't parse is allowed, so a hook bug never stops an agent.

**They are guardrails, not a sandbox.** They check the text of agent tool calls. A script an agent writes can still read anything its Unix user can read. Keep anything truly dangerous (signing keys, other people's data) under a different Unix user.

## The guard

Before each tool call the agent sends the guard a JSON payload on stdin (tool name, input, working directory). The guard answers in the caller's format: Claude Code gets exit code 2 with the reason on stderr; Hermes gets `{"decision": "block", "reason": "guard: ..."}`. Every block is appended to `~/.cache/agent-guard.log`.

### Built-in rules (every vault)

| Rule | Blocks | Can a vault turn it off? |
|---|---|---|
| Secrets | Shell readers or copiers (`cat`, `grep`, `sed`, `cp`, `rsync`, `curl`, `echo` and others) whose text names `.env`, `.env.<x>` (not `.env.example`), `auth.json` or `.credentials.json`; file-tool reads and writes of those files | No |
| Force push | `git push --force`, `-f`, `--force-with-lease`, `+branch` | No |
| Deploy without a dry run | `rsync --delete` without `-n` / `--dry-run` | Yes: `"disable": ["rsync_dry_run"]` |

Loading keys into a shell the safe way passes: `set -a; . ./.env; set +a`, then test a variable (`[ -n "$SOME_KEY" ] && echo set`).

Shell commands are split on `;`, `&&`, `||`, pipes, newlines and `$(`, and each piece is judged by its first real word (skipping `VAR=x`, `sudo`, `env`). Because it matches on text, a harmless command that merely *mentions* `.env` next to `grep` is blocked too. The fix is to put the work in a script file, not to dodge the rule.

### Your own rules: `guard.local.json`

`.agents/guard.local.json` in your vault adds rules:

```json
{
  "protected_dirs": [{ "path": "/home/other-user/", "reason": "another user's keys" }],
  "no_delete":      [{ "path": "data/blobs", "reason": "the only copy" }],
  "readonly":       [{ "pattern": "Areas/old/[^/]*\\.html$", "reason": "legacy file" }],
  "disable":        ["rsync_dry_run"],
  "devlog": {
    "roots":  ["Areas/app/*"],
    "exempt": [".agents/memory/"]
  }
}
```

| Key | Effect |
|---|---|
| `protected_dirs` | Any command or file tool that names the path is blocked |
| `no_delete` | `rm`, `find -delete`, `trash`, `rmdir` under the path are blocked |
| `readonly` | File-tool writes to a path matching the regex are blocked |
| `disable` | Built-in rules to switch off. Only `rsync_dry_run` can be |
| `devlog.roots` | Extra places where dev logs count (globs; `<root>/**/dev-log/YYYY-MM-DD*.md`) |
| `devlog.exempt` | Path prefixes the dev-log gate never watches |

The guard finds the file at `$SB_GUARD_LOCAL`, then next to the vault that holds the engine, then under `$CLAUDE_PROJECT_DIR`, then in the first parent of the working directory that has one. A missing or broken file means built-in rules only.

## The dev-log gate

When an agent tries to finish (Claude Code `Stop`, Hermes `pre_verify`), the gate looks at which files the session changed. If any are **watched** and the agent wrote no dev-log entry recently, it sends the agent back once with "write the dev log entry first".

| | |
|---|---|
| Watched | `.agents/`, `.claude/settings.json`, `.claude/agents/`, `.hermes/skills/`, `.hermes/scripts/`, `.hermes/server/`, `.hermes/plugins/` |
| Counts as a dev log | `Projects/*/**/dev-log/YYYY-MM-DD*.md`, plus any `devlog.roots` you add |
| Index to link from | `DEV_LOG_INDEX` in your `.env`, if set |
| One-shot | A second attempt always passes (Claude's `stop_hook_active`, Hermes's `attempt > 0`) |

The point is a record a person can read: what changed, why, how it was tested. The `AGENTS.base.md` rules describe the expected dev-log layout.

## Wiring

### Claude Code

`secondbrain-vault init` copies `harness/claude/settings.json` into `.claude/settings.json`:

- `PreToolUse` on `Bash|Read|Grep|Glob|Edit|Write|MultiEdit|NotebookEdit` runs `guard.py`;
- `Stop` runs `devlog_gate.py`;
- `permissions.deny` also blocks reading or editing `.env`, `.env.*`, `auth.json` and `.credentials.json` at the Claude Code level;
- `permissions.deny` keeps Read, Grep and Glob out of `node_modules/`, `dist/`, `build/`, `.git/objects/`, virtualenvs, caches, minified bundles, source maps and database files (Claude Code has no `.claudeignore`; this is how it ignores paths);
- `env` caps a Bash result at 12,000 characters (`BASH_MAX_OUTPUT_LENGTH`) and an MCP result at 10,000 tokens (`MAX_MCP_OUTPUT_TOKENS`). Each turn re-sends the whole conversation, so one big output costs again on every later turn.

`init` copies the file only into a new vault. An existing vault picks up these rules by copying `harness/claude/settings.json` over its `.claude/settings.json` again (keep any lines you added).

The commands use `$CLAUDE_PROJECT_DIR/.secondbrain/harness/hooks/`, so they follow your engine pin.

### Hermes

Add the block from `harness/hermes-hooks.example.yaml` to Hermes's `config.yaml`, with your vault path:

```yaml
hooks:
  pre_tool_call:
    - matcher: "terminal|read_file|write_file|patch|search_files"
      command: "python3 /path/to/vault/.secondbrain/harness/hooks/guard.py"
      timeout: 5
  pre_verify:
    - command: "python3 /path/to/vault/.secondbrain/harness/hooks/devlog_gate.py"
      timeout: 10

skills:
  external_dirs:
    - /path/to/vault/.agents/skills
```

Hermes asks for consent to each exact hook command once per machine and records it in `~/.hermes/shell-hooks-allowlist.json`. **If the command string in the config and the allowlist differ, Hermes skips the hook silently.** Update both together, and test with a command the guard should block.

### zen-agent

[zen-agent](https://github.com/kon-rad/argo/blob/main/zen-agent/README.md) runs the guard in process (the same built-in rules and the same `guard.local.json`, ported to TypeScript) and runs `guard.py` and `devlog_gate.py` as hook commands when `zen.json` lists them under `guard.hooks.preToolUse` and `guard.hooks.stop`. Its skills come from the same `.agents/skills`. Every block is appended to the same `~/.cache/agent-guard.log`. Running the bots on it is described in [zen-runtime.md](zen-runtime.md).

### Other agents

Any agent that can run a command before a tool call and pass it a JSON payload can use the guard. The payload shape is in the docstring at the top of `guard.py`; the tests show real examples.

## Testing your setup

```bash
python3 -m pytest .secondbrain/harness
```

Then, inside the agent, ask it to `cat .env`. It should be refused with a reason that starts with `guard:`.
