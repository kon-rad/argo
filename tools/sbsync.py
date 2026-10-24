#!/usr/bin/env python3
"""secondbrain-vault sync: keep this vault checkout in step with the others, by git, on a timer.

  run [--dry-run]                  one pass: commit, scan, fetch, rebase, push
  status [--json]                  last run, last success, ahead/behind, problems, conflict copies
  install [--interval MIN] [--render DIR]
                                   schedule `run` with launchd (macOS) or a systemd user timer (Linux)
  uninstall
  resolve [--keep local|remote NOTE]
                                   list conflict copies; pick a side for one note

Spec and settings: docs/sync.md. Standard library only, Python 3.9+, so a single copy of
this file runs on a server with nothing but git. `secondbrain-vault sync ...` is the front door.
"""
import argparse
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple

HERE = Path(__file__).resolve()
ENGINE = HERE.parents[1]
STATE_FILE = "sync.json"
LOG_FILE = "sync.log"
LAUNCHD_LABEL = "com.secondbrain.vault-sync"
SYSTEMD_UNIT = "secondbrain-vault-sync"
APP_NAME = "SecondBrainSync"
SHIM_DIR = Path("~/.local/libexec/secondbrain").expanduser()
OFFLINE_ALERT_AFTER = timedelta(hours=24)
PUSH_FAILURES_BEFORE_ALERT = 3
SETTLE_CHECKS = 5
SCAN_CAP = 5 * 1024 * 1024  # the built-in rules read at most this much of a staged file
POLICY_DEFAULT = {"owner": "stop", "agent": "both"}
JSON_DEFAULTS = {"remote": "origin", "branch": "main", "agentOwned": [], "embeddedRepos": "ignore",
                 "maxFileMB": 20, "settleSeconds": 90, "heartbeat": False}

