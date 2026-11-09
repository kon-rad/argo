"""The Mac installer is tested with synthetic homes and fake launchctl/npm only."""
import os
import json
import plistlib
import shutil
import subprocess
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / 'app/bin/install-usage-push-mac.sh'


def test_usage_install_lifecycle(tmp_path):
    app = tmp_path / 'app'
    (app / 'bin').mkdir(parents=True)
    shutil.copy(SCRIPT, app / 'bin/install.sh')
    (app / 'bin/statusline-usage.mjs').write_text('// synthetic\n')
    dist = app / 'server/dist'
    for group, names in {'usage': 'push readFrom walkFiles lines statusline types wire', 'archive': 'stage clean redact'}.items():
        (dist / group).mkdir(parents=True)
        for name in names.split():
            (dist / group / (name + '.js')).write_text('// synthetic\n')
    (dist / 'cli-usage-push.js').write_text("console.log(process.env.CODEX_HOME); console.log(process.env.USAGE_HOST);\n")
    fakebin = tmp_path / 'bin'
    fakebin.mkdir()
    for name in ['npm', 'launchctl']:
        path = fakebin / name
        path.write_text('#!/bin/sh\nexit 0\n')
        path.chmod(0o755)
    home = tmp_path / 'home'
    home.mkdir()
    (home / '.claude').mkdir()
    original = dict(type='command', command='printf original', padding=2)
    settings = home / '.claude/settings.json'
    settings.write_text(json.dumps(dict(statusLine=original, unrelated=True)))
    env = dict(os.environ, HOME=str(home), PATH=str(fakebin) + ':' + os.environ['PATH'],
               USAGE_HOST='laptop-a', USAGE_PUSH_HOST='my-server', CODEX_HOME=str(tmp_path / 'codex & home'))
    run = lambda *args, **kw: subprocess.run(['bash', str(app / 'bin/install.sh'), *args], env=kw.get('env', env), capture_output=True, text=True)
    assert run().returncode == 0
    assert run().returncode == 0
    configured = json.loads(settings.read_text())
    assert configured['unrelated'] is True
    assert configured['statusLine']['command'].count('statusline-usage.mjs') == 1
    assert 'printf original' in configured['statusLine']['command']
    assert configured['statusLine']['refreshInterval'] == 60
    plist = home / 'Library/LaunchAgents/com.secondbrain.usage-push.plist'
    config = plistlib.loads(plist.read_bytes())
    assert config['EnvironmentVariables']['USAGE_HOST'] == 'laptop-a'
    assert config['EnvironmentVariables']['CODEX_HOME'] == env['CODEX_HOME']
    assert config['StartInterval'] == 60
    assert 'laptop-a' in run('doctor').stdout
    assert run(env=dict(env, USAGE_HOST='laptop-b')).returncode == 0
    assert 'laptop-b' in run('doctor').stdout
    assert run('disable').returncode == 0
    assert not plist.exists()
    assert json.loads(settings.read_text())['statusLine'] == original
    assert run('doctor').returncode == 1
    assert run('uninstall').returncode == 0
    assert run(env=dict(env, USAGE_HOST='')).returncode != 0
    assert run(env=dict(env, USAGE_PUSH_HOST='-oProxyCommand=bad')).returncode != 0
