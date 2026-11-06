"""Opt-in probes against a real Linux Docker daemon and running internal gateway."""
import hashlib
import json
import os
import platform
import subprocess
import time
import uuid
from pathlib import Path

import pytest

from gateway import issue_capability


pytestmark = pytest.mark.skipif(
    os.environ.get("DESK_WORKER_CONTAINER_TESTS") != "1" or platform.system() != "Linux",
    reason="requires explicit opt-in on the dedicated Linux VM",
)


def docker(*args, timeout=30):
    return subprocess.check_output(["docker", *args], text=True, timeout=timeout).strip()


@pytest.fixture
def job_network():
    gateway_container = os.environ.get("DESK_WORKER_GATEWAY_CONTAINER", "desk-gateway")
    network = "desk-test-" + uuid.uuid4().hex[:12]
    docker("network", "create", "--internal", network)
    docker("network", "connect", "--alias", "desk-gateway", network, gateway_container)
    try:
        yield network
    finally:
        subprocess.run(["docker", "network", "disconnect", network, gateway_container], capture_output=True, check=False)
        subprocess.run(["docker", "network", "rm", network], capture_output=True, check=False)


def test_worker_container_denies_forbidden_access_and_completes_research(tmp_path, job_network):
    image = os.environ.get("DESK_WORKER_IMAGE", "desk-worker:dev")
    network = job_network
    signing_key = os.environ["DESK_SIGNING_KEY"]
    assert len(signing_key) >= 32
    inspected = json.loads(docker("network", "inspect", network))[0]
    assert inspected["Internal"] is True
    docker("image", "inspect", image)

    # Probe real container filesystem and network behavior with no mounts or token.
    name = "desk-deny-" + uuid.uuid4().hex[:10]
    probe = r'''import os, urllib.error, urllib.request
assert "DESK_CAPABILITY" not in os.environ
assert not os.path.exists("/run/secrets") or not os.listdir("/run/secrets")
try:
    open("/etc/shadow").read()
except PermissionError:
    pass
else:
    raise AssertionError("shadow readable")
for url in ("http://1.1.1.1/", "http://169.254.169.254/latest/meta-data/", "http://10.0.0.1/", "http://172.16.0.1/", "http://192.168.1.1/"):  # public-ok
    try:
        urllib.request.urlopen(url, timeout=2)
    except (urllib.error.URLError, TimeoutError, OSError):
        continue
    raise AssertionError("raw/private egress succeeded: " + url)
print("container denial probes passed")'''
    try:
        output = docker("run", "--name", name, "--network", network, "--read-only", "--cap-drop=ALL",
            "--security-opt=no-new-privileges", "--pids-limit=32", "--memory=128m", "--user=10001:10001",
            "--entrypoint", "python", image, "-I", "-c", probe)
        mounts = json.loads(docker("inspect", "--format", "{{json .Mounts}}", name))
        assert mounts == []
        assert "container denial probes passed" in output
    finally:
        subprocess.run(["docker", "rm", "-f", name], capture_output=True, check=False)

    # Run the unmodified worker in a real container against the fixture corpus/gateway.
    corpus = Path(__file__).parents[1] / "fixtures" / "corpus"
    refs = ["doc-a", "doc-b", "doc-c"]
    manifest = {ref: hashlib.sha256((corpus / f"{ref}.md").read_bytes()).hexdigest() for ref in refs}
    corpus_digest = hashlib.sha256(json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    now = int(time.time())
    spec = {"version": "desk/v1", "jobId": "container-test", "attemptId": uuid.uuid4().hex,
        "acceptanceDigest": "a" * 64, "skillVersion": "v1", "corpusDigest": corpus_digest,
        "inputRefs": refs, "planDigest": "b" * 64,
        "limits": {"tools": ["search"], "model": "test-model", "maxCostAtomic": "100", "costAsset": "USD", "maxRuntimeSeconds": 60, "maxOutputTokens": 100},
        "audience": "gateway", "expiresAt": now + 120}
    spec_bytes = json.dumps(spec, sort_keys=True, separators=(",", ":")).encode()
    spec_dir = tmp_path / "spec"
    spec_dir.mkdir()
    os.chmod(spec_dir, 0o755)
    (spec_dir / "spec.json").write_bytes(spec_bytes)
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    os.chmod(scratch, 0o777)
    claims = {**spec, "specDigest": hashlib.sha256(spec_bytes).hexdigest(), "model": "test-model",
        "tools": ["search"], "maxCostAtomic": "100", "costAsset": "USD", "maxOutputTokens": 100}
    capability = issue_capability(claims, signing_key)
    result = docker("run", "--rm", "--network", network, "--read-only", "--cap-drop=ALL",
        "--security-opt=no-new-privileges", "--pids-limit=32", "--memory=128m", "--user=10001:10001",
        "--mount", f"type=bind,src={corpus.resolve()},dst=/corpus,readonly",
        "--mount", f"type=bind,src={spec_dir.resolve()},dst=/spec,readonly",
        "--mount", f"type=bind,src={scratch.resolve()},dst=/scratch",
        "--env", "DESK_CAPABILITY=" + capability, "--env", "DESK_GATEWAY=http://desk-gateway:8787",
        image, timeout=90)
    metadata = json.loads(result.splitlines()[-1])
    artifact = (scratch / "result.md").read_bytes()
    assert metadata["artifactHash"] == hashlib.sha256(artifact).hexdigest()
    assert metadata["mediaType"] == "text/markdown"
    assert all(f"Source: `{ref}`".encode() in artifact for ref in refs)
