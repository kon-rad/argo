"""Security regression for the rendered app service's Codex state exception."""
import configparser
from pathlib import Path


def test_codex_state_is_optional_and_narrow_without_writable_home():
    template = (Path(__file__).resolve().parents[1] / 'app/deploy/secondbrain.service').read_text()
    for name, value in {'APP_USER': 'example', 'APP_DIR': '/srv/app', 'VAULT_DIR': '/srv/vault', 'APP_HOME': '/home/example'}.items():
        template = template.replace('@' + name + '@', value)
    unit = configparser.ConfigParser(interpolation=None)
    unit.read_string(template)
    service = unit['Service']
    assert service['ProtectHome'] == 'read-only'
    assert service['ProtectSystem'] == 'strict'
    paths = service['ReadWritePaths'].split()
    assert paths == ['/srv/vault', '/srv/app/data', '-/home/example/.codex']
    assert '/home/example' not in paths
    assert '-/home/example' not in paths
    assert service['NoNewPrivileges'] == 'true'
