"""Narrow capability-authenticated model/search/result gateway; stdlib only."""
import base64
import hashlib
import hmac
import json
import os
import sqlite3
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

DB = os.environ.get("DESK_STATE_DB", "/var/lib/desk-gateway/state.sqlite3")


def b64(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def decode_capability(token):
    try:
        encoded, signature = token.split(".", 1)
        key = os.environ["DESK_SIGNING_KEY"].encode()
        expected = b64(hmac.new(key, encoded.encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(signature, expected):
            return None
        claims = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
        if claims.get("audience") != "gateway" or int(claims["expiresAt"]) <= int(time.time()):
            return None
        if not all(claims.get(k) for k in ("jobId", "attemptId", "model", "corpusDigest", "specDigest")):
            return None
        if claims.get("costAsset") != "USD" or not str(claims.get("maxCostAtomic", "")).isdigit():
            return None
        return claims
    except (ValueError, KeyError, TypeError, json.JSONDecodeError):
        return None


def issue_capability(claims, key=None):
    """Trusted control-plane helper. Never call from worker-facing request handlers."""
    encoded = b64(json.dumps(claims, sort_keys=True, separators=(",", ":")).encode())
    signing_key = (key or os.environ["DESK_SIGNING_KEY"]).encode()
    return encoded + "." + b64(hmac.new(signing_key, encoded.encode(), hashlib.sha256).digest())


def connect():
    os.makedirs(os.path.dirname(DB), exist_ok=True)
    db = sqlite3.connect(DB, timeout=15, isolation_level=None)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("CREATE TABLE IF NOT EXISTS attempts (attempt TEXT PRIMARY KEY, job TEXT NOT NULL, budget INTEGER NOT NULL, reserved INTEGER NOT NULL DEFAULT 0, spent INTEGER NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0)")
    db.execute("CREATE TABLE IF NOT EXISTS reservations (id TEXT PRIMARY KEY, attempt TEXT NOT NULL, amount INTEGER NOT NULL, status TEXT NOT NULL)")
    return db


def ensure_attempt(db, claims):
    db.execute("INSERT OR IGNORE INTO attempts(attempt,job,budget) VALUES(?,?,?)", (claims["attemptId"], claims["jobId"], int(claims["maxCostAtomic"])))
    row = db.execute("SELECT job,budget,revoked FROM attempts WHERE attempt=?", (claims["attemptId"],)).fetchone()
    if not row or row[0] != claims["jobId"] or row[1] != int(claims["maxCostAtomic"]) or row[2]:
        raise PermissionError("attempt denied or revoked")


def reserve(db, claims, amount):
    db.execute("BEGIN IMMEDIATE")
    try:
        ensure_attempt(db, claims)
        row = db.execute("SELECT budget,reserved,spent FROM attempts WHERE attempt=?", (claims["attemptId"],)).fetchone()
        if amount <= 0 or row[1] + row[2] + amount > row[0]:
            raise PermissionError("budget exhausted")
        rid = hashlib.sha256(f"{claims['attemptId']}:{time.time_ns()}".encode()).hexdigest()
        db.execute("INSERT INTO reservations(id,attempt,amount,status) VALUES(?,?,?,'reserved')", (rid, claims["attemptId"], amount))
        db.execute("UPDATE attempts SET reserved=reserved+? WHERE attempt=?", (amount, claims["attemptId"]))
        db.execute("COMMIT")
        return rid
    except Exception:
        db.execute("ROLLBACK")
        raise


def settle(db, reservation, actual):
    db.execute("BEGIN IMMEDIATE")
    try:
        row = db.execute("SELECT attempt,amount,status FROM reservations WHERE id=?", (reservation,)).fetchone()
        if not row or row[2] != "reserved" or actual < 0 or actual > row[1]:
            raise ValueError("invalid reservation reconciliation")
        db.execute("UPDATE reservations SET status='settled' WHERE id=?", (reservation,))
        db.execute("UPDATE attempts SET reserved=reserved-?,spent=spent+? WHERE attempt=?", (row[1], actual, row[0]))
        db.execute("COMMIT")
    except Exception:
        db.execute("ROLLBACK")
        raise


class Handler(BaseHTTPRequestHandler):
    server_version = "DeskGateway/1"

    def log_message(self, _fmt, *_args):
        pass

    def respond(self, code, value):
        raw = json.dumps(value).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self):
        if self.path not in ("/v1/search", "/v1/model", "/v1/revoke"):
            return self.respond(404, {"error": "unavailable"})
        auth = self.headers.get("Authorization", "")
        claims = decode_capability(auth[7:]) if auth.startswith("Bearer ") else None
        if claims is None:
            return self.respond(403, {"error": "denied"})
        if not hmac.compare_digest(self.headers.get("X-Desk-Spec-Digest", ""), claims["specDigest"]):
            return self.respond(403, {"error": "spec mismatch"})
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
            if content_length < 0 or content_length > 16384:
                return self.respond(413, {"error": "request too large"})
            body = json.loads(self.rfile.read(content_length))
            db = connect()
            ensure_attempt(db, claims)
            if self.path == "/v1/revoke":
                db.execute("UPDATE attempts SET revoked=1 WHERE attempt=?", (claims["attemptId"],))
                return self.respond(200, {"revoked": True})
            tools = claims.get("tools", [])
            if self.path == "/v1/search":
                if "search" not in tools or set(body) != {"query"} or not isinstance(body["query"], str) or len(body["query"]) > 200:
                    return self.respond(403, {"error": "denied"})
                # The only allowed search is over refs declared in the signed capability.
                query = body["query"]
                refs = claims.get("inputRefs", [])
                if query not in refs:
                    return self.respond(403, {"error": "input not approved"})
                return self.respond(200, {"matches": [query]})
            if "model" not in tools:
                return self.respond(403, {"error": "denied"})
            return self.model(db, claims, body)
        except PermissionError as exc:
            return self.respond(403, {"error": str(exc)})
        except Exception:
            return self.respond(503, {"error": "unavailable"})

    def model(self, db, claims, body):
        if set(body) != {"messages", "max_tokens"} or not isinstance(body["messages"], list):
            return self.respond(400, {"error": "invalid input"})
        if not isinstance(body["max_tokens"], int) or body["max_tokens"] < 1 or body["max_tokens"] > int(claims["maxOutputTokens"]):
            return self.respond(403, {"error": "output token limit exceeded"})
        prompt = json.dumps(body["messages"], ensure_ascii=False)
        if len(prompt) > 12000:
            return self.respond(413, {"error": "input too large"})
        model = claims["model"]
        if model != os.environ.get("DESK_MODEL_NAME"):
            return self.respond(403, {"error": "model not approved"})
        input_rate = int(os.environ.get("DESK_INPUT_MICRO_USD_PER_1K", ""))
        output_rate = int(os.environ.get("DESK_OUTPUT_MICRO_USD_PER_1K", ""))
        url = os.environ["DESK_MODEL_URL"]
        if urlparse(url).scheme != "https" or not os.environ.get("DESK_MODEL_API_KEY"):
            return self.respond(503, {"error": "model configuration unavailable"})
        if input_rate < 0 or output_rate < 0:
            return self.respond(503, {"error": "model pricing unavailable"})
        # UTF-8 byte count is a conservative upper bound for input token count.
        max_cost = ((len(prompt.encode("utf-8")) * input_rate + body["max_tokens"] * output_rate + 999) // 1000)
        rid = reserve(db, claims, max_cost)
        payload = json.dumps({"model": model, "messages": body["messages"], "max_tokens": body["max_tokens"]}).encode()
        request = Request(url, payload, {"Authorization": "Bearer " + os.environ["DESK_MODEL_API_KEY"], "Content-Type": "application/json"})
        try:
            class NoRedirect(HTTPRedirectHandler):
                def redirect_request(self, _req, _fp, _code, _msg, _headers, _newurl):
                    return None
            with build_opener(NoRedirect).open(request, timeout=30) as response:
                result = json.loads(response.read(256000))
            usage = result.get("usage", {})
            actual = (int(usage["prompt_tokens"]) * input_rate + int(usage["completion_tokens"]) * output_rate + 999) // 1000
            settle(db, rid, actual)
            return self.respond(200, {"result": result, "usage": usage})
        except Exception:
            # Keep the reservation charged on ambiguity: retry cannot double-spend it.
            return self.respond(503, {"error": "provider unavailable; reservation retained"})


def main():
    if len(os.environ.get("DESK_SIGNING_KEY", "")) < 32:
        raise SystemExit("DESK_SIGNING_KEY must contain at least 32 bytes")
    connect().close()
    ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("DESK_GATEWAY_PORT", "8787"))), Handler).serve_forever()


if __name__ == "__main__":
    main()
