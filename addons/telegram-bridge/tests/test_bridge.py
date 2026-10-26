"""Tests for the Telegram bridge: allowlist, commands, sessions, chunking and the zen-agent call. No network."""
import importlib.util
import json
import subprocess
from pathlib import Path
from types import SimpleNamespace

ADDON = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("bridge", ADDON / "bridge.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

OWNER = 1001


class FakeTg:
    def __init__(self):
        self.sent = []
        self.token = "123456:SECRET"

    def call(self, method, _timeout=40, **params):
        if method == "sendMessage":
            self.sent.append(params)
        return []


def make(tmp_path, runner, **env):
    base = {"TELEGRAM_BOT_TOKEN": "123456:SECRET", "TELEGRAM_ALLOWED_USERS": str(OWNER),
            "BRIDGE_STATE": str(tmp_path / "state.json"), "BRIDGE_FOOTER": "0"}
    base.update(env)
    cfg = bridge.Config(base)
    tg = FakeTg()
    return bridge.Bridge(cfg, tg, bridge.State(cfg.state_file), runner=runner), tg


def update(text, sender=OWNER, chat_type="private", uid=1, mid=77):
    return {"update_id": uid, "message": {"message_id": mid, "from": {"id": sender}, "chat": {"id": sender, "type": chat_type}, "text": text}}


def ok_runner(calls, text="done", session="s-1", total=120):
    def run(argv, **kw):
        calls.append((argv, kw))
        out = json.dumps({"text": text, "stopped": "done", "turns": 2, "usage": {"total": total}, "sessionId": session})
        return SimpleNamespace(stdout="noise\n" + out + "\n", stderr="", returncode=0)
    return run


def test_refuses_to_start_without_token_or_allowlist():
    assert bridge.Config({}).problems() == [
        "TELEGRAM_BOT_TOKEN is not set",
        "TELEGRAM_ALLOWED_USERS is empty: the bridge refuses to answer everyone",
    ]
    assert bridge.Config({"TELEGRAM_BOT_TOKEN": "t", "TELEGRAM_ALLOWED_USERS": "1, 2"}).allowed == {1, 2}


def test_strangers_groups_and_empty_messages_get_no_reply(tmp_path):
    calls = []
    b, tg = make(tmp_path, ok_runner(calls))
    b.handle(update("hi", sender=999))
    b.handle(update("hi", chat_type="group"))
    b.handle(update("   "))
    assert tg.sent == [] and calls == []


def test_message_goes_to_stdin_not_argv_and_reply_is_sent(tmp_path):
    calls = []
    b, tg = make(tmp_path, ok_runner(calls, text="the answer"), ZEN_PERSONA="sol", ZEN_TOOLS="fs,kanban")
    b.handle(update("--help --persona evil"))
    argv, kw = calls[0]
    assert kw["input"] == "--help --persona evil"
    assert "--help --persona evil" not in argv
    assert argv[:4] == ["zen-agent", "run", "--json", "--quiet"]
    assert argv[argv.index("--persona") + 1] == "sol"
    assert argv[argv.index("--tools") + 1] == "fs,kanban"
    assert tg.sent[-1]["text"] == "the answer" and tg.sent[-1]["chat_id"] == OWNER


def test_session_is_resumed_then_reset_by_new(tmp_path):
    calls = []
    b, tg = make(tmp_path, ok_runner(calls, session="s-7"))
    b.handle(update("one"))
    b.handle(update("two"))
    assert "--resume" not in calls[0][0]
    assert calls[1][0][calls[1][0].index("--resume") + 1] == "s-7"
    b.handle(update("/new"))
    b.handle(update("three"))
    assert "--resume" not in calls[2][0]


def test_session_rolls_over_after_max_runs(tmp_path):
    calls = []
    b, tg = make(tmp_path, ok_runner(calls), BRIDGE_MAX_RUNS="2")
    for t in ("a", "b", "c"):
        b.handle(update(t))
    assert "--resume" in calls[1][0] and "--resume" not in calls[2][0]
    assert "fresh conversation" in tg.sent[-1]["text"]


def test_status_and_help_do_not_call_the_agent(tmp_path):
    calls = []
    b, tg = make(tmp_path, ok_runner(calls))
    b.handle(update("one"))
    b.handle(update("/status"))
    b.handle(update("/help"))
    assert len(calls) == 1
    assert "120 tokens" in tg.sent[-2]["text"] and "/new" in tg.sent[-1]["text"]


def test_footer_shows_tokens_when_on(tmp_path):
    b, tg = make(tmp_path, ok_runner([]), BRIDGE_FOOTER="1")
    b.handle(update("x"))
    assert tg.sent[-1]["text"].endswith("[120 tokens, 2 turns]")


def test_footer_separates_cached_rereads_from_new_tokens(tmp_path):
    def run(argv, **kw):
        out = json.dumps({"text": "ok", "stopped": "done", "turns": 11, "sessionId": "s",
                          "usage": {"total": 231698, "input": 32768, "output": 1170, "cacheRead": 197760, "cacheWrite": 0}})
        return SimpleNamespace(stdout=out, stderr="", returncode=0)

    b, tg = make(tmp_path, run, BRIDGE_FOOTER="1")
    b.handle(update("x"))
    assert tg.sent[-1]["text"].endswith("[33938 tokens + 197760 cached, 11 turns]")


def test_failures_are_reported_not_raised(tmp_path):
    def boom(argv, **kw):
        return SimpleNamespace(stdout="", stderr="Error: no key\n", returncode=1)

    def slow(argv, **kw):
        raise subprocess.TimeoutExpired(argv, 1)

    b, tg = make(tmp_path, boom)
    b.handle(update("x"))
    assert "failed (exit 1): Error: no key" in tg.sent[-1]["text"]
    b2, tg2 = make(tmp_path, slow, BRIDGE_RUN_TIMEOUT="120")
    b2.handle(update("x"))
    assert "longer than 2 minutes" in tg2.sent[-1]["text"]


def test_budget_stop_is_explained(tmp_path):
    def run(argv, **kw):
        out = json.dumps({"text": "partial", "stopped": "budget", "turns": 40, "usage": {"total": 9}, "sessionId": "s"})
        return SimpleNamespace(stdout=out, stderr="", returncode=3)

    b, tg = make(tmp_path, run)
    b.handle(update("x"))
    assert "budget ran out" in tg.sent[-1]["text"]


def test_long_replies_are_split_under_the_limit():
    parts = bridge.chunks(("para " * 300 + "\n\n") * 5)
    assert len(parts) > 1 and all(len(p) <= bridge.MESSAGE_LIMIT for p in parts)
    assert bridge.chunks("") == ["(no answer)"]
    assert len(bridge.chunks("x" * 9000)) == 3


def test_offset_is_saved_before_the_update_is_handled(tmp_path):
    seen = []

    class Tg(FakeTg):
        def call(self, method, _timeout=40, **params):
            if method == "getUpdates":
                return [update("boom", uid=41)]
            return super().call(method, _timeout, **params)

    cfg = bridge.Config({"TELEGRAM_BOT_TOKEN": "t", "TELEGRAM_ALLOWED_USERS": str(OWNER), "BRIDGE_STATE": str(tmp_path / "s.json")})
    b = bridge.Bridge(cfg, Tg(), bridge.State(cfg.state_file), runner=lambda *a, **k: seen.append(json.loads((tmp_path / "s.json").read_text())["offset"]) or (_ for _ in ()).throw(ValueError("crash")))
    assert b.poll_once() == 1
    assert seen == [42]
    assert bridge.State(cfg.state_file).data["offset"] == 42


def test_token_never_appears_in_errors(tmp_path, monkeypatch):
    import urllib.error

    def fail(*a, **k):
        raise urllib.error.URLError("https://api.telegram.org/bot123456:SECRET/getMe unreachable")

    monkeypatch.setattr(bridge.urllib.request, "urlopen", fail)
    try:
        bridge.Telegram("123456:SECRET").call("getMe")
    except RuntimeError as e:
        assert "SECRET" not in str(e)
    else:
        raise AssertionError("expected RuntimeError")


def test_runs_are_labelled_for_the_usage_page_without_the_chat_id_or_text(tmp_path):
    calls = []
    b, tg = make(tmp_path, ok_runner(calls))
    b.handle(update("secret question", mid=4242))
    argv = calls[0][0]
    assert argv[argv.index("--meta") + 1] == "work_type=telegram"
    assert "channel=telegram" in argv
    meta = json.loads(argv[argv.index("--meta-json") + 1])
    assert meta == {"reasons": [{"reason": "telegram", "ref": "4242"}]}
    assert str(OWNER) not in " ".join(argv) and "secret question" not in " ".join(argv)
