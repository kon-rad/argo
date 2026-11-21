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
BUILD = Path(__file__).resolve().parents[1] / "app" / "build.sh"
ICON_SVG = Path(__file__).resolve().parents[1] / "app" / "Resources" / "AgentDockIcon.svg"
ICON_PNG = Path(__file__).resolve().parents[1] / "app" / "Resources" / "AgentDockIcon.png"
loader = importlib.machinery.SourceFileLoader("agent_dock", str(CLI))
spec = importlib.util.spec_from_loader("agent_dock", loader)
dock = importlib.util.module_from_spec(spec)
loader.exec_module(dock)

PERSONA = "---\nname: ada\nmodel: some-model\n---\n\n# ada, Head of Research\n\nYou are **ada**. Read your memory file.\n"


def test_app_build_packages_a_default_icon_and_keeps_the_override():
    script = BUILD.read_text()
    assert ICON_SVG.read_text().startswith("<svg")
    assert ICON_PNG.read_bytes().startswith(b"\x89PNG\r\n\x1a\n")
    assert 'icon="$here/Resources/AgentDockIcon.png"' in script
    assert '--icon) icon="$2"; shift 2 ;;' in script
    assert '<key>CFBundleIconFile</key><string>AppIcon</string>' in script
    assert 'for size in 16 32 128 256 512' in script
    assert 'icon_${size}x${size}.png' in script
    assert 'icon_${size}x${size}@2x.png' in script


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
    for name in ("claude", "codex", "hermes", "zen-agent"):
        f = b / name
        f.write_text('#!/bin/sh\nprintf "%s\\n" "$@" > "$FAKE_OUT"\necho "child=${CLAUDE_CODE_CHILD_SESSION:-none}" >> "$FAKE_OUT"\n'
                     'echo "$AGENT_DOCK_AGENT" >> "$FAKE_OUT"\nexit 3\n')
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


def test_claude_chat_keeps_the_name_and_persona_without_the_wake_tool_list(vault, fake_bin):
    s = dock.load_settings(vault)
    info = dock.agent_info(vault, s, "ada")
    argv, meta = dock.build_runtime_command("ada", info, "claude", s, vault, host="box")
    assert argv[1:3] == ["-n", "ada"] and argv[argv.index("--agent") + 1] == "ada"
    inline = json.loads(argv[argv.index("--agents") + 1])
    assert set(inline) == {"ada"} and "tools" not in inline["ada"], "an inline agent without a tool list gets them all"
    assert "You are **ada**" in inline["ada"]["prompt"] and not inline["ada"]["prompt"].startswith("---")
    assert argv[argv.index("--model") + 1] == "sonnet", "the roster's Codex model must not reach Claude Code"
    assert "live terminal chat" in argv[argv.index("--append-system-prompt") + 1]
    assert meta == {"model": "sonnet", "provider": "anthropic"}


def test_claude_tools_roster_uses_the_compiled_agent_file(vault, fake_bin):
    s = dock.load_settings(vault)
    s["runtimes"]["claude"]["tools"] = "roster"
    argv, _ = dock.build_runtime_command("ada", dock.agent_info(vault, s, "ada"), "claude", s, vault, host="box")
    assert argv[1:5] == ["-n", "ada", "--agent", "ada"] and "--agents" not in argv
    argv, _ = dock.build_runtime_command("bo", dock.agent_info(vault, s, "bo"), "claude", s, vault)
    assert "--agent" not in argv, "no compiled file: the persona goes in the system prompt"
    assert "You are **bo**" in argv[argv.index("--append-system-prompt") + 1]


def test_claude_keeps_a_roster_model_for_the_same_harness(vault, fake_bin):
    s = dock.load_settings(vault)
    argv, meta = dock.build_runtime_command("bo", dock.agent_info(vault, s, "bo"), "claude", s, vault)
    assert meta["model"] == "opus"


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


def test_ghostty_opens_a_tab_with_the_command_quoted_for_a_login_shell():
    cmd = dock.terminal_command("ghostty", "ada", ["/a b/agent-dock", "run", "ada", "--vault", "/my vault"], shell="/bin/zsh")
    assert cmd[:2] == ["osascript", "-e"] and "new tab in front window with configuration cfg" in cmd[2]
    assert cmd[3] == "/bin/zsh -l -i -c 'exec '\"'\"'/a b/agent-dock'\"'\"' run ada --vault '\"'\"'/my vault'\"'\"''"
    assert cmd[4] == "tab"
    assert dock.terminal_command("ghostty", "ada", ["x"], how="window")[4] == "window"
    assert "--args" not in cmd, "the command is never handed to a new Ghostty instance on its command line"


def test_terminal_app_line_escapes_quotes_for_applescript():
    cmd = dock.terminal_command("terminal", "t", ["x", 'say "hi"'], shell="/bin/zsh")
    assert cmd[0] == "osascript" and '\\"' in cmd[2] and cmd[2].startswith('tell application "Terminal" to do script "')
    with pytest.raises(dock.DockError):
        dock.terminal_command("xterm", "t", ["x"])