# Files that are secrets by name, whatever is in them. `.env.example` and public keys are fine.
SECRET_NAME = re.compile(r"^(\.env(\.(?!example$).*)?|.*\.(pem|key|p12|pfx|keystore)|id_(rsa|dsa|ecdsa|ed25519))$")
SECRET_PATTERNS = [
    ("private key", re.compile(rb"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("AWS access key", re.compile(rb"\bAKIA[0-9A-Z]{16}\b")),
    ("GitHub token", re.compile(rb"\bgh[pousr]_[A-Za-z0-9]{36,}\b")),
    ("GitHub fine-grained token", re.compile(rb"\bgithub_pat_[A-Za-z0-9_]{60,}\b")),
    ("Slack token", re.compile(rb"\bxox[abprs]-[A-Za-z0-9-]{10,}\b")),
    ("sk- API key", re.compile(rb"\bsk-[A-Za-z0-9_-]{20,}\b")),
]
CONFLICT_COPY = re.compile(r"^(?P<stem>.*) \(conflict from (?P<machine>[^)]*)\)(?P<n> \d+)?(?P<suffix>\.[^./]*)?$")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
    return dt.replace(microsecond=0).isoformat()


def parse_iso(s: Optional[str]) -> Optional[datetime]:
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


# ---- settings ----

def env_file_values(path: Path) -> Dict[str, str]:
    """KEY=value lines of a .env, read literally (never sourced: values hold `$` and quotes)."""
    out: Dict[str, str] = {}
    if not path.is_file():
        return out
    for line in path.read_text(errors="replace").splitlines():
        m = re.match(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$", line)
        if not m:
            continue
        val = m.group(2).strip()
        if len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'":
            val = val[1:-1]
        out[m.group(1)] = val
    return out


class Settings:
    def __init__(self, vault: Path, dry_run: bool = False):
        self.vault = vault
        self.dry_run = dry_run
        env = env_file_values(vault / ".env")
        env.update({k: v for k, v in os.environ.items() if k.startswith("SYNC_")})
        self.role = env.get("SYNC_ROLE", "owner").strip().lower() or "owner"
        if self.role not in POLICY_DEFAULT:
            raise ValueError(f"SYNC_ROLE must be owner or agent, not {self.role!r}")
        self.machine = env.get("SYNC_MACHINE", "").strip() or socket.gethostname().split(".")[0] or "machine"
        self.interval_min = int(env.get("SYNC_INTERVAL_MIN", "60") or 60)
        self.conflicts = env.get("SYNC_CONFLICTS", "").strip().lower() or POLICY_DEFAULT[self.role]
        if self.conflicts not in ("stop", "both"):
            raise ValueError(f"SYNC_CONFLICTS must be stop or both, not {self.conflicts!r}")
        self.alert = env.get("SYNC_ALERT", "").strip() or "desktop"
        self.state_dir = Path(env.get("SYNC_STATE_DIR", "") or "~/.local/state/secondbrain").expanduser()
        # Test hook: how long one settle wait is (docs: a minute).
        self.settle_wait = float(env.get("SYNC_SETTLE_WAIT", "60") or 60)
        js = self.read_json(vault, env)
        self.remote = str(js["remote"])
        self.branch = str(js["branch"])
        self.agent_owned = [str(p).strip("/") for p in js["agentOwned"]]
        self.embedded = str(js["embeddedRepos"])
        self.max_bytes = int(float(js["maxFileMB"]) * 1024 * 1024)
        self.settle_seconds = float(js["settleSeconds"])
        self.heartbeat = bool(js["heartbeat"])

    @staticmethod
    def read_json(vault: Path, env: Dict[str, str]) -> Dict[str, object]:
        out: Dict[str, object] = dict(JSON_DEFAULTS)
        name = os.environ.get("SECONDBRAIN_SETTINGS") or env.get("SECONDBRAIN_SETTINGS") or "secondbrain.json"
        path = Path(name) if os.path.isabs(name) else vault / name
        if not path.is_file():
            return out
        try:
            data = json.loads(path.read_text())
        except (OSError, ValueError) as e:
            print(f"sync: {path.name} does not parse ({e}); using defaults", file=sys.stderr)
            return out
        sync = data.get("sync") if isinstance(data, dict) else None
        if isinstance(sync, dict):
            for k in JSON_DEFAULTS:
                if k in sync and sync[k] is not None:
                    out[k] = sync[k]
        if out["embeddedRepos"] not in ("ignore", "record"):
            out["embeddedRepos"] = "ignore"
        if not isinstance(out["agentOwned"], list):
            out["agentOwned"] = []
        return out

    @property
    def upstream(self) -> str:
        return f"{self.remote}/{self.branch}"


# ---- git ----

class Git:
    def __init__(self, vault: Path):
        self.vault = vault
        self.env = dict(os.environ, GIT_EDITOR="true", GIT_SEQUENCE_EDITOR="true", GIT_TERMINAL_PROMPT="0",
                        GIT_OPTIONAL_LOCKS="0")

    def run(self, *args: str, check: bool = True, binary: bool = False) -> subprocess.CompletedProcess:
        return subprocess.run(["git", "-C", str(self.vault), *args], check=check, capture_output=True,
                              text=not binary, env=self.env)

    def out(self, *args: str) -> str:
        return self.run(*args).stdout.strip()

    def ok(self, *args: str) -> bool:
        return self.run(*args, check=False).returncode == 0

    def git_dir(self) -> Path:
        d = self.out("rev-parse", "--git-dir")
        return Path(d) if os.path.isabs(d) else self.vault / d

    def busy(self) -> Optional[str]:
        gd = self.git_dir()
        for name in ("index.lock", "rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD"):
            if (gd / name).exists():
                return name
        return None

    def in_rebase(self) -> bool:
        gd = self.git_dir()
        return (gd / "rebase-merge").exists() or (gd / "rebase-apply").exists()

    def status(self) -> List[Tuple[str, str]]:
        """(XY, path) for every changed or untracked path."""
        raw = self.run("status", "--porcelain=v1", "-z", "--untracked-files=all").stdout
        items = raw.split("\0")
        out: List[Tuple[str, str]] = []
        i = 0
        while i < len(items) and items[i]:
            xy, path = items[i][:2], items[i][3:]
            if "R" in xy or "C" in xy:
                i += 1  # the original name follows; the new name is what is on disk
            out.append((xy, path))
            i += 1
        return out

    def staged(self) -> List[Tuple[str, str]]:
        raw = self.run("diff", "--cached", "--name-status", "-z").stdout
        items = raw.split("\0")
        out: List[Tuple[str, str]] = []
        i = 0
        while i < len(items) and items[i]:
            st = items[i]
            if st[0] in "RC":
                out.append((st[0], items[i + 2]))
                i += 3
            else:
                out.append((st[0], items[i + 1]))
                i += 2
        return out

    def staged_gitlinks(self) -> List[str]:
        raw = self.run("diff", "--cached", "--raw", "-z").stdout
        items = raw.split("\0")
        out: List[str] = []
        i = 0
        while i < len(items) and items[i]:
            meta = items[i].split()
            # :srcmode dstmode srcsha dstsha status
            rename = len(meta) >= 5 and meta[4][0] in "RC"
            if len(meta) >= 5 and ("160000" in (meta[0].lstrip(":"), meta[1])):
                out.append(items[i + 2] if rename else items[i + 1])
            i += 3 if rename else 2
        return out

    def counts(self, upstream: str) -> Tuple[int, int]:
        try:
            a, b = self.out("rev-list", "--left-right", "--count", f"HEAD...{upstream}").split()
            return int(a), int(b)
        except (subprocess.CalledProcessError, ValueError):
            return 0, 0

    def blob(self, spec: str) -> Optional[bytes]:
        r = self.run("show", spec, check=False, binary=True)
        return r.stdout if r.returncode == 0 else None


# ---- state, log, alerts ----

class State:
    def __init__(self, s: Settings):
        self.s = s
        self.file = s.state_dir / STATE_FILE
        self.log_file = s.state_dir / LOG_FILE
        self.data: Dict[str, object] = {}
        if self.file.is_file():
            try:
                self.data = json.loads(self.file.read_text())
            except ValueError:
                self.data = {}
        self.data.setdefault("alerted", {})
        self.data.setdefault("push_failures", 0)
        self.data["machine"] = s.machine
        self.data["role"] = s.role
        self.data["policy"] = s.conflicts
        self.data["vault"] = str(s.vault)

    def log(self, msg: str) -> None:
        line = f"{iso(utcnow())} {msg}"
        print(line)
        try:
            self.s.state_dir.mkdir(parents=True, exist_ok=True)
            with self.log_file.open("a") as fh:
                fh.write(line + "\n")
        except OSError:
            pass

    def save(self) -> None:
        self.s.state_dir.mkdir(parents=True, exist_ok=True)
        tmp = self.file.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.data, indent=2, sort_keys=True) + "\n")
        os.replace(tmp, self.file)

    def alert(self, key: str, title: str, text: str) -> None:
        """Once per key until clear(key): a conflict left for a day is one notification."""
        alerted: Dict[str, str] = self.data["alerted"]  # type: ignore[assignment]
        self.log(f"alert[{key}]: {title}: {text}" + (" (already sent)" if key in alerted else ""))
        if key in alerted:
            return
        alerted[key] = iso(utcnow())
        notify(self.s, title, text, self.log)

    def clear(self, key: str) -> None:
        self.data["alerted"].pop(key, None)  # type: ignore[union-attr]


def notify(s: Settings, title: str, text: str, log) -> None:
    how = s.alert
    try:
        if how.startswith("http://") or how.startswith("https://"):
            body = json.dumps({"title": title, "text": text}).encode()
            req = urllib.request.Request(how, data=body, headers={"Content-Type": "application/json"})
            urllib.request.urlopen(req, timeout=10).read()
        elif how == "desktop":
            if sys.platform == "darwin" and shutil.which("osascript"):
                script = 'display notification "%s" with title "%s"' % (text.replace('"', "'"), title.replace('"', "'"))
                subprocess.run(["osascript", "-e", script], check=False, capture_output=True, timeout=15)
            elif shutil.which("notify-send") and (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")):
                subprocess.run(["notify-send", title, text], check=False, capture_output=True, timeout=15)
            # else: the log line above is the alert
    except Exception as e:  # an alert must never fail the run
        log(f"alert delivery failed: {e}")


# ---- the run ----

class Lock:
    def __init__(self, s: Settings):
        self.dir = s.state_dir / "sync.lock"
        self.held = False

    def __enter__(self) -> bool:
        self.dir.parent.mkdir(parents=True, exist_ok=True)
        for _ in range(2):
            try:
                self.dir.mkdir()
                (self.dir / "pid").write_text(str(os.getpid()))
                self.held = True
                return True
            except FileExistsError:
                if not self.stale():
                    return False
                shutil.rmtree(self.dir, ignore_errors=True)
        return False

    def stale(self) -> bool:
        try:
            pid = int((self.dir / "pid").read_text().strip())
            os.kill(pid, 0)
            alive = True
        except (OSError, ValueError):
            alive = False
        try:
            age = time.time() - self.dir.stat().st_mtime
        except OSError:
            return True
        return not alive or age > 2 * 3600

    def __exit__(self, *exc) -> None:
        if self.held:
            shutil.rmtree(self.dir, ignore_errors=True)


def summary(paths: List[str], limit: int = 4) -> str:
    n = len(paths)
    shown = ", ".join(paths[:limit])
    more = f", +{n - limit} more" if n > limit else ""
    return f"{n} file{'s' if n != 1 else ''}: {shown}{more}"


def settle(s: Settings, git: Git, st: State) -> None:
    """Wait while changed files are still being written, then go ahead anyway."""
    if s.settle_seconds <= 0:
        return
    for check in range(SETTLE_CHECKS):
        now = time.time()
        recent = []
        for _, path in git.status():
            try:
                if now - (s.vault / path).stat().st_mtime < s.settle_seconds:
                    recent.append(path)
            except OSError:
                continue
        if not recent:
            return
        st.log(f"settle: {summary(recent)} changed in the last {int(s.settle_seconds)} s; waiting ({check + 1}/{SETTLE_CHECKS})")
        if check < SETTLE_CHECKS - 1 and s.settle_wait > 0:
            time.sleep(s.settle_wait)
    st.log("settle: still changing; going ahead")


def drop_unowned(s: Settings, git: Git) -> List[str]:
    """Owner machines never commit agent-owned files: restore tracked changes, leave untracked copies alone."""
    if s.role != "owner" or not s.agent_owned:
        return []
    dropped = []
    dirty = {path: xy for xy, path in git.status()}
    for path in s.agent_owned:
        xy = dirty.get(path)
        if xy and xy != "??":
            git.run("reset", "-q", "--", path, check=False)
            git.run("checkout", "-q", "--", path, check=False)
            dropped.append(path)
    return dropped


def guard(s: Settings, git: Git, staged: List[Tuple[str, str]], st: State) -> List[str]:
    """Reasons not to commit, naming files but never contents."""
    problems: List[str] = []
    paths = [p for status, p in staged if status != "D"]
    for p in paths:
        if SECRET_NAME.match(os.path.basename(p)):
            problems.append(f"{p}: a secret by name")
        try:
            size = (s.vault / p).stat().st_size
        except OSError:
            size = 0
        if size > s.max_bytes:
            problems.append(f"{p}: {size / (1024 * 1024):.1f} MB is over the {s.max_bytes // (1024 * 1024)} MB cap")
    scanned = gitleaks(s, st)
    if scanned is None:
        for p in paths:
            data = git.blob(f":{p}")
            if data is None:
                continue
            for name, rx in SECRET_PATTERNS:
                if rx.search(data[:SCAN_CAP]):
                    problems.append(f"{p}: looks like a {name}")
                    break
    else:
        problems.extend(scanned)
    return problems


def gitleaks(s: Settings, st: State) -> Optional[List[str]]:
    """Staged-diff scan with gitleaks when installed: a list of problems, or None when it could not run."""
    exe = shutil.which("gitleaks")
    if not exe:
        return None
    report = s.state_dir / "gitleaks-report.json"
    attempts = [
        [exe, "git", "--staged", "--no-banner", "--redact", "--exit-code", "1",
         "--report-format", "json", "--report-path", str(report), str(s.vault)],
        [exe, "protect", "--staged", "--no-banner", "--redact", "--exit-code", "1",
         "--report-format", "json", "--report-path", str(report), "--source", str(s.vault)],
    ]
    for cmd in attempts:
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=300, cwd=str(s.vault))
        except (OSError, subprocess.TimeoutExpired) as e:
            st.log(f"gitleaks did not run ({e}); using the built-in rules")
            return None
        if r.returncode == 0:
            report.unlink(missing_ok=True)
            return []
        if r.returncode == 1 and report.is_file():
            problems = []
            try:
                for f in json.loads(report.read_text()):
                    problems.append(f"{f.get('File') or '?'}: gitleaks {f.get('RuleID') or 'finding'}")
            except (OSError, ValueError):
                problems.append("gitleaks found a secret in the staged changes")
            report.unlink(missing_ok=True)
            return sorted(set(problems)) or ["gitleaks found a secret in the staged changes"]
        # no report: this gitleaks does not know the subcommand (an unknown command also exits 1); try the older one
    st.log("gitleaks returned an error for both `git --staged` and `protect --staged`; using the built-in rules")
    return None


def owner_of(s: Settings, path: str) -> str:
    """Which side owns a conflicted file: 'remote', 'local' or 'note' (a real note, policy decides)."""
    if path in s.agent_owned:
        return "local" if s.role == "agent" else "remote"
    return "note"


def copy_name(s: Settings, git: Git, path: str) -> str:
    who = "remote"
    subj = git.run("log", "-1", "--format=%s", s.upstream, "--", path, check=False).stdout.strip()
    m = re.match(r"^sync\(([^)]+)\)", subj)
    if m:
        who = m.group(1)
    p = Path(path)
    base = f"{p.stem} (conflict from {who})" if p.suffix else f"{p.name} (conflict from {who})"
    candidate = p.with_name(base + p.suffix)
    n = 1
    while (s.vault / candidate).exists():
        n += 1
        candidate = p.with_name(f"{base} {n}{p.suffix}")
    return candidate.as_posix()


def write_blob(s: Settings, git: Git, path: str, data: bytes) -> None:
    abs_path = s.vault / path
    abs_path.parent.mkdir(parents=True, exist_ok=True)
    abs_path.write_bytes(data)
    git.run("add", "--", path)


def take_side(s: Settings, git: Git, path: str, side: str) -> List[str]:
    """During a rebase, stage 2 is upstream (remote), stage 3 is the local commit being replayed."""
    remote = git.blob(f":2:{path}")
    local = git.blob(f":3:{path}")
    copies: List[str] = []
    if side == "both":
        if remote is not None and local is not None:
            write_blob(s, git, path, local)
            copy = copy_name(s, git, path)
            write_blob(s, git, copy, remote)
            copies.append(copy)
            return copies
        side = "local" if local is not None else "remote"
    keep = remote if side == "remote" else local
    if keep is None:
        git.run("rm", "-q", "--cached", "--ignore-unmatch", "--", path, check=False)
        try:
            (s.vault / path).unlink()
        except OSError:
            pass
    else:
        write_blob(s, git, path, keep)
    return copies


def rebase(s: Settings, git: Git, st: State) -> Tuple[str, List[str]]:
    """Rebase onto upstream. Returns ('ok', copies) | ('conflict', files) | ('error', [message])."""
    r = git.run("rebase", "-q", s.upstream, check=False)
    copies: List[str] = []
    while r.returncode != 0:
        if not git.in_rebase():
            return "error", [r.stderr.strip().splitlines()[-1] if r.stderr.strip() else "rebase failed"]
        conflicted = [p for p in git.out("diff", "--name-only", "--diff-filter=U").splitlines() if p]
        if not conflicted:
            git.run("rebase", "--abort", check=False)
            return "error", ["rebase stopped without conflicts: " + (r.stderr.strip() or "unknown reason")]
        unresolved = []
        for path in conflicted:
            side = owner_of(s, path)
            if side == "note":
                if s.conflicts == "stop":
                    unresolved.append(path)
                    continue
                side = "both"
            copies.extend(take_side(s, git, path, side))
            st.log(f"conflict on {path}: took {side}")
        if unresolved:
            git.run("rebase", "--abort", check=False)
            return "conflict", sorted(unresolved)
        r = git.run("rebase", "--continue", check=False)
    return "ok", copies


def heartbeat(s: Settings, git: Git) -> None:
    engine = subprocess.run(["git", "-C", str(ENGINE), "rev-parse", "--short", "HEAD"], capture_output=True,
                            text=True, check=False).stdout.strip() or None
    path = Path(".sync") / f"{s.machine}.json"
    (s.vault / path).parent.mkdir(parents=True, exist_ok=True)
    (s.vault / path).write_text(json.dumps({"machine": s.machine, "role": s.role, "at": iso(utcnow()), "engine": engine},
                                            indent=2, sort_keys=True) + "\n")
    git.run("add", "--", path.as_posix())


def run_once(s: Settings) -> int:
    st = State(s)
    git = Git(s.vault)
    now = utcnow()
    st.data["last_run"] = iso(now)
    st.data["dry_run"] = s.dry_run

    def finish(result: str, error: Optional[str] = None) -> int:
        st.data["last_result"] = result
        st.data["last_error"] = error
        try:
            ahead, behind = git.counts(s.upstream)
            st.data["ahead"], st.data["behind"] = ahead, behind
        except Exception:
            pass
        st.save()
        st.log(f"result: {result}" + (f" ({error})" if error else ""))
        return 0 if result in ("ok", "busy", "offline", "dry-run") else 1

    if not git.ok("rev-parse", "--git-dir"):
        return finish("error", f"{s.vault} is not a git checkout")

    with Lock(s) as got:
        if not got:
            return finish("busy", "another sync run is going")
        busy = git.busy()
        if busy:
            return finish("busy", f"git is busy ({busy})")
        try:
            settle(s, git, st)
            dropped = drop_unowned(s, git)
            if dropped:
                st.log(f"dropped local changes to agent-owned {', '.join(dropped)}")
            git.run("add", "-A")
            for path in s.agent_owned if s.role == "owner" else []:
                git.run("reset", "-q", "--", path, check=False)
            if s.embedded == "ignore":
                for path in git.staged_gitlinks():
                    git.run("reset", "-q", "--", path, check=False)
                    st.log(f"left out embedded repo {path}")
            staged = git.staged()
            if staged:
                problems = guard(s, git, staged, st)
                if problems:
                    git.run("reset", "-q")
                    st.alert("refused", "Second Brain sync refused to commit", "; ".join(problems))
                    return finish("refused", "; ".join(problems))
                st.clear("refused")
                if s.heartbeat:
                    heartbeat(s, git)
                    staged = git.staged()
                paths = [p for _, p in staged]
                if s.dry_run:
                    git.run("reset", "-q")
                    st.log(f"dry run: would commit {summary(paths)}")
                else:
                    ident = [] if git.run("config", "user.email", check=False).stdout.strip() else \
                        ["-c", f"user.name={s.machine}", "-c", "user.email=secondbrain-sync@localhost"]
                    r = git.run(*ident, "commit", "-q", "-m", f"sync({s.machine}): {summary(paths)}", check=False)
                    if r.returncode != 0:
                        git.run("reset", "-q")
                        return finish("error", "commit failed: " + r.stderr.strip().splitlines()[-1])
                    st.log(f"committed {summary(paths)}")
            else:
                st.clear("refused")

            fetch = git.run("fetch", "-q", s.remote, s.branch, check=False)
            if fetch.returncode != 0:
                last_ok = parse_iso(st.data.get("last_success"))  # type: ignore[arg-type]
                if last_ok is None or now - last_ok > OFFLINE_ALERT_AFTER:
                    st.alert("offline", "Second Brain sync has not reached the remote",
                             f"no successful sync since {iso(last_ok) if last_ok else 'ever'}")
                return finish("offline", fetch.stderr.strip().splitlines()[-1] if fetch.stderr.strip() else "fetch failed")
            st.clear("offline")

            if s.dry_run:
                if git.status():
                    st.log("dry run: tree is dirty, skipping the rebase")
                return finish("dry-run")

            res, detail = rebase(s, git, st)
            if res == "conflict":
                st.data["conflict_files"] = detail
                st.alert("conflict:" + ",".join(detail), "Second Brain sync stopped on a conflict",
                         f"{summary(detail)}. Local commits are kept; pull and push wait until it is resolved.")
                return finish("conflict", summary(detail))
            if res == "error":
                return finish("error", detail[0])
            for k in [k for k in st.data["alerted"] if k.startswith("conflict:")]:  # type: ignore[union-attr]
                st.clear(k)
            st.data["conflict_files"] = []
            if detail:
                st.log(f"kept both versions: {', '.join(detail)}")

            ahead, _ = git.counts(s.upstream)
            if ahead:
                pushed = False
                for attempt in (1, 2):
                    r = git.run("push", "-q", s.remote, f"HEAD:refs/heads/{s.branch}", check=False)
                    if r.returncode == 0:
                        pushed = True
                        break
                    if attempt == 1 and git.ok("fetch", "-q", s.remote, s.branch):
                        res, detail = rebase(s, git, st)
                        if res == "conflict":
                            st.data["conflict_files"] = detail
                            st.alert("conflict:" + ",".join(detail), "Second Brain sync stopped on a conflict",
                                     f"{summary(detail)}. Local commits are kept; pull and push wait until it is resolved.")
                            return finish("conflict", summary(detail))
                        if res == "error":
                            return finish("error", detail[0])
                if not pushed:
                    st.data["push_failures"] = int(st.data.get("push_failures", 0)) + 1  # type: ignore[call-overload]
                    if int(st.data["push_failures"]) >= PUSH_FAILURES_BEFORE_ALERT:  # type: ignore[call-overload]
                        st.alert("push", "Second Brain sync cannot push", r.stderr.strip().splitlines()[-1] if r.stderr.strip() else "push rejected")
                    return finish("push-failed", r.stderr.strip().splitlines()[-1] if r.stderr.strip() else "push rejected")
                st.log(f"pushed {ahead} commit{'s' if ahead != 1 else ''}")
            st.data["push_failures"] = 0
            st.clear("push")
            st.data["last_success"] = iso(utcnow())
            return finish("ok")
        except subprocess.CalledProcessError as e:
            err = (e.stderr or "").strip().splitlines()
            return finish("error", f"git {' '.join(e.cmd[3:5])} failed: {err[-1] if err else e.returncode}")


# ---- status, resolve ----

def conflict_copies(vault: Path) -> List[Tuple[str, str]]:
    """(copy, note) for every conflict copy in the checkout, tracked or not."""
    git = Git(vault)
    if not git.ok("rev-parse", "--git-dir"):
        return []
    tracked = git.run("ls-files", "-z").stdout.split("\0")
    others = git.run("ls-files", "-z", "--others", "--exclude-standard").stdout.split("\0")
    out = []
    for path in sorted(set(p for p in tracked + others if p)):
        m = CONFLICT_COPY.match(os.path.basename(path))
        if m:
            note = os.path.join(os.path.dirname(path), m.group("stem") + (m.group("suffix") or ""))
            out.append((path, note))
    return out


def cmd_status(s: Settings, as_json: bool) -> int:
    st = State(s)
    copies = conflict_copies(s.vault)
    if as_json:
        print(json.dumps({**st.data, "conflict_copies": [c for c, _ in copies]}, indent=2, sort_keys=True))
        return 0
    d = st.data
    print(f"vault:        {s.vault}")
    print(f"machine:      {s.machine} ({s.role}, conflicts: {s.conflicts})")
    print(f"last run:     {d.get('last_run') or 'never'}  result: {d.get('last_result') or '-'}")
    print(f"last success: {d.get('last_success') or 'never'}")
    if d.get("last_error"):
        print(f"last error:   {d['last_error']}")
    print(f"ahead/behind: {d.get('ahead', '?')}/{d.get('behind', '?')} vs {s.upstream}")
    if d.get("conflict_files"):
        print(f"conflict:     {', '.join(d['conflict_files'])}  (resolve by hand, the next run retries)")  # type: ignore[arg-type]
    if copies:
        print("conflict copies (sync resolve --keep local|remote NOTE):")
        for copy, note in copies:
            print(f"  {copy}  ->  {note}")
    return 0


def cmd_resolve(s: Settings, keep: Optional[str], note: Optional[str]) -> int:
    copies = conflict_copies(s.vault)
    if not keep:
        if not copies:
            print("no conflict copies")
            return 0
        for copy, n in copies:
            print(f"{copy}  ->  {n}")
        return 0
    if not note:
        print("sync resolve --keep needs the note's path", file=sys.stderr)
        return 2
    note = note.strip("/")
    mine = [c for c, n in copies if n == note]
    if not mine:
        print(f"no conflict copies for {note}", file=sys.stderr)
        return 1
    for copy in mine:
        if keep == "remote":
            os.replace(s.vault / copy, s.vault / note)
            print(f"{copy} is now {note}")
        else:
            (s.vault / copy).unlink()
            print(f"removed {copy}")
    return 0


# ---- install ----

PROTECTED = ("Documents", "Desktop", "Downloads", "Library/Mobile Documents")


def protected_on_mac(vault: Path, home: Path) -> bool:
    try:
        rel = vault.resolve().relative_to(home.resolve())
    except ValueError:
        return False
    return any(rel.as_posix() == p or rel.as_posix().startswith(p + "/") for p in PROTECTED)


def xml(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def shim_text(python: str, vault: Path) -> str:
    return (f"#!/bin/bash\n# Written by `secondbrain-vault sync install`. Runs the engine's sync from the vault,\n"
            f"# so moving the engine pin updates the sync too. Lives outside the vault because the\n"
            f"# scheduler cannot read a protected folder before the vault's launcher has its grant.\n"
            f"exec {sh_quote(python)} {sh_quote(str(HERE))} run --vault {sh_quote(str(vault))}\n")


def sh_quote(s: str) -> str:
    return "'" + s.replace("'", "'\\''") + "'"


def launchd_plist(program: List[str], interval_min: int, log_file: Path) -> str:
    args = "".join(f"<string>{xml(a)}</string>" for a in program)
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>{LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key><array>{args}</array>
  <key>StartInterval</key><integer>{interval_min * 60}</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>{xml(str(log_file))}</string>
  <key>StandardErrorPath</key><string>{xml(str(log_file))}</string>
</dict></plist>
"""


def info_plist() -> str:
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>{APP_NAME}</string>
  <key>CFBundleDisplayName</key><string>Second Brain Sync</string>
  <key>CFBundleIdentifier</key><string>{LAUNCHD_LABEL}</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>{APP_NAME}</string>
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSDocumentsFolderUsageDescription</key>
  <string>Second Brain Sync commits and pulls the markdown vault stored in your Documents folder.</string>
</dict></plist>
"""


def systemd_units(shim: Path, interval_min: int) -> Tuple[str, str]:
    service = f"""[Unit]
Description=Second Brain vault sync: commit, pull and push the vault

[Service]
Type=oneshot
ExecStart=/bin/bash {str(shim).replace('%', '%%')}
"""
    timer = f"""[Unit]
Description=Second Brain vault sync every {interval_min} minutes

[Timer]
OnBootSec=120
OnUnitActiveSec={interval_min}min
Persistent=true

[Install]
WantedBy=timers.target
"""
    return service, timer


def cmd_install(s: Settings, interval: Optional[int], render: Optional[Path], platform: str, home: Path) -> int:
    interval_min = max(1, interval or s.interval_min)
    python = sys.executable or "/usr/bin/python3"
    shim = (render / "vault-sync") if render else SHIM_DIR / "vault-sync"
    out_dir = render
    if platform == "win32":
        print("sync install: Windows is not scheduled yet. Point Task Scheduler at:\n"
              f"  {python} {HERE} run --vault {s.vault}", file=sys.stderr)
        return 2
    if platform not in ("darwin", "linux"):
        print(f"sync install: no scheduler for {platform}", file=sys.stderr)
        return 2

    def write(path: Path, text: str, mode: int = 0o644) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        path.chmod(mode)

    write(shim, shim_text(python, s.vault), 0o755)
    written = [shim]
    if platform == "darwin":
        log_file = home / "Library" / "Logs" / f"{SYSTEMD_UNIT}.log"
        if protected_on_mac(s.vault, home):
            app = (out_dir / f"{APP_NAME}.app") if out_dir else home / "Applications" / f"{APP_NAME}.app"
            write(app / "Contents" / "Info.plist", info_plist())
            written.append(app)
            if not out_dir:
                exe = app / "Contents" / "MacOS" / APP_NAME
                exe.parent.mkdir(parents=True, exist_ok=True)
                src = ENGINE / "app" / "bin" / "launcher.c"
                cmd = ["clang", "-O2", "-Wall", f'-DSECONDBRAIN_SCRIPT="{shim}"', "-o", str(exe), str(src)]
                r = subprocess.run(cmd, capture_output=True, text=True)
                if r.returncode != 0:
                    print("sync install: could not compile the launcher (install the Xcode command line tools: "
                          f"xcode-select --install)\n{r.stderr}", file=sys.stderr)
                    return 1
                subprocess.run(["codesign", "--force", "--sign", "-", str(app)], check=False, capture_output=True)
            program = ["/usr/bin/open", "-g", "-j", "-a", str(app)]
        else:
            program = ["/bin/bash", str(shim)]
        plist = (out_dir or home / "Library" / "LaunchAgents") / f"{LAUNCHD_LABEL}.plist"
        write(plist, launchd_plist(program, interval_min, log_file))
        written.append(plist)
        if not out_dir:
            uid = str(os.getuid())
            subprocess.run(["launchctl", "bootout", f"gui/{uid}", str(plist)], check=False, capture_output=True)
            subprocess.run(["launchctl", "bootstrap", f"gui/{uid}", str(plist)], check=True)
            print(f"scheduled every {interval_min} min: {plist}\nlog: {log_file}\n"
                  "The first run asks once for access to the vault's folder if it is under Documents.")
    else:
        unit_dir = out_dir or Path(os.environ.get("XDG_CONFIG_HOME") or home / ".config") / "systemd" / "user"
        service, timer = systemd_units(shim, interval_min)
        write(unit_dir / f"{SYSTEMD_UNIT}.service", service)
        write(unit_dir / f"{SYSTEMD_UNIT}.timer", timer)
        written += [unit_dir / f"{SYSTEMD_UNIT}.service", unit_dir / f"{SYSTEMD_UNIT}.timer"]
        if not out_dir:
            subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)
            subprocess.run(["systemctl", "--user", "enable", "--now", f"{SYSTEMD_UNIT}.timer"], check=True)
            print(f"scheduled every {interval_min} min: {unit_dir}/{SYSTEMD_UNIT}.timer\n"
                  f"headless box: run `loginctl enable-linger {os.environ.get('USER', '<user>')}` so it runs with nobody logged in")
    if out_dir:
        print("rendered:\n  " + "\n  ".join(str(p) for p in written))
    return 0


def cmd_uninstall(platform: str, home: Path) -> int:
    if platform == "darwin":
        plist = home / "Library" / "LaunchAgents" / f"{LAUNCHD_LABEL}.plist"
        subprocess.run(["launchctl", "bootout", f"gui/{os.getuid()}", str(plist)], check=False, capture_output=True)
        plist.unlink(missing_ok=True)
        shutil.rmtree(home / "Applications" / f"{APP_NAME}.app", ignore_errors=True)
    elif platform == "linux":
        subprocess.run(["systemctl", "--user", "disable", "--now", f"{SYSTEMD_UNIT}.timer"], check=False, capture_output=True)
        unit_dir = Path(os.environ.get("XDG_CONFIG_HOME") or home / ".config") / "systemd" / "user"
        for name in (f"{SYSTEMD_UNIT}.service", f"{SYSTEMD_UNIT}.timer"):
            (unit_dir / name).unlink(missing_ok=True)
        subprocess.run(["systemctl", "--user", "daemon-reload"], check=False, capture_output=True)
    (SHIM_DIR / "vault-sync").unlink(missing_ok=True)
    print("unscheduled. The state in ~/.local/state/secondbrain stays; delete it by hand if you mean to.")
    return 0


# ---- main ----

def default_vault() -> Path:
    if ENGINE.name == ".secondbrain":
        return ENGINE.parent
    return Path.cwd()


def main(argv: Optional[List[str]] = None, vault: Optional[Path] = None) -> int:
    ap = argparse.ArgumentParser(prog="secondbrain-vault sync", description=__doc__.split("\n\n")[0])
    ap.add_argument("--vault", type=Path)
    # --vault is accepted before or after the subcommand.
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--vault", dest="vault_after", type=Path, help="the vault checkout (default: around this engine)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p_run = sub.add_parser("run", help="one sync pass", parents=[common])
    p_run.add_argument("--dry-run", action="store_true", help="stage, scan, fetch and report; commit and push nothing")
    p_status = sub.add_parser("status", help="last run, problems, conflict copies", parents=[common])
    p_status.add_argument("--json", action="store_true")
    p_inst = sub.add_parser("install", help="schedule `run` on this machine", parents=[common])
    p_inst.add_argument("--interval", type=int, help="minutes between runs (default SYNC_INTERVAL_MIN, else 60)")
    p_inst.add_argument("--render", type=Path, help="write the scheduler files to this folder instead of installing")
    p_inst.add_argument("--platform", default=sys.platform, help=argparse.SUPPRESS)
    p_inst.add_argument("--home", type=Path, default=Path.home(), help=argparse.SUPPRESS)
    p_un = sub.add_parser("uninstall", help="remove the schedule", parents=[common])
    p_un.add_argument("--platform", default=sys.platform, help=argparse.SUPPRESS)
    p_un.add_argument("--home", type=Path, default=Path.home(), help=argparse.SUPPRESS)
    p_res = sub.add_parser("resolve", help="list conflict copies, or pick a side for one note", parents=[common])
    p_res.add_argument("--keep", choices=["local", "remote"])
    p_res.add_argument("note", nargs="?")
    args = ap.parse_args(argv)

    vault = (args.vault or args.vault_after or vault or default_vault()).resolve()
    try:
        s = Settings(vault, dry_run=getattr(args, "dry_run", False))
    except ValueError as e:
        print(f"sync: {e}", file=sys.stderr)
        return 2
    if args.cmd == "run":
        return run_once(s)
    if args.cmd == "status":
        return cmd_status(s, args.json)
    if args.cmd == "install":
        return cmd_install(s, args.interval, args.render, args.platform, args.home)
    if args.cmd == "uninstall":
        return cmd_uninstall(args.platform, args.home)
    return cmd_resolve(s, args.keep, args.note)


if __name__ == "__main__":
    sys.exit(main())
