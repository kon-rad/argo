"""Opt-in real CDP smoke test: TV_VOICE_TEST_CHROME=/path/to/chrome pytest this_file."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

SPEC = importlib.util.spec_from_file_location("browser_voice", Path(__file__).parents[1] / "voice.py")
voice = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(voice)


def test_real_browser_scroll_fullscreen_navigation_and_stale_page(tmp_path):
    chrome = os.environ.get("TV_VOICE_TEST_CHROME")
    if not chrome:
        pytest.skip("set TV_VOICE_TEST_CHROME to opt into an isolated real browser")
    try:
        voice.local_json("/json/version")
    except Exception:
        pass
    else:
        pytest.skip("port 9222 is in use; never attach to a pre-existing browser in a test")

    class Page(BaseHTTPRequestHandler):
        def do_GET(self):
            body = b'<html><body style="height:5000px"><h1>Voice test</h1></body></html>'
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Page)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_port}/one"
    with (tmp_path / "chrome.log").open("w") as log:
        process = subprocess.Popen([chrome, "--headless=new", "--no-first-run", "--password-store=basic",
                                    f"--user-data-dir={tmp_path / 'profile'}", "--remote-debugging-port=9222",
                                    "--remote-debugging-address=127.0.0.1", url], stdout=log, stderr=log)
        try:
            browser = voice.Browser()
            for _ in range(100):
                try:
                    pinned = browser.snapshot()
                    break
                except Exception:
                    time.sleep(0.1)
            else:
                pytest.fail("Chrome never became available")
            browser.execute("scroll down", pinned)
            result = browser.page_call(pinned["id"], "Runtime.evaluate", {"expression": "window.scrollY"})
            assert result["result"]["value"] > 0
            browser.execute("enter fullscreen", pinned)
            window = browser.browser_call("Browser.getWindowForTarget", {"targetId": pinned["id"]})
            assert window["bounds"]["windowState"] == "fullscreen"
            browser.execute("leave fullscreen", pinned)
            window = browser.browser_call("Browser.getWindowForTarget", {"targetId": pinned["id"]})
            assert window["bounds"]["windowState"] == "normal"
            browser.page_call(pinned["id"], "Page.navigate", {"url": url.replace("/one", "/two")})
            for _ in range(50):
                if browser.snapshot()["url"].endswith("/two"):
                    break
                time.sleep(0.05)
            with pytest.raises(RuntimeError, match="changed"):
                browser.execute("reload page", pinned)
            browser.execute("back", browser.snapshot())
            for _ in range(50):
                if browser.snapshot()["url"].endswith("/one"):
                    break
                time.sleep(0.05)
            assert browser.snapshot()["url"].endswith("/one")
            second = browser.browser_call("Target.createTarget", {"url": url.replace("/one", "/three")})["targetId"]
            for _ in range(50):
                try:
                    if browser.snapshot()["id"] == second:
                        break
                except RuntimeError:
                    pass
                time.sleep(0.05)
            pinned = browser.snapshot()
            assert pinned["id"] == second
            browser.execute("next tab", pinned)
            for _ in range(50):
                if browser.snapshot()["id"] != second:
                    break
                time.sleep(0.05)
            assert browser.snapshot()["id"] != second
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            server.shutdown()
            server.server_close()
