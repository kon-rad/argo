#!/usr/bin/env python3
"""Telegram bridge for zen-agent: one bot, one allowlist, one `zen-agent run` per message.

Long-polls Telegram, answers only the allowlisted private chats, and runs the message through
`zen-agent run --json --resume <session>`. The chat keeps its session until /new, until it has run
BRIDGE_MAX_RUNS times, or until the next run would be a fresh start anyway. Standard library only.

Settings come from the environment (see env.example). The token is never printed or put in an error.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

API = "https://api.telegram.org"
MESSAGE_LIMIT = 4000  # Telegram caps a message at 4096 characters; stay under it
HELP = (
    "Send a message and the agent answers it.\n"
    "/new  start a fresh conversation\n"
    "/status  the session and what the last run cost\n"
    "/help  this text"
)


class Config:
    def __init__(self, env: Optional[Dict[str, str]] = None) -> None:
        e = os.environ if env is None else env
        self.token = e.get("TELEGRAM_BOT_TOKEN", "").strip()
        self.allowed = {int(x) for x in e.get("TELEGRAM_ALLOWED_USERS", "").replace(" ", "").split(",") if x}
        self.zen_bin = e.get("ZEN_AGENT_BIN", "zen-agent")
        self.persona = e.get("ZEN_PERSONA", "").strip()
        self.model = e.get("ZEN_MODEL", "").strip()
        self.tools = e.get("ZEN_TOOLS", "").strip()
        self.max_turns = e.get("BRIDGE_MAX_TURNS", "").strip()
        self.max_tokens = e.get("BRIDGE_MAX_TOKENS", "").strip()
        self.workdir = e.get("BRIDGE_WORKDIR", os.getcwd())
        self.run_timeout = int(e.get("BRIDGE_RUN_TIMEOUT", "600"))
        self.max_runs = int(e.get("BRIDGE_MAX_RUNS", "20"))
        self.footer = e.get("BRIDGE_FOOTER", "1") != "0"
        self.state_file = Path(e.get("BRIDGE_STATE", str(Path.home() / ".zen" / "telegram-bridge.json")))

    def problems(self) -> List[str]:
        out = []
        if not self.token:
            out.append("TELEGRAM_BOT_TOKEN is not set")
        if not self.allowed:
            out.append("TELEGRAM_ALLOWED_USERS is empty: the bridge refuses to answer everyone")
        return out


class State:
    """The polling offset and each chat's session, in one small JSON file written atomically."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.data: Dict[str, Any] = {"offset": 0, "chats": {}}
        try:
            loaded = json.loads(path.read_text())
            if isinstance(loaded, dict):
                self.data.update(loaded)
        except (OSError, ValueError):
            pass

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.data))
        os.replace(tmp, self.path)

    def chat(self, chat_id: int) -> Dict[str, Any]:
        return self.data["chats"].setdefault(str(chat_id), {"session": None, "runs": 0, "last": None})


class Telegram:
    def __init__(self, token: str) -> None:
        self.token = token

    def call(self, method: str, _timeout: int = 40, **params: Any) -> Any:
        req = urllib.request.Request(
            f"{API}/bot{self.token}/{method}",
            data=json.dumps(params).encode(),
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=_timeout) as resp:
                body = json.loads(resp.read())
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"telegram {method}: HTTP {e.code}") from None
        except (urllib.error.URLError, OSError, ValueError) as e:
            raise RuntimeError(f"telegram {method}: {type(e).__name__}") from None
        if not body.get("ok"):
            raise RuntimeError(f"telegram {method}: {body.get('description', 'not ok')}")
        return body["result"]


def chunks(text: str, limit: int = MESSAGE_LIMIT) -> List[str]:
    """Split on paragraph, then line, then space boundaries so no message is over the limit."""
    text = text.strip() or "(no answer)"
    out: List[str] = []
    while len(text) > limit:
        cut = max(text.rfind("\n\n", 0, limit), text.rfind("\n", 0, limit), text.rfind(" ", 0, limit))
        if cut < limit // 2:
            cut = limit
        out.append(text[:cut].rstrip())
        text = text[cut:].lstrip()
    out.append(text)
    return out


def parse_result(stdout: str) -> Optional[Dict[str, Any]]:
    """The run result is the last JSON object line of stdout."""
    for line in reversed(stdout.strip().splitlines()):
        try:
            obj = json.loads(line)
        except ValueError:
            continue
        if isinstance(obj, dict) and "text" in obj:
            return obj
    return None


