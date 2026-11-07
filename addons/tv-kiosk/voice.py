#!/usr/bin/env python3
"""One short offline recording, one exact navigation command, one bound browser tab."""
import argparse
import contextlib
import fcntl
import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import sys
import time
import urllib.request
from urllib.parse import urlparse

ENDPOINT = "http://127.0.0.1:9222"
COMMANDS = {"back", "forward", "reload page", "scroll down", "scroll up",
            "enter fullscreen", "leave fullscreen", "next tab", "previous tab", "cancel"}


def announce(message):
    print(message, flush=True)
    if shutil.which("notify-send"):
        try:
            subprocess.run(["notify-send", "-t", "2500", "Browser voice", message],
                           timeout=2, check=False, stderr=subprocess.DEVNULL)
        except (OSError, subprocess.TimeoutExpired):
            pass  # Notification failure must not turn a dispatched action into a retry.


def parse_command(text):
    text = " ".join(text.lower().split())
    return text if text in COMMANDS else None


def validate_websocket(url):
    parsed = urlparse(url)
    if (parsed.scheme != "ws" or parsed.hostname != "127.0.0.1" or
            parsed.port != 9222 or parsed.username or parsed.password):
        raise ValueError("Browser debugging must use ws://127.0.0.1:9222")


def rpc(url, method, params=None):
    import websocket
    validate_websocket(url)
    with contextlib.closing(websocket.create_connection(url, timeout=3, suppress_origin=True,
                                                       http_no_proxy=["127.0.0.1"])) as connection:
        connection.send(json.dumps({"id": 1, "method": method, "params": params or {}}))
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            message = json.loads(connection.recv())
            if message.get("id") == 1:
                if "error" in message:
                    raise RuntimeError(message["error"].get("message", "Browser rejected action"))
                return message.get("result", {})
        raise TimeoutError("Browser response timed out")


def local_json(path):
    # No proxies or redirects: browser observations must stay on this machine.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            raise RuntimeError("Unexpected redirect from local browser")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(ENDPOINT + path, timeout=3) as response:
        return json.load(response)


class Browser:
    def pages(self):
        return [p for p in local_json("/json/list") if p.get("type") == "page"]

    def page_call(self, target, method, params=None):
        page = next((p for p in self.pages() if p["id"] == target), None)
        if page is None:
            raise RuntimeError("Browser tab closed")
        return rpc(page["webSocketDebuggerUrl"], method, params)

    def browser_call(self, method, params=None):
        return rpc(local_json("/json/version")["webSocketDebuggerUrl"], method, params)

    def snapshot(self):
        candidates = []
        for page in self.pages():
            if not page.get("url", "").startswith(("http://", "https://")):
                continue
            state = self.page_call(page["id"], "Runtime.evaluate", {
                "expression": "({visible: document.visibilityState === 'visible', focused: document.hasFocus()})",
                "returnByValue": True,
            }).get("result", {}).get("value", {})
            if state.get("visible"):
                candidates.append((page, state.get("focused")))
        focused = [p for p, focus in candidates if focus]
        if len(focused) == 1:
            page = focused[0]
        elif len(candidates) == 1:
            page = candidates[0][0]
        else:
            raise RuntimeError("Focus one visible HTTP browser tab before recording")
        frame = self.page_call(page["id"], "Page.getFrameTree")["frameTree"]["frame"]
        return {"id": page["id"], "url": frame["url"], "loader": frame["loaderId"]}

    def execute(self, command, pinned):
        if command not in COMMANDS:
            raise ValueError("Unknown command")
        if command == "cancel":
            return
        if self.snapshot() != pinned:
            raise RuntimeError("Browser tab or page changed during capture; command discarded")
        target = pinned["id"]
        if command == "reload page":
            self.page_call(target, "Page.reload")
        elif command in ("back", "forward"):
            history = self.page_call(target, "Page.getNavigationHistory")
            index = history["currentIndex"] + (-1 if command == "back" else 1)
            if 0 <= index < len(history["entries"]):
                self.page_call(target, "Page.navigateToHistoryEntry", {"entryId": history["entries"][index]["id"]})
        elif command in ("scroll down", "scroll up"):
            direction = "" if command == "scroll down" else "-"
            self.page_call(target, "Runtime.evaluate", {
                "expression": f"window.scrollBy(0, {direction}window.innerHeight * 0.7)"})
        elif command in ("enter fullscreen", "leave fullscreen"):
            window = self.browser_call("Browser.getWindowForTarget", {"targetId": target})
            state = "fullscreen" if command == "enter fullscreen" else "normal"
            self.browser_call("Browser.setWindowBounds", {"windowId": window["windowId"],
                                                         "bounds": {"windowState": state}})
        elif command in ("next tab", "previous tab"):
            window = self.browser_call("Browser.getWindowForTarget", {"targetId": target})["windowId"]
            tabs = []
            for page in self.pages():
                info = self.browser_call("Browser.getWindowForTarget", {"targetId": page["id"]})
                if info["windowId"] == window:
                    tabs.append(page["id"])
            # CDP does not expose tab-strip indices. Use a stable session order.
            tabs.sort()
            offset = 1 if command == "next tab" else -1
            selected = tabs[(tabs.index(target) + offset) % len(tabs)]
            self.browser_call("Target.activateTarget", {"targetId": selected})


