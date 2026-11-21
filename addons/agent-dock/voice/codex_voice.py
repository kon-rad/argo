"""One app-server process and fresh thread per managed voice session."""
import asyncio
import json
from pathlib import Path
from speech import Opening


def parameters(profile, prompt, workspace):
    if profile.get("runtime") != "codex" or not profile.get("model") or not prompt:
        raise ValueError("Voice requires a registered Codex persona, model and prompt")
    tools = set(profile.get("tools", []))
    writable = {"Edit", "Write"} <= tools and profile.get("permission_mode") == "acceptEdits"
    shell = "Bash" in tools
    return dict(model=profile["model"], cwd=str(workspace), ephemeral=True,
                sandbox="workspace-write" if writable else "read-only", approvalPolicy="untrusted",
                config={"features.shell_tool": shell, "features.unified_exec": shell,
                        "features.multi_agent": False, "web_search": "disabled"},
                developerInstructions=prompt + "\nOpen your public reply with a short speakable paragraph. "
                "Put commands, paths, detailed evidence and code in later paragraphs.")


def verify_thread(params, result):
    root = Path(params["cwd"]).resolve()
    policy = result["sandbox"]
    expected = {"read-only": "readOnly", "workspace-write": "workspaceWrite"}[params["sandbox"]]
    if (Path(result["cwd"]).resolve() != root or result["model"] != params["model"]
            or policy["type"] != expected or policy.get("networkAccess", False)
            or result["approvalPolicy"] != params["approvalPolicy"]
            or any(not Path(path).resolve().is_relative_to(root) for path in policy.get("writableRoots", []))):
        raise ValueError("Codex returned a different model, workspace or permission policy")


