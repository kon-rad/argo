"""Offline tests: no microphone, model, browser, or cloud credential required."""
import importlib.util
from pathlib import Path

import pytest

SPEC = importlib.util.spec_from_file_location("tv_voice", Path(__file__).parents[1] / "voice.py")
voice = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(voice)


@pytest.mark.parametrize("phrase", ["", "approve job", "reload page then back", "[unk]", "rm -rf /", "please scroll down"])
def test_unlisted_phrases_cannot_act(phrase):
    assert voice.parse_command(phrase) is None


def test_normalizes_only_case_and_whitespace():
    assert voice.parse_command("  SCROLL   down ") == "scroll down"


@pytest.mark.parametrize("url", ["ws://example.com/x", "ws://127.0.0.1:80/x", "wss://127.0.0.1:9222/x", "ws://user@127.0.0.1:9222/x"])
def test_rejects_nonlocal_or_unexpected_websocket(url):
    with pytest.raises(ValueError):
        voice.validate_websocket(url)


def test_accepts_only_fixed_local_debug_endpoint():
    voice.validate_websocket("ws://127.0.0.1:9222/devtools/page/fake")


class FakeBrowser(voice.Browser):
    def __init__(self):
        self.calls = []
        self.current = {"id": "a", "url": "https://example.com", "loader": "one"}

    def snapshot(self):
        return self.current.copy()

    def page_call(self, target, method, params=None):
        self.calls.append((method, params))
        if method == "Page.getNavigationHistory":
            return {"currentIndex": 0, "entries": [{"id": 1}]}
        return {}

    def browser_call(self, method, params=None):
        self.calls.append((method, params))
        if method == "Browser.getWindowForTarget":
            return {"windowId": 7}
        return {}


@pytest.mark.parametrize("change", [{"id": "b"}, {"url": "https://other.example"}, {"loader": "two"}])
def test_changed_target_never_dispatches(change):
    browser = FakeBrowser()
    pinned = browser.snapshot()
    browser.current.update(change)
    with pytest.raises(RuntimeError, match="changed"):
        browser.execute("reload page", pinned)
    assert browser.calls == []


def test_unknown_command_rejected_before_any_browser_call():
    browser = FakeBrowser()
    with pytest.raises(ValueError):
        browser.execute("approve job", browser.snapshot())
    assert browser.calls == []


def test_scroll_is_a_fixed_expression():
    browser = FakeBrowser()
    browser.execute("scroll down", browser.snapshot())
    assert browser.calls == [("Runtime.evaluate", {"expression": "window.scrollBy(0, window.innerHeight * 0.7)"})]


def test_back_at_first_history_entry_does_not_navigate():
    browser = FakeBrowser()
    browser.execute("back", browser.snapshot())
    assert [c[0] for c in browser.calls] == ["Page.getNavigationHistory"]


def test_fullscreen_is_explicit_not_a_toggle():
    browser = FakeBrowser()
    browser.execute("leave fullscreen", browser.snapshot())
    assert browser.calls[-1] == ("Browser.setWindowBounds", {"windowId": 7, "bounds": {"windowState": "normal"}})


def test_rpc_ignores_events_and_checks_protocol_errors(monkeypatch):
    class Socket:
        def __init__(self):
            self.messages = iter(['{"method":"Page.loaded"}', '{"id":1,"error":{"message":"denied"}}'])
        def send(self, data):
            pass
        def recv(self):
            return next(self.messages)
        def close(self):
            pass
    import sys
    from types import SimpleNamespace
    monkeypatch.setitem(sys.modules, "websocket", SimpleNamespace(create_connection=lambda *a, **kw: Socket()))
    with pytest.raises(RuntimeError, match="denied"):
        voice.rpc("ws://127.0.0.1:9222/devtools/page/fake", "Page.reload")


def test_ambiguous_visible_windows_refused():
    class Ambiguous(voice.Browser):
        def pages(self):
            return [{"id": "a", "type": "page", "url": "https://example.com"},
                    {"id": "b", "type": "page", "url": "https://example.org"}]
        def page_call(self, target, method, params=None):
            return {"result": {"value": {"visible": True, "focused": False}}}
    with pytest.raises(RuntimeError, match="one visible"):
        Ambiguous().snapshot()


def test_capture_combines_all_segments_and_does_not_write_audio(tmp_path, monkeypatch):
    import sys
    from types import SimpleNamespace
    (tmp_path / "am").mkdir()
    monkeypatch.setattr(voice, "announce", lambda message: None)
    class Recognizer:
        def AcceptWaveform(self, data):
            return True
        def Result(self):
            return '{"text":"scroll"}'
        def FinalResult(self):
            return '{"text":"down"}'
    class Input:
        def __init__(self, **kwargs):
            self.callback = kwargs["callback"]
        def __enter__(self):
            self.callback(b"audio", 4000, None, None)
        def __exit__(self, *args):
            pass
    monkeypatch.setitem(sys.modules, "sounddevice", SimpleNamespace(
        query_devices=lambda *a: {"default_samplerate": 16000}, RawInputStream=Input))
    monkeypatch.setitem(sys.modules, "vosk", SimpleNamespace(
        Model=lambda path: object(), KaldiRecognizer=lambda *a: Recognizer(), SetLogLevel=lambda n: None))
    ticks = iter([0, 2])
    monkeypatch.setattr(voice.time, "monotonic", lambda: next(ticks))
    assert voice.recognize(tmp_path, None, 1) == "scroll down"
    assert list(tmp_path.iterdir()) == [tmp_path / "am"]


def test_capture_audio_error_never_returns_a_command(tmp_path, monkeypatch):
    import sys
    from types import SimpleNamespace
    (tmp_path / "am").mkdir()
    monkeypatch.setattr(voice, "announce", lambda message: None)
    class Input:
        def __init__(self, **kwargs):
            self.callback = kwargs["callback"]
        def __enter__(self):
            self.callback(b"audio", 4000, None, "input overflow")
        def __exit__(self, *args):
            pass
    monkeypatch.setitem(sys.modules, "sounddevice", SimpleNamespace(
        query_devices=lambda *a: {"default_samplerate": 16000}, RawInputStream=Input))
    monkeypatch.setitem(sys.modules, "vosk", SimpleNamespace(
        Model=lambda path: object(), KaldiRecognizer=lambda *a: object(), SetLogLevel=lambda n: None))
    ticks = iter([0, 2])
    monkeypatch.setattr(voice.time, "monotonic", lambda: next(ticks))
    with pytest.raises(RuntimeError, match="Microphone error"):
        voice.recognize(tmp_path, None, 1)
