import hashlib
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

_spec = importlib.util.spec_from_file_location("usage_ledger", Path(__file__).with_name("__init__.py"))
ul = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ul)

BASE = dict(
    session_id="20261020_101500_ab12cd", task_id="t1", turn_id="turn-1", api_request_id="req-1", api_call_count=2,
    platform="telegram", provider="openrouter", base_url="https://user:pw@openrouter.ai/api/v1?key=x", api_mode="chat_completions",
    model="anthropic/claude-sonnet-4.6", response_model="anthropic/claude-4.6-sonnet-20260101", api_duration=1.5,
    started_at=1_792_000_000.0, ended_at=1_792_000_001.5, finish_reason="tool_calls",
    usage={"input_tokens": 1200, "output_tokens": 80, "cache_read_tokens": 9000, "cache_write_tokens": 300, "reasoning_tokens": 40},
)


def test_row_has_tokens_model_and_tool_match_key():
    msg = SimpleNamespace(content="", tool_calls=[
        SimpleNamespace(id="call_a", function=SimpleNamespace(name="terminal")),
        {"id": "call_b", "function": {"name": "read_file"}},
    ])
    row = ul.build_row("main", {**BASE, "assistant_message": msg})
    assert row["ts"] == "2026-10-14T17:46:41.500000+00:00"
    assert (row["input"], row["output"], row["cache_read"], row["cache_write"], row["reasoning"]) == (1200, 80, 9000, 300, 40)
    assert row["duration_ms"] == 1500
    assert row["tools"] == ["terminal", "read_file"]
    assert row["match"] == "t:call_a,call_b"
    # No user info or query from the base URL, and no message text anywhere.
    assert row["base_url"] == "https://openrouter.ai/api/v1"
    assert "pw" not in json.dumps(row)


def test_text_response_matches_by_hash_of_trimmed_text():
    row = ul.build_row("main", {**BASE, "assistant_message": SimpleNamespace(content="  Done.\n", tool_calls=None)})
    assert row["match"] == "c:" + hashlib.sha256(b"Done.").hexdigest()[:32]


def test_aux_call_has_no_match_and_no_session_is_skipped():
    row = ul.build_row("aux", {**BASE, "aux_task": "title_generation", "assistant_message": None})
    assert row["kind"] == "aux" and row["aux_task"] == "title_generation" and row["match"] is None
    assert ul.build_row("main", {**BASE, "session_id": ""}) is None


def test_rows_append_to_one_file_per_utc_day(tmp_path):
    ul.write_row(ul.build_row("main", BASE), tmp_path)
    ul.write_row(ul.build_row("aux", BASE), tmp_path)
    lines = (tmp_path / "usage" / "calls-2026-10-14.jsonl").read_text().splitlines()
    assert [json.loads(l)["kind"] for l in lines] == ["main", "aux"]


def test_a_failing_hook_never_raises(monkeypatch):
    monkeypatch.setattr(ul, "write_row", lambda *_a, **_k: (_ for _ in ()).throw(OSError("disk full")))
    ul._hook("main")(**BASE)  # no exception
    ul._hook("main")(usage="not a dict", session_id="s")  # odd payloads too
