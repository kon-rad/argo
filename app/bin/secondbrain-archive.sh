#!/usr/bin/env bash
# launchd target for SecondBrainArchive.app (see .hermes/scripts/install-archive-mac.sh).
set -euo pipefail
exec >>"$HOME/Library/Logs/secondbrain-archive.log" 2>&1
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
# Node comes from nvm (spec §6): nvm prepends its bin, ahead of Homebrew's newer node.
export NVM_DIR="$HOME/.nvm"
set +u; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null; set -u
exec "$HERE/secondbrain" archive
