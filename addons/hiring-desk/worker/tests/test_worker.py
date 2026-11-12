import importlib.util
import hashlib
import json
from pathlib import Path


WORKER = Path(__file__).parents[1] / "worker.py"
spec = importlib.util.spec_from_file_location("desk_worker", WORKER)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


def test_refs_reject_paths():
    assert worker.safe_ref("doc-1")
    assert not worker.safe_ref("../secrets")
    assert not worker.safe_ref("/etc/passwd")
    assert not worker.safe_ref("x" * 200)


def test_three_document_research_writes_cited_hash_bound_artifact(tmp_path, monkeypatch):
    refs = ["a", "b", "c"]
    corpus = tmp_path / "corpus"
    corpus.mkdir()
    manifest = {}
    for ref in refs:
        content = f"# {ref}\n\nSample evidence for {ref}.\n"
        (corpus / f"{ref}.md").write_text(content, encoding="utf-8")
        manifest[ref] = hashlib.sha256(content.encode()).hexdigest()
    digest = hashlib.sha256(json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    spec_path = tmp_path / "spec.json"
    spec_path.write_text(json.dumps({"inputRefs": refs, "corpusDigest": digest}), encoding="utf-8")
    output = tmp_path / "result.md"
    monkeypatch.setattr(worker, "CORPUS", str(corpus))
    monkeypatch.setattr(worker, "SPEC", str(spec_path))
    monkeypatch.setattr(worker, "OUT", str(output))
    monkeypatch.setattr(worker, "gateway", lambda *_args: {})
    monkeypatch.setenv("DESK_CAPABILITY", "test-capability")
    worker.main()
    artifact = output.read_bytes()
    assert all(f"Source: `{ref}`".encode() in artifact for ref in refs)
    assert hashlib.sha256(artifact).hexdigest()
