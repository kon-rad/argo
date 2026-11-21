#!/usr/bin/env python3
"""Private stdio media channel to Dock, owner-only Unix socket to Ghostty."""
import argparse
import asyncio
import base64
import contextlib
import json
import platform
from pathlib import Path
import runpy
import socket
import subprocess
import sys
import tempfile
import threading
import uuid
import wave

sys.dont_write_bytecode = True

from codex_voice import Codex, parameters
from speech import Endpoint, candidates, decode_pcm, probe

HERE = Path(__file__).resolve().parent
cli = HERE.parent / "agent-dock"
dock = runpy.run_path(str(cli if cli.is_file() else HERE.parent / "bin/agent-dock"))


def workspace_root(workspace):
    path = Path(workspace).resolve(strict=True)
    root = subprocess.check_output(["git", "-C", str(path), "rev-parse", "--show-toplevel"], text=True).strip()
    if Path(root).resolve() != path or not (path / ".git").is_file():
        raise ValueError("Choose the root of a linked Git worktree")
    return path


class Session:
    def __init__(self, model):
        self.model = model
        self.terminal = None
        self.epoch = 0
        self.speech_generation = 0
        self.utterance_generation = 0
        self.harness = Codex(self.emit)
        self.audio = Endpoint()
        self.uid = None
        self.preview = None
        self.jobs = set()
        self.final_lock = asyncio.Lock()
        self.stopped = asyncio.Event()

    def emit(self, kind, text):
        line = json.dumps(dict(kind=kind, text=text, epoch=self.epoch))
        print(line, flush=True)
        if self.terminal:
            self.terminal.write((line + "\n").encode())
        if kind == "disconnect":
            self.stopped.set()

    def job(self, coroutine):
        task = asyncio.create_task(coroutine)
        self.jobs.add(task)
        def finish(done):
            self.jobs.discard(done)
            if not done.cancelled() and done.exception():
                self.emit("error", str(done.exception()))
        task.add_done_callback(finish)
        return task

    def reset_capture(self):
        self.uid = None
        self.audio = Endpoint()
        if self.preview:
            self.preview.cancel()
        for task in tuple(self.jobs):
            if task.get_name() == "decode-final":
                task.cancel()

    def silence(self):
        self.speech_generation += 1
        self.harness.opening.silence()
        self.emit("silence", "")

    async def decode(self, kind, uid, data, generation):
        if kind == "partial":
            text = await self.recognize(data)
            if uid == self.uid:
                self.emit("draft", text)
            return
        async with self.final_lock:
            text = await self.recognize(data)
            await self.harness.final(uid, text, allow_speech=generation == self.speech_generation)

    async def recognize(self, data):
        try:
            return await decode_pcm(self.model, data)
        except (ValueError, OSError, KeyError, asyncio.TimeoutError) as error:
            self.emit("disconnect", f"Recognition stopped: {error}")
            raise

    def command(self, msg):
        kind = msg["kind"]
        if kind == "pcm":
            for event, data in self.audio.feed(base64.b64decode(msg["data"], validate=True)):
                if event == "onset":
                    self.uid = str(uuid.uuid4())
                    self.silence()
                    self.utterance_generation = self.speech_generation
                    self.emit("draft", "")
                elif event == "partial" and (not self.preview or self.preview.done()):
                    self.preview = self.job(self.decode(event, self.uid, data, self.utterance_generation))
                elif event == "final":
                    self.emit("endpoint", "")
                    if self.preview:
                        self.preview.cancel()
                    self.job(self.decode(event, self.uid, data, self.utterance_generation)).set_name("decode-final")
                    self.uid = None
        elif kind == "captureOff":
            self.reset_capture()
        elif kind == "silence":
            self.epoch = msg["epoch"]
            self.silence()
        elif kind == "stop":
            self.job(self.harness.interrupt())
        elif kind == "timing":
            self.emit("timing", f'{msg["seconds"]:.6f}s {msg["stage"]}')
        elif kind == "end":
            self.stopped.set()

    async def attach(self, reader, writer):
        if self.terminal:
            writer.close()
            return
        self.terminal = writer
        self.attached.set()
        try:
            while line := await reader.readline():
                words = line.decode().strip().split()
                if len(words) == 2 and words[0] in ("allow", "deny"):
                    self.harness.decide(words[1], words[0] == "allow")
                elif words == ["stop"]:
                    await self.harness.interrupt()
        finally:
            self.terminal = None
            writer.close()
            self.emit("disconnect", "Ghostty closed")

    async def inputs(self):
        reader = asyncio.StreamReader()
        transport, _ = await asyncio.get_running_loop().connect_read_pipe(
            lambda: asyncio.StreamReaderProtocol(reader), sys.stdin.buffer)
        try:
            while line := await reader.readline():
                self.command(json.loads(line))
        finally:
            transport.close()
            self.stopped.set()

    async def run(self, exe, params):
        self.attached = asyncio.Event()
        with tempfile.TemporaryDirectory(dir="/tmp", prefix="dock-voice-") as d:
            path = str(Path(d) / "terminal")
            server = await asyncio.start_unix_server(self.attach, path)
            inputs = asyncio.create_task(self.inputs())
            try:
                async with server:
                    async def setup():
                        await probe(self.model)
                        argv = dock["terminal_command"]("ghostty", "Agent Dock Voice",
                            [sys.executable, str(Path(__file__).resolve()), "terminal", path])
                        launch = await asyncio.create_subprocess_exec(*argv, stdout=subprocess.DEVNULL)
                        if await launch.wait():
                            raise ValueError("Ghostty did not open")
                        await asyncio.wait_for(self.attached.wait(), 20)
                        await self.harness.start(exe, params)
                        self.emit("ready", "Listening")
                    setup_task = asyncio.create_task(setup())
                    stop_task = asyncio.create_task(self.stopped.wait())
                    try:
                        await asyncio.wait([setup_task, stop_task], return_when=asyncio.FIRST_COMPLETED)
                        if not stop_task.done():
                            await setup_task
                            await stop_task
                    finally:
                        setup_task.cancel()
                        stop_task.cancel()
                        await asyncio.gather(setup_task, stop_task, return_exceptions=True)
            finally:
                inputs.cancel()
                tasks = list(self.jobs) + [inputs]
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
                await self.harness.close()


