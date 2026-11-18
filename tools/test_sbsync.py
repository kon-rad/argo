"""Tests for secondbrain-vault sync: two clones of one bare repo play two machines.

Every case runs the real loop over real git, with the settle wait at zero and alerts to the
log. Nothing here touches the network or the home folder: each machine has its own state
dir, and the install tests only render files.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sbsync  # noqa: E402

SYNC_ENV = [k for k in os.environ if k.startswith("SYNC_")] + ["SECONDBRAIN_SETTINGS"]


def git(repo: Path, *args: str, check=True) -> str:
    return subprocess.run(["git", "-C", str(repo), *args], check=check, capture_output=True, text=True).stdout.strip()


class Machine:
    def __init__(self, base: Path, origin: Path, name: str, role: str, **json_over):
        self.name, self.role = name, role
        self.vault = base / name
        self.state = base / f"{name}-state"
        subprocess.run(["git", "clone", "-q", str(origin), str(self.vault)], check=True, capture_output=True)
        git(self.vault, "config", "user.name", name)
        git(self.vault, "config", "user.email", f"{name}@localhost")
        self.settings = {"sync": {"settleSeconds": 0, **json_over}}
        (self.vault / "secondbrain.json").write_text(json.dumps(self.settings))
        git(self.vault, "add", "-A")
        if git(self.vault, "status", "--porcelain"):
            git(self.vault, "commit", "-q", "-m", "settings")
            git(self.vault, "push", "-q", "origin", "main")

    def write(self, rel: str, text: str, old=False) -> Path:
        p = self.vault / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)
        if old:
            os.utime(p, (1, 1))
        return p

    def read(self, rel: str) -> str:
        return (self.vault / rel).read_text()

    def commit_push(self, rel: str, text: str, msg="by hand") -> None:
        self.write(rel, text)
        git(self.vault, "add", "-A")
        git(self.vault, "commit", "-q", "-m", msg)
        git(self.vault, "push", "-q", "origin", "main")

    def run(self, monkeypatch, dry_run=False, **env) -> dict:
        for k in SYNC_ENV:
            monkeypatch.delenv(k, raising=False)
        monkeypatch.setenv("SYNC_ROLE", self.role)
        monkeypatch.setenv("SYNC_MACHINE", self.name)
        monkeypatch.setenv("SYNC_STATE_DIR", str(self.state))
        monkeypatch.setenv("SYNC_ALERT", "log")
        monkeypatch.setenv("SYNC_SETTLE_WAIT", "0")
        for k, v in env.items():
            monkeypatch.setenv(k, v)
        argv = ["run", "--vault", str(self.vault)] + (["--dry-run"] if dry_run else [])
        self.rc = sbsync.main(argv)
        return json.loads((self.state / "sync.json").read_text())

    def log(self) -> str:
        return (self.state / "sync.log").read_text() if (self.state / "sync.log").exists() else ""

    def pull(self) -> None:
        git(self.vault, "pull", "-q", "--rebase", "origin", "main")


@pytest.fixture
def world(tmp_path):
    origin = tmp_path / "origin.git"
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(origin)], check=True)
    seed = tmp_path / "seed"
    subprocess.run(["git", "clone", "-q", str(origin), str(seed)], check=True, capture_output=True)
    git(seed, "config", "user.name", "seed")
    git(seed, "config", "user.email", "seed@localhost")
    (seed / "note.md").write_text("hello\n")
    (seed / "projects.md").write_text("report v1\n")
    git(seed, "add", "-A")
    git(seed, "commit", "-q", "-m", "seed")
    git(seed, "push", "-q", "origin", "main")
    return tmp_path, origin


def origin_files(origin: Path) -> dict:
    out = {}
    for line in git(origin, "ls-tree", "-r", "--name-only", "main").splitlines():
        out[line] = subprocess.run(["git", "-C", str(origin), "show", f"main:{line}"], check=True,
                                   capture_output=True, text=True).stdout
    return out


def origin_log(origin: Path) -> list:
    return git(origin, "log", "--format=%s", "main").splitlines()


# ---- the loop ----

def test_clean_push(world, monkeypatch):
    base, origin = world
    lap = Machine(base, origin, "laptop", "owner")
    lap.write("Projects/idea.md", "an idea\n", old=True)
    st = lap.run(monkeypatch)
    assert st["last_result"] == "ok" and lap.rc == 0
    assert st["ahead"] == 0 and st["behind"] == 0
    assert origin_log(origin)[0] == "sync(laptop): 1 file: Projects/idea.md"
    assert git(origin, "log", "-1", "--format=%an", "main") == "laptop"
    assert st["last_success"]


def test_behind_only_pulls(world, monkeypatch):
    base, origin = world
    lap = Machine(base, origin, "laptop", "owner")
    srv = Machine(base, origin, "server", "agent")
    srv.commit_push("Areas/from-server.md", "server wrote this\n")
    st = lap.run(monkeypatch)
    assert st["last_result"] == "ok"
    assert lap.read("Areas/from-server.md") == "server wrote this\n"
    assert origin_log(origin)[0] == "by hand"  # nothing to commit on the laptop


def test_diverged_without_overlap(world, monkeypatch):
    base, origin = world
    lap = Machine(base, origin, "laptop", "owner")
    srv = Machine(base, origin, "server", "agent")
    lap.write("a.md", "A\n", old=True)
    srv.write("b.md", "B\n", old=True)
    assert srv.run(monkeypatch)["last_result"] == "ok"
    assert lap.run(monkeypatch)["last_result"] == "ok"
    files = origin_files(origin)
    assert files["a.md"] == "A\n" and files["b.md"] == "B\n"
    assert lap.read("b.md") == "B\n"
    assert origin_log(origin)[:2] == ["sync(laptop): 1 file: a.md", "sync(server): 1 file: b.md"]


def test_owner_drops_agent_owned_changes(world, monkeypatch):
    base, origin = world
    lap = Machine(base, origin, "laptop", "owner", agentOwned=["projects.md"])
    srv = Machine(base, origin, "server", "agent", agentOwned=["projects.md"])
    lap.write("projects.md", "laptop scribbled on the report\n", old=True)
    lap.write("note.md", "hello from laptop\n", old=True)
    srv.commit_push("projects.md", "report v2\n", "sync(server): 1 file: projects.md")
    st = lap.run(monkeypatch)
    assert st["last_result"] == "ok"
    assert lap.read("projects.md") == "report v2\n"
    assert origin_files(origin)["projects.md"] == "report v2\n"
    assert origin_log(origin)[0] == "sync(laptop): 1 file: note.md"
    assert "dropped local changes to agent-owned projects.md" in lap.log()


def test_agent_owned_conflict_takes_the_owner_side(world, monkeypatch):
    base, origin = world
    lap = Machine(base, origin, "laptop", "owner", agentOwned=["projects.md"])
    srv = Machine(base, origin, "server", "agent", agentOwned=["projects.md"])
    # A hand commit on the laptop touched the report; the server renders a new one meanwhile.
    lap.write("projects.md", "laptop version\n")
    git(lap.vault, "commit", "-qam", "hand edit of the report")
    srv.commit_push("projects.md", "server version\n", "sync(server): 1 file: projects.md")
    st = lap.run(monkeypatch)
    assert st["last_result"] == "ok"
    assert lap.read("projects.md") == "server version\n"
    assert origin_files(origin)["projects.md"] == "server version\n"
    assert "conflict on projects.md: took remote" in lap.log()


def test_note_conflict_stops_and_alerts_once(world, monkeypatch):
    base, origin = world
    lap = Machine(base, origin, "laptop", "owner")
    srv = Machine(base, origin, "server", "agent")
    lap.write("note.md", "laptop edit\n", old=True)
    srv.commit_push("note.md", "server edit\n", "sync(server): 1 file: note.md")
    before = git(origin, "rev-parse", "main")
    st = lap.run(monkeypatch)
    assert st["last_result"] == "conflict" and lap.rc == 1
    assert st["conflict_files"] == ["note.md"]
    # Nothing lost, nothing pushed, the tree is exactly the laptop's commit.
    assert lap.read("note.md") == "laptop edit\n"
    assert git(lap.vault, "log", "-1", "--format=%s") == "sync(laptop): 1 file: note.md"
    assert git(lap.vault, "status", "--porcelain") == ""
    assert git(origin, "rev-parse", "main") == before
    assert lap.log().count("alert[conflict:note.md]") == 1
    # The next run retries, stays stopped, and does not alert again.
    st = lap.run(monkeypatch)
    assert st["last_result"] == "conflict"
    assert lap.log().count("alert[conflict:note.md]") == 2
    assert lap.log().count("(already sent)") == 1
    # Resolved by hand: the next run pushes and clears the alert.
    git(lap.vault, "fetch", "-q", "origin", "main")
    subprocess.run(["git", "-C", str(lap.vault), "rebase", "-X", "theirs", "origin/main"], check=True, capture_output=True)
    st = lap.run(monkeypatch)
    assert st["last_result"] == "ok"
    assert st["conflict_files"] == [] and st["alerted"] == {}


def test_note_conflict_keeps_both_on_agent(world, monkeypatch):
    base, origin = world
    lap = Machine(base, origin, "laptop", "owner")
    srv = Machine(base, origin, "server", "agent")
    srv.write("note.md", "server edit\n", old=True)
    lap.commit_push("note.md", "laptop edit\n", "sync(laptop): 1 file: note.md")
    st = srv.run(monkeypatch)
    assert st["last_result"] == "ok"
    assert srv.read("note.md") == "server edit\n"
    assert srv.read("note (conflict from laptop).md") == "laptop edit\n"
    files = origin_files(origin)
    assert files["note.md"] == "server edit\n"
    assert files["note (conflict from laptop).md"] == "laptop edit\n"
    assert "kept both versions: note (conflict from laptop).md" in srv.log()
    # status lists the copy; resolve picks a side.
    lap.run(monkeypatch)
    assert lap.read("note (conflict from laptop).md") == "laptop edit\n"
    assert sbsync.conflict_copies(lap.vault) == [("note (conflict from laptop).md", "note.md")]
    assert sbsync.main(["resolve", "--vault", str(lap.vault), "--keep", "remote", "note.md"]) == 0
    assert lap.read("note.md") == "laptop edit\n"
    assert not (lap.vault / "note (conflict from laptop).md").exists()


def test_both_policy_can_be_forced_on_an_owner(world, monkeypatch):
    base, origin = world
    lap = Machine(base, origin, "laptop", "owner")
    srv = Machine(base, origin, "server", "agent")
    lap.write("note.md", "laptop edit\n", old=True)
    srv.commit_push("note.md", "server edit\n", "by hand")
    st = lap.run(monkeypatch, SYNC_CONFLICTS="both")
    assert st["last_result"] == "ok"
    assert lap.read("note (conflict from remote).md") == "server edit\n"  # no sync(...) author to name


def test_refuses_a_planted_key(world, monkeypatch):
    base, origin = world
    lap = Machine(base, origin, "laptop", "owner")
    # Built at runtime so the fixture never looks like a key to a secret scanner reading this file.
    planted = "AKIA" + "I" * 16
    lap.write("Areas/ops.md", f"the key is {planted} and that's bad\n", old=True)
    lap.write("Areas/fine.md", "just a note\n", old=True)
    st = lap.run(monkeypatch)
    assert st["last_result"] == "refused" and lap.rc == 1
    assert "Areas/ops.md: looks like a AWS access key" in st["last_error"]
    assert "AKIA" not in lap.log()  # names, never values
    assert git(lap.vault, "diff", "--cached", "--name-only") == ""  # nothing staged
    assert git(lap.vault, "log", "-1", "--format=%s") == "settings"  # nothing committed
    assert lap.read("Areas/ops.md").startswith("the key")  # nothing deleted
    assert "alert[refused]" in lap.log()
    # Fixed: the next run commits and clears the alert.
    lap.write("Areas/ops.md", "the key is in the password manager\n", old=True)
    st = lap.run(monkeypatch)
    assert st["last_result"] == "ok" and st["alerted"] == {}


def test_refuses_secret_files_by_name(world, monkeypatch):
    base, origin = world
    lap = Machine(base, origin, "laptop", "owner")
    lap.write("keys/server.pem", "not even a key\n", old=True)
    lap.write(".env", "X=1\n", old=True)
    lap.write(".env.example", "X=\n", old=True)
    st = lap.run(monkeypatch)
    assert st["last_result"] == "refused"
    assert "keys/server.pem: a secret by name" in st["last_error"]
    assert ".env: a secret by name" in st["last_error"]
    assert ".env.example" not in st["last_error"]


def test_refuses_a_big_file(world, monkeypatch):
    base, origin = world
    lap = Machine(base, origin, "laptop", "owner", maxFileMB=1)
    (lap.vault / "big.bin").write_bytes(b"\0" * (1024 * 1024 + 1))
    os.utime(lap.vault / "big.bin", (1, 1))
    st = lap.run(monkeypatch)
    assert st["last_result"] == "refused"
    assert "big.bin: 1.0 MB is over the 1 MB cap" in st["last_error"]


def test_skips_when_git_is_busy(world, monkeypatch):
    base, origin = world
    lap = Machine(base, origin, "laptop", "owner")
    lap.write("note.md", "edit\n", old=True)
    (lap.vault / ".git" / "index.lock").write_text("")
    st = lap.run(monkeypatch)
    assert st["last_result"] == "busy" and lap.rc == 0
    assert "index.lock" in st["last_error"]
    assert git(lap.vault, "log", "-1", "--format=%s") == "settings"


def test_skips_when_another_run_holds_the_lock(world, monkeypatch):
    base, origin = world
    lap = Machine(base, origin, "laptop", "owner")
    lock = lap.state / "sync.lock"
    lock.mkdir(parents=True)
    (lock / "pid").write_text(str(os.getpid()))  # alive: not stale
    st = lap.run(monkeypatch)
    assert st["last_result"] == "busy" and "another sync run" in st["last_error"]
    (lock / "pid").write_text("999999999")  # dead: stale, taken over
    st = lap.run(monkeypatch)
    assert st["last_result"] == "ok"


def test_waits_for_recent_writes_then_goes_ahead(world, monkeypatch):
    base, origin = world
    lap = Machine(base, origin, "laptop", "owner", settleSeconds=90)
    lap.write("note.md", "being written\n")  # mtime now
    st = lap.run(monkeypatch)
    assert st["last_result"] == "ok"
    assert lap.log().count("settle: 1 file: note.md changed") == sbsync.SETTLE_CHECKS
    assert "settle: still changing; going ahead" in lap.log()
    assert origin_files(origin)["note.md"] == "being written\n"


def test_embedded_repo_pointer_is_ignored_by_default(world, monkeypatch):
    base, origin = world
    lap = Machine(base, origin, "laptop", "owner")
    nested = lap.vault / "Areas" / "code"
    nested.mkdir(parents=True)
    subprocess.run(["git", "init", "-q", str(nested)], check=True)
    (nested / "main.py").write_text("print(1)\n")
    git(nested, "-c", "user.name=n", "-c", "user.email=n@localhost", "add", "-A")
    git(nested, "-c", "user.name=n", "-c", "user.email=n@localhost", "commit", "-q", "-m", "nested")
    lap.write("note.md", "edit\n", old=True)
    st = lap.run(monkeypatch)
    assert st["last_result"] == "ok"
    assert "Areas/code" not in origin_files(origin)
    assert "left out embedded repo Areas/code" in lap.log()
    assert origin_log(origin)[0] == "sync(laptop): 1 file: note.md"


def test_embedded_repo_pointer_recorded_when_asked(world, monkeypatch):
    base, origin = world
    lap = Machine(base, origin, "laptop", "owner", embeddedRepos="record")
    nested = lap.vault / "code"
    nested.mkdir()
    subprocess.run(["git", "init", "-q", str(nested)], check=True)
    (nested / "x").write_text("x")
    git(nested, "-c", "user.name=n", "-c", "user.email=n@localhost", "add", "-A")
    git(nested, "-c", "user.name=n", "-c", "user.email=n@localhost", "commit", "-q", "-m", "nested")
    st = lap.run(monkeypatch)
    assert st["last_result"] == "ok"
    assert git(origin, "ls-tree", "main", "code").startswith("160000 commit")


def test_dry_run_commits_nothing(world, monkeypatch):
    base, origin = world
    lap = Machine(base, origin, "laptop", "owner")
    srv = Machine(base, origin, "server", "agent")
    srv.commit_push("b.md", "B\n")
    lap.write("a.md", "A\n", old=True)
    st = lap.run(monkeypatch, dry_run=True)
    assert st["last_result"] == "dry-run" and lap.rc == 0
    assert "dry run: would commit 1 file: a.md" in lap.log()
    assert git(lap.vault, "log", "-1", "--format=%s") == "settings"
    assert git(lap.vault, "diff", "--cached", "--name-only") == ""
    assert st["behind"] == 1 and st["ahead"] == 0
    assert "b.md" not in os.listdir(lap.vault)  # fetched, not merged


def test_offline_keeps_the_commit_and_alerts_only_after_a_day(world, monkeypatch):
    base, origin = world
    lap = Machine(base, origin, "laptop", "owner")
    git(lap.vault, "remote", "set-url", "origin", str(base / "gone.git"))
    lap.write("note.md", "offline edit\n", old=True)
    st = lap.run(monkeypatch)
    assert st["last_result"] == "offline" and lap.rc == 0
    assert git(lap.vault, "log", "-1", "--format=%s") == "sync(laptop): 1 file: note.md"
    # Never synced from this state dir: that alerts (no success on record), so plant a recent one.
    lap.state.joinpath("sync.json").write_text(json.dumps({**st, "alerted": {}, "last_success": sbsync.iso(sbsync.utcnow())}))
    st = lap.run(monkeypatch)
    assert st["last_result"] == "offline" and st["alerted"] == {}
    old = sbsync.iso(sbsync.utcnow() - sbsync.OFFLINE_ALERT_AFTER * 2)
    lap.state.joinpath("sync.json").write_text(json.dumps({**st, "last_success": old}))
    st = lap.run(monkeypatch)
    assert "offline" in st["alerted"]
    # Back online: pushes, clears the alert.
    git(lap.vault, "remote", "set-url", "origin", str(origin))
    st = lap.run(monkeypatch)
    assert st["last_result"] == "ok" and st["alerted"] == {}
    assert origin_log(origin)[0] == "sync(laptop): 1 file: note.md"


def test_heartbeat_rides_on_a_real_commit(world, monkeypatch):
    base, origin = world
    lap = Machine(base, origin, "laptop", "owner", heartbeat=True)
    st = lap.run(monkeypatch)
    assert st["last_result"] == "ok"
    assert ".sync/laptop.json" not in origin_files(origin)  # nothing else to commit: no heartbeat commit
    lap.write("note.md", "edit\n", old=True)
    lap.run(monkeypatch)
    hb = json.loads(origin_files(origin)[".sync/laptop.json"])
    assert hb["machine"] == "laptop" and hb["role"] == "owner" and hb["at"]
    assert origin_log(origin)[0] == "sync(laptop): 2 files: .sync/laptop.json, note.md"


def test_commit_summary_truncates():
    assert sbsync.summary(["a"]) == "1 file: a"
    assert sbsync.summary(["a", "b", "c", "d", "e", "f"]) == "6 files: a, b, c, d, +2 more"


def test_settings_env_file_and_environment(tmp_path, monkeypatch):
    for k in SYNC_ENV:
        monkeypatch.delenv(k, raising=False)
    (tmp_path / ".env").write_text('SYNC_ROLE="agent"\nexport SYNC_MACHINE=box\nOTHER=$x\n')
    s = sbsync.Settings(tmp_path)
    assert s.role == "agent" and s.machine == "box" and s.conflicts == "both"
    monkeypatch.setenv("SYNC_CONFLICTS", "stop")
    assert sbsync.Settings(tmp_path).conflicts == "stop"
    (tmp_path / ".env").write_text("SYNC_ROLE=boss\n")
    with pytest.raises(ValueError):
        sbsync.Settings(tmp_path)
    (tmp_path / ".env").write_text("")
    (tmp_path / "secondbrain.json").write_text("{not json")
    s = sbsync.Settings(tmp_path)
    assert s.remote == "origin" and s.max_bytes == 20 * 1024 * 1024  # defaults survive a bad file


# ---- status, install ----

def test_status_json_and_text(world, monkeypatch, capsys):
    base, origin = world
    lap = Machine(base, origin, "laptop", "owner")
    lap.run(monkeypatch)
    assert sbsync.main(["status", "--vault", str(lap.vault), "--json"]) == 0
    out = capsys.readouterr().out
    data = json.loads(out[out.index("{"):])  # after the run's own log lines
    assert data["last_result"] == "ok" and data["conflict_copies"] == []
    assert sbsync.main(["status", "--vault", str(lap.vault)]) == 0
    out = capsys.readouterr().out
    assert "machine:      laptop (owner, conflicts: stop)" in out and "ahead/behind: 0/0" in out


def test_install_renders_launchd_with_the_wrapper_app_under_documents(tmp_path, monkeypatch):
    for k in SYNC_ENV:
        monkeypatch.delenv(k, raising=False)
    home = tmp_path / "home"
    vault = home / "Documents" / "vault"
    vault.mkdir(parents=True)
    out = tmp_path / "out"
    rc = sbsync.main(["install", "--vault", str(vault), "--render", str(out), "--platform", "darwin",
                      "--home", str(home), "--interval", "30"])
    assert rc == 0
    plist = (out / "com.secondbrain.vault-sync.plist").read_text()
    assert "<key>StartInterval</key><integer>1800</integer>" in plist
    assert "/usr/bin/open" in plist and "SecondBrainSync.app" in plist
    assert "<key>RunAtLoad</key><true/>" in plist
    info = (out / "SecondBrainSync.app" / "Contents" / "Info.plist").read_text()
    assert "NSDocumentsFolderUsageDescription" in info and "<key>LSUIElement</key><true/>" in info
    shim = (out / "vault-sync").read_text()
    assert shim.startswith("#!/bin/bash") and "sbsync.py' run --vault" in shim and str(vault) in shim
    assert os.access(out / "vault-sync", os.X_OK)


def test_install_renders_plain_launchd_outside_documents(tmp_path, monkeypatch):
    for k in SYNC_ENV:
        monkeypatch.delenv(k, raising=False)
    home = tmp_path / "home"
    vault = home / "vault"
    vault.mkdir(parents=True)
    out = tmp_path / "out"
    assert sbsync.main(["install", "--vault", str(vault), "--render", str(out), "--platform", "darwin", "--home", str(home)]) == 0
    plist = (out / "com.secondbrain.vault-sync.plist").read_text()
    assert "/bin/bash" in plist and "open" not in plist
    assert "<integer>3600</integer>" in plist  # the default hour
    assert not (out / "SecondBrainSync.app").exists()


def test_install_renders_systemd_user_units(tmp_path, monkeypatch):
    for k in SYNC_ENV:
        monkeypatch.delenv(k, raising=False)
    vault = tmp_path / "vault"
    vault.mkdir()
    (vault / ".env").write_text("SYNC_INTERVAL_MIN=15\n")
    out = tmp_path / "out"
    assert sbsync.main(["install", "--vault", str(vault), "--render", str(out), "--platform", "linux", "--home", str(tmp_path)]) == 0
    timer = (out / "secondbrain-vault-sync.timer").read_text()
    service = (out / "secondbrain-vault-sync.service").read_text()
    assert "OnUnitActiveSec=15min" in timer and "Persistent=true" in timer
    assert f"ExecStart=/bin/bash {out / 'vault-sync'}" in service


def test_install_refuses_windows(tmp_path, monkeypatch, capsys):
    for k in SYNC_ENV:
        monkeypatch.delenv(k, raising=False)
    assert sbsync.main(["install", "--vault", str(tmp_path), "--render", str(tmp_path / "o"), "--platform", "win32"]) == 2
    assert "Task Scheduler" in capsys.readouterr().err


def test_vault_cli_forwards_sync(tmp_path, capsys):
    cli = Path(__file__).resolve().parent / "sbvault.py"
    r = subprocess.run([sys.executable, str(cli), "--vault", str(tmp_path), "sync", "resolve"], capture_output=True, text=True)
    assert r.returncode == 0 and r.stdout.strip() == "no conflict copies"
    r = subprocess.run([sys.executable, str(cli), "sync"], capture_output=True, text=True)
    assert "run | status | install" in r.stdout or "install" in r.stdout


# ---- merge fallback when the rebase stops, repeating conflict alerts ----

def commit_local(m: Machine, files: dict, msg: str) -> None:
    """A hand commit on a machine, not pushed: one step of a local series."""
    for rel, text in files.items():
        m.write(rel, text)
    git(m.vault, "add", "-A")
    git(m.vault, "commit", "-q", "-m", msg)


def is_ancestor(repo: Path, a: str, b: str) -> bool:
    return subprocess.run(["git", "-C", str(repo), "merge-base", "--is-ancestor", a, b]).returncode == 0


def parents(repo: Path, rev: str) -> int:
    return len(git(repo, "rev-list", "--parents", "-n", "1", rev).split()) - 1


def test_intermediate_conflict_with_matching_final_merges(world, monkeypatch):
    # (a) The rebase replays "draft", which clashes with upstream, though both tips end the same.
    base, origin = world
    lap = Machine(base, origin, "laptop", "owner")
    srv = Machine(base, origin, "server", "agent")
    commit_local(lap, {"note.md": "laptop draft\n"}, "draft")
    commit_local(lap, {"note.md": "final\n", "a.md": "A\n"}, "final")
    local_tip = git(lap.vault, "rev-parse", "HEAD")
    srv.write("b.md", "B\n")
    srv.commit_push("note.md", "final\n", "sync(server): 2 files: b.md, note.md")
    upstream_tip = git(origin, "rev-parse", "main")
    st = lap.run(monkeypatch)
    assert st["last_result"] == "ok" and lap.rc == 0
    assert "rebase conflict on 1 file: note.md; merged instead: ok" in lap.log()
    assert "merge: 1 file: note.md identical on both tips; not a conflict" in lap.log()
    head = git(lap.vault, "rev-parse", "HEAD")
    assert parents(lap.vault, head) == 2  # a merge commit
    # Nothing lost on either side: both tips are in the pushed history, every file is there.
    assert git(origin, "rev-parse", "main") == head
    assert is_ancestor(origin, local_tip, "main") and is_ancestor(origin, upstream_tip, "main")
    files = origin_files(origin)
    assert files["note.md"] == "final\n" and files["a.md"] == "A\n" and files["b.md"] == "B\n"
    assert git(lap.vault, "status", "--porcelain") == ""
    assert st["ahead"] == 0 and st["behind"] == 0 and st["alerted"] == {}


def test_real_note_conflict_aborts_the_merge_and_names_only_real_files(world, monkeypatch):
    # (b) note.md really differs; projects.md only clashed on its intermediate version.
    base, origin = world
    lap = Machine(base, origin, "laptop", "owner")
    srv = Machine(base, origin, "server", "agent")
    commit_local(lap, {"note.md": "laptop draft\n", "projects.md": "draft\n"}, "draft")
    commit_local(lap, {"note.md": "laptop final\n", "projects.md": "report v2\n", "a.md": "A\n"}, "final")
    local_tip = git(lap.vault, "rev-parse", "HEAD")
    srv.write("projects.md", "report v2\n")
    srv.commit_push("note.md", "server final\n", "sync(server): 2 files")
    before = git(origin, "rev-parse", "main")
    st = lap.run(monkeypatch)
    assert st["last_result"] == "conflict" and lap.rc == 1
    assert st["conflict_files"] == ["note.md"]
    assert "rebase conflict on 2 files: note.md, projects.md; merged instead: conflict (1 file: note.md)" in lap.log()
    # The merge was aborted: no merge in progress, a clean tree, the local tip untouched, nothing pushed.
    assert not (lap.vault / ".git" / "MERGE_HEAD").exists()
    assert git(lap.vault, "status", "--porcelain") == ""
    assert git(lap.vault, "rev-parse", "HEAD") == local_tip
    assert lap.read("note.md") == "laptop final\n"
    assert git(origin, "rev-parse", "main") == before
    assert "alert[conflict:note.md]" in lap.log() and "2 ahead and 1 behind" in lap.log()


def test_merge_resolves_agent_owned_files_with_merge_stages(world, monkeypatch):
    # During a merge stage 2 is local and stage 3 upstream: the owner must still get the server's report.
    base, origin = world
    lap = Machine(base, origin, "laptop", "owner", agentOwned=["projects.md"])
    srv = Machine(base, origin, "server", "agent", agentOwned=["projects.md"])
    commit_local(lap, {"note.md": "laptop draft\n"}, "draft")
    commit_local(lap, {"note.md": "final\n", "projects.md": "laptop version\n"}, "final plus a hand edit of the report")
    srv.write("projects.md", "server version\n")
    srv.commit_push("note.md", "final\n", "sync(server): 2 files")
    st = lap.run(monkeypatch)
    assert st["last_result"] == "ok"
    assert "merged instead: ok" in lap.log()
    assert "conflict on projects.md: took remote" in lap.log()
    assert lap.read("projects.md") == "server version\n"
    files = origin_files(origin)
    assert files["projects.md"] == "server version\n" and files["note.md"] == "final\n"


def test_after_a_fallback_merge_the_next_rebase_is_a_noop_and_push_fast_forwards(world, monkeypatch):
    # (c) The fallback merges but the push is refused; the next run must not replay the series again.
    base, origin = world
    lap = Machine(base, origin, "laptop", "owner")
    srv = Machine(base, origin, "server", "agent")
    commit_local(lap, {"note.md": "laptop draft\n"}, "draft")
    commit_local(lap, {"note.md": "final\n", "a.md": "A\n"}, "final")
    srv.commit_push("note.md", "final\n", "sync(server): 1 file: note.md")
    upstream_tip = git(origin, "rev-parse", "main")
    hook = origin / "hooks" / "pre-receive"
    hook.write_text("#!/bin/sh\nexit 1\n")
    hook.chmod(0o755)
    st = lap.run(monkeypatch)
    assert st["last_result"] == "push-failed"
    merged = git(lap.vault, "rev-parse", "HEAD")
    assert parents(lap.vault, merged) == 2
    assert st["ahead"] == 3 and st["behind"] == 0  # draft, final and the merge
    hook.unlink()
    st = lap.run(monkeypatch)
    assert st["last_result"] == "ok"
    assert git(lap.vault, "rev-parse", "HEAD") == merged  # the rebase was a no-op
    assert lap.log().count("rebase conflict on") == 1  # the series was not replayed again
    assert git(origin, "rev-parse", "main") == merged
    assert is_ancestor(origin, upstream_tip, merged)  # the remote branch moved by fast-forward
    # Upstream moves on again: an ordinary pull on top of the merge.
    srv.pull()
    srv.commit_push("c.md", "C\n", "sync(server): 1 file: c.md")
    st = lap.run(monkeypatch)
    assert st["last_result"] == "ok" and lap.read("c.md") == "C\n"
    assert lap.log().count("rebase conflict on") == 1


def test_conflict_alert_repeats_after_n_hours_until_cleared(world, monkeypatch):
    # (d) Unit level: a fake clock and a counting notifier.
    base, origin = world
    lap = Machine(base, origin, "laptop", "owner", alertRepeatHours=6)
    for k in SYNC_ENV:
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("SYNC_STATE_DIR", str(lap.state))
    s = sbsync.Settings(lap.vault)
    assert s.alert_repeat == sbsync.timedelta(hours=6)
    st = sbsync.State(s)
    sent = []
    monkeypatch.setattr(sbsync, "notify", lambda s, title, text, log: sent.append(text))
    t0 = sbsync.utcnow()
    clock = [t0]
    monkeypatch.setattr(sbsync, "utcnow", lambda: clock[0])

    def at(hours: float) -> None:
        clock[0] = t0 + sbsync.timedelta(hours=hours)
        st.alert("conflict:x.md", "stuck", f"at {hours}", repeat=s.alert_repeat)

    at(0)
    at(1)
    at(5.9)
    assert sent == ["at 0"]
    at(6)
    assert sent == ["at 0", "at 6"]
    at(11.9)
    assert sent == ["at 0", "at 6"]
    at(12)
    assert sent == ["at 0", "at 6", "at 12"]
    st.clear("conflict:x.md")
    at(12.5)  # cleared: the next one goes out at once
    assert sent[-1] == "at 12.5"
    # Without repeat (the refused, offline and push alerts) it stays once per key.
    st.alert("refused", "t", "first")
    clock[0] += sbsync.timedelta(days=3)
    st.alert("refused", "t", "second")
    assert sent[-1] == "first"
    # 0 turns the repeat off; the default is 6 hours.
    lap.settings["sync"]["alertRepeatHours"] = 0
    (lap.vault / "secondbrain.json").write_text(json.dumps(lap.settings))
    assert sbsync.Settings(lap.vault).alert_repeat is None
    (lap.vault / "secondbrain.json").write_text("{}")
    assert sbsync.Settings(lap.vault).alert_repeat == sbsync.timedelta(hours=6)


def test_stuck_sync_realerts_with_how_long_and_how_far(world, monkeypatch):
    # (d) End to end: a conflict left for 7 hours is announced again, saying how long and how far.
    base, origin = world
    lap = Machine(base, origin, "laptop", "owner")
    srv = Machine(base, origin, "server", "agent")
    lap.write("note.md", "laptop edit\n", old=True)
    srv.commit_push("note.md", "server edit\n", "sync(server): 1 file: note.md")
    st = lap.run(monkeypatch)
    assert st["last_result"] == "conflict"
    st = lap.run(monkeypatch)
    assert lap.log().count("(already sent)") == 1
    # Seven hours pass: move the recorded times back.
    ago = sbsync.iso(sbsync.utcnow() - sbsync.timedelta(hours=7))
    st["alerted"]["conflict:note.md"] = ago
    st["conflict_since"] = ago
    lap.state.joinpath("sync.json").write_text(json.dumps(st))
    st = lap.run(monkeypatch)
    assert st["last_result"] == "conflict"
    last = [line for line in lap.log().splitlines() if "alert[conflict:note.md]" in line][-1]
    assert "(already sent)" not in last
    assert "Stuck for 7h 0m" in last and "1 ahead and 1 behind" in last
    assert st["alerted"]["conflict:note.md"] != ago
    # Resolved: the alert and the stuck-since time are cleared.
    git(lap.vault, "fetch", "-q", "origin", "main")
    subprocess.run(["git", "-C", str(lap.vault), "rebase", "-X", "theirs", "origin/main"], check=True, capture_output=True)
    st = lap.run(monkeypatch)
    assert st["last_result"] == "ok" and st["alerted"] == {} and "conflict_since" not in st


def test_duration_text():
    td = sbsync.timedelta
    assert sbsync.duration(td(minutes=7)) == "7m"
    assert sbsync.duration(td(hours=5, minutes=12)) == "5h 12m"
    assert sbsync.duration(td(days=3, hours=4, minutes=30)) == "3d 4h"
