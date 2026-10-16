#!/usr/bin/env bash
# secondbrain-db-backup: nightly pg_dump -Fc of a secondbrain Postgres database
# to Backblaze B2 (through b2store, so the dump is stored encrypted), then prune.
#
#   secondbrain-db-backup.sh            dump, verify, upload, prune
#   secondbrain-db-backup.sh --dry-run  dump + verify locally, show what prune would delete
#
# Remote: db-backups/secondbrain/<host>/YYYY-MM-DD.dump  (UTC date)
# Retention: the 14 newest daily dumps + the 8 newest Sunday dumps. Pruning runs
# only after tonight's upload verified, and only touches YYYY-MM-DD.dump names.
#
# Env:
#   DB_BACKUP_URL     database URL (default: DATABASE_URL, from /etc/secondbrain/env
#                     on the droplet via the unit's EnvironmentFile)
#   DB_BACKUP_HOST    remote folder name: droplet | mac (default: droplet)
#   DB_BACKUP_PG_BIN  directory holding pg_dump/pg_restore matching the server's
#                     major version (default: whatever is on PATH)
#   DB_BACKUP_KEEP_DAILY / DB_BACKUP_KEEP_WEEKLY  (default 14 / 8)
#   B2STORE           path to b2store (default: on PATH, else ~/.local/bin/b2store)
#
# Runs on the server (systemd, as the app user) and on a laptop (launchd, from
# a copy outside ~/Documents, which launchd can't read).
# Portable to macOS bash 3.2. Never prints the database URL or B2 credentials.
set -euo pipefail
umask 077

URL=${DB_BACKUP_URL:-${DATABASE_URL:-}}
HOST=${DB_BACKUP_HOST:-droplet}
KEEP_DAILY=${DB_BACKUP_KEEP_DAILY:-14}
KEEP_WEEKLY=${DB_BACKUP_KEEP_WEEKLY:-8}
B2STORE=${B2STORE:-$(command -v b2store || echo "$HOME/.local/bin/b2store")}
PG_DUMP=pg_dump; PG_RESTORE=pg_restore
if [ -n "${DB_BACKUP_PG_BIN:-}" ]; then
  PG_DUMP=$DB_BACKUP_PG_BIN/pg_dump; PG_RESTORE=$DB_BACKUP_PG_BIN/pg_restore
fi
REMOTE=db-backups/secondbrain/$HOST
DRY=0
[ "${1:-}" = --dry-run ] && DRY=1

log() { printf '%s db-backup[%s]: %s\n' "$(date -u '+%F %TZ')" "$HOST" "$*" >&2; }
die() { log "FAILED: $*"; exit 1; }

[ -n "$URL" ] || die "no DB_BACKUP_URL or DATABASE_URL"
[ -x "$B2STORE" ] || die "b2store not found"
command -v "$PG_DUMP" >/dev/null || die "pg_dump not found ($PG_DUMP)"

# Day of week for YYYY-MM-DD, 0 = Sunday (Sakamoto; no GNU/BSD date differences).
dow() {
  local y=${1%%-*} m d t
  m=${1#*-}; m=${m%-*}; d=${1##*-}
  y=$((10#$y)); m=$((10#$m)); d=$((10#$d))
  t=(0 3 2 5 0 3 5 1 4 6 2 4)
  [ "$m" -lt 3 ] && y=$((y - 1))
  echo $(( (y + y/4 - y/100 + y/400 + ${t[$((m - 1))]} + d) % 7 ))
}

# Server and client major versions must match, or the dump is refused or
# misses features (e.g. a laptop on 15.x, the server on 16.x).
srv=$(psql_bin=${PG_DUMP%pg_dump}psql; "$psql_bin" "$URL" -Atc 'show server_version_num' 2>/dev/null || true)
cli=$("$PG_DUMP" --version | sed -E 's/.* ([0-9]+)\..*/\1/')
if [ -n "$srv" ] && [ "$((srv / 10000))" != "$cli" ]; then
  die "pg_dump $cli does not match server $((srv / 10000)); set DB_BACKUP_PG_BIN"
fi

day=$(date -u +%F)
work=$(mktemp -d "${TMPDIR:-/tmp}/sb-db-backup.XXXXXX")
trap 'rm -rf "$work"' EXIT
dump=$work/$day.dump

log "dumping to $dump"
start=$(date +%s)
"$PG_DUMP" -Fc --no-owner --no-acl -d "$URL" -f "$dump" || die "pg_dump exited $?"
# A truncated or corrupt archive fails to list its table of contents.
entries=$("$PG_RESTORE" -l "$dump" | grep -c ' TABLE DATA ' || true)
[ "${entries:-0}" -gt 0 ] || die "dump has no TABLE DATA entries"
bytes=$(wc -c < "$dump" | tr -d ' ')
log "dump ok: $bytes bytes, $entries tables with data, $(( $(date +%s) - start ))s"

if [ "$DRY" = 0 ]; then
  "$B2STORE" put "$dump" "$REMOTE" >/dev/null || die "b2store put"
  log "uploaded $REMOTE/$day.dump"
fi

# ---- prune: keep the KEEP_DAILY newest, plus the KEEP_WEEKLY newest Sundays.
names=$("$B2STORE" ls "$REMOTE" | awk '{print $NF}' | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}\.dump$' | sort -r || true)
[ -n "$names" ] || { log "nothing listed under $REMOTE; skip prune"; exit 0; }
n=0 sundays=0 deleted=0
for f in $names; do
  n=$((n + 1)); keep=0
  [ "$n" -le "$KEEP_DAILY" ] && keep=1
  if [ "$(dow "${f%.dump}")" = 0 ]; then
    sundays=$((sundays + 1))
    [ "$sundays" -le "$KEEP_WEEKLY" ] && keep=1
  fi
  [ "$keep" = 1 ] && continue
  if [ "$DRY" = 1 ]; then log "would delete $REMOTE/$f"; continue; fi
  "$B2STORE" rm "$REMOTE/$f" >/dev/null 2>&1 && deleted=$((deleted + 1)) || log "could not delete $REMOTE/$f"
done
log "done: $n dumps listed, $deleted pruned"
