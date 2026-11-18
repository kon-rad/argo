"""Trusted, bearer-authenticated Desk worker control plane. Never expose to browsers/workers."""
import base64
import fcntl
import hashlib
import hmac
import json
import os
import re
import sqlite3
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from gateway import issue_capability
from runner import DeskRunner

MAX_BODY = 32768
MAX_ARTIFACT = 1_000_000
SAFE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,100}\Z")
HASH = re.compile(r"sha256:[a-f0-9]{64}\Z")


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def integer(value, minimum, maximum):
    return type(value) is int and minimum <= value <= maximum


def validate_spec(spec, models, now=None):
    now = int(time.time()) if now is None else now
    fields = {"version", "jobId", "attemptId", "acceptanceDigest", "skillVersion", "corpusDigest", "inputRefs", "planDigest", "limits", "audience", "expiresAt"}
    if not isinstance(spec, dict) or set(spec) != fields or spec["version"] != "desk/v1" or spec["audience"] != "gateway":
        raise ValueError("unsupported WorkerSpec")
    if not isinstance(spec["jobId"], str) or not 1 <= len(spec["jobId"]) <= 500 or not isinstance(spec["skillVersion"], str) or not 1 <= len(spec["skillVersion"]) <= 200:
        raise ValueError("invalid job or skill binding")
    if not isinstance(spec["attemptId"], str) or not SAFE.fullmatch(spec["attemptId"]):
        raise ValueError("invalid attempt reference")
    if any(not isinstance(spec[k], str) or not HASH.fullmatch(spec[k]) for k in ("acceptanceDigest", "corpusDigest", "planDigest")):
        raise ValueError("invalid digest binding")
    if not integer(spec["expiresAt"], now + 1, now + 3600):
        raise ValueError("expired or excessive capability lifetime")
    refs = spec["inputRefs"]
    if not isinstance(refs, list) or len(refs) != 3 or len(set(refs)) != 3 or any(not isinstance(ref, str) or not SAFE.fullmatch(ref) or ".." in ref for ref in refs):
        raise ValueError("exactly three unique safe corpus references required")
    limits = spec["limits"]
    if not isinstance(limits, dict) or set(limits) != {"tools", "model", "maxCostAtomic", "costAsset", "maxRuntimeSeconds", "maxOutputTokens"}:
        raise ValueError("invalid worker limits")
    tools = limits["tools"]
    if not isinstance(tools, list) or not tools or not all(isinstance(tool, str) and tool in ("search", "model") for tool in tools) or len(set(tools)) != len(tools) or "search" not in tools:
        raise ValueError("unsupported worker tools")
    if limits["model"] not in models or limits["costAsset"] != "USD" or not isinstance(limits["maxCostAtomic"], str) or not re.fullmatch(r"[1-9][0-9]{0,11}", limits["maxCostAtomic"]):
        raise ValueError("unapproved model or atomic cost budget")
    if not integer(limits["maxRuntimeSeconds"], 1, 3600) or not integer(limits["maxOutputTokens"], 1, 16000):
        raise ValueError("invalid execution limits")
    return spec


