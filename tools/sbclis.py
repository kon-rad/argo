#!/usr/bin/env python3
"""secondbrain-vault clis: the agent CLIs (cli-board, cli-org, cli-projects, ...) on a machine that is not the server.

  install [--bin DIR] [--bundle FILE]   put every wrapper the feature manifests name on PATH (default ~/.local/bin)
  uninstall [--bin DIR]                 remove what install wrote, nothing else
  status [--bin DIR] [--json]           per wrapper: installed, server-only or missing on this machine

cli-board gets its HTTPS door: a bundle (app/bin/build-agent-clis.sh) that reads BOARD_URL and BOARD_TOKEN from the
environment, else from the vault .env. Every other wrapper prints one line saying it is server-only and exits 69.
Safe to re-run: a file whose bytes would not change is not touched, and a file this tool did not write (it carries
no marker line) is never overwritten or removed. The token is never read here, only whether the keys are present.
Stdlib only. The table comes from app/bin/agent-clis.json, generated from the manifests (docs/kanban-board.md, section 2).
"""
import argparse
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ENGINE = Path(__file__).resolve().parents[1]
TABLE = ENGINE / "app" / "bin" / "agent-clis.json"
BUILD = ENGINE / "app" / "bin" / "build-agent-clis.sh"
MARK = "# secondbrain-agent-cli:"
SERVER_ENV = Path("/etc/secondbrain/env")
EX_UNAVAILABLE = 69
NAME = re.compile(r"^cli-[a-z0-9][a-z0-9-]*$")
BUNDLE = "cli-board.mjs"


def say(msg: str) -> None:
    print(msg)


def bin_dir(arg) -> Path:
    if arg:
        return Path(arg).expanduser().resolve()
    env = os.environ.get("SECONDBRAIN_BIN_DIR")
    return Path(env).expanduser().resolve() if env else Path.home() / ".local" / "bin"


def data_dir() -> Path:
    env = os.environ.get("SECONDBRAIN_CLI_HOME")
    if env:
        return Path(env).expanduser().resolve()
    base = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    return Path(base) / "secondbrain" / "agent-clis"


def load_table() -> list:
    rows = json.loads(TABLE.read_text())["wrappers"]
    for r in rows:
        if not NAME.match(r["name"]) or r["door"] not in ("https", "server-only"):
            raise ValueError(f"bad row in {TABLE}: {r}")
    return rows


def https_script(name: str, bundle: Path, vault_env: Path) -> str:
    return f"""#!/bin/sh
{MARK} https {name}
# Written by `secondbrain-vault clis install`; `secondbrain-vault clis uninstall` removes it. Local edits are replaced.
# {name} over HTTPS: BOARD_URL and BOARD_TOKEN from the environment, else from the vault .env below (the bundle reads
# that file, it is never sourced). No database, no server env file, no server build.
SB_VAULT_ENV={shlex.quote(str(vault_env))}
export SB_VAULT_ENV
bundle={shlex.quote(str(bundle))}
if [ ! -f "$bundle" ]; then
  echo "{name}: its client bundle is not built on this machine; run npm ci in the engine's app/, then: secondbrain-vault clis install" >&2
  exit {EX_UNAVAILABLE}
fi
if ! command -v node >/dev/null 2>&1; then
  echo "{name}: needs Node.js 22 or newer on PATH" >&2
  exit {EX_UNAVAILABLE}
fi
exec node --no-warnings "$bundle" "$@"
"""


def server_only_script(name: str) -> str:
    return f"""#!/bin/sh
{MARK} server-only {name}
# Written by `secondbrain-vault clis install`; `secondbrain-vault clis uninstall` removes it.
echo "{name} is server-only: it needs the app's database, which this machine does not have. Run it on the server (ssh <server> {name} ...); cli-board works here over HTTPS." >&2
exit {EX_UNAVAILABLE}
"""


