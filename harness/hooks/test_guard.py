"""Tests for guard.py in both agents' payload formats.

Run: python3 -m pytest harness

Each test runs a copy of guard.py from a temp dir, so a real vault's
.agents/guard.local.json next to this checkout can't leak into the results.
"""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parent / "guard.py"

SHELL = [
    ("cat .env", True),
    ("cat ~/.hermes/.env | head", True),
    ("grep API_KEY .env", True),
    ("tail -n 3 /srv/vault/.env.production", True),
    ("cp .env /tmp/x", True),
    ("cat .env.example", False),
    ("set -a; . ./.env; set +a; python3 gen.py | head -5", False),
    ("source .env && echo ok", False),
    ("rsync -avz --delete web/ server:/srv/web/", True),
    ("rsync -avzn --delete web/ server:/srv/web/", False),
    ("rsync -avz --delete --dry-run web/ server:/srv/web/", False),
    ("rsync -avz web/ server:/srv/web/", False),
    ("git push --force origin main", True),
    ("git push -f", True),
    ("git push --force-with-lease", True),
    ("git push origin +main", True),
    ("git push origin main", False),
    ("git commit -m 'fix -f flag docs' && git push", False),
    ("echo $(cat .env)", True),
    ("ls /home/someone", False),
]

FILES = [
    ("Read", "read_file", "/vault/.env", True),
    ("Read", "read_file", ".env.local", True),
    ("Read", "read_file", ".env.example", False),
    ("Read", "read_file", "/home/agent/.hermes/auth.json", True),
    ("Read", "read_file", "/home/agent/.claude/.credentials.json", True),
    ("Edit", "patch", ".env", True),
    ("Write", "write_file", "Projects/x/notes.md", False),
    ("Grep", "search_files", ".env", True),
]

LOCAL = {
    "protected_dirs": [{"path": "/home/signer/", "reason": "the signer's keys"}],
    "no_delete": [{"path": "media/blob", "reason": "blobs are irreplaceable"}],
    "readonly": [{"pattern": r"Areas/legacy/[^/]*\.html$", "reason": "legacy page"}],
}

LOCAL_SHELL = [
    ("ls /home/signer/", True),
    ("sudo cat /home/signer/key.json", True),
    ("rm -rf ~/app/media/blob/abc", True),
    ("find ~/app/media/blob -name '*.tmp' -delete", True),
    ("ls ~/app/media/blob", False),
    ("rm -rf /tmp/other", False),
]

LOCAL_FILES = [
    ("Write", "write_file", "Areas/legacy/old-page.html", True),
    ("Read", "read_file", "Areas/legacy/old-page.html", False),
    ("Read", "read_file", "/home/signer/.config/key", True),
    ("Write", "write_file", "Areas/legacy/notes.md", False),
]


@pytest.fixture
def guard(tmp_path):
    hooks = tmp_path / "engine" / "harness" / "hooks"
    hooks.mkdir(parents=True)
    shutil.copy(SRC, hooks / "guard.py")
    workdir = tmp_path / "work"
    workdir.mkdir()
    env = {k: v for k, v in os.environ.items() if k not in ("SB_GUARD_LOCAL", "CLAUDE_PROJECT_DIR")}

    def run(payload, local=None, raw=None):
        e = dict(env)
        if local is not None:
            f = tmp_path / "guard.local.json"
            f.write_text(local if isinstance(local, str) else json.dumps(local))
            e["SB_GUARD_LOCAL"] = str(f)
        data = raw if raw is not None else json.dumps({**payload, "cwd": str(workdir)})
        return subprocess.run([sys.executable, str(hooks / "guard.py")], input=data,
                              capture_output=True, text=True, timeout=10, cwd=workdir, env=e)

    return run


def both(guard, claude_tool, hermes_tool, claude_input, hermes_input, local=None):
    pc = guard({"hook_event_name": "PreToolUse", "tool_name": claude_tool, "tool_input": claude_input}, local)
    ph = guard({"hook_event_name": "pre_tool_call", "tool_name": hermes_tool, "tool_input": hermes_input}, local)
    claude_blocked = pc.returncode == 2
    hermes_out = json.loads(ph.stdout or "{}")
    hermes_blocked = hermes_out.get("decision") == "block"
    if not hermes_blocked:
        assert ph.stdout.strip() == "{}", "Hermes allow must print {}"
    return claude_blocked, hermes_blocked


@pytest.mark.parametrize("cmd,want", SHELL)
def test_builtin_shell_rules(guard, cmd, want):
    assert both(guard, "Bash", "terminal", {"command": cmd}, {"command": cmd}) == (want, want)


@pytest.mark.parametrize("ct,ht,path,want", FILES)
def test_builtin_file_rules(guard, ct, ht, path, want):
    key = "file_path" if ct in ("Read", "Edit", "Write") else "path"
    assert both(guard, ct, ht, {key: path}, {"path": path}) == (want, want)


@pytest.mark.parametrize("cmd,want", LOCAL_SHELL)
def test_local_shell_rules(guard, cmd, want):
    assert both(guard, "Bash", "terminal", {"command": cmd}, {"command": cmd}, LOCAL) == (want, want)


@pytest.mark.parametrize("ct,ht,path,want", LOCAL_FILES)
def test_local_file_rules(guard, ct, ht, path, want):
    key = "file_path" if ct in ("Read", "Edit", "Write") else "path"
    assert both(guard, ct, ht, {key: path}, {"path": path}, LOCAL) == (want, want)


def test_local_rules_only_apply_when_present(guard):
    assert both(guard, "Bash", "terminal", {"command": "ls /home/signer/"}, {"command": "ls /home/signer/"}) == (False, False)


def test_local_reason_is_shown(guard):
    p = guard({"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "rm -r media/blob/x"}}, LOCAL)
    assert p.returncode == 2 and "blobs are irreplaceable" in p.stderr


@pytest.mark.parametrize("bad", ["not json", "[1, 2]", '{"protected_dirs": "nope", "readonly": [{"pattern": "("}]}'])
def test_broken_local_file_keeps_builtin_rules(guard, bad):
    claude, hermes = both(guard, "Bash", "terminal", {"command": "cat .env"}, {"command": "cat .env"}, bad)
    assert claude and hermes


def test_engine_inside_a_vault_finds_the_vault_rules(tmp_path):
    vault = tmp_path / "vault"
    hooks = vault / ".secondbrain" / "harness" / "hooks"
    hooks.mkdir(parents=True)
    shutil.copy(SRC, hooks / "guard.py")
    (vault / ".agents").mkdir()
    (vault / ".agents" / "guard.local.json").write_text(json.dumps(LOCAL))
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    env = {k: v for k, v in os.environ.items() if k not in ("SB_GUARD_LOCAL", "CLAUDE_PROJECT_DIR")}
    payload = {"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "ls /home/signer/"},
               "cwd": str(elsewhere)}
    p = subprocess.run([sys.executable, str(hooks / "guard.py")], input=json.dumps(payload),
                       capture_output=True, text=True, timeout=10, cwd=elsewhere, env=env)
    assert p.returncode == 2


@pytest.mark.parametrize("raw", ["not json", "[1, 2]"])
def test_fails_open_on_bad_payload(guard, raw):
    assert guard({}, raw=raw).returncode == 0
