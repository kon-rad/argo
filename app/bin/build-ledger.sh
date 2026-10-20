#!/usr/bin/env bash
# app/bin/build-ledger.sh [out-dir] - the agent ledger as one file, ledger.mjs, for any machine that runs
# agents (macOS, Linux, Windows). It needs Node >= 22.5 and nothing else: no node_modules, no app checkout.
# Copy it to the machine, then: node --no-warnings ledger.mjs install --server <url> --token <t> --host <slug>
set -euo pipefail
APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$APP_ROOT/server/dist/ledger}"
VERSION="$(git -C "$APP_ROOT" rev-parse --short HEAD 2>/dev/null || echo dev)"
mkdir -p "$OUT"
"$APP_ROOT/node_modules/.bin/esbuild" "$APP_ROOT/server/src/cli-ledger.ts" --bundle --platform=node --format=esm \
  --target=node22 --outfile="$OUT/ledger.mjs" --define:LEDGER_BUNDLE="\"$VERSION\"" --log-level=warning
# The ledger runs outside the app: it must never pull in the database client or the web server.
if grep -qE "from ['\"](pg|express)['\"]" "$OUT/ledger.mjs"; then
  echo "build-ledger: the bundle imports pg or express; keep server/src/ledger on node builtins and pure parsers" >&2
  exit 1
fi
echo "$OUT/ledger.mjs ($VERSION)"