class Bridge:
    def __init__(self, cfg: Config, tg: Telegram, state: State, runner: Optional[Callable[..., Any]] = None) -> None:
        self.cfg, self.tg, self.state = cfg, tg, state
        self.runner = runner or subprocess.run

    def argv(self, session: Optional[str], message_id: Optional[int] = None) -> List[str]:
        c = self.cfg
        a = [c.zen_bin, "run", "--json", "--quiet"]
        # Labels the usage page reads from the trace (usage/zenTrace.ts): a work type to filter on, and a wake reason
        # whose ref is the Telegram message id, never the chat id or the text.
        a += ["--meta", "work_type=telegram", "--meta", "channel=telegram"]
        if message_id is not None:
            a += ["--meta-json", json.dumps({"reasons": [{"reason": "telegram", "ref": str(message_id)}]})]
        for flag, val in (("--persona", c.persona), ("--model", c.model), ("--tools", c.tools),
                          ("--max-turns", c.max_turns), ("--max-tokens", c.max_tokens)):
            if val:
                a += [flag, val]
        if session:
            a += ["--resume", session]
        return a

    def run_agent(self, chat_id: int, text: str, message_id: Optional[int] = None) -> str:
        chat = self.state.chat(chat_id)
        note = ""
        if chat["session"] and chat["runs"] >= self.cfg.max_runs:
            chat["session"], chat["runs"] = None, 0
            note = "(Started a fresh conversation: the last one had run long enough to cost more than it helps.)\n\n"
        try:
            # The prompt goes in on stdin, so a message that starts with "-" can never be read as a flag.
            proc = self.runner(self.argv(chat["session"], message_id), input=text, capture_output=True, text=True,
                               timeout=self.cfg.run_timeout, cwd=self.cfg.workdir)
        except subprocess.TimeoutExpired:
            return f"The run took longer than {self.cfg.run_timeout // 60} minutes and was stopped."
        except OSError as e:
            return f"Could not start zen-agent ({type(e).__name__})."
        result = parse_result(proc.stdout or "")
        if result is None:
            tail = (proc.stderr or "").strip().splitlines()[-1:] or ["no output"]
            return f"The run failed (exit {proc.returncode}): {tail[0][:300]}"
        chat["session"] = result.get("sessionId") or chat["session"]
        chat["runs"] += 1
        usage = result.get("usage") or {}
        chat["last"] = {"tokens": usage.get("total"), "turns": result.get("turns"), "stopped": result.get("stopped")}
        reply = note + (result.get("text") or "").strip()
        if result.get("stopped") == "budget":
            reply += "\n\n(Stopped: the run's budget ran out. Ask again or narrow the request.)"
        if result.get("error"):
            reply += f"\n\n(error: {str(result['error'])[:300]})"
        if self.cfg.footer and usage.get("total") is not None:
            reply += f"\n\n[{usage['total']} tokens, {result.get('turns')} turns]"
        return reply

    def command(self, chat_id: int, text: str) -> Optional[str]:
        word = text.split()[0].split("@")[0].lower()
        chat = self.state.chat(chat_id)
        if word in ("/start", "/help"):
            return HELP
        if word == "/new":
            chat["session"], chat["runs"] = None, 0
            return "Fresh conversation."
        if word == "/status":
            last = chat["last"] or {}
            return (f"session: {chat['session'] or 'none'}\nruns in it: {chat['runs']} of {self.cfg.max_runs}\n"
                    f"persona: {self.cfg.persona or 'none'}\n"
                    f"last run: {last.get('tokens', '?')} tokens, {last.get('turns', '?')} turns, {last.get('stopped', '?')}")
        return None

    def handle(self, update: Dict[str, Any]) -> None:
        msg = update.get("message") or {}
        sender = (msg.get("from") or {}).get("id")
        chat = msg.get("chat") or {}
        text = (msg.get("text") or "").strip()
        # Strangers get nothing: no reply, so the bot does not confirm that it is listening.
        if sender not in self.cfg.allowed or chat.get("type") != "private" or not text:
            return
        chat_id = chat["id"]
        reply = self.command(chat_id, text) if text.startswith("/") else None
        if reply is None:
            stop = threading.Event()
            threading.Thread(target=self.typing, args=(chat_id, stop), daemon=True).start()
            try:
                reply = self.run_agent(chat_id, text, msg.get("message_id"))
            finally:
                stop.set()
        for part in chunks(reply):
            self.tg.call("sendMessage", chat_id=chat_id, text=part)

    def typing(self, chat_id: int, stop: threading.Event) -> None:
        while not stop.is_set():
            try:
                self.tg.call("sendChatAction", _timeout=10, chat_id=chat_id, action="typing")
            except RuntimeError:
                return
            stop.wait(4)

    def poll_once(self, timeout: int = 30) -> int:
        updates = self.tg.call("getUpdates", _timeout=timeout + 10, offset=self.state.data["offset"],
                               timeout=timeout, allowed_updates=["message"])
        for u in updates:
            # Advance and save the offset first: a message that crashes a run is skipped, not replayed forever.
            self.state.data["offset"] = u["update_id"] + 1
            self.state.save()
            try:
                self.handle(u)
            except Exception as e:  # keep the loop alive; say the class of error, never the payload
                print(f"bridge: update {u.get('update_id')}: {type(e).__name__}: {str(e)[:200]}", file=sys.stderr, flush=True)
            self.state.save()
        return len(updates)


def main() -> int:
    cfg = Config()
    problems = cfg.problems()
    if problems:
        print("bridge: " + "; ".join(problems), file=sys.stderr)
        return 2
    tg = Telegram(cfg.token)
    me = tg.call("getMe", _timeout=15)
    print(f"bridge: up as @{me.get('username')}, {len(cfg.allowed)} allowed user(s), persona={cfg.persona or 'none'}", flush=True)
    bridge = Bridge(cfg, tg, State(cfg.state_file))
    backoff = 1
    while True:
        try:
            bridge.poll_once()
            backoff = 1
        except RuntimeError as e:
            print(f"bridge: {e}; retry in {backoff}s", file=sys.stderr, flush=True)
            time.sleep(backoff)
            backoff = min(backoff * 2, 60)


if __name__ == "__main__":
    sys.exit(main())
