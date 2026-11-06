"""Deterministic, non-shell worker for the synthetic three-document research task."""
import hashlib
import json
import os
import re
import urllib.error
import urllib.request

GATEWAY = os.environ.get("DESK_GATEWAY", "http://desk-gateway:8787")
CORPUS = os.environ.get("DESK_CORPUS", "/corpus")
SPEC = os.environ.get("DESK_SPEC_PATH", "/spec/spec.json")
OUT = os.environ.get("DESK_RESULT_PATH", "/scratch/result.md")


def safe_ref(value):
    return isinstance(value, str) and re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}", value) and ".." not in value


def gateway(tool, payload, capability):
    body = json.dumps(payload).encode()
    with open(SPEC, "rb") as stream:
        spec_digest = hashlib.sha256(stream.read()).hexdigest()
    request = urllib.request.Request(f"{GATEWAY}/v1/{tool}", body, {"Authorization": f"Bearer {capability}", "Content-Type": "application/json", "X-Desk-Spec-Digest": spec_digest})
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)


def main():
    with open(SPEC, encoding="utf-8") as stream:
        spec = json.load(stream)
    refs = spec.get("inputRefs")
    if not isinstance(refs, list) or len(refs) != 3 or not all(safe_ref(ref) for ref in refs):
        raise ValueError("exactly three safe input references are required")
    docs = []
    manifest = {}
    for ref in refs:
        with open(os.path.join(CORPUS, f"{ref}.md"), encoding="utf-8") as stream:
            content = stream.read(20000)
            docs.append((ref, content))
            manifest[ref] = hashlib.sha256(content.encode()).hexdigest()
    corpus_digest = hashlib.sha256(json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    if corpus_digest != spec.get("corpusDigest"):
        raise ValueError("corpus digest does not match approved spec")
    lines = ["# Comparative research brief", "", "## Findings", ""]
    for ref, content in docs:
        excerpt = " ".join(content.split())
        lines += [f"### {ref}", "", excerpt[:1200], "", f"Source: `{ref}`", ""]
    lines += ["## Comparison", "", "This brief compares the three supplied public documents above. Claims are limited to their text; differences and missing evidence should be reviewed before publication.", ""]
    artifact = "\n".join(lines).encode()
    with open(OUT, "xb") as stream:
        stream.write(artifact)
    capability = os.environ["DESK_CAPABILITY"]
    # Search is the only read tool; the worker cannot ask the gateway to fetch URLs.
    for ref, _content in docs:
        gateway("search", {"query": ref}, capability)
    result = {"artifactHash": hashlib.sha256(artifact).hexdigest(), "mediaType": "text/markdown", "artifactRef": "result.md", "boundedTrace": "read=3 supplied corpus documents; network=approved gateway tools only"}
    print(json.dumps(result))


if __name__ == "__main__":
    main()
