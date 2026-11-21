"""Synthetic event and PCM replay. No microphone, login, or model is required."""
import array
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "voice"))
from speech import Endpoint, Opening, rating


def pcm(value, millis):
    return array.array("h", [value] * (16 * millis)).tobytes()


def test_endpoint_replay_and_hesitation():
    detector = Endpoint()
    events = []
    for value, millis in [(0, 100), (2200, 800), (0, 300), (1800, 700), (0, 800), (0, 1000)]:
        for _ in range(millis // 100):
            events.extend(kind for kind, _ in detector.feed(pcm(value, 100)))
    assert events.count("onset") == events.count("final") == 1
    assert events.index("partial") < events.index("final")


def test_opening_and_silence():
    o = Opening()
    assert o.feed("One sen") == []
    assert o.feed("tence. Another") == ["One sentence."]
    assert o.feed(" here.\n\n```sh\nls") == ["Another here."]
    assert o.feed("more", final=True) == []
    o = Opening()
    assert o.feed("An unfinished") == []
    o.silence()
    assert o.feed(" sentence. ", final=True) == []


def test_reference_requires_exact_model_and_backend():
    digest = "4b50b6dd862bf6e346929aaf4f5eaacec003bfa3f56462d6c874b41ef2f38795"
    assert rating(digest, "handy")["error"] == 3.99
    assert rating(digest, "whisper") is None
    assert rating("unknown", "handy") is None
