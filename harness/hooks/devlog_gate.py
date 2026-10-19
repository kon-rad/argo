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

Dev logs live under Projects/<project>/ by default. A vault can add roots and
exempt paths in the "devlog" section of .agents/guard.local.json (found the
same way guard.py finds it):

  "devlog": {
    "roots":  ["Areas/app/*"],          # globs; <root>/**/dev-log/YYYY-MM-DD*.md counts
    "exempt": [".agents/memory/"],      # path prefixes that are never watched
    "experience": {                     # optional: an experience library for harness changes
      "dir":   "Projects/harness/experience",   # <dir>/YYYY-MM-DD*.md counts
      "watch": ["AGENTS.local.md"]              # prefixes watched on top of the harness paths
    }
  }

With "experience" set, a session that changed harness files must also write an
entry in that folder (the run that showed the problem, the change, the run that
showed it worked), so the next agent editing the harness can read why. Same
one-shot nudge as the dev log; both reasons go out in one message.
"""
import glob
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from guard import find_local_rules  # noqa: E402

WATCHED = re.compile(
    r"(?:^|/)(?:\.hermes/(?:skills|scripts|server|plugins)/|\.agents/|\.claude/settings\.json$|\.claude/agents/)"
)
DEFAULT_ROOTS = ["Projects/*"]
RECENT_SECONDS = 6 * 3600
DATED_MD = r"/\d{4}-\d{2}-\d{2}[^/]*\.md$"
EDIT_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}

REASON = (
    "devlog gate: this session changed harness or infrastructure files ({files}) but wrote no "
    "dev-log entry. Before finishing: add Projects/<project>/dev-log/YYYY-MM-DD_<slug>.md "
    "(what changed and why, how it was tested with real results), update the ## Resume block in "
    "that project's dev-log/README.md{index} (AGENTS.md, 'Dev logs and feature docs'). "
    "If this change truly needs no dev log, say why in one line and finish."
)
EXPERIENCE_REASON = (
    "experience gate: this session changed how agents work ({files}) but added no entry to {dir}/. "
    "Before finishing: add {dir}/YYYY-MM-DD_<slug>.md from its _template.md (the run that showed the "
    "problem, the change, the run that showed it worked or 'not yet', the lesson, applies when) and a "
    "line in its index.md. If this change needs no entry, say why in one line and finish."
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


def load_settings(payload: dict):
    """Dev-log roots, exempt prefixes and the experience library: defaults plus the vault's guard.local.json."""
    roots, exempt, experience = list(DEFAULT_ROOTS), [], None
    path = find_local_rules(payload)
    try:
        with open(path) as f:
            section = (json.load(f) or {}).get("devlog") or {}
    except (OSError, TypeError, ValueError, AttributeError):
        section = {}
    if isinstance(section, dict):
        for key, out in (("roots", roots), ("exempt", exempt)):
            items = section.get(key)
            if isinstance(items, list):
                out.extend(i.strip("/") for i in items if isinstance(i, str) and i.strip("/"))
        exp = section.get("experience")
        if isinstance(exp, dict) and isinstance(exp.get("dir"), str) and exp["dir"].strip("/"):
            watch = exp.get("watch") if isinstance(exp.get("watch"), list) else []
            experience = (exp["dir"].strip("/"), [w for w in watch if isinstance(w, str) and w.strip("/")])
    return roots, exempt, experience


def devlog_pattern(roots):
    alts = "|".join(re.escape(r).replace(r"\*", "[^/]+") for r in roots)
    return re.compile(r"(?:^|/)(?:" + alts + r")/(?:.+/)?dev-log/\d{4}-\d{2}-\d{2}[^/]*\.md$")


def exempt_pattern(prefixes):
    if not prefixes:
        return None
    return re.compile(r"(?:^|/)(?:" + "|".join(re.escape(p) for p in prefixes) + r")(?:/|$)")


def recent_devlog_on_disk(root: str, roots, devlog) -> bool:
    now = time.time()
    for r in roots:
        for p in glob.glob(os.path.join(root, r, "**", "dev-log", "*.md"), recursive=True):
            if devlog.search(p) and now - os.path.getmtime(p) < RECENT_SECONDS:
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

    roots, prefixes, experience = load_settings(payload)
    devlog, exempt = devlog_pattern(roots), exempt_pattern(prefixes)
    root = vault_root(payload.get("cwd") or "")
    rel = lambda p: os.path.relpath(p, root) if os.path.isabs(p) else p  # noqa: E731
    watched = sorted({rel(p) for p in changed if WATCHED.search(p) and not (exempt and exempt.search(p))})
    wrote_devlog = any(devlog.search(p) for p in changed)

    reasons = []
    if experience:
        exp_dir, watch_extra = experience
        entry = re.compile(r"(?:^|/)" + re.escape(exp_dir) + DATED_MD)
        extra_rx = re.compile(r"^(?:" + "|".join(re.escape(w) for w in watch_extra) + r")") if watch_extra else None
        exp_watched = sorted({rel(p) for p in changed
                              if (WATCHED.search(p) or (extra_rx and extra_rx.search(rel(p))))
                              and not (exempt and exempt.search(p)) and not entry.search(p)})
        wrote_entry = any(entry.search(p) for p in changed)
        if not claude and not wrote_entry:
            now = time.time()
            wrote_entry = any(now - os.path.getmtime(p) < RECENT_SECONDS
                              for p in glob.glob(os.path.join(root, exp_dir, "*.md")) if entry.search(p))
        if exp_watched and not wrote_entry:
            shown = ", ".join(exp_watched[:4]) + (f" +{len(exp_watched) - 4} more" if len(exp_watched) > 4 else "")
            reasons.append(EXPERIENCE_REASON.format(files=shown, dir=exp_dir))

    # Claude's transcript covers the whole session. Hermes only reports this
    # turn's edits, so a dev log written in an earlier turn counts if it's recent.
    if not claude and not wrote_devlog:
        wrote_devlog = recent_devlog_on_disk(root, roots, devlog)

    if watched and not wrote_devlog:
        shown = ", ".join(watched[:4]) + (f" +{len(watched) - 4} more" if len(watched) > 4 else "")
        index = os.environ.get("DEV_LOG_INDEX")
        reasons.insert(0, REASON.format(files=shown, index=f", and link new projects from {index}" if index else ""))

    if reasons:
        reason = "\n\n".join(reasons)
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