def test_hermes_on_ollama_becomes_a_custom_endpoint(vault, fake_bin, monkeypatch):
    monkeypatch.delenv("OLLAMA_HOST", raising=False)
    (vault / "secondbrain.json").write_text(json.dumps({"agentDock": {"runtimes": {"hermes": {
        "provider": "ollama", "model": "big-model:27b"}}}}))
    s = dock.load_settings(vault)
    info = dock.agent_info(vault, s, "ada")
    argv, meta = dock.build_runtime_command("ada", info, "hermes", s, vault)
    assert argv[1:7] == ["chat", "-m", "big-model:27b", "--provider", "custom", "--base-url"]
    assert argv[7] == "http://127.0.0.1:11434/v1"
    assert meta == {"model": "big-model:27b", "provider": "ollama"}
    argv, meta = dock.build_runtime_command("ada", info, "hermes", s, vault, model="cloud-1", provider="together")
    assert argv[1:6] == ["chat", "-m", "cloud-1", "--provider", "together"] and "--base-url" not in argv
    assert meta == {"model": "cloud-1", "provider": "together"}


def test_ollama_base_accepts_host_setting_and_v1_urls(monkeypatch):
    monkeypatch.setenv("OLLAMA_HOST", "192.0.2.7:11434")
    assert dock.ollama_base() == "http://192.0.2.7:11434"
    assert dock.ollama_base({"baseUrl": "http://192.0.2.9:11434/v1/"}) == "http://192.0.2.9:11434"


def test_choices_list_local_models_then_settings_and_mark_the_default():
    conf = {"provider": "ollama", "model": "big:27b", "choices": [
        {"label": "Cloud fast", "provider": "together", "model": "cloud-1", "auth": "api-key"},
        {"provider": "anthropic", "model": "claude-x", "auth": "subscription"},
        {"provider": "p", "model": "m", "auth": "nonsense"}]}
    local = [{"name": "big:27b", "bytes": 18}, {"name": "small:9b", "bytes": 9}]
    out = dock.runtime_choices("hermes", conf, local)
    assert [(c["label"], c["group"], c["provider"]) for c in out] == [
        ("big:27b", "Local (Ollama)", "ollama"), ("small:9b", "Local (Ollama)", "ollama"),
        ("Cloud fast", "API key", "together"), ("claude-x", "Subscription", "anthropic"), ("m", "API key", "p")]
    assert [c["is_default"] for c in out] == [True, False, False, False, False]
    assert all("key" not in k.lower() or k == "api-key" for c in out for k in c), "a choice never carries a key"
    assert dock.runtime_choices("claude", {"model": "sonnet", "choices": [{"model": "opus", "auth": "subscription"}]}, [])[0]["model"] == "opus"


def test_embedding_models_are_left_out(monkeypatch):
    class Resp:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self): return json.dumps({"models": [
            {"name": "small:9b", "size": 9}, {"name": "big:27b", "size": 18},
            {"name": "acme/multilingual-e5-large:latest", "size": 1}, {"name": "nomic-embed-text", "size": 1}]}).encode()
    monkeypatch.setattr(dock.urllib.request, "urlopen", lambda url, timeout=0: Resp())
    assert [m["name"] for m in dock.ollama_chat_models("http://127.0.0.1:11434")] == ["big:27b", "small:9b"]


def test_a_local_ollama_endpoint_is_named_in_the_process_view():
    rows = dock.parse_ps("  9     1 Tue Jan  1 10:00:00 2030     hermes chat -m big:27b --provider custom --base-url http://127.0.0.1:11434/v1\n")
    assert dock.classify_processes(rows)[0]["provider"] == "ollama"


def test_launch_dry_run_prints_the_terminal_command(vault, fake_bin):
    r = run_cli("launch", "ada", "--runtime", "codex", "--card", "t_0123abcd", "--vault", str(vault), "--dry-run", "--json",
                env=dict(os.environ))
    assert r.returncode == 0, r.stderr
    command = json.loads(r.stdout)["command"]
    assert command[0] == "osascript"
    # `auto` picks Ghostty when it is installed and Terminal.app otherwise (CI has no Ghostty).
    if "Terminal" in command[2]:
        assert command[-1] == 'tell application "Terminal" to activate'
        script = command[2]
    else:
        assert command[-1] == "tab"
        script = command[-2]
    assert " run ada --runtime codex --vault " in script and "--card t_0123abcd" in script


def test_run_records_start_and_end_and_returns_the_exit_code(vault, fake_bin, tmp_path):
    env = dict(os.environ, AGENT_DOCK_STATE=str(tmp_path / "state"), FAKE_OUT=str(tmp_path / "argv.txt"),
               CLAUDE_CODE_CHILD_SESSION="1", CLAUDECODE="1", KEEP_ME="yes")
    r = run_cli("run", "ada", "--runtime", "claude", "--card", "t_0123abcd", "--vault", str(vault), env=env)
    assert r.returncode == 3, r.stderr
    seen = (tmp_path / "argv.txt").read_text().splitlines()
    assert seen[:2] == ["-n", "ada"] and seen[seen.index("--agent") + 1] == "ada" and seen[-1] == "ada"
    assert seen[-2] == "child=none", "a parent session's marker must not reach the agent, or its transcript is not saved"
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
    assert s["runtimes"]["claude"] == {"command": "claude", "model": "opus", "tools": "full", "choices": []}
    assert "mystery" not in s["runtimes"]


