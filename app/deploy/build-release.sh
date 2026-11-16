#!/usr/bin/env bash
# app/deploy/build-release.sh <app dir> - install and build the app beside the live tree, check that the built
# shared-memory CLIs load, then swap node_modules and the dist folders in by rename.
#
# deploy.sh used to run `npm ci && npm run build` in the live tree. npm ci empties node_modules first, so every CLI
# an agent started in that window (cli-org recall from a zen-agent run the dispatcher pause does not stop) died with
# `Cannot find package '<app>/node_modules/zod/index.js'`. Here the live tree is only touched by the renames at the
# end, and a failed install, build or check leaves it exactly as it was.
#
# Run as the app user. The stage is <app dir>/data/release: data/ is the app user's, survives the deploy rsync and
# is on the same filesystem, so each swap is a rename. SB_RELEASE_INSTALL and SB_RELEASE_BUILD replace the two npm
# commands (the tests use them).
set -euo pipefail

APP_DIR="$(cd "${1:?usage: build-release.sh <app dir>}" && pwd)"
STAGE="$APP_DIR/data/release"
OLD="$APP_DIR/data/release-old"
INSTALL="${SB_RELEASE_INSTALL:-npm ci --no-audit --no-fund}"
BUILD="${SB_RELEASE_BUILD:-npm run build}"
# What a running process loads, node_modules first: the dist folders swap a moment later.
PARTS=(node_modules shared/dist server/dist web/dist)

rm -rf "$STAGE" "$OLD"
mkdir -p "$STAGE" "$OLD"
rsync -a --delete --exclude node_modules --exclude dist --exclude data --exclude .git "$APP_DIR/" "$STAGE/"

echo "→ installing and building in $STAGE"
(cd "$STAGE" && bash -c "$INSTALL" && bash -c "$BUILD")

# The workspace links in node_modules are relative (node_modules/@secondbrain/contracts -> ../../shared), so the
# stage resolves exactly as the live tree will after the swap. `help` loads each CLI's whole import graph and needs
# no database.
for cli in cli-org.js cli-memory.js; do
  if ! (cd "$STAGE" && node --no-warnings "server/dist/$cli" help >/dev/null); then
    echo "✗ server/dist/$cli does not load from the new build; the live tree is unchanged" >&2
    exit 1
  fi
done
echo "✓ the shared-memory CLIs load from the new build"

# Each part is exchanged in one system call where the kernel has one (renameat2 RENAME_EXCHANGE on Linux, renamex_np
# RENAME_SWAP on macOS), so the live path never stops existing; elsewhere two renames back to back in one process.
python3 - "$APP_DIR" "$STAGE" "$OLD" "${PARTS[@]}" <<'PY'
import ctypes, ctypes.util, os, sys
app, stage, old, *parts = sys.argv[1:]
libc = ctypes.CDLL(ctypes.util.find_library('c'), use_errno=True)

def exchange(a, b):
    a, b = os.fsencode(a), os.fsencode(b)
    if hasattr(libc, 'renameat2'):
        return libc.renameat2(-100, a, -100, b, 2) == 0  # AT_FDCWD, RENAME_EXCHANGE
    if hasattr(libc, 'renamex_np'):
        return libc.renamex_np(a, b, 2) == 0  # RENAME_SWAP
    return False

for p in parts:
    new, live, gone = (os.path.join(d, p) for d in (stage, app, old))
    if not os.path.exists(new):
        continue
    os.makedirs(os.path.dirname(gone), exist_ok=True)
    if os.path.lexists(live) and exchange(new, live):
        os.rename(new, gone)  # the stage path now holds the old build
    else:
        if os.path.lexists(live):
            os.rename(live, gone)
        os.rename(new, live)
PY
rm -rf "$STAGE" "$OLD"
echo "✓ swapped in: ${PARTS[*]}"
