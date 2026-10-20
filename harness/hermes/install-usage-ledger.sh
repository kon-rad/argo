#!/usr/bin/env bash
# install-usage-ledger.sh <hermes-home>... - put the usage-ledger plugin in each Hermes home and each of
# its profiles, and enable it there: a profile loads plugins from its own folder and its own config.yaml.
# Hermes picks it up on the next gateway or CLI start. Safe to re-run (it refreshes the copy).
# HERMES_BIN overrides the `hermes` on PATH. A config.yaml that is a symlink (kept in a git repo) is left
# alone and reported: enable the plugin in the file it points to instead.
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/usage-ledger" && pwd)"
HERMES_BIN="${HERMES_BIN:-hermes}"
[ $# -gt 0 ] || { echo "usage: $0 <hermes-home>..." >&2; exit 2; }
for root in "$@"; do
  for home in "$root" "$root"/profiles/*; do
    [ -f "$home/config.yaml" ] || continue
    mkdir -p "$home/plugins/usage-ledger"
    cp "$SRC/plugin.yaml" "$SRC/__init__.py" "$home/plugins/usage-ledger/"
    if [ -L "$home/config.yaml" ]; then
      echo "copied, NOT enabled (config.yaml is a symlink to $(readlink "$home/config.yaml")): $home"
      continue
    fi
    if grep -Eq '^\s*-\s*usage-ledger\s*$' "$home/config.yaml"; then echo "already enabled: $home"; continue; fi
    HERMES_HOME="$home" "$HERMES_BIN" plugins enable usage-ledger </dev/null >/dev/null
    grep -Eq '^\s*-\s*usage-ledger\s*$' "$home/config.yaml" && echo "enabled: $home" || { echo "enable failed: $home" >&2; exit 1; }
  done
done