def marker(path: Path):
    """(door, name) when this tool wrote `path`, else None. A symlink is never ours."""
    if path.is_symlink() or not path.is_file():
        return None
    try:
        with path.open("rb") as f:
            head = f.read(512).decode("utf-8", "replace")
    except OSError:
        return None
    for line in head.splitlines()[:3]:
        if line.startswith(MARK):
            parts = line[len(MARK):].split()
            return (parts[0], parts[1]) if len(parts) >= 2 else None
    return None


def elsewhere(name: str, skip: Path):
    """The first `name` on PATH outside `skip`, if it is not one of ours (e.g. the server's deploy.sh wrapper)."""
    dirs = [d for d in os.environ.get("PATH", "").split(os.pathsep) if d and Path(d).resolve() != skip.resolve()]
    found = shutil.which(name, path=os.pathsep.join(dirs))
    return found if found and marker(Path(found)) is None else None


def write_if_changed(path: Path, text: str, mode: int) -> bool:
    data = text.encode()
    if path.is_file() and not path.is_symlink() and path.read_bytes() == data:
        if path.stat().st_mode & 0o777 != mode:
            path.chmod(mode)
            return True
        return False
    tmp = path.with_name(f".{path.name}.sbtmp")
    tmp.write_bytes(data)
    tmp.chmod(mode)
    tmp.replace(path)
    return True


