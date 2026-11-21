"""Local batch decoders, endpoint detection and opening-paragraph speech."""
import array
import asyncio
import hashlib
import json
import math
import os
import re
import shutil
import tempfile
import wave
from pathlib import Path

HERE = Path(__file__).resolve().parent
REFERENCE = json.loads((HERE / "handy-reference.json").read_text())


def rating(digest, adapter):
    if adapter == "handy" and digest == REFERENCE["sha256"]:
        return REFERENCE
    return None


def candidates(folder=None):
    home = Path.home()
    hub = Path(os.getenv("HF_HUB_CACHE", Path(os.getenv("HF_HOME", home / ".cache/huggingface")) / "hub"))
    paths = list(hub.glob("models--handy-computer--parakeet-unified-en-0.6b-gguf/snapshots/*/" + REFERENCE["file"]))
    paths.extend((home / "Library/Application Support/com.pais.handy/models").rglob(REFERENCE["file"]))
    paths.extend((home / ".cache/whisper-cpp/models").glob("ggml-*.bin"))
    if folder:
        paths.extend(Path(folder).expanduser().rglob("ggml-*.bin"))
    models = []
    seen = set()
    for path in sorted(paths):
        if not path.is_file() or path.resolve() in seen:
            continue
        seen.add(path.resolve())
        handy = path.name == REFERENCE["file"]
        digest = ""
        if handy and path.stat().st_size == REFERENCE["bytes"]:
            sha = hashlib.sha256()
            with path.open("rb") as f:
                for block in iter(lambda: f.read(2**20), b""):
                    sha.update(block)
            digest = sha.hexdigest()
        adapter = "handy" if handy else "whisper"
        if handy and not rating(digest, adapter):
            continue
        models.append(dict(path=str(path), name=path.name, adapter=adapter, reference=rating(digest, adapter)))
    return models


def decoder(model, wav):
    if not Path(model["path"]).is_file():
        raise ValueError("Cached model disappeared")
    if model["adapter"] == "handy":
        return ["/Applications/Handy.app/Contents/MacOS/handy", "--transcribe-file", str(wav),
                "--model", REFERENCE["id"], "--json"]
    exe = shutil.which("whisper-cli") or "/opt/homebrew/bin/whisper-cli"
    return [exe, "-ng", "-np", "-nt", "-m", model["path"], "-f", str(wav)]


async def transcribe(model, wav):
    process = await asyncio.create_subprocess_exec(*decoder(model, wav), stdout=asyncio.subprocess.PIPE,
                                                    stderr=asyncio.subprocess.PIPE)
    try:
        out, err = await asyncio.wait_for(process.communicate(), 90)
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()
    if process.returncode:
        raise ValueError(f'{model["adapter"]} exited {process.returncode}: {err.decode(errors="replace")[-300:]}')
    text = out.decode().strip()
    if model["adapter"] == "handy":
        text = json.loads(text)["text"]
    return text.strip()


async def decode_pcm(model, data):
    with tempfile.TemporaryDirectory(prefix="dock-audio-") as directory:
        wav = Path(directory) / "input.wav"
        with wave.open(str(wav), "wb") as f:
            f.setparams((1, 2, 16000, 0, "NONE", ""))
            f.writeframes(data)
        return await transcribe(model, wav)


async def probe(model):
    text = await transcribe(model, HERE / "bench/greeting.wav")
    if "violet" not in text.lower():
        raise ValueError(f"Sample expected violet, heard {text!r}")
    return text


class Endpoint:
    """16 kHz mono PCM. End on 700 ms quiet or 25 s total, bounded draft snapshots."""
    def __init__(self):
        self.audio = bytearray()
        self.quiet = 0
        self.next_preview = 24000

    def feed(self, data):
        samples = array.array("h", data)
        if not samples:
            return []
        loud = math.sqrt(sum(x*x for x in samples) / len(samples)) >= 400
        events = []
        if not self.audio:
            if not loud:
                return []
            events.append(("onset", None))
        self.audio.extend(data)
        self.quiet = 0 if loud else self.quiet + len(data)
        if self.quiet >= 22400 or len(self.audio) >= 800000:
            events.append(("final", bytes(self.audio)))
            self.__init__()
        elif len(self.audio) >= self.next_preview:
            self.next_preview = len(self.audio) + 32000
            events.append(("partial", bytes(self.audio)))
        return events


class Opening:
    def __init__(self):
        self.buffer = ""
        self.done = False

    def silence(self):
        self.done = True
        self.buffer = ""

    def feed(self, delta, final=False):
        if self.done:
            return []
        self.buffer += delta
        boundary = re.search(r"\n\s*\n|`|(?m:^[+#>|-])", self.buffer)
        if boundary:
            self.buffer = self.buffer[:boundary.start()]
            final = True
        sentences = []
        while match := re.search(r"[.!?](?=\s)", self.buffer):
            sentences.append(self.buffer[:match.end()].strip())
            self.buffer = self.buffer[match.end():].lstrip(" ")
        if final:
            if self.buffer.strip():
                sentences.append(self.buffer.strip())
            self.silence()
        return sentences
