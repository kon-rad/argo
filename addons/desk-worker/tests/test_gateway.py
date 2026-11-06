import base64
import json
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from gateway import decode_capability, issue_capability, reserve, connect


def claims(**overrides):
    value = {"jobId": "job-1", "attemptId": "attempt-1", "audience": "gateway", "expiresAt": 4102444800,
             "model": "approved-model", "tools": ["search", "model"], "inputRefs": ["doc-a"],
             "corpusDigest": "a" * 64, "specDigest": "b" * 64, "maxCostAtomic": "100", "costAsset": "USD", "maxOutputTokens": 20}
    value.update(overrides)
    return value


def test_capability_signature_expiry_and_audience(monkeypatch):
    monkeypatch.setenv("DESK_SIGNING_KEY", "t" * 40)
    good = issue_capability(claims())
    assert decode_capability(good)["attemptId"] == "attempt-1"
    assert decode_capability(good[:-1] + ("A" if good[-1] != "A" else "B")) is None
    assert decode_capability(issue_capability(claims(audience="other"))) is None
    assert decode_capability(issue_capability(claims(expiresAt=1))) is None


def test_budget_reservation_is_atomic_across_concurrent_calls(tmp_path, monkeypatch):
    import gateway
    db_path = tmp_path / "gateway.sqlite3"
    monkeypatch.setattr(gateway, "DB", str(db_path))
    capability = claims(maxCostAtomic="50")
    barrier = threading.Barrier(8)

    def attempt(_):
        db = connect()
        barrier.wait()
        try:
            reserve(db, capability, 10)
            return True
        except PermissionError:
            return False
        finally:
            db.close()

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(attempt, range(8)))
    assert sum(results) == 5
    db = connect()
    row = db.execute("SELECT reserved,spent FROM attempts WHERE attempt='attempt-1'").fetchone()
    assert row == (50, 0)
    db.close()


def test_reservation_cannot_be_overdrawn(tmp_path, monkeypatch):
    import gateway
    monkeypatch.setattr(gateway, "DB", str(tmp_path / "gateway.sqlite3"))
    db = connect()
    with pytest.raises(PermissionError):
        reserve(db, claims(maxCostAtomic="9"), 10)
    db.close()
