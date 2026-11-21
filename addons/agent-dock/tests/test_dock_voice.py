"""Synthetic event and PCM replay. No microphone, login, or model is required."""
import array
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "voice"))
from speech import Endpoint, Opening, rating


def pcm(value, millis):
    return array.array("h", [value] * (16 * millis)).tobytes()


def test_endpoint_replay_and_hesitation():
    detector = Endpoint()
    events = []
    for value, millis in [(0, 100), (2200, 800), (0, 300), (1800, 700), (0, 800), (0, 1000)]:
        for _ in range(millis // 100):
            events.extend(kind for kind, _ in detector.feed(pcm(value, 100)))
    assert events.count("onset") == events.count("final") == 1
    assert events.index("partial") < events.index("final")


def test_opening_and_silence():
    o = Opening()
    assert o.feed("One sen") == []
    assert o.feed("tence. Another") == ["One sentence."]
    assert o.feed(" here.\n\n```sh\nls") == ["Another here."]
    assert o.feed("more", final=True) == []
    o = Opening()
    assert o.feed("An unfinished") == []
    o.silence()
    assert o.feed(" sentence. ", final=True) == []


def test_reference_requires_exact_model_and_backend():
    digest = "4b50b6dd862bf6e346929aaf4f5eaacec003bfa3f56462d6c874b41ef2f38795"
    assert rating(digest, "handy", "0.10.1")["error"] == 3.99
    assert rating(digest, "whisper", "0.10.1") is None
    assert rating(digest, "handy", "other") is None
    assert rating("unknown", "handy", "0.10.1") is None


def test_protocol_interruption_isolation_and_duplicate_final():
    import asyncio
    from codex_voice import Codex
    events = []
    calls = []
    async def replay():
        agent = Codex(lambda *event: events.append(event))
        agent.thread = "guide-thread"
        async def request(method, args):
            calls.append((method, args))
            if method == "turn/start":
                agent.receive(dict(method="turn/started", params=dict(threadId=agent.thread, turn={"id":"first"})))
            return {}
        agent.request = request
        await asyncio.gather(agent.final("utterance", "Read my marker"), agent.final("utterance", "Read my marker"))
        def delta(thread, text):
            agent.receive(dict(method="item/agentMessage/delta", params=dict(threadId=thread, turnId="first", itemId="message", delta=text)))
        delta("writer-thread", "Silver. ")
        delta(agent.thread, "Violet. More")
        agent.opening.silence()
        delta(agent.thread, " details. ")
        await agent.final("second", "What is the current status?")
        assert [name for name, _ in calls] == ["turn/start"]
        await agent.final("third", "Use the second note")
        assert calls[-1][0] == "turn/steer" and calls[-1][1]["expectedTurnId"] == "first"
        await agent.interrupt()
        assert calls[-1] == ("turn/interrupt", dict(threadId="guide-thread", turnId="first"))
        assert ("clause", "Violet.") in events
        assert ("delta", " details. ") in events and ("clause", "More details.") not in events
        assert all("Silver" not in item for _, item in events)
    asyncio.run(replay())


def test_tools_are_never_inferred_from_role_or_scoped_shell(tmp_path):
    from codex_voice import parameters
    base = {"runtime":"codex", "model":"fixture", "tools":["Read", "Bash(git status)"], "permission_mode":"acceptEdits"}
    params = parameters(base, "persona", tmp_path)
    assert params["sandbox"] == "read-only"
    assert not params["config"]["features.shell_tool"]
    base.update(tools=["Read", "Edit", "Write", "Bash"])
    params = parameters(base, "persona", tmp_path)
    assert params["sandbox"] == "workspace-write" and params["config"]["features.shell_tool"]
    assert params["approvalPolicy"] == "untrusted"


def test_worktree_fixture(tmp_path):
    import json
    import subprocess
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "voice/bench"))
    from fixture import create
    import runpy
    workspace_root = runpy.run_path(str(Path(__file__).resolve().parents[1] / "voice/worker.py"))["workspace_root"]
    root = create(tmp_path)
    guide = workspace_root(root / "guide")
    assert (guide / "marker.txt").read_text() != (root / "writer/marker.txt").read_text()
    assert subprocess.run([sys.executable, "-m", "unittest"], cwd=guide).returncode == 1
    (guide / "color.py").write_text('color = "violet"\n')
    assert subprocess.run([sys.executable, "-m", "unittest"], cwd=guide).returncode == 0
    assert subprocess.check_output(["git", "diff", "--name-only"], cwd=guide).strip() == b"color.py"
    assert (root / "writer/color.py").read_text() == 'color = "grey"\n'
    assert len(json.loads((root / "vault/.agents/org/org-agents.json").read_text())["agents"]) == 2


