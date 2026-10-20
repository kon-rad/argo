"""usage-ledger: one JSON line per model API request, for the Second Brain usage page.

Hermes's state.db keeps only session totals; per-message `token_count` is never filled.
This plugin listens to `post_api_request` (every main-loop request) and
`post_auxiliary_call` (titles, compression, other side calls) and appends one line per
request to `$HERMES_HOME/usage/calls-YYYY-MM-DD.jsonl` (UTC day). The Second Brain
collectors (agents-sync, the archive run, the agent ledger) read those files into
`usage_calls`.

A line holds tokens, model, provider, timing and a match key, never message text or
headers: the text is already in state.db, and the match key (the tool-call ids, or a hash
of the response text) lets the usage page put each call's tokens on the response it made.

It must never stop an agent: every hook body is wrapped, and a write that fails is dropped.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit

log = logging.getLogger(__name__)
_lock = threading.Lock()


def _home() -> Path:
    try:
        from hermes_constants import get_hermes_home
        return Path(get_hermes_home())
    except Exception:
        return Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")


def _int(v: Any) -> int:
    try:
        return int(v or 0)
    except (TypeError, ValueError):
        return 0


def _iso(epoch: Any) -> str | None:
    try:
        return datetime.fromtimestamp(float(epoch), tz=timezone.utc).isoformat()
    except (TypeError, ValueError, OverflowError, OSError):
        return None


def _field(obj: Any, name: str) -> Any:
    return obj.get(name) if isinstance(obj, dict) else getattr(obj, name, None)


def _tool_calls(msg: Any) -> tuple[list[str], list[str]]:
    ids: list[str] = []
    names: list[str] = []
    for tc in _field(msg, "tool_calls") or []:
        tid = _field(tc, "id")
        if tid:
            ids.append(str(tid))
        name = _field(_field(tc, "function"), "name") or _field(tc, "name")
        if name:
            names.append(str(name))
    return ids, names


def match_key(msg: Any) -> str | None:
    """The same key the usage page computes from the stored message: tool-call ids, else a text hash."""
    if msg is None:
        return None
    ids, _ = _tool_calls(msg)
    if ids:
        return "t:" + ",".join(ids)
    content = _field(msg, "content")
    if isinstance(content, str) and content.strip():
        return "c:" + hashlib.sha256(content.strip().encode("utf-8")).hexdigest()[:32]
    return None


def _clean_url(url: Any) -> str | None:
    """Scheme, host and path only: a base URL can carry a key in its user info or query."""
    if not isinstance(url, str) or not url:
        return None
    try:
        p = urlsplit(url)
        return urlunsplit((p.scheme, p.hostname or "", p.path, "", "")) if p.scheme else None
    except ValueError:
        return None


def build_row(kind: str, kw: dict[str, Any]) -> dict[str, Any] | None:
    usage = kw.get("usage") or {}
    if not isinstance(usage, dict):
        usage = {}
    session_id = kw.get("session_id") or ""
    if not session_id:
        return None
    ended = kw.get("ended_at") or time.time()
    started = kw.get("started_at")
    duration = kw.get("api_duration")
    msg = kw.get("assistant_message")
    _, names = _tool_calls(msg)
    return {
        "v": 1,
        "kind": kind,
        "ts": _iso(ended),
        "started_at": _iso(started) if started else None,
        "duration_ms": int(float(duration) * 1000) if isinstance(duration, (int, float)) else None,
        "session_id": str(session_id),
        "task_id": kw.get("task_id"),
        "turn_id": kw.get("turn_id"),
        "api_request_id": kw.get("api_request_id"),
        "api_call_count": kw.get("api_call_count"),
        "aux_task": kw.get("aux_task"),
        "platform": kw.get("platform"),
        "provider": kw.get("provider"),
        "base_url": _clean_url(kw.get("base_url")),
        "api_mode": kw.get("api_mode"),
        "model": kw.get("model"),
        "response_model": kw.get("response_model"),
        "finish_reason": None if kw.get("finish_reason") is None else str(kw.get("finish_reason")),
        "input": _int(usage.get("input_tokens")),
        "output": _int(usage.get("output_tokens")),
        "cache_read": _int(usage.get("cache_read_tokens")),
        "cache_write": _int(usage.get("cache_write_tokens")),
        "reasoning": _int(usage.get("reasoning_tokens")),
        "tools": names,
        "match": match_key(msg) if kind == "main" else None,
    }


def write_row(row: dict[str, Any], home: Path | None = None) -> None:
    day = (row.get("ts") or _iso(time.time()) or "")[:10]
    folder = (home or _home()) / "usage"
    folder.mkdir(parents=True, exist_ok=True)
    line = json.dumps(row, ensure_ascii=False, separators=(",", ":"), default=str) + "\n"
    with _lock, open(folder / f"calls-{day}.jsonl", "a", encoding="utf-8") as f:
        f.write(line)


def _hook(kind: str):
    def handler(**kw: Any) -> None:
        try:
            row = build_row(kind, kw)
            if row:
                write_row(row)
        except Exception as exc:  # never let usage logging reach the agent
            log.debug("usage-ledger: dropped a %s call: %s", kind, exc)
    return handler


def register(ctx) -> None:
    ctx.register_hook("post_api_request", _hook("main"))
    ctx.register_hook("post_auxiliary_call", _hook("aux"))
