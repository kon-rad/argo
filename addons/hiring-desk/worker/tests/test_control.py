import hashlib
import json
import sqlite3
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

from control import Control, canonical, digest, handler_for, validate_spec, MAX_ARTIFACT


class FakeRunner:
    def __init__(self, root):
        self.corpus = root / 'corpus'
        self.state = root / 'runs'
        self.corpus.mkdir(); self.state.mkdir()
        for ref in ('a', 'b', 'c'):
            (self.corpus / (ref + '.md')).write_text('# Public document ' + ref)
        self.starts = 0; self.cancels = 0; self.reaped = 0
        self.next_status = {'kind': 'ok', 'value': {'status': 'running'}}
    def _check_host(self):
        pass
    def reap_orphans(self):
        self.reaped += 1
        return {'kind': 'ok', 'value': {'containersRemoved': 0}}
    def start(self, spec, capability):
        self.starts += 1
        return {'kind': 'ok', 'value': {'attemptId': spec['attemptId']}}
    def cancel(self, attempt):
        self.cancels += 1
        return {'kind': 'ok', 'value': None}
    def status(self, attempt):
        return self.next_status


def spec_for(runner, **overrides):
    manifest = {ref: hashlib.sha256((runner.corpus / (ref + '.md')).read_bytes()).hexdigest() for ref in ('a', 'b', 'c')}
    import time
    spec = {'version': 'desk/v1', 'jobId': 'arkiv:123/job', 'attemptId': 'attempt-one', 'acceptanceDigest': 'sha256:' + 'a' * 64,
            'skillVersion': 'research/v1', 'corpusDigest': 'sha256:' + digest(manifest), 'inputRefs': ['a', 'b', 'c'],
            'planDigest': 'sha256:' + 'b' * 64, 'audience': 'gateway', 'expiresAt': int(time.time()) + 300,
            'limits': {'tools': ['search'], 'model': 'approved-model', 'maxCostAtomic': '1000', 'costAsset': 'USD', 'maxRuntimeSeconds': 120, 'maxOutputTokens': 100}}
    spec.update(overrides)
    return spec


@pytest.fixture
def setup(tmp_path):
    runner = FakeRunner(tmp_path)
    db = tmp_path / 'gateway.sqlite3'
    with sqlite3.connect(db) as connection:
        connection.execute('CREATE TABLE attempts(attempt TEXT PRIMARY KEY, job TEXT NOT NULL, budget INTEGER NOT NULL, reserved INTEGER DEFAULT 0, spent INTEGER DEFAULT 0, revoked INTEGER DEFAULT 0)')
    control = Control(runner, tmp_path / 'control', db, 'c' * 40, 's' * 40, {'approved-model'})
    assert control.initialize()
    yield control, runner
    control.close()


def test_distinct_control_credentials_required(tmp_path):
    for token, key in [('short', 's' * 40), ('same' * 10, 'same' * 10)]:
        with pytest.raises(ValueError):
            Control(None, tmp_path, tmp_path / 'gateway', token, key, {'model'})


def test_auth_is_exact_and_capability_not_control_token(setup):
    control, runner = setup
    token = control.issue(spec_for(runner))
    assert control.authorized('Bearer ' + 'c' * 40)
    assert not control.authorized(None)
    assert not control.authorized('Bearer ' + token)
    assert not control.authorized('Bearer ' + 'c' * 39)


def test_issue_binds_budget_expiry_corpus_and_full_spec(setup):
    control, runner = setup
    spec = spec_for(runner)
    token = control.issue(spec)
    assert control.issue(spec) == token
    claims = json.loads(__import__('base64').urlsafe_b64decode(token.split('.')[0] + '=='))
    assert claims['specDigest'] == hashlib.sha256(canonical(spec)).hexdigest()
    assert claims['maxCostAtomic'] == '1000'
    assert claims['expiresAt'] == spec['expiresAt']
    changed = {**spec, 'skillVersion': 'changed'}
    with pytest.raises(PermissionError): control.issue(changed)
    with pytest.raises(PermissionError): control.start(changed, token)
    with pytest.raises(PermissionError): control.start(spec, token + 'x')


