"""Offline, session-resident Kokoro renderer. Each request returns one tagged WAV."""
import base64
import contextlib
import io
import json
import os
from pathlib import Path
import sys

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"


def main():
    import numpy as np
    import soundfile as sf
    from mlx_audio.tts.utils import load_model

    cache = Path(os.getenv("HF_HUB_CACHE", Path(os.getenv("HF_HOME", Path.home() / ".cache/huggingface")) / "hub"))
    roots = cache.glob("models--mlx-community--Kokoro-82M-bf16/snapshots/*")
    root = next((p for p in sorted(roots) if (p / "voices/af_bella.safetensors").is_file()
                 and (p / "kokoro-v1_0.safetensors").is_file()), None)
    if root is None:
        raise ValueError("Cached MLX Kokoro-82M bf16 and af_bella are required")
    with contextlib.redirect_stdout(sys.stderr):
        model = load_model("mlx-community/Kokoro-82M-bf16")
    for line in sys.stdin:
        req = json.loads(line)
        with contextlib.redirect_stdout(sys.stderr):
            audio = [np.asarray(r.audio).reshape(-1) for r in model.generate(
                text=req["text"], voice=str(root / "voices/af_bella.safetensors"), lang_code="a")]
            buf = io.BytesIO()
            sf.write(buf, np.concatenate(audio), model.sample_rate, format="WAV")
        req["wav"] = base64.b64encode(buf.getvalue()).decode("ascii")
        print(json.dumps(req), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"error": str(exc)}), flush=True)
        sys.exit(1)
