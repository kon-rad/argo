"""Local batch decoders, endpoint detection and opening-paragraph speech."""
import array
import asyncio
import functools
import threading
import hashlib
import json
import math
import os
import plistlib
import re
import shutil
import sys
import tempfile
import wave
from pathlib import Path

HERE = Path(__file__).resolve().parent
REFERENCE = json.loads((HERE / "handy-reference.json").read_text())


def rating(digest, adapter, version):
    if adapter == "handy" and f"Handy {version}" == REFERENCE["release"] and digest == REFERENCE["sha256"]:
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
    try:
        with Path("/Applications/Handy.app/Contents/Info.plist").open("rb") as f:
            handy_version = plistlib.load(f).get("CFBundleShortVersionString")
    except (OSError, plistlib.InvalidFileException):
        handy_version = None
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
        if handy and digest != REFERENCE["sha256"]:
            continue
        models.append(dict(path=str(path), name=path.name, adapter=adapter, reference=rating(digest, adapter, handy_version)))
    snapshots = list(hub.glob("models--Systran--faster-whisper-*/snapshots/*"))
    if folder:
        snapshots.extend(p.parent for p in Path(folder).expanduser().rglob("model.bin"))
    for path in sorted(snapshots):
        if path.resolve() in seen or not all((path / name).is_file() for name in
                ("config.json", "model.bin", "tokenizer.json", "vocabulary.txt")):
            continue
        seen.add(path.resolve())
        name = path.parent.parent.name.split("--")[-1] if path.parent.name == "snapshots" else path.name
        models.append(dict(path=str(path), name=name, adapter="faster-whisper", reference=None))
    return models


# One worker process owns one selected model. Serialize partial and final inference
# because cancelling an asyncio caller does not stop a native inference in flight.
_inference_lock = threading.Lock()


@functools.lru_cache(maxsize=1)
def _parakeet(path):
    source = Path.home() / "Library/Application Support/AgentDockVoice/transcribe.cpp"
    if source.is_dir():
        sys.path.insert(0, str(source / "bindings/python/src"))
    try:
        from transcribe_cpp import Model
        return Model(path)
    except (ImportError, OSError, RuntimeError) as error:
        raise ValueError(f"Install the Agent Dock Parakeet runtime (see the voice guide): {error}") from error


def parakeet_pcm(path, data):
    samples = array.array("h")
    samples.frombytes(data)
    pcm = array.array("f", (sample / 32768.0 for sample in samples))
    with _inference_lock, _parakeet(path).session() as session:
        return session.run(pcm).text.strip()


def decoder(model, wav):
    if model["adapter"] == "faster-whisper":
        return [sys.executable, str(Path(__file__).resolve()), model["path"], str(wav)]
    if not Path(model["path"]).is_file():
        raise ValueError("Cached model disappeared")
    exe = shutil.which("whisper-cli") or "/opt/homebrew/bin/whisper-cli"
    return [exe, "-ng", "-np", "-nt", "-m", model["path"], "-f", str(wav)]


async def transcribe(model, wav):
    if model["adapter"] == "handy":
        with wave.open(str(wav), "rb") as source:
            if (source.getnchannels(), source.getsampwidth(), source.getframerate()) != (1, 2, 16000):
                raise ValueError("Parakeet requires mono 16 kHz PCM16")
            return await decode_pcm(model, source.readframes(source.getnframes()))
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
    return text.strip()


async def decode_pcm(model, data):
    if model["adapter"] == "handy":
        return await asyncio.to_thread(parakeet_pcm, model["path"], data)
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


if __name__ == "__main__":
    # A cancellable child owns the native CTranslate2 inference. Local files only.
    os.environ["HF_HUB_OFFLINE"] = "1"
    from faster_whisper import WhisperModel
    directory = Path(sys.argv[1]).resolve(strict=True)
    if not all((directory / name).is_file() for name in ("model.bin", "config.json", "tokenizer.json", "vocabulary.txt")):
        sys.exit("Incomplete CTranslate2 snapshot")
    recognizer = WhisperModel(str(directory), device="cpu", compute_type="int8", local_files_only=True)
    segments, _ = recognizer.transcribe(sys.argv[2], language="en", beam_size=1)
    print(" ".join(segment.text.strip() for segment in segments))
