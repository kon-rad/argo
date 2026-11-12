#!/usr/bin/env python3
"""Shared tool guard for Claude Code (PreToolUse) and Hermes (pre_tool_call).

Reads the hook payload as JSON on stdin, checks the vault's hard rules, and
answers in whichever format the calling agent expects:

  Claude Code  hook_event_name "PreToolUse"   block = exit 2, reason on stderr
  Hermes       hook_event_name "pre_tool_call" block = print {"decision": "block", ...}

Built-in rules (every vault): secrets files never reach a tool, key values
never sit in a command line or travel over ssh, no rsync --delete without a
dry run first, no force push.

Vault-specific rules come from .agents/guard.local.json in the vault:

  {
    "protected_dirs": [{"path": "/home/other-user/", "reason": "..."}],
    "no_delete":      [{"path": "data/blobs", "reason": "..."}],
    "readonly":       [{"pattern": "Areas/old/[^/]*\\.html$", "reason": "..."}],
    "disable":        ["rsync_dry_run"]
  }

"disable" switches off built-in rules by name. Only "rsync_dry_run" can be
switched off (for a vault whose owner deploys without a dry run); the secrets
and force-push rules always apply. The same file's "devlog" section is read
by devlog_gate.py.

The file is found, in order, at $SB_GUARD_LOCAL, next to the vault that holds
this engine (<vault>/.secondbrain/harness/hooks/guard.py), under
$CLAUDE_PROJECT_DIR, or in the first parent of the payload's cwd that has one.
A missing or broken file means built-in rules only.

Fails open: a payload it can't parse is allowed, so a guard bug never bricks
an agent. Blocks are appended to ~/.cache/agent-guard.log.
"""
import json
import os
import re
import shlex
import sys
import time

SHELL_TOOLS = {"Bash", "terminal"}
READ_TOOLS = {"Read", "Grep", "Glob", "read_file", "search_files"}
WRITE_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit", "write_file", "patch"}

SECRET_NAMES = {".env", "auth.json", ".credentials.json"}
# Commands that would put a file's contents (or a copy of it) somewhere visible.
READERS = {
    "cat", "less", "more", "head", "tail", "grep", "egrep", "rg", "awk", "sed",
    "echo", "printf", "cp", "scp", "rsync", "xxd", "od", "strings", "base64",
    "bat", "nl", "tee", "diff", "sort", "uniq", "wc", "cut", "jq", "curl",
}
HERE = os.path.dirname(os.path.abspath(__file__))
SECRET_TOKEN = re.compile(
    r"""(?:^|[\s/"'=<>:])(?:\.env(?:\.(?!example\b)[\w.-]+)?|auth\.json|\.credentials\.json)(?=$|[\s"';|&)<>])"""
)
SEGMENT_SPLIT = re.compile(r"&&|\|\||[;|\n]|\$\(|`")
# rsync/scp flags that keep a file OUT of a transfer. Naming .env.local there is how a
# deploy protects the server's secrets, so it must not read as copying them.
EXCLUDE_ARG = re.compile(
    r"""--(?:exclude|filter|include)(?:-from)?(?:=|\s+)(?:'[^']*'|"[^"]*"|\S+)"""
)
# Key values written into a command line. The command is visible to every user in the
# process list and is saved verbatim in the agent's transcript and logs.
KEY_VALUE = re.compile(
    r"""(?<![A-Za-z0-9_-])(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}"""
    r"""|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}"""
    r"""|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}"""
    r"""|hf_[A-Za-z0-9]{30,}|glpat-[A-Za-z0-9_-]{20,}"""
    r"""|[A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Za-z0-9_]*=['"]?(?=[A-Za-z_+-]*[0-9])[A-Za-z0-9_+-]{20,}(?![A-Za-z0-9_+/.~-]))"""
)
# A shell variable whose name says it holds a secret, e.g. $OPENAI_API_KEY or ${HF_TOKEN}.
SECRET_VAR = re.compile(
    r"""\$\{?[A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)[A-Za-z0-9_]*\}?(?![A-Za-z0-9_])"""
)
SSH_WORD = re.compile(r"""(?:^|[\s;&|(])ssh(?=\s)""")
# Built-in rules a vault may switch off in guard.local.json "disable".
DISABLEABLE = {"rsync_dry_run"}


