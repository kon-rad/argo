#!/bin/bash
# Run as the Pi desktop user, from this checkout. Never as root.
set -euo pipefail
[ "$(uname -s)" = Linux ] || { echo "Run this installer on the Linux desktop device." >&2; exit 1; }
[ "$(id -u)" != 0 ] || { echo "Run as your desktop user, not root." >&2; exit 1; }
[ $# -ge 1 ] && [ $# -le 2 ] || { echo "usage: bash install-voice.sh /path/to/extracted-vosk-model [microphone]" >&2; exit 1; }
[ -d "$1/am" ] || { echo "Model must be an extracted Vosk model with an am/ directory." >&2; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)
CONF="$HOME/.config/sb-tv"
[ -s "$CONF/pages" ] || { echo "Configure sb-tv with a page before installing voice." >&2; exit 1; }
BACKUP="$HOME/.local/state/sb-tv/voice-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP" "$CONF"
chmod 700 "$BACKUP"
# Back up configuration before modifications. No browser profile or audio is copied.
for file in /usr/local/bin/sb-tv "$HOME/.config/labwc/rc.xml" "$CONF/default-mode" "$CONF/voice-enabled" "$CONF/voice-run" "$CONF/voice.py"; do
  if [ -f "$file" ]; then cp -p "$file" "$BACKUP/$(basename "$file")"; fi
done
python3 -m venv "$CONF/voice-venv"
"$CONF/voice-venv/bin/python" -m pip install -r "$HERE/requirements-voice.txt"
# Validate existing XML/key conflicts before replacing the system launcher.
ARGS=("$1")
[ $# -lt 2 ] || ARGS+=(--device "$2")
python3 "$HERE/configure_voice.py" "${ARGS[@]}"
install -m 700 "$HERE/voice.py" "$CONF/voice.py"
sudo install -m 755 "$HERE/bin/sb-tv" /usr/local/bin/sb-tv
echo "Configuration backup: $BACKUP"
echo "Restarting this profile's browser in windowed mode. Existing login is retained."
/usr/local/bin/sb-tv reload
if command -v labwc >/dev/null; then labwc --reconfigure; fi
echo "Press Ctrl+Alt+V with the browser visible. Wait for Listening, then say one command."
echo "Diagnostics: $CONF/voice-venv/bin/python $CONF/voice.py check"
for attempt in 1 2 3 4 5; do
  if "$CONF/voice-venv/bin/python" "$CONF/voice.py" check; then exit 0; fi
  sleep 1
done
echo "Files installed, but browser attachment failed. Inspect the diagnostics before using voice." >&2
exit 1
