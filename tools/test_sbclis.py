"""Tests for `secondbrain-vault clis` (tools/sbclis.py), with a temp HOME and a copy of the engine that has no
node_modules and no build. The real bundle against a real app is covered by app/server/test/agent-clis.test.ts.
Run: python3 -m pytest tools"""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ENGINE_SRC = Path(__file__).resolve().parents[1]


@pytest.fixture
def env(tmp_path):
    """An engine copy (tools, template, harness, skills, the wrapper table) inside a fresh vault, and a clean HOME."""
    vault = tmp_path / "vault"
    eng = vault / ".secondbrain"
    for part in ("vault-template", "skills", "tools", "harness"):
        shutil.copytree(ENGINE_SRC / part, eng / part, ignore=shutil.ignore_patterns("__pycache__", ".pytest_cache"))
    (eng / "app" / "bin").mkdir(parents=True)
    for f in ("agent-clis.json", "build-agent-clis.sh"):
        shutil.copy2(ENGINE_SRC / "app" / "bin" / f, eng / "app" / "bin" / f)
    home = tmp_path / "home"
    home.mkdir()
    bindir = home / ".local" / "bin"
    e = dict(HOME=str(home), PATH=os.pathsep.join([str(bindir), "/usr/bin", "/bin"]), LANG="C")
    return dict(vault=vault, eng=eng, home=home, bin=bindir, data=home / ".local/share/secondbrain/agent-clis", env=e, tmp=tmp_path)


def vcli(ctx, *args, extra=None):
    return subprocess.run([sys.executable, str(ctx["eng"] / "tools" / "sbvault.py"), *args], capture_output=True, text=True,
                          cwd=ctx["vault"], env=dict(ctx["env"], **(extra or {})), timeout=60)


def table():
    return json.loads((ENGINE_SRC / "app" / "bin" / "agent-clis.json").read_text())["wrappers"]


def fake_bundle(ctx):
    b = ctx["tmp"] / "cli-board.mjs"
    b.write_text("console.log(JSON.stringify({argv: process.argv.slice(2), env: process.env.SB_VAULT_ENV}))\n")
    return b


def snapshot(*dirs):
    return {str(p): (p.read_bytes(), p.stat().st_mode, p.stat().st_mtime_ns) for d in dirs if d.exists() for p in sorted(d.iterdir())}


def test_install_writes_every_wrapper_and_rerun_changes_nothing(env):
    p = vcli(env, "clis", "install", "--bundle", str(fake_bundle(env)))
    assert p.returncode == 0, p.stderr
    names = sorted(r["name"] for r in table())
    assert sorted(x.name for x in env["bin"].iterdir()) == names
    assert (env["data"] / "cli-board.mjs").is_file()
    assert f"agent CLIs: {len(names) + 1} changed" in p.stdout
    assert "BOARD_URL and BOARD_TOKEN not in" in p.stdout   # the vault has no .env yet: say so, by key name only
    before = snapshot(env["bin"], env["data"])
    again = vcli(env, "clis", "install", "--bundle", str(fake_bundle(env)))
    assert again.returncode == 0
    assert "agent CLIs: 0 changed" in again.stdout
    assert snapshot(env["bin"], env["data"]) == before


def test_server_only_wrappers_print_one_line_and_exit_69(env):
    vcli(env, "clis", "install", "--bundle", str(fake_bundle(env)))
    for r in table():
        if r["door"] != "server-only":
            continue
        p = subprocess.run([str(env["bin"] / r["name"]), "list"], capture_output=True, text=True, env=env["env"])
        assert p.returncode == 69
        assert p.stdout == ""
        lines = p.stderr.strip().splitlines()
        assert len(lines) == 1 and lines[0].startswith(f"{r['name']} is server-only: ")