def find_local_rules(payload: dict):
    candidates = []
    if os.environ.get("SB_GUARD_LOCAL"):
        candidates.append(os.environ["SB_GUARD_LOCAL"])
    engine = os.path.dirname(os.path.dirname(HERE))
    if os.path.basename(engine) == ".secondbrain":
        candidates.append(os.path.join(os.path.dirname(engine), ".agents", "guard.local.json"))
    if os.environ.get("CLAUDE_PROJECT_DIR"):
        candidates.append(os.path.join(os.environ["CLAUDE_PROJECT_DIR"], ".agents", "guard.local.json"))
    d = os.path.abspath(str(payload.get("cwd") or os.getcwd()))
    while True:
        candidates.append(os.path.join(d, ".agents", "guard.local.json"))
        if d == os.path.dirname(d):
            break
        d = os.path.dirname(d)
    for c in candidates:
        if os.path.isfile(c):
            return c
    return None


def load_local_rules(payload: dict) -> dict:
    path = find_local_rules(payload)
    rules = {"protected_dirs": [], "no_delete": [], "readonly": [], "disable": set()}
    if not path:
        return rules
    try:
        with open(path) as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return rules
    if not isinstance(data, dict):
        return rules
    for key in ("protected_dirs", "no_delete", "readonly"):
        field = "pattern" if key == "readonly" else "path"
        items = data.get(key) or []
        if isinstance(items, list):
            rules[key] = [i for i in items if isinstance(i, dict) and isinstance(i.get(field), str) and i.get(field)]
    disable = data.get("disable") or []
    if isinstance(disable, list):
        rules["disable"] = {d for d in disable if d in DISABLEABLE}
    return rules


def is_secret_path(path: str) -> bool:
    base = os.path.basename(path.rstrip("/"))
    if base in SECRET_NAMES:
        return True
    return base.startswith(".env.") and base != ".env.example"


def first_word(segment: str) -> str:
    try:
        words = shlex.split(segment, posix=True)
    except ValueError:
        words = segment.split()
    # Skip VAR=value prefixes and sudo/env/command wrappers.
    for w in words:
        if re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", w) or w in {"sudo", "env", "command", "nohup", "time"}:
            continue
        return os.path.basename(w)
    return ""


def locally_expanded(cmd: str) -> str:
    """The parts of cmd this shell expands: drops single-quoted spans and \\$ escapes."""
    out, i, dq = [], 0, False
    while i < len(cmd):
        c = cmd[i]
        if c == "\\" and i + 1 < len(cmd):
            i += 2
            continue
        if c == '"':
            dq = not dq
        elif c == "'" and not dq:
            end = cmd.find("'", i + 1)
            i = len(cmd) if end < 0 else end + 1
            continue
        out.append(c)
        i += 1
    return "".join(out)


def check_inline_secrets(cmd: str):
    if KEY_VALUE.search(cmd):
        return ("guard: that command has a key value written into it, which leaves it in the process "
                "list and the agent logs. Source .env and pass the variable to a local program instead.")
    expanded = locally_expanded(cmd)
    if SSH_WORD.search(" " + cmd) and SECRET_VAR.search(expanded):
        return ("guard: that would send a key to another machine through ssh, where it lands in the "
                "remote process list and shell history. Keys are moved between machines by hand: ask "
                "the owner to put it in a chmod 600 env file there, and source that file remotely.")
    for raw in SEGMENT_SPLIT.split(cmd):
        seg = raw.strip().lstrip("(").strip()
        word = first_word(seg)
        if word in {"echo", "printf"} and SECRET_VAR.search(locally_expanded(seg)):
            return ("guard: that would print a key into the transcript. Test it with "
                    "`[ -n \"$NAME\" ] && echo set` instead (AGENTS.md, Credentials).")
        if word == "printenv" and re.search(r"(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)", seg):
            return "guard: that would print a key into the transcript. Test it with `[ -n \"$NAME\" ] && echo set` instead."
    return None


