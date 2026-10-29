# Connect Hermes

Hermes works in the same vault, under the same rules, with the same two hooks. The wiring is a block in its `config.yaml`. Reference: [agent-harness.md](../agent-harness.md#hermes).

## 1. Add the hooks and the skills folder

Copy the block from `.secondbrain/harness/hermes-hooks.example.yaml` into Hermes's `config.yaml`, with your vault's absolute path in place of `/path/to/vault`:

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

`skills.external_dirs` points at the same folder Claude Code reads through its `.claude/skills` symlink, so one skill serves both agents.

## 2. Consent to the hook commands, once per machine

Hermes asks for consent to each exact hook command the first time it would run it, and records the answer in `~/.hermes/shell-hooks-allowlist.json`.

**If the command string in `config.yaml` and the one in the allowlist differ, Hermes skips the hook silently.** That includes a changed vault path. Whenever you edit the command, update both, then test with a command the guard should block.

## 3. Work from the vault

Run Hermes with the vault as its working directory so it finds `AGENTS.md` and so the guard can locate your `.agents/guard.local.json` (it walks up from the working directory when the engine is not at `<vault>/.secondbrain/`).

## 4. Check it

Ask Hermes to `cat .env`. The answer is a block whose reason starts with `guard:`. Then change a file under `.agents/skills/` and ask it to finish; the `pre_verify` hook sends it back once for a dev log.

Hermes reports only the current turn's edits to the gate, so a dev log written earlier in the same session counts if it is recent (six hours).

## 5. Per-request token accounting (optional, for the `usage` module)

Hermes keeps only session totals. The plugin in `harness/hermes/usage-ledger/` appends one JSON line per model request (tokens, model, provider, timing, and a match key, never the text) to `<hermes home>/usage/calls-YYYY-MM-DD.jsonl`. Install it in every Hermes home and profile, then restart the gateway:

```bash
.secondbrain/harness/hermes/install-usage-ledger.sh ~/.hermes
```

The agent ledger and `secondbrain agents-sync` read those files into the usage tables. See "Agent ledger" in the [app README](https://github.com/kon-rad/argo/blob/main/app/README.md).

## Hermes on a server

When Hermes runs on the server next to the app:

| Setting | Where | Purpose |
|---|---|---|
| `DEPLOY_HERMES_HOME` | Vault `.env`, read by `deploy.sh` | Hermes's home on the server, for the `agents` module (default: the app user's `~/.hermes`) |
| `HERMES_HOME` | The machine's env | Hermes's home on this machine |
| `ARCHIVE_SSH_HOST`, `REMOTE_HERMES_HOME`, `REMOTE_HERMES_USER` | Laptop `.env` | Pull the server's Hermes history over ssh; unset skips the pull |

The guard and gate paths in the server's `config.yaml` point at the server's vault checkout, for example `/srv/vault/.secondbrain/harness/hooks/guard.py`.

Next: [Connect another harness](05-other-harnesses.md), or [Connect servers and computers](06-connect-machines.md).