class Codex:
    def __init__(self, emit):
        self.emit = emit
        self.thread = self.turn = None
        self.policy = None
        self.pending = {}
        self.approvals = {}
        self.serial = 0
        self.seen = set()
        self.opening = Opening()
        self.last_finished = None
        self.message_items = set()
        self.suppressed_items = set()
        self.lock = asyncio.Lock()
        self.status = "Idle"

    def send(self, message):
        self.process.stdin.write(json.dumps(message).encode() + b"\n")

    async def request(self, method, params):
        self.serial += 1
        key = self.serial
        self.pending[key] = asyncio.get_running_loop().create_future()
        try:
            self.send(dict(id=key, method=method, params=params))
            return await asyncio.wait_for(self.pending[key], 45)
        finally:
            self.pending.pop(key, None)

    async def start(self, exe, params):
        self.policy = params
        self.process = await asyncio.create_subprocess_exec(exe, "app-server", "--listen", "stdio://",
            cwd=params["cwd"], stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            limit=8*1024*1024)
        self.closing = False
        self.reader = asyncio.create_task(self.read())
        await self.request("initialize", {"clientInfo":{"name":"agent_dock","title":"Agent Dock","version":"1"}})
        self.send({"method":"initialized"})
        result = await self.request("thread/start", params)
        verify_thread(params, result)
        self.thread = result["thread"]["id"]
        self.emit("session", f'{self.thread} · {result["model"]} · {result["cwd"]} · {result["sandbox"]["type"]}')

    async def close(self):
        self.closing = True
        if hasattr(self, "process") and self.process.returncode is None:
            self.process.stdin.close()
            try:
                await asyncio.wait_for(self.process.wait(), 2)
            except asyncio.TimeoutError:
                self.process.kill()
                await self.process.wait()
        if hasattr(self, "reader"):
            await asyncio.gather(self.reader, return_exceptions=True)

    async def read(self):
        try:
            while line := await self.process.stdout.readline():
                self.receive(json.loads(line))
        finally:
            for future in self.pending.values():
                if not future.done():
                    future.set_exception(ConnectionError("Codex disconnected"))
            if not self.closing and self.thread:
                self.emit("disconnect", "Codex exited during the session")

    def receive(self, msg):
        key, method = msg.get("id"), msg.get("method")
        p = msg.get("params", {})
        if key is not None and not method:
            f = self.pending.get(key)
            if f and not f.done():
                if "error" in msg:
                    f.set_exception(ValueError(msg["error"].get("message", "Codex request failed")))
                else:
                    f.set_result(msg["result"])
            return
        if key is not None:
            if p.get("threadId") == self.thread and method in (
                    "item/commandExecution/requestApproval", "item/fileChange/requestApproval"):
                if not self.allowed_approval(method, p):
                    self.send(dict(id=key, result=dict(decision="decline")))
                    self.emit("task", "Declined approval outside the session scope")
                    return
                self.approvals[str(key)] = key
                self.emit("approval", json.dumps({"id":key, "method":method, "details":p}))
            else:
                self.send(dict(id=key, error=dict(code=-32601, message="Unsupported request")))
            return
        if not self.thread or p.get("threadId") != self.thread:
            return
        if method == "turn/started":
            self.turn = p["turn"]["id"]
            self.task_status("Working")
        elif method == "turn/completed" and p["turn"]["id"] == self.turn:
            self.last_finished = self.turn
            self.turn = None
            self.approvals.clear()
            self.task_status(p["turn"]["status"])
        elif p.get("turnId") == self.turn and self.turn:
            if method == "item/agentMessage/delta":
                self.emit("delta", p["delta"])
                item = p["itemId"]
                self.message_items.add(item)
                if item in self.suppressed_items:
                    return
                for text in self.opening.feed(p["delta"]):
                    self.emit("clause", text)
            elif method == "item/completed" and p["item"]["type"] == "agentMessage":
                if p["item"]["id"] in self.suppressed_items:
                    return
                for text in self.opening.feed("", final=True):
                    self.emit("clause", text)
            elif method in ("item/started", "item/completed"):
                self.emit("item", json.dumps(p["item"], ensure_ascii=False))
                self.task_status(p["item"]["type"] if method.endswith("started") else "Working")
            elif method in ("item/commandExecution/outputDelta", "item/fileChange/outputDelta", "turn/diff/updated"):
                self.emit("output", p.get("delta", p.get("diff", "")))

    def task_status(self, text):
        self.status = text
        self.emit("task", text)

    def allowed_approval(self, method, params):
        if not self.policy or not self.turn or params.get("turnId") != self.turn:
            return False
        root = Path(self.policy["cwd"]).resolve()
        if method == "item/fileChange/requestApproval":
            grant = params.get("grantRoot")
            return (self.policy["sandbox"] == "workspace-write"
                    and (not grant or Path(grant).resolve().is_relative_to(root)))
        cwd = params.get("cwd") or root
        return (self.policy["config"]["features.shell_tool"] and not params.get("networkApprovalContext")
                and Path(cwd).resolve().is_relative_to(root))

    def decide(self, key, accept):
        if key in self.approvals:
            self.send(dict(id=self.approvals.pop(key), result=dict(decision="accept" if accept else "decline")))
            self.task_status("Working")

    async def final(self, uid, text, allow_speech=True):
        async with self.lock:
            if uid in self.seen or not text.strip():
                return
            self.seen.add(uid)
            self.emit("final", text)
            if self.turn and text.lower().strip(" .?!") in ("status", "what is the current status"):
                if allow_speech:
                    self.emit("clause", self.status)
                return
            args = dict(threadId=self.thread, input=[dict(type="text", text=text)], clientUserMessageId=uid)
            self.opening = Opening()
            if not allow_speech:
                self.opening.silence()
            if self.turn:
                self.suppressed_items.update(self.message_items)
                args["expectedTurnId"] = self.turn
                await self.request("turn/steer", args)
            else:
                self.suppressed_items.clear()
                self.message_items.clear()
                result = await self.request("turn/start", args)
                started = result.get("turn", {}).get("id")
                if started and started != self.last_finished:
                    self.turn = started

    async def interrupt(self):
        if self.turn:
            await self.request("turn/interrupt", dict(threadId=self.thread, turnId=self.turn))