def test_approval_requires_terminal_decision_for_current_thread():
    from codex_voice import Codex
    sent, events = [], []
    agent = Codex(lambda *event: events.append(event))
    agent.thread = "session"
    agent.turn = "active"
    agent.policy = {"sandbox":"workspace-write", "cwd":"/fixture"}
    agent.send = sent.append
    args = dict(id=203, method="item/fileChange/requestApproval", params={"threadId":"session","turnId":"active","reason":"edit"})
    agent.receive(args)
    assert not sent and events[-1][0] == "approval"
    agent.decide("202", True)
    assert not sent
    agent.decide("203", False)
    assert sent == [dict(id=203, result={"decision":"decline"})]
    agent.decide("203", True)
    assert len(sent) == 1
    agent.receive(dict(args, id=204, params=dict(args["params"], grantRoot="/")))
    assert sent[-1] == dict(id=204, result={"decision":"decline"})


def test_rejects_expanded_effective_workspace_policy(tmp_path):
    import pytest
    from codex_voice import verify_thread
    params = dict(cwd=str(tmp_path), model="fixture", sandbox="read-only", approvalPolicy="untrusted")
    result = dict(params, sandbox={"type":"readOnly"})
    verify_thread(params, result)
    for changed in ({"type":"dangerFullAccess"}, {"type":"workspaceWrite"}, {"type":"readOnly","networkAccess":True}):
        with pytest.raises(ValueError):
            verify_thread(params, dict(result, sandbox=changed))


def test_worker_drafts_and_barred_late_audio(monkeypatch):
    import asyncio
    import base64
    import runpy
    worker = runpy.run_path(str(Path(__file__).resolve().parents[1] / "voice/worker.py"))
    async def replay():
        session = worker["Session"]({})
        submitted, events = [], []
        session.emit = lambda *args: events.append(args)
        async def decode(_model, _data):
            return "synthetic transcript"
        monkeypatch.setitem(session.recognize.__globals__, "decode_pcm", decode)
        async def final(uid, text, allow_speech=True):
            submitted.append((uid, text))
        session.harness.final = final
        session.harness.turn = "coding"
        def feed(level, ms):
            session.command({"kind":"pcm", "data":base64.b64encode(pcm(level, ms)).decode()})
        feed(2200, 800)
        await asyncio.sleep(0)
        assert events[:2] == [("silence", ""), ("draft", "")]
        assert events[-1] == ("draft", "synthetic transcript")
        assert session.harness.turn == "coding"
        assert session.harness.opening.feed("Late speech. ") == []
        feed(0, 800)
        feed(0, 800)
        await asyncio.gather(*list(session.jobs))
        assert len(submitted) == 1
        feed(2200, 800)
        session.command({"kind":"captureOff"})
        feed(0, 800)
        await asyncio.sleep(0)
        assert len(submitted) == 1
    asyncio.run(replay())