@pytest.mark.parametrize('field,value', [('expiresAt', 1), ('expiresAt', True), ('audience', 'browser'), ('attemptId', '../escape'), ('planDigest', 'a' * 64), ('inputRefs', ['a', 'a', 'c']), ('inputRefs', ['a', 'b', '../private']), ('version', 'fixture')])
def test_spec_rejects_invalid_binding(setup, field, value):
    control, runner = setup
    with pytest.raises((ValueError, PermissionError, TypeError)): control.issue(spec_for(runner, **{field: value}))


@pytest.mark.parametrize('change', [{'maxCostAtomic': '1.2'}, {'maxCostAtomic': '0'}, {'costAsset': 'OTHER'}, {'model': 'unapproved'}, {'tools': ['shell']}, {'maxOutputTokens': 999999}, {'maxRuntimeSeconds': 0}])
def test_limits_are_exact_and_bounded(setup, change):
    control, runner = setup
    spec = spec_for(runner); spec['limits'].update(change)
    with pytest.raises(ValueError): control.issue(spec)


def test_corpus_hash_and_symlink_rejected(setup, tmp_path):
    control, runner = setup
    spec = spec_for(runner)
    (runner.corpus / 'a.md').write_text('changed')
    with pytest.raises(PermissionError): control.issue(spec)
    target = tmp_path / 'private.md'; target.write_text('private')
    (runner.corpus / 'a.md').unlink(); (runner.corpus / 'a.md').symlink_to(target)
    with pytest.raises(ValueError): control.issue(spec)


def test_idempotent_start_cancel_revokes_durably(setup):
    control, runner = setup
    spec = spec_for(runner); token = control.issue(spec)
    assert control.start(spec, token) == {'attemptId': spec['attemptId']}
    assert control.start(spec, token) == {'attemptId': spec['attemptId']}
    assert runner.starts == 1
    control.cancel(spec['attemptId']); control.cancel(spec['attemptId'])
    assert runner.cancels == 1
    assert control.status(spec['attemptId']) == {'status': 'cancelled'}
    with sqlite3.connect(control.gateway_db) as db:
        assert db.execute('SELECT revoked FROM attempts').fetchone()[0] == 1
    with pytest.raises(PermissionError): control.start(spec, token)


def test_restart_cleans_orphans_revokes_leases_and_fails_interrupted_attempts(setup):
    control, runner = setup
    spec = spec_for(runner); token = control.issue(spec); control.start(spec, token)
    control.close()
    restarted = Control(runner, control.root, control.gateway_db, 'c' * 40, 's' * 40, {'approved-model'})
    try:
        assert restarted.initialize()
        assert runner.reaped == 2
        assert restarted.status(spec['attemptId']) == {'status': 'failed'}
        with pytest.raises(PermissionError): restarted.start(spec, token)
    finally: restarted.close()


def test_startup_host_failure_and_orphan_failure_never_accept_starts(setup, monkeypatch):
    control, runner = setup
    control.close()
    monkeypatch.setattr(runner, '_check_host', lambda: (_ for _ in ()).throw(RuntimeError('Linux unavailable')))
    assert not control.initialize()
    with pytest.raises(RuntimeError): control.dispatch('POST', '/v1/capabilities/issue', {'spec': spec_for(runner)})
    control.close()
    monkeypatch.setattr(runner, '_check_host', lambda: None)
    monkeypatch.setattr(runner, 'reap_orphans', lambda: {'kind': 'unavailable'})
    assert not control.initialize()


def complete(control, runner):
    spec = spec_for(runner); token = control.issue(spec); control.start(spec, token)
    directory = runner.state / 'trusted-root' / 'result'; directory.mkdir(parents=True)
    path = directory / 'result.md'; data = b'# Public result\n'; path.write_bytes(data)
    metadata = {'artifactRef': str(path), 'artifactHash': hashlib.sha256(data).hexdigest(), 'mediaType': 'text/markdown', 'boundedTrace': 'read=3 supplied documents'}
    runner.next_status = {'kind': 'ok', 'value': {'status': 'complete', 'result': metadata}}
    return spec, path, data, metadata


