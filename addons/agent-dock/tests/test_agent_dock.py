"""Tests for the agent-dock CLI: the roster view, the command each runtime gets, the terminal line,
the run record and the process view. No network, no real agent: runtimes are fake scripts in a temp folder."""
import importlib.machinery
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

CLI = Path(__file__).resolve().parents[1] / "bin" / "agent-dock"
loader = importlib.machinery.SourceFileLoader("agent_dock", str(CLI))
spec = importlib.util.spec_from_loader("agent_dock", loader)
dock = importlib.util.module_from_spec(spec)
loader.exec_module(dock)

PERSONA = "---\nname: ada\nmodel: some-model\n---\n\n# ada, Head of Research\n\nYou are **ada**. Read your memory file.\n"


@pytest.fixture
def vault(tmp_path):
    v = tmp_path / "vault"
    (v / ".agents" / "org").mkdir(parents=True)
    (v / ".claude" / "agents").mkdir(parents=True)
    (v / "avatars").mkdir()
    (v / "avatars" / "ada.jpg").write_bytes(b"jpg")
    (v / ".claude" / "agents" / "ada.md").write_text(PERSONA)
    (v / "personas").mkdir()
    (v / "personas" / "bo.md").write_text("You are **bo**, a writer.\n")
    roster = {"company": "Example Co", "agents": {
        "ada": {"role": "Head of Research", "team": "research", "team_name": "Research", "is_lead": True,
                "runtime": "codex", "model": "codex-model-1", "avatar": "avatars/ada.jpg",
                "prompt_file": ".claude/agents/ada.md"},
        "bo": {"role": "Writer", "team": "media", "team_name": "Media", "runtime": "claude-code",
               "model": "opus", "avatar": "avatars/missing.jpg", "prompt_file": "personas/bo.md"},
        "owner": {"role": "CEO", "team": "office", "runtime": "human"},
    }}
    (v / ".agents" / "org" / "org-agents.json").write_text(json.dumps(roster))
    return v


@pytest.fixture
def fake_bin(tmp_path, monkeypatch):
    """A folder on PATH holding fake `claude`, `codex` and `hermes` that write their argv and exit 3."""
    b = tmp_path / "bin"
    b.mkdir()
    for name in ("claude", "codex", "hermes"):
        f = b / name
        f.write_text('#!/bin/sh\nprintf "%s\\n" "$@" > "$FAKE_OUT"\necho "$AGENT_DOCK_AGENT" >> "$FAKE_OUT"\nexit 3\n')
        f.chmod(0o755)
    monkeypatch.setenv("PATH", f"{b}{os.pathsep}/usr/bin{os.pathsep}/bin")
    return b


def run_cli(*args, env=None):
    return subprocess.run([sys.executable, str(CLI), *args], capture_output=True, text=True, env=env)


def test_roster_lists_agents_not_humans(vault, fake_bin):
    view = dock.roster_view(vault, dock.load_settings(vault))
    assert [a["name"] for a in view["agents"]] == ["ada", "bo"]
    ada, bo = view["agents"]
    assert ada["avatar"] == str(vault / "avatars" / "ada.jpg") and ada["is_lead"] is True
    assert bo["avatar"] is None, "a missing avatar file is reported as none, not as a broken path"
    assert bo["runtime"] == "claude"
    assert all(r["installed"] for r in view["runtimes"])
    assert view["company"] == "Example Co"


def test_roster_reports_a_runtime_that_is_not_installed(vault, tmp_path, monkeypatch):
    monkeypatch.setenv("PATH", str(tmp_path / "empty"))
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setattr(dock, "resolve_command", lambda c: None)
    view = dock.roster_view(vault, dock.load_settings(vault))
    assert not any(r["installed"] for r in view["runtimes"])


def test_missing_roster_is_a_clear_error(tmp_path):
    empty = tmp_path / "v"
    empty.mkdir()
    r = run_cli("roster", "--vault", str(empty), "--json")
    assert r.returncode == 2
    assert "no roster" in json.loads(r.stdout)["error"]


def test_claude_uses_the_agent_file_and_overrides_a_foreign_model(vault, fake_bin):
    s = dock.load_settings(vault)
    info = dock.agent_info(vault, s, "ada")
    argv, meta = dock.build_runtime_command("ada", info, "claude", s, vault, host="box")
    assert argv[1:5] == ["-n", "ada", "--agent", "ada"]
    assert argv[argv.index("--model") + 1] == "sonnet", "the roster's Codex model must not reach Claude Code"
    assert "live terminal chat" in argv[argv.index("--append-system-prompt") + 1]
    assert meta == {"model": "sonnet", "provider": "anthropic"}


