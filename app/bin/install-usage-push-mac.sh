#!/usr/bin/env bash
# Explicit opt-in. Copies a standalone collector outside protected Documents folders.
set -euo pipefail
APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${USAGE_PUSH_STATE:-$HOME/.local/share/secondbrain}"
BUNDLE="$DEST/usage-push"
LABEL="${USAGE_PUSH_LABEL:-com.secondbrain.usage-push}"
[[ "$LABEL" =~ ^[a-zA-Z0-9.-]+$ ]] || { echo 'invalid USAGE_PUSH_LABEL' >&2; exit 1; }
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
# Preserve the owner's status line and restore it only while our wrapper still owns it.
configure_statusline() {
  python3 - "$1" "$DEST" "${NODE:-}" <<'STATUSLINEPY'
import json, os, shlex, sys
from pathlib import Path
mode, dest, node = sys.argv[1:]
settings = Path(os.environ.get('CLAUDE_CONFIG_DIR', str(Path.home() / '.claude'))) / 'settings.json'
backup = Path(dest) / 'claude-statusline-original.json'
data = json.loads(settings.read_text()) if settings.exists() else {}
wrapper = str(Path(dest) / 'statusline-usage.mjs')
current = data.get('statusLine')
owned = isinstance(current, dict) and wrapper in current.get('command', '')
if mode == 'restore':
    if not backup.exists() or not owned: sys.exit(0)
    old = json.loads(backup.read_text())
    if old['present']: data['statusLine'] = old['value']
    else: data.pop('statusLine', None)
    backup.unlink()
else:
    if owned: sys.exit(0)
    # An unsupported status-line type is left for the user to configure explicitly.
    if current is not None and (not isinstance(current, dict) or current.get('type') != 'command'):
        sys.exit('unsupported Claude statusLine; configure the quota wrapper manually')
    backup.parent.mkdir(parents=True, exist_ok=True)
    backup.write_text(json.dumps(dict(present='statusLine' in data, value=current)))
    backup.chmod(0o600)
    command = shlex.quote(node) + ' ' + shlex.quote(wrapper)
    if current and current.get('command'):
        command += ' -- /bin/sh -c ' + shlex.quote(current['command'])
    data['statusLine'] = dict(current or {}, type='command', command=command, refreshInterval=60)
settings.parent.mkdir(parents=True, exist_ok=True)
tmp = settings.with_suffix('.json.usage-tmp')
tmp.write_text(json.dumps(data, indent=2) + '\n')
tmp.chmod(settings.stat().st_mode & 0o777 if settings.exists() else 0o600)
tmp.replace(settings)
STATUSLINEPY
}
case "${1:-install}" in
  disable|uninstall)
    launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
    configure_statusline restore
    rm -f "$PLIST"
    echo 'usage-push disabled; history and cursor retained; rerun install to enable'
    exit 0 ;;
  doctor)
    [[ -f "$BUNDLE/cli-usage-push.js" ]] || { echo 'collector missing; run install first' >&2; exit 1; }
    # Read only the settings this installer wrote, never shell-source them.
    exec python3 - "$PLIST" <<'PY'
import os, plistlib, sys
try:
    with open(sys.argv[1], 'rb') as f: config = plistlib.load(f)
except (OSError, ValueError):
    sys.exit('collector disabled or settings missing; rerun install')
env = dict(os.environ, **config['EnvironmentVariables'])
args = config['ProgramArguments'] + ['--doctor']
os.execve(args[0], args, env)
PY
    ;;
  install) ;;
  *) echo 'usage: install-usage-push-mac.sh [install|doctor|disable|uninstall]' >&2; exit 1 ;;
esac
: "${USAGE_PUSH_HOST:?set USAGE_PUSH_HOST to your existing SSH upload destination}"
: "${USAGE_HOST:?set a unique USAGE_HOST slug for this machine}"
[[ "$USAGE_HOST" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || { echo 'invalid USAGE_HOST slug' >&2; exit 1; }
# OpenSSH must receive a destination, never an option or a shell command.
[[ "$USAGE_PUSH_HOST" =~ ^[a-zA-Z0-9][a-zA-Z0-9@._:-]*$ ]] || { echo 'invalid SSH destination' >&2; exit 1; }
command -v python3 >/dev/null
NODE="$(command -v node)"
(cd "$APP_ROOT" && npm run -w server build >/dev/null)
mkdir -p "$BUNDLE/usage" "$BUNDLE/archive" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cp "$APP_ROOT/server/dist/cli-usage-push.js" "$BUNDLE/"
for f in push readFrom walkFiles lines statusline types wire; do cp "$APP_ROOT/server/dist/usage/$f.js" "$BUNDLE/usage/"; done
for f in stage clean redact; do cp "$APP_ROOT/server/dist/archive/$f.js" "$BUNDLE/archive/"; done
printf '{"type":"module"}\n' > "$BUNDLE/package.json"
cp "$APP_ROOT/bin/statusline-usage.mjs" "$DEST/statusline-usage.mjs"
export USAGE_PUSH_STATE="$DEST" CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
export USAGE_PUSH_HOST USAGE_HOST
python3 - "$PLIST" "$LABEL" "$NODE" "$BUNDLE" <<'PY'
import os, plistlib, sys
path, label, node, bundle = sys.argv[1:]
keys = ['USAGE_PUSH_HOST', 'USAGE_HOST', 'USAGE_PUSH_STATE', 'CODEX_HOME', 'CLAUDE_PROJECTS_DIR', 'USAGE_PUSH_MAX_BYTES']
config = dict(Label=label, EnvironmentVariables={k: os.environ[k] for k in keys if k in os.environ},
    ProgramArguments=[node, '--no-warnings', bundle + '/cli-usage-push.js'], StartInterval=60,
    RunAtLoad=True, ProcessType='Background',
    StandardOutPath=os.path.expanduser('~/Library/Logs/usage-push.log'),
    StandardErrorPath=os.path.expanduser('~/Library/Logs/usage-push.log'))
with open(path, 'wb') as f: plistlib.dump(config, f)
os.chmod(path, 0o600)
PY
configure_statusline install
launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo 'usage-push installed (60 seconds); run this installer with doctor to verify local discovery'