def build_bundle(dest: Path, given) -> str:
    """'written', 'unchanged' or a one-line reason it could not be built (an existing bundle is then kept)."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    if given:
        new = Path(given).read_bytes()
    else:
        if not (ENGINE / "app" / "node_modules" / ".bin" / "esbuild").exists():
            return "not built: run npm ci in the engine's app/ first (or pass --bundle FILE built on another machine)"
        with tempfile.TemporaryDirectory(dir=dest.parent) as tmp:
            p = subprocess.run(["bash", str(BUILD), tmp], capture_output=True, text=True)
            if p.returncode != 0:
                return "not built: " + (p.stderr.strip().splitlines() or ["build-agent-clis.sh failed"])[-1]
            new = (Path(tmp) / BUNDLE).read_bytes()
    if dest.is_file() and dest.read_bytes() == new:
        return "unchanged"
    tmp = dest.with_name(f".{dest.name}.sbtmp")
    tmp.write_bytes(new)
    tmp.chmod(0o644)
    tmp.replace(dest)
    return "written"


def env_has_board_keys(vault_env: Path) -> list:
    """The door keys missing from the vault .env (names only; values are never read into output)."""
    present = set()
    if vault_env.is_file():
        for line in vault_env.read_text(errors="replace").splitlines():
            m = re.match(r"^\s*(?:export\s+)?(BOARD_URL|BOARD_TOKEN)\s*=\s*\S", line)
            if m:
                present.add(m.group(1))
    return [k for k in ("BOARD_URL", "BOARD_TOKEN") if k not in present]


def install(vault: Path, bin_arg=None, bundle_arg=None) -> int:
    if SERVER_ENV.exists():
        say(f"agent CLIs: {SERVER_ENV} exists, so this is the server; deploy.sh installs its wrappers. Nothing to do.")
        return 0
    if not TABLE.is_file():
        say(f"agent CLIs: skipped, this engine has no {TABLE.relative_to(ENGINE)}")
        return 0
    rows = load_table()
    bindir, home = bin_dir(bin_arg), data_dir()
    bindir.mkdir(parents=True, exist_ok=True)
    bundle = home / BUNDLE
    vault_env = vault / ".env"
    changed = kept = 0
    if any(r["door"] == "https" for r in rows):
        state = build_bundle(bundle, bundle_arg)
        changed += state == "written"
        say(f"bundle {bundle}: {state}")
    for r in rows:
        name, path = r["name"], bindir / r["name"]
        if path.exists() or path.is_symlink():
            if marker(path) is None:
                say(f"kept {path}: not written by secondbrain-vault, left alone")
                kept += 1
                continue
        else:
            other = elsewhere(name, bindir)
            if other:
                say(f"kept {name}: already on PATH at {other}, not shadowed")
                kept += 1
                continue
        text = https_script(name, bundle, vault_env) if r["door"] == "https" else server_only_script(name)
        if write_if_changed(path, text, 0o755):
            changed += 1
            say(f"wrote {path} ({r['door']})")
    say(f"agent CLIs: {changed} changed, {len(rows) - kept} in place, {kept} kept as they were")
    if bindir.resolve() not in [Path(d).resolve() for d in os.environ.get("PATH", "").split(os.pathsep) if d]:
        say(f"note: {bindir} is not on PATH; add it in your shell profile")
    missing = env_has_board_keys(vault_env)
    if missing and any(r["door"] == "https" for r in rows):
        say(f"note: {' and '.join(missing)} not in {vault_env}; cli-board needs both (docs/kanban-board.md, door 2)")
    return 0


def uninstall(bin_arg=None) -> int:
    bindir = bin_dir(bin_arg)
    removed = 0
    if bindir.is_dir():
        for path in sorted(bindir.glob("cli-*")):
            if marker(path) is not None:
                path.unlink()
                removed += 1
                say(f"removed {path}")
    bundle = data_dir() / BUNDLE
    if bundle.is_file():
        bundle.unlink()
        say(f"removed {bundle}")
        try:
            bundle.parent.rmdir()
        except OSError:
            pass
    say(f"agent CLIs: {removed} wrapper(s) removed; the vault .env is untouched")
    return 0


def status_rows(bin_arg=None) -> list:
    """Per wrapper: state is installed (https or the server's own), server-only, or missing."""
    bindir = bin_dir(bin_arg)
    out = []
    for r in load_table():
        path = bindir / r["name"]
        found = str(path) if path.exists() else (shutil.which(r["name"]) or "")
        mk = marker(Path(found)) if found else None
        if not found:
            state, detail = "missing", "run: secondbrain-vault clis install"
        elif mk and mk[0] == "server-only":
            state, detail = "server-only", f"{found} says how to reach it on the server"
        elif mk and mk[0] == "https" and not (data_dir() / BUNDLE).is_file():
            state, detail = "missing", f"{found} has no bundle; run npm ci in app/, then secondbrain-vault clis install"
        elif mk:
            state, detail = "installed", f"{found} (HTTPS door)"
        else:
            state, detail = "installed", f"{found} (not written by secondbrain-vault)"
        out.append(dict(name=r["name"], feature=r["feature"], door=r["door"], state=state, path=found, detail=detail))
    return out


def status(bin_arg=None, as_json=False) -> int:
    if not TABLE.is_file():
        say(f"agent CLIs: this engine has no {TABLE.relative_to(ENGINE)}")
        return 1
    rows = status_rows(bin_arg)
    if as_json:
        print(json.dumps(rows, indent=2))
    else:
        for r in rows:
            say(f"{r['state']:<12} {r['name']:<16} {r['detail']}")
    return 1 if any(r["state"] == "missing" for r in rows) else 0


def main(argv, vault: Path) -> int:
    ap = argparse.ArgumentParser(prog="secondbrain-vault clis", description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    p_install = sub.add_parser("install", help="put the agent CLIs on PATH")
    p_install.add_argument("--bin", help="where the wrappers go (default: $SECONDBRAIN_BIN_DIR, else ~/.local/bin)")
    p_install.add_argument("--bundle", help="a cli-board.mjs built elsewhere, instead of building one here")
    p_uninstall = sub.add_parser("uninstall", help="remove what install wrote")
    p_uninstall.add_argument("--bin")
    p_status = sub.add_parser("status", help="installed / server-only / missing, per wrapper")
    p_status.add_argument("--bin")
    p_status.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)
    if args.cmd == "install":
        return install(vault, args.bin, args.bundle)
    if args.cmd == "uninstall":
        return uninstall(args.bin)
    return status(args.bin, args.json)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:], Path.cwd()))