def test_claude_without_an_agent_file_gets_the_persona_as_system_prompt(vault, fake_bin):
    s = dock.load_settings(vault)
    argv, meta = dock.build_runtime_command("bo", dock.agent_info(vault, s, "bo"), "claude", s, vault)
    assert "--agent" not in argv
    assert "You are **bo**" in argv[argv.index("--append-system-prompt") + 1]
    assert meta["model"] == "opus", "a roster model for the same harness is kept"


def test_codex_gets_the_persona_without_frontmatter_and_its_roster_model(vault, fake_bin):
    s = dock.load_settings(vault)
    argv, meta = dock.build_runtime_command("ada", dock.agent_info(vault, s, "ada"), "codex", s, vault)
    assert argv[1:5] == ["--cd", str(vault), "--model", "codex-model-1"]
    assert argv[-1].startswith("# ada, Head of Research") and "name: ada" not in argv[-1]
    assert meta["provider"] == "openai"


def test_hermes_takes_model_provider_and_base_url_from_settings(vault, fake_bin):
    (vault / "secondbrain.json").write_text(json.dumps({"agentDock": {"runtimes": {"hermes": {
        "model": "local-model:7b", "provider": "local", "baseUrl": "http://127.0.0.1:11434/v1"}}}}))
    s = dock.load_settings(vault)
    argv, meta = dock.build_runtime_command("ada", dock.agent_info(vault, s, "ada"), "hermes", s, vault)
    assert argv[1:8] == ["chat", "-m", "local-model:7b", "--provider", "local", "--base-url", "http://127.0.0.1:11434/v1"]
    assert argv[-2] == "-q" and "You are **ada**" in argv[-1]
    assert meta == {"model": "local-model:7b", "provider": "local"}


def test_model_override_wins(vault, fake_bin):
    s = dock.load_settings(vault)
    argv, meta = dock.build_runtime_command("ada", dock.agent_info(vault, s, "ada"), "codex", s, vault, model="other")
    assert meta["model"] == "other" and "other" in argv


def test_unknown_agent_and_runtime_are_refused(vault, fake_bin):
    s = dock.load_settings(vault)
    with pytest.raises(dock.DockError):
        dock.agent_info(vault, s, "owner")
    with pytest.raises(dock.DockError):
        dock.build_runtime_command("ada", dock.agent_info(vault, s, "ada"), "zsh", s, vault)


def test_ghostty_line_quotes_the_command_for_a_login_shell():
    cmd = dock.terminal_command("ghostty", "ada · Codex", ["/a b/agent-dock", "run", "ada", "--vault", "/my vault"], shell="/bin/zsh")
    assert cmd[:5] == ["open", "-na", "Ghostty.app", "--args", "--title=ada · Codex"]
    assert cmd[5:10] == ["-e", "/bin/zsh", "-l", "-i", "-c"]
    assert cmd[10] == "exec '/a b/agent-dock' run ada --vault '/my vault'"


def test_terminal_app_line_escapes_quotes_for_applescript():
    cmd = dock.terminal_command("terminal", "t", ["x", 'say "hi"'], shell="/bin/zsh")
    assert cmd[0] == "osascript" and '\\"' in cmd[2] and cmd[2].startswith('tell application "Terminal" to do script "')
    with pytest.raises(dock.DockError):
        dock.terminal_command("xterm", "t", ["x"])


def test_launch_dry_run_prints_the_terminal_command(vault, fake_bin):
    r = run_cli("launch", "ada", "--runtime", "codex", "--card", "t_0123abcd", "--vault", str(vault), "--dry-run", "--json",
                env=dict(os.environ))
    assert r.returncode == 0, r.stderr
    line = json.loads(r.stdout)["command"][-1]
    assert " run ada --runtime codex --vault " in line and line.endswith("--card t_0123abcd")


def test_run_records_start_and_end_and_returns_the_exit_code(vault, fake_bin, tmp_path):
    env = dict(os.environ, AGENT_DOCK_STATE=str(tmp_path / "state"), FAKE_OUT=str(tmp_path / "argv.txt"))
    r = run_cli("run", "ada", "--runtime", "claude", "--card", "t_0123abcd", "--vault", str(vault), env=env)
    assert r.returncode == 3, r.stderr
    seen = (tmp_path / "argv.txt").read_text().splitlines()
    assert seen[:4] == ["-n", "ada", "--agent", "ada"] and seen[-1] == "ada"
    events = [json.loads(l) for l in (tmp_path / "state" / "history.jsonl").read_text().splitlines()]
    assert [e["event"] for e in events] == ["start", "end"]
    start, end = events
    assert (start["agent"], start["harness"], start["provider"], start["model"], start["ticket"], start["source"]) == \
        ("ada", "claude", "anthropic", "sonnet", "t_0123abcd", "dock")
    assert start["team"] == "Research" and start["cwd"] == str(vault) and end["exit_code"] == 3
    h = run_cli("history", "--json", env=env)
    run = json.loads(h.stdout)["runs"][0]
    assert run["ended_at"] and run["seconds"] is not None and run["id"] == start["id"]


