"""Tests for devlog_gate.py (Hermes pre_verify and Claude Stop formats)."""
import json
import os
import subprocess
import sys
from pathlib import Path

GATE = Path(__file__).resolve().parent / "devlog_gate.py"


def run(payload, env_extra=None):
    env = {k: v for k, v in os.environ.items() if k not in ("DEV_LOG_INDEX", "SB_GUARD_LOCAL", "CLAUDE_PROJECT_DIR")}
    env.update(env_extra or {})
    return subprocess.run([sys.executable, str(GATE)], input=json.dumps(payload),
                          capture_output=True, text=True, timeout=10, env=env)


def hermes(changed, attempt=0, cwd="/nonexistent"):
    return {"hook_event_name": "pre_verify", "cwd": cwd, "extra": {"changed_paths": changed, "attempt": attempt}}


def test_harness_change_without_devlog_is_sent_back():
    p = run(hermes([".agents/hooks/guard.py"]))
    out = json.loads(p.stdout)
    assert out["decision"] == "block"
    assert ".agents/hooks/guard.py" in out["reason"]


def test_harness_change_with_devlog_passes():
    p = run(hermes([".agents/hooks/guard.py", "Projects/x/dev-log/2026-10-13_guard.md"]))
    assert json.loads(p.stdout) == {}


def test_note_edits_pass():
    assert json.loads(run(hermes(["Areas/notes/a.md"])).stdout) == {}


def test_second_attempt_passes():
    assert json.loads(run(hermes([".agents/hooks/guard.py"], attempt=1)).stdout) == {}


def test_index_path_comes_from_env():
    p = run(hermes([".hermes/skills/x/SKILL.md"]), {"DEV_LOG_INDEX": "Projects/README.md"})
    assert "link new projects from Projects/README.md" in json.loads(p.stdout)["reason"]
    p = run(hermes([".hermes/skills/x/SKILL.md"]))
    assert "link new projects" not in json.loads(p.stdout)["reason"]


def test_claude_stop_reads_transcript(tmp_path):
    t = tmp_path / "t.jsonl"
    t.write_text(json.dumps({"message": {"content": [
        {"type": "tool_use", "name": "Edit", "input": {"file_path": ".claude/settings.json"}}]}}) + "\n")
    p = run({"hook_event_name": "Stop", "transcript_path": str(t), "stop_hook_active": False})
    assert p.returncode == 2
    p = run({"hook_event_name": "Stop", "transcript_path": str(t), "stop_hook_active": True})
    assert p.returncode == 0


def local_file(tmp_path, data):
    f = tmp_path / "guard.local.json"
    f.write_text(json.dumps(data))
    return {"SB_GUARD_LOCAL": str(f)}


def test_local_devlog_roots_count_as_dev_logs(tmp_path):
    changed = [".agents/hooks/guard.py", "Areas/app/search/dev-log/2026-10-16_x.md"]
    assert json.loads(run(hermes(changed)).stdout)["decision"] == "block"
    env = local_file(tmp_path, {"devlog": {"roots": ["Areas/app/*"]}})
    assert json.loads(run(hermes(changed), env).stdout) == {}
    # Projects/ still counts with extra roots set.
    p = run(hermes([".agents/hooks/guard.py", "Projects/x/dev-log/2026-10-16_y.md"]), env)
    assert json.loads(p.stdout) == {}


def test_local_devlog_roots_are_found_on_disk(tmp_path):
    vault = tmp_path / "vault"
    (vault / "Projects").mkdir(parents=True)
    (vault / "AGENTS.md").write_text("x")
    log = vault / "Areas" / "app" / "search" / "dev-log"
    log.mkdir(parents=True)
    (log / "2026-10-16_x.md").write_text("entry")
    env = local_file(tmp_path, {"devlog": {"roots": ["Areas/app/*"]}})
    p = run(hermes([".agents/hooks/guard.py"], cwd=str(vault)), env)
    assert json.loads(p.stdout) == {}


def test_local_devlog_exempt_paths_are_not_watched(tmp_path):
    changed = [".agents/memory/bot.md"]
    assert json.loads(run(hermes(changed)).stdout)["decision"] == "block"
    env = local_file(tmp_path, {"devlog": {"exempt": [".agents/memory/"]}})
    assert json.loads(run(hermes(changed), env).stdout) == {}
    p = run(hermes(changed + [".agents/hooks/guard.py"]), env)
    reason = json.loads(p.stdout)["reason"]
    assert ".agents/hooks/guard.py" in reason and "memory" not in reason


def test_broken_devlog_section_keeps_defaults(tmp_path):
    env = local_file(tmp_path, {"devlog": {"roots": "nope", "exempt": [3]}})
    assert json.loads(run(hermes([".agents/hooks/guard.py"]), env).stdout)["decision"] == "block"