class Control:
    def __init__(self, runner, state_dir, gateway_db, token, signing_key, models):
        if len(token) < 32 or len(signing_key) < 32 or hmac.compare_digest(token, signing_key) or not models:
            raise ValueError("distinct control token, capability key and approved models are required")
        self.runner, self.token, self.key, self.models = runner, token, signing_key, frozenset(models)
        self.root = Path(state_dir).resolve()
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.db_path = self.root / "control.sqlite3"
        self.gateway_db = Path(gateway_db).resolve()
        self.lock = threading.RLock()
        self.ready = False
        self.startup_lock = None
        with self.db() as db:
            db.execute("CREATE TABLE IF NOT EXISTS control_attempts (id TEXT PRIMARY KEY, spec_digest TEXT NOT NULL, spec TEXT NOT NULL, token_hash TEXT NOT NULL, status TEXT NOT NULL, result TEXT)")

    def db(self):
        db = sqlite3.connect(self.db_path, timeout=15)
        db.row_factory = sqlite3.Row
        return db

    def initialize(self):
        """One owner per state directory. Restart never resumes an unobserved container."""
        with self.lock:
            if self.startup_lock is not None:
                return self.ready
            lock = open(self.root / "control.lock", "a+")
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                lock.close()
                raise RuntimeError("another worker control service owns this state")
            self.startup_lock = lock
            try:
                self.runner._check_host()
                if not self.gateway_db.is_file():
                    raise RuntimeError("gateway state database unavailable")
                with sqlite3.connect(self.gateway_db) as db:
                    db.execute("SELECT attempt FROM attempts LIMIT 1").fetchall()
                result = self.runner.reap_orphans()
                if result.get("kind") != "ok":
                    return False
                # Revoke all old leases before accepting dispatches. Even completed leases are no longer usable.
                with self.db() as db:
                    rows = db.execute("SELECT id FROM control_attempts").fetchall()
                    for row in rows:
                        self._revoke_gateway(row["id"])
                    db.execute("UPDATE control_attempts SET status='failed', result=NULL WHERE status IN ('issued','starting','running')")
                self.ready = True
            except Exception:
                self.ready = False
            return self.ready

    def close(self):
        self.ready = False
        if self.startup_lock:
            fcntl.flock(self.startup_lock, fcntl.LOCK_UN)
            self.startup_lock.close()
            self.startup_lock = None

    def authorized(self, header):
        return isinstance(header, str) and hmac.compare_digest(header.encode(), ("Bearer " + self.token).encode())

    def _row(self, attempt):
        if not isinstance(attempt, str) or not SAFE.fullmatch(attempt):
            raise ValueError("invalid attempt reference")
        with self.db() as db:
            return db.execute("SELECT * FROM control_attempts WHERE id=?", (attempt,)).fetchone()

    def _revoke_gateway(self, attempt):
        # This is the gateway's explicitly shared private state file, never a caller-selected path.
        if not self.gateway_db.is_file():
            raise RuntimeError("shared gateway revocation database is unavailable")
        with sqlite3.connect(self.gateway_db, timeout=15) as db:
            db.execute("UPDATE attempts SET revoked=1 WHERE attempt=?", (attempt,))

    def _claims(self, spec):
        return {"jobId": spec["jobId"], "attemptId": spec["attemptId"], "audience": spec["audience"], "expiresAt": spec["expiresAt"],
                "corpusDigest": spec["corpusDigest"], "specDigest": digest(spec), "inputRefs": spec["inputRefs"], **spec["limits"]}

    def issue(self, spec):
        validate_spec(spec, self.models)
        self._verify_corpus(spec)
        token = issue_capability(self._claims(spec), self.key)
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        with self.lock, self.db() as db:
            prior = db.execute("SELECT * FROM control_attempts WHERE id=?", (spec["attemptId"],)).fetchone()
            if prior:
                if prior["spec_digest"] != digest(spec) or prior["status"] not in ("issued", "running"):
                    raise PermissionError("attempt is revoked, completed or bound to different terms")
                return token
            # Reserve gateway identity and budget on issuance, even before any worker call.
            with sqlite3.connect(self.gateway_db, timeout=15) as gateway:
                gateway.execute("INSERT INTO attempts(attempt,job,budget) VALUES(?,?,?)", (spec["attemptId"], spec["jobId"], int(spec["limits"]["maxCostAtomic"])))
            db.execute("INSERT INTO control_attempts VALUES(?,?,?,?,?,NULL)", (spec["attemptId"], digest(spec), canonical(spec).decode(), token_hash, "issued"))
        return token

    def _verify_corpus(self, spec):
        manifest = {}
        root = self.runner.corpus.resolve()
        for ref in spec["inputRefs"]:
            path = root / (ref + ".md")
            if path.is_symlink() or path.resolve().parent != root or not path.is_file() or path.stat().st_size > 20000:
                raise ValueError("approved corpus document unavailable or unsafe")
            # Worker reads UTF-8 text, normalizing newlines through TextIO just like this check.
            text = path.read_text(encoding="utf-8")
            manifest[ref] = hashlib.sha256(text.encode()).hexdigest()
        if "sha256:" + digest(manifest) != spec["corpusDigest"]:
            raise PermissionError("approved corpus digest mismatch")

    def start(self, spec, token):
        validate_spec(spec, self.models)
        if not isinstance(token, str) or len(token) > 16000:
            raise PermissionError("invalid capability")
        with self.lock:
            row = self._row(spec["attemptId"])
            if not row or row["spec_digest"] != digest(spec) or not hmac.compare_digest(row["token_hash"], hashlib.sha256(token.encode()).hexdigest()):
                raise PermissionError("capability does not bind this exact spec")
            if row["status"] == "running":
                return {"attemptId": spec["attemptId"]}
            if row["status"] != "issued":
                raise PermissionError("attempt is not startable")
            self._verify_corpus(spec)
            with self.db() as db:
                db.execute("UPDATE control_attempts SET status='starting' WHERE id=?", (spec["attemptId"],))
            result = self.runner.start(spec, token)
            if result.get("kind") != "ok":
                self._revoke_gateway(spec["attemptId"])
                with self.db() as db:
                    db.execute("UPDATE control_attempts SET status='failed' WHERE id=?", (spec["attemptId"],))
                raise RuntimeError("isolated worker start unavailable")
            with self.db() as db:
                db.execute("UPDATE control_attempts SET status='running' WHERE id=?", (spec["attemptId"],))
            return {"attemptId": spec["attemptId"]}

    def cancel(self, attempt):
        with self.lock:
            row = self._row(attempt)
            if not row:
                return None
            self._revoke_gateway(attempt)
            if row["status"] in ("running", "starting"):
                result = self.runner.cancel(attempt)
                if result.get("kind") != "ok":
                    raise RuntimeError("worker cancellation could not be confirmed")
            with self.db() as db:
                db.execute("UPDATE control_attempts SET status='cancelled', result=NULL WHERE id=? AND status!='complete'", (attempt,))
            return None

    def status(self, attempt):
        with self.lock:
            row = self._row(attempt)
            if not row:
                raise ValueError("unknown attempt")
            if row["status"] in ("cancelled", "failed"):
                return {"status": row["status"]}
            if row["status"] == "complete":
                return {"status": "complete", "result": self._public_result(attempt, json.loads(row["result"]))}
            if row["status"] == "issued":
                return {"status": "queued"}
            result = self.runner.status(attempt)
            if result.get("kind") != "ok":
                raise RuntimeError("worker status unavailable")
            value = result["value"]
            if value.get("status") == "complete":
                metadata = value.get("result", {})
                # Read and verify the artifact now, before recording completion or exposing a reference.
                self._read_artifact(metadata)
                self._revoke_gateway(attempt)
                with self.db() as db:
                    db.execute("UPDATE control_attempts SET status='complete', result=? WHERE id=?", (canonical(metadata).decode(), attempt))
                return {"status": "complete", "result": self._public_result(attempt, metadata)}
            if value.get("status") in ("failed", "cancelled"):
                self._revoke_gateway(attempt)
                with self.db() as db:
                    db.execute("UPDATE control_attempts SET status=?, result=NULL WHERE id=?", (value["status"], attempt))
                return {"status": value["status"]}
            if value.get("status") != "running":
                raise RuntimeError("invalid worker status")
            return {"status": "running"}

    def _read_artifact(self, metadata):
        ref = metadata.get("artifactRef")
        path = Path(ref) if isinstance(ref, str) else None
        root = self.runner.state.resolve()
        if not path or not path.is_absolute() or path.name != "result.md" or path.parent.name != "result" or path.is_symlink() or root not in path.resolve().parents or path.resolve() != path.absolute():
            raise PermissionError("unsafe artifact reference")
        # No caller supplies this path. It is retained only from the trusted local runner.
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, "rb") as stream:
            data = stream.read(MAX_ARTIFACT + 1)
        if not data or len(data) > MAX_ARTIFACT or metadata.get("mediaType") != "text/markdown" or metadata.get("artifactHash") != hashlib.sha256(data).hexdigest():
            raise PermissionError("artifact size, media type or hash mismatch")
        return data

    def _public_result(self, attempt, metadata):
        return {"artifactRef": "desk-worker:" + attempt, "artifactHash": "sha256:" + metadata["artifactHash"], "mediaType": "text/markdown", "boundedTrace": str(metadata.get("boundedTrace", ""))[:2000]}

    def artifact(self, attempt):
        with self.lock:
            row = self._row(attempt)
            if not row or row["status"] != "complete" or not row["result"]:
                raise PermissionError("artifact requires completed attempt")
            metadata = json.loads(row["result"])
            data = self._read_artifact(metadata)
            return {**self._public_result(attempt, metadata), "bytesBase64": base64.b64encode(data).decode()}

    def dispatch(self, method, path, body):
        if not self.ready:
            raise RuntimeError("worker host is not ready; startup cleanup required")
        if method == "POST" and path == "/v1/capabilities/issue" and set(body) == {"spec"}:
            return self.issue(body["spec"])
        if method == "POST" and path == "/v1/attempts/start" and set(body) == {"spec", "capability"}:
            return self.start(body["spec"], body["capability"])
        match = re.fullmatch(r"/v1/attempts/([A-Za-z0-9][A-Za-z0-9._-]{0,100})(?:/(cancel|revoke|artifact))?", path)
        if not match:
            raise ValueError("unsupported worker operation")
        attempt, operation = match.groups()
        if method == "GET" and operation is None:
            return self.status(attempt)
        if method == "GET" and operation == "artifact":
            return self.artifact(attempt)
        if method == "POST" and operation in ("cancel", "revoke") and body == {}:
            return self.cancel(attempt)
        raise ValueError("unsupported worker operation")


