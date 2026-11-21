"""Voice turns for locally installed CLIs with explicit session continuation."""
import asyncio
import json
from speech import Opening


class CLIHarness:
    def __init__(self, emit, runtime, argv, env, cwd, label):
        self.emit, self.runtime, self.argv = emit, runtime, argv
        self.env, self.cwd, self.label = env, cwd, label
        self.session = self.child = None
        self.opening = Opening()
        self.seen = set()

    async def start(self, exe, params):
        self.emit("session", self.label)

    def command(self, text):
        args = self.argv.copy()
        if self.runtime == "claude":
            args += ["--print", "--output-format", "json"]
            if self.session:
                args += ["--resume", self.session]
            return args, text
        if self.runtime == "hermes":
            args, persona = args[:-2], args[-1]
            if self.session:
                args += ["--resume", self.session]
            else:
                text = persona + "\n\n" + text
            return args + ["--oneshot", "--format", "stream-json", "--query-file", "/dev/stdin"], text
        args[1] = "run"
        if self.session:
            args += ["--resume", self.session]
        return args + ["--json", "--file", "/dev/stdin"], text

    async def final(self, uid, text, allow_speech=True):
        if uid in self.seen or not text.strip():
            return
        self.seen.add(uid)
        self.opening = Opening()
        if not allow_speech:
            self.opening.silence()
        self.emit("final", text)
        args, prompt = self.command(text)
        self.emit("task", self.runtime + " working")
        self.child = await asyncio.create_subprocess_exec(*args, env=self.env, cwd=self.cwd,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE)
        try:
            out, _ = await self.child.communicate(prompt.encode())
            if self.child.returncode:
                raise ValueError(f"{self.runtime} exited with status {self.child.returncode}. Check the harness login and model.")
            if self.runtime == "hermes":
                events = (json.loads(s) for s in out.splitlines() if s.strip())
                result = next((e for e in events if e.get("type") == "result"), {})
            else:
                result = json.loads(out)
            if result.get("is_error") or result.get("exit_code") or result.get("error"):
                raise ValueError(f"{self.runtime} reported a turn error")
            reply = result.get("result") if self.runtime == "claude" else result.get("text")
            self.session = result.get("session_id") or result.get("sessionId")
            if not isinstance(reply, str) or not self.session:
                raise ValueError(f"{self.runtime} returned no usable reply or session ID")
            self.emit("delta", reply)
            for sentence in self.opening.feed(reply, final=True):
                self.emit("clause", sentence)
        finally:
            if self.child and self.child.returncode is None:
                self.child.terminate()
                await self.child.wait()
            self.child = None
            self.emit("task", "Idle")

    def decide(self, key, accept):
        self.emit("task", "Terminal approvals are available for managed Codex sessions.")

    async def interrupt(self):
        if self.child and self.child.returncode is None:
            self.child.terminate()

    async def close(self):
        await self.interrupt()
