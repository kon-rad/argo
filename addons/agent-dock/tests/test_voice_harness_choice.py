"""Verify each selected harness gets the final utterance and resumes its own thread."""
import asyncio
import json
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "voice"))
from cli_voice import CLIHarness


@pytest.mark.parametrize("runtime", ["claude", "hermes", "zen"])
def test_two_turns_use_selected_executable_and_thread(tmp_path, runtime):
    tool = tmp_path / runtime
    tool.write_text("""#!/usr/bin/env python3
import json,sys
with open('calls','a') as f: print(json.dumps([sys.argv[1:],sys.stdin.read()]),file=f)
print(json.dumps({'type':'result','result':'Good.','text':'Good.','sessionId':'unique','session_id':'unique'}))
""")
    tool.chmod(0o755)
    args = [str(tool)] + (["chat", "-q", "persona"] if runtime == "hermes" else ["chat"] if runtime == "zen" else [])
    events = []
    h = CLIHarness(lambda k,v: events.append((k,v)), runtime, args, os.environ.copy(), tmp_path, runtime)
    async def run():
        await h.final("one","First")
        await h.final("two","Second")
    asyncio.run(run())
    first, second = map(json.loads,(tmp_path / "calls").read_text().splitlines())
    assert first[1].endswith("First") and second[1] == "Second"
    assert second[0][second[0].index("--resume")+1] == "unique"
    assert events.count(("clause","Good.")) == 2