def test_stdio_thread_against_synthetic_server(tmp_path):
    """Use the production pipe reader with a deterministic server in a real linked worktree."""
    import asyncio
    import json
    import subprocess
    import textwrap
    from codex_voice import Codex, parameters
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "voice/bench"))
    from fixture import create
    root = create(tmp_path)
    server = root / "simulated-codex"
    server.write_text("#!" + sys.executable + "\n" + textwrap.dedent("""
        import json, sys, subprocess
        from pathlib import Path
        def emit(**msg):
            print(json.dumps(msg), flush=True)
        for line in sys.stdin:
            msg = json.loads(line)
            method = msg['method']
            if method == 'initialize':
                emit(id=msg['id'], result={'userAgent':'fixture'})
            elif method == 'thread/start':
                args = msg['params']
                assert Path.cwd() == Path(args['cwd'])
                emit(id=msg['id'], result=dict(thread={'id':'fixture-thread'}, model=args['model'],
                     cwd=args['cwd'], approvalPolicy='untrusted', sandbox={'type':'workspaceWrite'}))
            elif method == 'turn/start':
                assert msg['params']['threadId'] == 'fixture-thread'
                context = {'threadId':'fixture-thread', 'turnId':'fixture-turn'}
                emit(method='turn/started', params=dict(threadId='fixture-thread', turn={'id':'fixture-turn'}))
                emit(id=msg['id'], result={'turn':{'id':'fixture-turn'}})
                with Path('calls').open('a') as log:
                    log.write('edit\\n')
                Path('color.py').write_text('color = "violet"\\n')
                result = subprocess.run([sys.executable, '-m', 'unittest'], capture_output=True, text=True)
                emit(method='item/commandExecution/outputDelta', params=dict(context, delta=result.stderr))
                emit(method='item/agentMessage/delta', params=dict(context, itemId='reply', delta='Test passed. '))
                emit(method='turn/completed', params=dict(threadId='fixture-thread',
                     turn={'id':'fixture-turn', 'status':'completed'}))
    """))
    server.chmod(0o755)
    profile = json.loads((root / "vault/.agents/org/org-agents.json").read_text())["agents"]["guide"]
    events = []
    async def run():
        finished = asyncio.Event()
        def emit(kind, text):
            events.append((kind, text))
            if (kind, text) == ("task", "completed"):
                finished.set()
        harness = Codex(emit)
        try:
            await harness.start(str(server), parameters(profile, "synthetic guide", root / "guide"))
            await harness.final("one-final", "Fix the test")
            await asyncio.wait_for(finished.wait(), 5)
            await harness.final("one-final", "Fix the test")
        finally:
            await harness.close()
    asyncio.run(run())
    assert (root / "guide/calls").read_text().splitlines() == ["edit"]
    assert any(kind == "output" and "OK" in value for kind, value in events)
    assert ("clause", "Test passed.") in events
    assert subprocess.run([sys.executable, "-m", "unittest"], cwd=root / "guide").returncode == 0
    assert subprocess.check_output(["git", "diff", "--name-only"], cwd=root / "guide").strip() == b"color.py"


def test_silence_while_final_decode_is_in_flight():
    import asyncio
    import runpy
    worker = runpy.run_path(str(Path(__file__).resolve().parents[1] / "voice/worker.py"))
    async def replay():
        session = worker["Session"]({})
        released = asyncio.Event()
        submissions = []
        async def delayed(_data):
            await released.wait()
            return "an earlier turn"
        async def final(uid, text, allow_speech):
            submissions.append((uid, allow_speech))
        session.recognize = delayed
        session.harness.final = final
        task = asyncio.create_task(session.decode("final", "old", b"", session.speech_generation))
        await asyncio.sleep(0)
        session.silence()
        released.set()
        await task
        assert submissions == [("old", False)]
    asyncio.run(replay())

def test_cached_gguf_uses_selected_file_and_keeps_context(monkeypatch, tmp_path):
    import speech
    import types
    loaded = []
    class Context:
        def __init__(self, path):
            loaded.append(path)
        def session(self):
            import contextlib
            return contextlib.nullcontext(self)
        def run(self, pcm):
            assert len(pcm) == 2
            return types.SimpleNamespace(text="violet")
    monkeypatch.setitem(sys.modules, "transcribe_cpp", types.SimpleNamespace(Model=Context))
    model = tmp_path / "sample.gguf"
    model.touch()
    for _ in range(2):
        assert speech.parakeet_pcm(str(model), b"\x00\x00\x01\x00") == "violet"
    assert loaded == [str(model)]


def test_normal_directory_is_valid_workspace(tmp_path):
    import runpy
    workspace_root = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'voice/worker.py'))['workspace_root']
    assert workspace_root(tmp_path) == tmp_path.resolve()
