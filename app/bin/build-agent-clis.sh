#!/usr/bin/env bash
# bash app/bin/build-agent-clis.sh <out-dir> - the client half of the agent CLIs as one file, cli-board.mjs, for a
# machine that is not the server (a laptop, a second Mac, a Linux box). It needs Node >= 22 and nothing else at run
# time: no node_modules, no server build, no database, no /etc/secondbrain/env. `secondbrain-vault clis install`
# runs this; it needs app/node_modules (npm ci) only to build. Same pattern as build-ledger.sh.
set -euo pipefail
APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:?usage: build-agent-clis.sh <out-dir>}"
ESBUILD="$APP_ROOT/node_modules/.bin/esbuild"
[[ -x "$ESBUILD" ]] || { echo "build-agent-clis: $ESBUILD is missing; run npm ci in $APP_ROOT first" >&2; exit 69; }
mkdir -p "$OUT"
"$ESBUILD" "$APP_ROOT/server/src/features/board/cli-remote-entry.ts" --bundle --platform=node --format=esm \
  --target=node22 --outfile="$OUT/cli-board.mjs" --log-level=warning
# The client bundle speaks HTTPS only: it must never pull in the database client, the config or the web server.
if grep -qE "from ['\"](pg|express|dotenv)['\"]|new pg\.Pool|/etc/secondbrain/env" "$OUT/cli-board.mjs"; then
  echo "build-agent-clis: the bundle loads pg, express, dotenv or the server env; keep features/board/cli-core.ts off them" >&2
  exit 1
fi
echo "$OUT/cli-board.mjs"