def test_fold_runs_keeps_open_runs_and_sorts_newest_first():
    events = [
        {"event": "start", "id": "a", "agent": "ada", "started_at": "2030-01-01T10:00:00Z"},
        {"event": "start", "id": "b", "agent": "bo", "started_at": "2030-01-01T11:00:00Z"},
        {"event": "end", "id": "a", "ended_at": "2030-01-01T10:02:05Z", "exit_code": 0},
        {"event": "end", "id": "zzz", "ended_at": "2030-01-01T10:02:05Z"},
    ]
    runs = dock.fold_runs(events)
    assert [r["id"] for r in runs] == ["b", "a"]
    assert runs[0]["ended_at"] is None and runs[0]["seconds"] is None
    assert runs[1]["seconds"] == 125


PS = """\
  100     1 Tue Jan  1 10:00:00 2030     /opt/x/ollama serve
  200     1 Tue Jan  1 10:00:00 2030     claude --dangerously-skip-permissions
  210   200 Tue Jan  1 10:00:01 2030     claude --dangerously-skip-permissions
  300     1 Tue Jan  1 10:05:00 2030     codex exec --json --model codex-model-1 You are **ada**, Head of Research. Card t_0a1b2c3d
  400     1 Tue Jan  1 10:06:00 2030     node /usr/lib/claude -p --agent bo --model=opus hello
  500     1 Tue Jan  1 10:07:00 2030     hermes gateway run
  600     1 Tue Jan  1 10:08:00 2030     claude restart
  700     1 Tue Jan  1 10:09:00 2030     /bin/zsh -c echo claude
  800     1 Tue Jan  1 10:09:30 2030     hermes chat -m local-model:7b --provider local
"""


def test_process_view_finds_agents_harnesses_models_and_tickets():
    rows = dock.parse_ps(PS)
    assert len(rows) == 9
    runs = {r["pid"]: r for r in dock.classify_processes(rows, {400: "/w/t_9f8e7d6c-fix-thing"})}
    assert sorted(runs) == [200, 300, 400, 500, 800], "children, plumbing subcommands and shells are not runs"
    assert (runs[300]["agent"], runs[300]["harness"], runs[300]["mode"], runs[300]["model"], runs[300]["ticket"]) == \
        ("ada", "codex", "headless", "codex-model-1", "t_0a1b2c3d")
    assert (runs[400]["agent"], runs[400]["model"], runs[400]["mode"], runs[400]["ticket"]) == \
        ("bo", "opus", "headless", "t_9f8e7d6c")
    assert runs[200]["mode"] == "interactive" and runs[200]["agent"] == "" and runs[200]["provider"] == "anthropic"
    assert runs[500]["mode"] == "service"
    assert (runs[800]["provider"], runs[800]["model"]) == ("local", "local-model:7b")


def test_long_commands_are_cut(tmp_path):
    rows = dock.parse_ps("  9     1 Tue Jan  1 10:00:00 2030     codex exec " + "x" * 500 + "\n")
    assert len(dock.classify_processes(rows)[0]["command"]) == 160


def test_observed_runs_get_history_once_and_close_when_gone(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_DOCK_STATE", str(tmp_path))
    seen = [{"source": "process", "pid": 5, "proc_start": "Tue Jan  1 10:00:00 2030", "harness": "claude",
             "agent": "", "started_at": "2030-01-01T10:00:00Z"}]
    dock.record_observed(seen)
    dock.record_observed(seen)
    assert [e["event"] for e in dock.read_events()] == ["start"]
    dock.record_observed([])
    events = dock.read_events()
    assert [e["event"] for e in events] == ["start", "end"] and events[0]["id"] == events[1]["id"]
    assert dock.fold_runs(events)[0]["ended_at"]


def test_settings_ignore_unknown_runtimes_and_keep_defaults(vault):
    (vault / "secondbrain.json").write_text(json.dumps({"agentDock": {"terminal": "terminal", "runtimes": {
        "claude": {"model": "opus"}, "mystery": {"command": "rm"}}}}))
    s = dock.load_settings(vault)
    assert s["terminal"] == "terminal" and dock.pick_terminal(s) == "terminal"
    assert s["runtimes"]["claude"] == {"command": "claude", "model": "opus"}
    assert "mystery" not in s["runtimes"]
