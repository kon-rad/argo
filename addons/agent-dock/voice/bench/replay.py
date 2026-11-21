#!/usr/bin/env python3
"""Replay versioned synthetic WAVs, optionally scoring a real installed ASR adapter."""
import argparse
import asyncio
import collections
import json
import math
import random
import statistics
import sys
import time
import wave
from pathlib import Path

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from speech import Endpoint, candidates, decode_pcm


def segmented(wav):
    segmenter = Endpoint()
    with wave.open(str(wav), "rb") as f:
        assert (f.getnchannels(), f.getframerate(), f.getsampwidth()) == (1, 16000, 2)
        raw = f.readframes(f.getnframes()) + bytes(32000)
    events = []
    for i in range(0, len(raw), 1600):
        events.extend(segmenter.feed(raw[i:i+1600]))
    return events


def words(text):
    import re
    return re.findall(r"\w+", text.lower())


def distance(a, b):
    row = list(range(len(b) + 1))
    for i, word in enumerate(a, 1):
        nxt = [i]
        for j, other in enumerate(b, 1):
            nxt.append(min(nxt[-1]+1, row[j]+1, row[j-1]+(word != other)))
        row = nxt
    return row[-1]


async def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--model", help="path from worker.py models for local ASR scoring")
    p.add_argument("--folder")
    p.add_argument("--repeats", type=int, default=5)
    args = p.parse_args()
    rows = json.loads((HERE / "scenarios.json").read_text()) * args.repeats
    random.Random(4107).shuffle(rows)
    model = next((m for m in candidates(args.folder) if m["path"] == args.model), None) if args.model else None
    if args.model and not model:
        p.error("model was not discovered")
    counts = collections.Counter()
    elapsed = []
    for row in rows:
        events = segmented(HERE / (row["id"] + ".wav"))
        finals = [data for kind, data in events if kind == "final"]
        if len(finals) != 1:
            counts["endpoint failures"] += 1
            continue
        counts["finals"] += 1
        if model:
            start = time.monotonic()
            try:
                transcript = await decode_pcm(model, finals[0])
                expected = words(row["text"])
                counts["reference words"] += len(expected)
                counts["word errors"] += distance(expected, words(transcript))
                elapsed.append(time.monotonic() - start)
            except (RuntimeError, ValueError, OSError, asyncio.TimeoutError) as e:
                print(row["id"], str(e), file=sys.stderr)
                counts["decoder failures"] += 1
    report = dict(scenarios=len(rows), **counts)
    if elapsed:
        report.update(decoder_median_s=round(statistics.median(elapsed), 3),
                      decoder_p95_s=round(sorted(elapsed)[math.ceil(.95*len(elapsed))-1], 3))
    print(json.dumps(report))
    return int(counts["finals"] != len(rows) or bool(counts["decoder failures"]))


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
