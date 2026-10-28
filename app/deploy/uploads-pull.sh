#!/usr/bin/env bash
# uploads-pull: runs on the second machine (the video-editing Mac). Asks the Second Brain app which uploaded
# files want a working copy here, downloads each from the bucket with `b2store`, files it under
# ~/<m1Dir>/<vault folder>/ and reports back. Run it from launchd every couple of minutes (docs/uploads.md).
#
# Env (from ~/.config/uploads-pull/env or the environment):
#   UPLOADS_PULL_URL     the app's public origin, e.g. https://brain.example.com
#   UPLOADS_PULL_TOKEN   the same string as UPLOADS_PULL_TOKEN on the server
#   B2_* / B2STORE_*     read by b2store itself (its own env file)
# Needs: curl, jq, b2store. Portable to macOS bash 3.2. Never prints the token.
set -euo pipefail

CONF=${UPLOADS_PULL_ENV:-$HOME/.config/uploads-pull/env}
# shellcheck disable=SC1090
[ -r "$CONF" ] && . "$CONF"
: "${UPLOADS_PULL_URL:?set UPLOADS_PULL_URL}" "${UPLOADS_PULL_TOKEN:?set UPLOADS_PULL_TOKEN}"
B2STORE=${B2STORE:-$(command -v b2store || echo "$HOME/.local/bin/b2store")}
export B2STORE_SCRATCH_MAX_GB=${B2STORE_SCRATCH_MAX_GB:-60}
export B2STORE_MIN_FREE_GB=${B2STORE_MIN_FREE_GB:-20}

log() { printf '%s uploads-pull: %s\n' "$(date '+%F %T')" "$*" >&2; }
fsize() { stat -f %z "$1" 2>/dev/null || stat -c %s "$1"; }

# One run at a time: a multi-GB download can outlast the launchd interval.
LOCK=${TMPDIR:-/tmp}/uploads-pull.lock
if ! mkdir "$LOCK" 2>/dev/null; then
  pid=$(cat "$LOCK/pid" 2>/dev/null || true)
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then exit 0; fi
  rm -rf "$LOCK"; mkdir "$LOCK"
fi
echo $$ > "$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT

api() { # method path [json]
  local m=$1 p=$2 d=${3:-}
  if [ -n "$d" ]; then
    curl -fsS -X "$m" -H "Authorization: Bearer $UPLOADS_PULL_TOKEN" -H 'Content-Type: application/json' -d "$d" "${UPLOADS_PULL_URL%/}/api/uploads/pull$p"
  else
    curl -fsS -X "$m" -H "Authorization: Bearer $UPLOADS_PULL_TOKEN" "${UPLOADS_PULL_URL%/}/api/uploads/pull$p"
  fi
}

pending=$(api GET /pending) || { log "app unreachable"; exit 0; }
m1dir=$(printf '%s' "$pending" | jq -r '.m1Dir')
n=$(printf '%s' "$pending" | jq '.uploads | length')
[ "$n" -gt 0 ] || exit 0
log "$n file(s) waiting"

i=0
while [ "$i" -lt "$n" ]; do
  row=$(printf '%s' "$pending" | jq -c ".uploads[$i]")
  i=$((i + 1))
  id=$(printf '%s' "$row" | jq -r .id)
  b2=$(printf '%s' "$row" | jq -r .b2_path)
  dir=$(printf '%s' "$row" | jq -r .dest_dir)
  want=$(printf '%s' "$row" | jq -r .size_bytes)
  name=$(basename "$b2")
  api POST "/$id/start" >/dev/null || continue
  dest="$HOME/$m1dir/$dir"
  log "pulling $b2"
  fail() { api POST "/$id/fail" "$(jq -nc --arg e "$1" '{error:$e}')" >/dev/null || true; log "FAILED $b2: $1"; }
  if ! local_copy=$("$B2STORE" fetch "$b2" 2>/dev/null); then fail "b2store fetch failed"; continue; fi
  got=$(fsize "$local_copy")
  if [ "$got" != "$want" ]; then "$B2STORE" release "$local_copy" >/dev/null 2>&1 || true; fail "size $got does not match $want"; continue; fi
  mkdir -p "$dest"
  target="$dest/$name"
  [ -e "$target" ] && target="$dest/${name%.*}-$id.${name##*.}"
  mv "$local_copy" "$target"   # same disk as the scratch area: instant, no second copy
  api POST "/$id/done" "$(jq -nc --arg p "$target" '{path:$p}')" >/dev/null || true
  log "ok -> $target"
done
# The moved file leaves an empty scratch entry and its lease behind; gc clears them.
"$B2STORE" gc >/dev/null 2>&1 || true