def test_completed_artifact_is_opaque_verified_and_survives_restart(setup):
    control, runner = setup
    spec, path, data, metadata = complete(control, runner)
    status = control.status(spec['attemptId'])
    assert status['result']['artifactRef'] == 'desk-worker:attempt-one'
    assert status['result']['artifactHash'] == 'sha256:' + hashlib.sha256(data).hexdigest()
    artifact = control.artifact(spec['attemptId'])
    assert __import__('base64').b64decode(artifact['bytesBase64']) == data
    assert str(path) not in json.dumps(artifact)
    control.close()
    restarted = Control(runner, control.root, control.gateway_db, 'c' * 40, 's' * 40, {'approved-model'})
    try:
        assert restarted.initialize()
        assert restarted.artifact(spec['attemptId']) == artifact
    finally: restarted.close()


@pytest.mark.parametrize('variant', ['symlink', 'escape', 'oversize', 'wrong-hash', 'wrong-media'])
def test_artifact_path_hash_and_size_denials(setup, tmp_path, variant):
    control, runner = setup
    spec, path, data, metadata = complete(control, runner)
    if variant == 'symlink':
        outside = tmp_path / 'private.md'; outside.write_bytes(data)
        path.unlink(); path.symlink_to(outside)
    elif variant == 'escape': metadata['artifactRef'] = str(tmp_path / 'result' / 'result.md')
    elif variant == 'oversize': path.write_bytes(b'x' * (MAX_ARTIFACT + 1))
    elif variant == 'wrong-hash': path.write_bytes(b'tampered')
    else: metadata['mediaType'] = 'application/octet-stream'
    with pytest.raises((PermissionError, OSError)): control.status(spec['attemptId'])
    with pytest.raises(PermissionError): control.artifact(spec['attemptId'])


def test_artifact_requires_completed_attempt(setup):
    control, runner = setup
    control.issue(spec_for(runner))
    with pytest.raises(PermissionError): control.artifact('attempt-one')
    with pytest.raises(ValueError): control.artifact('../escape')


def test_control_http_auth_and_body_bounds(setup):
    control, runner = setup
    server = ThreadingHTTPServer(('127.0.0.1', 0), handler_for(control))
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    base = 'http://127.0.0.1:' + str(server.server_port)
    try:
        for headers, body, expected in [({}, b'{}', 403), ({'Authorization': 'Bearer ' + 'c' * 40}, b'x' * 32769, 413), ({'Authorization': 'Bearer ' + 'c' * 40}, b'[]', 400), ({'Authorization': 'Bearer ' + 'c' * 40}, b'{bad', 400)]:
            req = urllib.request.Request(base + '/v1/capabilities/issue', body, headers)
            with pytest.raises(urllib.error.HTTPError) as error: urllib.request.urlopen(req, timeout=3)
            assert error.value.code == expected
        req = urllib.request.Request(base + '/v1/capabilities/issue', json.dumps({'spec': spec_for(runner)}).encode(), {'Authorization': 'Bearer ' + 'c' * 40})
        with urllib.request.urlopen(req, timeout=3) as response:
            assert json.load(response)['kind'] == 'ok'
    finally:
        server.shutdown(); server.server_close(); thread.join(3)


def test_runner_network_cleanup_detaches_gateway_before_removal(tmp_path, monkeypatch):
    from runner import DeskRunner
    runner = DeskRunner(tmp_path, tmp_path)
    calls = []
    monkeypatch.setattr(runner, '_docker', lambda *args: calls.append(args) or '')
    runner._remove_network('desk-job-test')
    assert calls == [('network', 'disconnect', '-f', 'desk-job-test', 'desk-gateway'), ('network', 'rm', 'desk-job-test')]


def test_linux_and_docker_requirements_fail_closed(tmp_path, monkeypatch):
    import runner as module
    runner = module.DeskRunner(tmp_path, tmp_path)
    monkeypatch.setattr(module.platform, 'system', lambda: 'Darwin')
    with pytest.raises(RuntimeError, match='dedicated Linux'): runner._check_host()
    monkeypatch.setattr(module.platform, 'system', lambda: 'Linux')
    monkeypatch.setattr(runner, '_docker', lambda *_: (_ for _ in ()).throw(RuntimeError('Docker unavailable')))
    with pytest.raises(RuntimeError, match='Docker unavailable'): runner._check_host()