def test_cli_board_wrapper_runs_the_bundle_with_the_vault_env(env):
    if not shutil.which("node"):
        pytest.skip("node not on PATH")
    vcli(env, "clis", "install", "--bundle", str(fake_bundle(env)))
    e = dict(env["env"], PATH=os.pathsep.join([str(env["bin"]), str(Path(shutil.which("node")).parent), "/usr/bin", "/bin"]))
    p = subprocess.run(["cli-board", "list", "--json"], capture_output=True, text=True, env=e)
    assert p.returncode == 0, p.stderr
    out = json.loads(p.stdout)
    assert out == {"argv": ["list", "--json"], "env": str(env["vault"].resolve() / ".env")}


def test_without_a_build_the_board_wrapper_says_how_to_get_one(env):
    p = vcli(env, "clis", "install")
    assert p.returncode == 0
    assert "not built: run npm ci" in p.stdout
    w = subprocess.run([str(env["bin"] / "cli-board"), "list"], capture_output=True, text=True, env=env["env"])
    assert w.returncode == 69
    assert len(w.stderr.strip().splitlines()) == 1 and "client bundle is not built" in w.stderr
    s = vcli(env, "clis", "status", "--json")
    assert s.returncode == 1
    states = {r["name"]: r["state"] for r in json.loads(s.stdout)}
    assert states["cli-board"] == "missing" and states["cli-org"] == "server-only"


def test_never_overwrites_or_removes_a_file_it_did_not_write(env):
    env["bin"].mkdir(parents=True)
    mine = env["bin"] / "cli-org"
    mine.write_text("#!/bin/sh\necho mine\n")
    elsewhere = env["tmp"] / "other-bin"
    elsewhere.mkdir()
    (elsewhere / "cli-projects").write_text("#!/bin/sh\necho server\n")
    (elsewhere / "cli-projects").chmod(0o755)
    extra = dict(PATH=os.pathsep.join([str(env["bin"]), str(elsewhere), "/usr/bin", "/bin"]))
    p = vcli(env, "clis", "install", "--bundle", str(fake_bundle(env)), extra=extra)
    assert p.returncode == 0
    assert f"kept {mine}: not written by secondbrain-vault" in p.stdout
    assert "kept cli-projects: already on PATH at" in p.stdout
    assert mine.read_text() == "#!/bin/sh\necho mine\n"
    assert not (env["bin"] / "cli-projects").exists()
    u = vcli(env, "clis", "uninstall", extra=extra)
    assert u.returncode == 0
    assert sorted(x.name for x in env["bin"].iterdir()) == ["cli-org"]
    assert not env["data"].exists()


def test_status_reports_missing_before_install(env):
    s = vcli(env, "clis", "status")
    assert s.returncode == 1
    assert all(line.startswith("missing") for line in s.stdout.strip().splitlines())


def test_init_installs_the_clis_unless_told_not_to(env, tmp_path):
    p = vcli(env, "init", ".", extra=dict(SECONDBRAIN_CLI_HOME=str(tmp_path / "d")))
    assert p.returncode == 0, p.stderr
    assert "agent CLIs:" in p.stdout
    assert (env["bin"] / "cli-org").is_file()
    v2 = tmp_path / "v2"
    shutil.copytree(env["eng"], v2 / ".secondbrain")
    q = subprocess.run([sys.executable, str(v2 / ".secondbrain/tools/sbvault.py"), "init", "--no-clis", "."], capture_output=True,
                       text=True, cwd=v2, env=dict(env["env"], SECONDBRAIN_BIN_DIR=str(tmp_path / "bin2")), timeout=60)
    assert q.returncode == 0, q.stderr
    assert "agent CLIs" not in q.stdout
    assert not (tmp_path / "bin2").exists()


def test_wrapper_names_and_doors_are_validated(env):
    t = env["eng"] / "app" / "bin" / "agent-clis.json"
    t.write_text(json.dumps({"wrappers": [{"name": "../evil", "feature": "x", "door": "https"}]}))
    p = vcli(env, "clis", "install")
    assert p.returncode != 0
    assert not env["bin"].exists() or not any(env["bin"].iterdir())
