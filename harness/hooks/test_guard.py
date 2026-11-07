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

# Fake keys, assembled at runtime so leak scanners don't flag this file.
FAKE_ANT = "sk-ant-api03-" + "x" * 24
FAKE_OPENAI = "sk-proj-" + "x" * 32
FAKE_GH = "ghp_" + "x" * 36

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
    # Excluding a secrets file from a transfer protects it; it isn't copying it.
    ("rsync -azn --delete --exclude node_modules --exclude '.env.local' ./ srv:/app/", False),
    ("rsync -az --exclude=.env --filter='protect .env.production' ./ srv:/app/", False),
    ("rsync -az --exclude node_modules .env.local srv:/app/", True),
    ("rsync -az --exclude '.env.local' ./.env srv:/app/", True),
    # A key value in a command line lands in the process list and in agent logs.
    ("curl -H 'Authorization: Bearer " + FAKE_ANT + "' https://example.com", True),
    ("export OPENAI_API_KEY=" + FAKE_OPENAI, True),
    ("git clone https://" + FAKE_GH + "@github.com/a/b", True),
    ("AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE aws s3 ls", True),
    ("FOO_TOKEN='" + "a1b2c3d4" * 4 + "' ./run.sh", True),
    ("TOKEN=$(cat ~/.config/x/token) ./run.sh", False),
    ("python3 gen.py --model sk-like-name", False),
    ("grep -n API_KEY= docs/configuration.md", False),
    ("python3 run.py --name task-runner-for-the-nightly-backups", False),
    ("DEPLOY_SSH_KEY=/home/agent/.ssh/deploy_key_ed25519 ./deploy.sh", False),
    ("DEPLOY_SSH_KEY=~/.ssh/deploy_key ./deploy.sh", False),
    ("TOKEN_FILE=nightly_backup_token_location ./run.sh", False),
    # A key sent to another machine travels in its argv and its shell history.
    ("set -a; . ./.env; set +a; ssh host \"export TOGETHER_API_KEY='$TOGETHER_API_KEY' && python3 x.py\"", True),
    ("set -a; . ./.env; set +a; K=\"$TOGETHER_API_KEY\" ssh host \"run --key $K\"", True),
    ("echo \"$HF_TOKEN\" | ssh host 'cat > ~/.hf_token'", True),
    ("ssh host \"curl -H \\\"x: ${OPENAI_API_KEY}\\\" https://example.com\"", True),
    ("ssh host 'set -a; . ~/.config/x/env; set +a; curl -H \"x: $OPENAI_API_KEY\" https://example.com'", False),
    ("ssh host \"echo \\$HF_TOKEN | wc -c\"", False),
    ("ssh host uptime", False),
    # Printing a key puts it in the transcript.
    ("echo $OPENAI_API_KEY", True),
    ("printf '%s' \"${GITHUB_TOKEN}\"", True),
    ("printenv TELEGRAM_BOT_TOKEN", True),
    ("set -a; . ./.env; set +a; [ -n \"$SOME_KEY\" ] && echo set", False),
    ("echo $HOME $PATH", False),
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


def test_local_file_can_disable_the_rsync_dry_run_rule(guard):
    cmd = "rsync -avz --delete web/ server:/srv/web/"
    off = {**LOCAL, "disable": ["rsync_dry_run"]}
    assert both(guard, "Bash", "terminal", {"command": cmd}, {"command": cmd}, off) == (False, False)
    # Secrets and force-push rules can't be switched off, and unknown names are ignored.
    off = {"disable": ["rsync_dry_run", "secrets", "force_push"]}
    assert both(guard, "Bash", "terminal", {"command": "cat .env"}, {"command": "cat .env"}, off) == (True, True)
    assert both(guard, "Bash", "terminal", {"command": "git push -f"}, {"command": "git push -f"}, off) == (True, True)


@pytest.mark.parametrize("raw", ["not json", "[1, 2]"])
def test_fails_open_on_bad_payload(guard, raw):
    assert guard({}, raw=raw).returncode == 0