def protected_reason(item: dict) -> str:
    return "guard: " + (item.get("reason") or f"{item['path']} is off limits to agents (.agents/guard.local.json).")


def check_shell(cmd: str, rules: dict):
    for item in rules["protected_dirs"]:
        d = item["path"]
        if d in cmd or d.rstrip("/") + " " in cmd + " ":
            return protected_reason(item)

    reason = check_inline_secrets(cmd)
    if reason:
        return reason

    for raw in SEGMENT_SPLIT.split(cmd):
        seg = raw.strip().lstrip("(").strip()
        if not seg:
            continue
        word = first_word(seg)

        if word in READERS and SECRET_TOKEN.search(EXCLUDE_ARG.sub(" ", seg)):
            return ("guard: that would print or copy a secrets file. Load keys with "
                    "`set -a; . ./.env; set +a` and test variables instead (AGENTS.md, Credentials).")

        if word == "rsync" and "--delete" in seg and "rsync_dry_run" not in rules["disable"]:
            dry = "--dry-run" in seg or re.search(r"(?:^|\s)-[A-Za-z]*n[A-Za-z]*(?=\s|$)", seg)
            if not dry:
                return ("guard: rsync --delete without a dry run. Run it with -n first, read the "
                        "'deleting' lines, then ask the user before the real run.")

        if word in {"rm", "find", "trash", "rmdir"}:
            for item in rules["no_delete"]:
                if item["path"] in seg and (word != "find" or "-delete" in seg or "-exec" in seg):
                    return "guard: " + (item.get("reason") or f"deleting under {item['path']} is blocked (.agents/guard.local.json).")

        if word == "git" and re.search(r"\bpush\b", seg):
            if re.search(r"(?:^|\s)(?:--force(?:-with-lease)?(?:=\S*)?|-f|-[A-Za-z]*f[A-Za-z]*)(?=\s|$)", seg) or re.search(r"\s\+\S+", seg):
                return "guard: force push is blocked. Other sessions and syncs share this repo; pull and merge instead."
    return None


def check_path(tool: str, path: str, rules: dict):
    if not path:
        return None
    for item in rules["protected_dirs"]:
        d = item["path"]
        if path.startswith(d) or path == d.rstrip("/"):
            return protected_reason(item)
    if is_secret_path(path) and (tool in READ_TOOLS or tool in WRITE_TOOLS):
        return "guard: secrets files can't be read or edited by agent tools. Source .env in a shell instead (AGENTS.md, Credentials)."
    if tool in WRITE_TOOLS:
        for item in rules["readonly"]:
            try:
                if re.search(item["pattern"], path):
                    return "guard: " + (item.get("reason") or f"{path} is read-only for agents (.agents/guard.local.json).")
            except re.error:
                continue
    return None


def decide(payload: dict):
    tool = payload.get("tool_name") or ""
    ti = payload.get("tool_input") or {}
    if not isinstance(ti, dict):
        return None
    if tool not in SHELL_TOOLS and tool not in READ_TOOLS and tool not in WRITE_TOOLS:
        return None
    rules = load_local_rules(payload)
    if tool in SHELL_TOOLS:
        return check_shell(str(ti.get("command") or ""), rules)
    path = ti.get("file_path") or ti.get("path") or ti.get("notebook_path") or ""
    return check_path(tool, str(path), rules)
    return None


def log(payload: dict, reason: str):
    try:
        p = os.path.expanduser("~/.cache/agent-guard.log")
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "a") as f:
            f.write(json.dumps({
                "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                "agent": "claude" if payload.get("hook_event_name") == "PreToolUse" else "hermes",
                "tool": payload.get("tool_name"),
                "reason": reason,
            }) + "\n")
    except OSError:
        pass


def main():
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError:
        sys.exit(0)
    claude = payload.get("hook_event_name") == "PreToolUse"
    reason = decide(payload)
    if reason:
        log(payload, reason)
        if claude:
            print(reason, file=sys.stderr)
            sys.exit(2)
        print(json.dumps({"decision": "block", "reason": reason}))
        sys.exit(0)
    if not claude:
        print("{}")
    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:  # fail open: a guard bug must never brick an agent
        sys.exit(0)