def handler_for(control):
    class Handler(BaseHTTPRequestHandler):
        server_version = "DeskControl/1"

        def setup(self):
            super().setup()
            self.connection.settimeout(10)

        def log_message(self, *_args):
            pass

        def respond(self, status, value):
            raw = json.dumps(value).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def handle_request(self):
            if not control.authorized(self.headers.get("Authorization")):
                return self.respond(403, {"kind": "denied", "message": "worker control authentication required"})
            try:
                if self.headers.get("Transfer-Encoding"):
                    return self.respond(400, {"kind": "invalid-input", "message": "chunked bodies are unsupported"})
                lengths = self.headers.get_all("Content-Length", [])
                if len(lengths) > 1:
                    raise ValueError("ambiguous length")
                length = int(lengths[0]) if lengths else 0
                if not 0 <= length <= MAX_BODY:
                    return self.respond(413, {"kind": "invalid-input", "message": "request too large"})
                raw = self.rfile.read(length)
                if len(raw) != length:
                    raise ValueError("incomplete request")
                body = json.loads(raw) if raw else {}
                if not isinstance(body, dict):
                    raise ValueError("object required")
                value = control.dispatch(self.command, self.path, body)
                self.respond(200, {"kind": "ok", "value": value})
            except PermissionError:
                self.respond(403, {"kind": "denied", "message": "worker operation does not match approved state"})
            except (ValueError, TypeError, KeyError):
                self.respond(400, {"kind": "invalid-input", "message": "invalid worker request"})
            except Exception:
                self.respond(503, {"kind": "unavailable", "message": "isolated worker service unavailable"})
        do_POST = handle_request
        do_GET = handle_request
    return Handler


def main():
    runner = DeskRunner(os.environ["DESK_CONTROL_CORPUS_DIR"], os.environ["DESK_CONTROL_RUN_DIR"], gateway_container=os.environ.get("DESK_CONTROL_GATEWAY_CONTAINER", "desk-gateway"), image=os.environ.get("DESK_CONTROL_WORKER_IMAGE", "desk-worker:dev"), gateway_url=os.environ.get("DESK_CONTROL_GATEWAY_URL", "http://127.0.0.1:8787"))
    control = Control(runner, os.environ["DESK_CONTROL_STATE_DIR"], os.environ["DESK_STATE_DB"], os.environ["DESK_CONTROL_TOKEN"], os.environ["DESK_SIGNING_KEY"], os.environ["DESK_CONTROL_ALLOWED_MODELS"].split(","))
    if not control.initialize():
        raise SystemExit("worker host unavailable; no starts accepted")
    try:
        ThreadingHTTPServer((os.environ.get("DESK_CONTROL_BIND", "127.0.0.1"), int(os.environ.get("DESK_CONTROL_PORT", "8790"))), handler_for(control)).serve_forever()
    finally:
        control.close()


if __name__ == "__main__":
    main()