def terminal(path):
    with socket.socket(socket.AF_UNIX) as sock:
        sock.connect(path)
        print("Voice session. Type allow ID or deny ID for an approval, or stop to interrupt.")
        def commands():
            for line in sys.stdin:
                with contextlib.suppress(OSError):
                    sock.sendall(line.encode())
        threading.Thread(target=commands, daemon=True).start()
        for line in sock.makefile():
            event = json.loads(line)
            kind = event["kind"]
            value = event["text"]
            safe = "".join(c for c in value if c.isprintable() or c in "\n\t")
            if kind == "draft":
                print("\r\033[2K" + safe.replace("\n", " "), end="", flush=True)
            elif kind == "delta":
                print(safe, end="", flush=True)
            elif kind not in ("clause", "silence"):
                print(f"\n[{kind}] {safe}", flush=True)


async def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="action", required=True)
    sub.add_parser("terminal").add_argument("socket")
    for name in ("models", "doctor", "session"):
        cmd = sub.add_parser(name)
        cmd.add_argument("--folder")
        if name != "models":
            cmd.add_argument("--model", required=True)
            cmd.add_argument("--workspace", required=True)
            cmd.add_argument("--vault", required=True)
            cmd.add_argument("--agent", required=True)
    args = p.parse_args()
    if args.action == "terminal":
        terminal(args.socket)
        return
    models = candidates(args.folder)
    if args.action == "models":
        print(json.dumps(models))
        return
    model = next((m for m in models if m["path"] == args.model), None)
    if not model:
        raise ValueError("Choose an available cached recognition model")
    workspace = workspace_root(args.workspace)
    vault = dock["find_vault"](args.vault)
    settings = dock["load_settings"](vault)
    info = dock["agent_info"](vault, settings, args.agent)
    params = parameters(info, dock["persona_text"](vault, info), workspace)
    exe = dock["resolve_command"](settings["runtimes"]["codex"]["command"])
    if not exe:
        raise ValueError("Codex is missing")
    if args.action == "doctor":
        errors = []
        print("Host:", platform.machine(), platform.mac_ver()[0], flush=True)
        if not Path("/Applications/Ghostty.app").is_dir():
            errors.append("Ghostty.app missing from /Applications")
        try:
            print("Decoder:", await probe(model), flush=True)
        except (OSError, ValueError, KeyError, asyncio.TimeoutError) as error:
            errors.append(f"Decoder: {error}")
        with tempfile.TemporaryDirectory() as scratch:
            wav = Path(scratch) / "voice.wav"
            try:
                speech = subprocess.run(["say", "-o", str(wav), "--file-format=WAVE", "--data-format=LEI16@16000",
                                         "The sample color is violet."], timeout=15)
                with wave.open(str(wav), "rb") as f:
                    frames = f.getnframes()
                if speech.returncode or frames == 0:
                    raise ValueError("no synthesized audio")
                print("System voice:", frames, "frames", flush=True)
            except (OSError, EOFError, wave.Error, ValueError, subprocess.TimeoutExpired) as error:
                errors.append(f"System voice: {error}")
        status = await asyncio.create_subprocess_exec(exe, "login", "status")
        if await status.wait():
            errors.append("Codex login unavailable")
        else:
            harness = Codex(lambda kind, text: print(kind, text))
            try:
                await harness.start(exe, params)
            finally:
                await harness.close()
        if errors:
            raise ValueError("; ".join(errors))
        return
    await Session(model).run(exe, params)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except (OSError, ValueError, RuntimeError, KeyError, asyncio.TimeoutError) as error:
        print(json.dumps(dict(kind="error", text=str(error) or type(error).__name__)), flush=True)
        sys.exit(1)