def test_child_env_drops_session_markers_and_keeps_everything_else():
    env = dock.child_env({"CLAUDE_CODE_CHILD_SESSION": "1", "CLAUDE_CODE_SESSION_ID": "x", "CODEX_THREAD_ID": "y",
                          "PATH": "/bin", "ANTHROPIC_BASE_URL": "http://127.0.0.1:1", "CLAUDE_CODE_USE_BEDROCK": "1"},
                         "ada", "claude")
    assert env == {"PATH": "/bin", "ANTHROPIC_BASE_URL": "http://127.0.0.1:1", "CLAUDE_CODE_USE_BEDROCK": "1",
                   "AGENT_DOCK_AGENT": "ada", "AGENT_DOCK_RUNTIME": "claude"}


def test_zen_agent_takes_the_persona_by_name_and_a_local_model_as_a_machine(vault, fake_bin, monkeypatch):
    monkeypatch.delenv("OLLAMA_HOST", raising=False)
    (vault / "secondbrain.json").write_text(json.dumps({"agentDock": {"runtimes": {"zen": {
        "provider": "ollama", "model": "big-model:27b"}}}}))
    s = dock.load_settings(vault)
    info = dock.agent_info(vault, s, "ada")
    argv, meta = dock.build_runtime_command("ada", info, "zen", s, vault)
    assert argv[1:] == ["chat", "--persona", "ada", "--model", "ollama-local/big-model:27b"]
    assert meta == {"model": "big-model:27b", "provider": "ollama", "env": {"OLLAMA_MACHINES": "local=http://127.0.0.1:11434"}}
    argv, meta = dock.build_runtime_command("ada", info, "zen", s, vault, model="fast-1", provider="example")
    assert argv[1:] == ["chat", "--persona", "ada", "--model", "example/fast-1"] and "env" not in meta
    plain = dock.load_settings(vault / "..")  # no settings file: zen-agent keeps its own default model
    argv, meta = dock.build_runtime_command("ada", info, "zen", plain, vault)
    assert argv[1:] == ["chat", "--persona", "ada"] and meta == {"model": "", "provider": ""}


def test_run_sets_the_local_machine_for_zen_agent(vault, fake_bin, tmp_path, monkeypatch):
    monkeypatch.delenv("OLLAMA_HOST", raising=False)
    (vault / "secondbrain.json").write_text(json.dumps({"agentDock": {"runtimes": {"zen": {
        "provider": "ollama", "model": "big-model:27b"}}}}))
    (fake_bin / "zen-agent").write_text('#!/bin/sh\necho "$OLLAMA_MACHINES" > "$FAKE_OUT"\nexit 0\n')
    env = dict(os.environ, AGENT_DOCK_STATE=str(tmp_path / "state"), FAKE_OUT=str(tmp_path / "out.txt"))
    r = run_cli("run", "ada", "--runtime", "zen", "--vault", str(vault), env=env)
    assert r.returncode == 0, r.stderr
    assert (tmp_path / "out.txt").read_text().strip() == "local=http://127.0.0.1:11434"
    start = json.loads((tmp_path / "state" / "history.jsonl").read_text().splitlines()[0])
    assert (start["harness"], start["provider"], start["model"]) == ("zen", "ollama", "big-model:27b")
    assert "env" not in start


def test_zen_agent_processes_are_recognised_through_node():
    rows = dock.parse_ps("  9     1 Tue Jan  1 10:00:00 2030     node --no-warnings /v/.secondbrain/zen-agent/dist/src/cli.js chat --persona ada --model ollama-local/big:27b\n"
                         " 10     1 Tue Jan  1 10:00:00 2030     zen-agent wake t_0a1b2c3d --persona bo --model example/fast-1\n")
    runs = {r["pid"]: r for r in dock.classify_processes(rows)}
    assert (runs[9]["harness"], runs[9]["agent"], runs[9]["provider"], runs[9]["mode"]) == ("zen-agent", "ada", "ollama", "interactive")
    assert (runs[10]["agent"], runs[10]["provider"], runs[10]["mode"], runs[10]["ticket"]) == ("bo", "example", "headless", "t_0a1b2c3d")


def test_a_zen_agent_bot_keeps_its_roster_model(vault, fake_bin):
    s = dock.load_settings(vault)
    info = dict(dock.agent_info(vault, s, "ada"), runtime="zen-agent", model="ollama-box/big:27b")
    argv, meta = dock.build_runtime_command("ada", info, "zen", s, vault)
    assert argv[1:] == ["chat", "--persona", "ada"] and meta == {"model": "ollama-box/big:27b", "provider": "ollama"}
