#!/usr/bin/env python3
"""Dev-log gate for Claude Code (Stop) and Hermes (pre_verify).

When an agent is about to finish, check whether this session changed harness
or infrastructure files (skills, scripts, server config, hooks, plugins). If it
did and no dev-log entry was written, send the agent back once with:
"write the dev log entry first" (AGENTS.md, "Dev logs and feature docs").

  Claude Code  Stop         payload has transcript_path, stop_hook_active
               keep going = exit 2, reason on stderr
  Hermes       pre_verify   payload.extra has changed_paths, attempt
               keep going = print {"decision": "block", "reason": ...}

One-shot: Claude's stop_hook_active and Hermes's attempt > 0 both mean the
agent was already nudged, so the gate lets it finish. Fails open on any error.
"""
import glob
import json
import os
import re
import sys
import time

WATCHED = re.compile(
    r"(?:^|/)(?:\.hermes/(?:skills|scripts|server|plugins)/|\.agents/|\.claude/settings\.json$|\.claude/agents/)"
)
DEVLOG = re.compile(r"(?:^|/)Projects/[^/]+/(?:.+/)?dev-log/\d{4}-\d{2}-\d{2}[^/]*\.md$")
RECENT_SECONDS = 6 * 3600
EDIT_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}

REASON = (
    "devlog gate: this session changed harness or infrastructure files ({files}) but wrote no "
    "dev-log entry. Before finishing: add Projects/<project>/dev-log/YYYY-MM-DD_<slug>.md "
    "(what changed and why, how it was tested with real results), update the ## Resume block in "
    "that project's dev-log/README.md{index} (AGENTS.md, 'Dev logs and feature docs'). "
    "If this change truly needs no dev log, say why in one line and finish."
)


def claude_changed_paths(transcript_path: str):
    paths = []
    try:
        with open(transcript_path) as f:
            for line in f:
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                content = (rec.get("message") or {}).get("content")
                if not isinstance(content, list):
                    continue
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "tool_use" and block.get("name") in EDIT_TOOLS:
                        inp = block.get("input") or {}
                        p = inp.get("file_path") or inp.get("notebook_path")
                        if p:
                            paths.append(p)
    except OSError:
        pass
    return paths


def recent_devlog_on_disk(root: str) -> bool:
    now = time.time()
    for p in glob.glob(os.path.join(root, "Projects", "**", "dev-log", "*.md"), recursive=True):
        if DEVLOG.search(p) and now - os.path.getmtime(p) < RECENT_SECONDS:
            return True
    return False


def vault_root(cwd: str) -> str:
    d = os.path.abspath(cwd or os.getcwd())
    while d != "/":
        if os.path.isfile(os.path.join(d, "AGENTS.md")) and os.path.isdir(os.path.join(d, "Projects")):
            return d
        d = os.path.dirname(d)
    return os.path.abspath(cwd or os.getcwd())


def main():
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError:
        sys.exit(0)
    event = payload.get("hook_event_name")
    claude = event == "Stop"
    extra = payload.get("extra") or {}

    if claude:
        if payload.get("stop_hook_active"):
            sys.exit(0)
        changed = claude_changed_paths(payload.get("transcript_path") or "")
    else:
        if extra.get("attempt"):
            print("{}")
            sys.exit(0)
        changed = list(extra.get("changed_paths") or [])

    watched = sorted({os.path.relpath(p, vault_root(payload.get("cwd") or "")) if os.path.isabs(p) else p
                      for p in changed if WATCHED.search(p)})
    wrote_devlog = any(DEVLOG.search(p) for p in changed)

    # Claude's transcript covers the whole session. Hermes only reports this
    # turn's edits, so a dev log written in an earlier turn counts if it's recent.
    if not claude and not wrote_devlog:
        wrote_devlog = recent_devlog_on_disk(vault_root(payload.get("cwd") or ""))

    if watched and not wrote_devlog:
        shown = ", ".join(watched[:4]) + (f" +{len(watched) - 4} more" if len(watched) > 4 else "")
        index = os.environ.get("DEV_LOG_INDEX")
        reason = REASON.format(files=shown, index=f", and link new projects from {index}" if index else "")
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
    except Exception:  # never trap an agent because of a gate bug
        sys.exit(0)