def recognize(model_path, device, seconds):
    import sounddevice as sd
    from vosk import KaldiRecognizer, Model, SetLogLevel
    if not Path(model_path, "am").is_dir():
        raise ValueError("Use the extracted Vosk model directory (containing am/)")
    SetLogLevel(-1)
    announce("Loading local speech model...")
    model = Model(str(model_path))
    rate = int(sd.query_devices(device, "input")["default_samplerate"])
    recognizer = KaldiRecognizer(model, rate)
    chunks = queue.Queue(maxsize=100)
    failure = []

    def audio(data, frames, timing, status):
        if status:
            failure.append(str(status))
        try:
            chunks.put_nowait(bytes(data))
        except queue.Full:
            failure.append("Audio queue overflow")

    words = []
    with sd.RawInputStream(samplerate=rate, blocksize=4000, device=device,
                           dtype="int16", channels=1, callback=audio):
        announce(f"Listening for {seconds:g} seconds. Say one command.")
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            try:
                chunk = chunks.get(timeout=min(0.25, max(0.001, deadline - time.monotonic())))
            except queue.Empty:
                continue
            if failure:
                raise RuntimeError("Microphone error: " + failure[0])
            if recognizer.AcceptWaveform(chunk):
                words.append(json.loads(recognizer.Result()).get("text", ""))
    if failure:
        raise RuntimeError("Microphone error: " + failure[0])
    while not chunks.empty():
        if recognizer.AcceptWaveform(chunks.get_nowait()):
            words.append(json.loads(recognizer.Result()).get("text", ""))
    words.append(json.loads(recognizer.FinalResult()).get("text", ""))
    return " ".join(words).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["listen", "check", "devices", "commands"])
    parser.add_argument("--model", default=str(Path.home() / ".config/sb-tv/voice-model"))
    parser.add_argument("--device", help="Microphone name substring or numeric ID")
    parser.add_argument("--seconds", type=float, default=5)
    args = parser.parse_args()
    try:
        if args.action == "commands":
            print("\n".join(sorted(COMMANDS)))
            return 0
        if args.action == "devices":
            import sounddevice as sd
            print(sd.query_devices())
            return 0
        if not 1 <= args.seconds <= 10:
            raise ValueError("Recording duration must be between 1 and 10 seconds")
        browser = Browser()
        if args.action == "check":
            pinned = browser.snapshot()
            print("Browser connected; one visible target selected. No action dispatched.")
            return 0
        # A compositor shortcut can invoke this repeatedly; only one recording may run.
        state_dir = Path.home() / ".local/state/sb-tv"
        state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        with (state_dir / "voice.lock").open("w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            pinned = browser.snapshot()
            device = int(args.device) if args.device and args.device.isdigit() else args.device
            text = recognize(args.model, device, args.seconds)
            command = parse_command(text)
            # Keep dictated text out of disk logs; only display the matched command.
            if not command:
                announce("No exact command recognized. Nothing changed.")
                return 2
            browser.execute(command, pinned)
            announce("Cancelled." if command == "cancel" else f"Dispatched: {command}")
            return 0
    except BlockingIOError:
        announce("A voice recording is already running.")
    except KeyboardInterrupt:
        print("Cancelled. No command dispatched.", file=sys.stderr)
    except Exception as error:
        announce(f"Voice unavailable: {error}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
