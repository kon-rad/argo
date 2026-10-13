#!/usr/bin/env bash
# Fails if anything private is about to go public: IPv4 addresses other than
# loopback/any/doc ranges, emails, Telegram-style chat IDs, and every pattern in
# the (uncommitted) private denylist. A line ending in "# public-ok" is a reviewed
# test fixture and is skipped. Usage: scripts/check-public.sh [path...]
set -uo pipefail
paths=("${@:-.}")
deny="${SB_DENYLIST_FILE:-$HOME/.config/secondbrain/denylist.txt}"
hits=0
EXCL=(--exclude-dir=.git --exclude-dir=node_modules --exclude-dir=.venv --exclude=check-public.sh --exclude=LICENSE)
# Vendored upstream code (forge-std, OpenZeppelin, committed so CI needs no network) carries its maintainers'
# contact emails in docs/package.json. The generic email/IPv4/chat-id scans skip it; the private denylist
# still scans everything. Matches by path, not basename, so other dirs named lib/ are still scanned.
VENDORED='(^|/)(node_modules|package-lock\.json)'
not_vendored() { grep -vE "^[^:]*$VENDORED" || true; }
ALLOWED='127\.0\.0\.1|0\.0\.0\.0|192\.0\.2\.[0-9]{1,3}|198\.51\.100\.[0-9]{1,3}|203\.0\.113\.[0-9]{1,3}'
strip_allowed() {  # blank out allowed whole addresses so a real IP on the same line still trips
  local line="$1" prev=""
  while [[ "$line" != "$prev" ]]; do
    prev="$line"
    line=$(printf '%s' "$line" | sed -E "s/(^|[^0-9.])($ALLOWED)(\.?([^0-9.]|\$))/\1_\3/g")
  done
  printf '%s' "$line"
}
scan() {  # $1 = extended regex, $2 = label
  local out
  out=$(grep -rnIE "${EXCL[@]}" -e "$1" "${paths[@]}" 2>/dev/null | grep -v 'public-ok' | not_vendored)
  if [[ -n "$out" ]]; then echo "$out" | sed "s/\$/  [$2]/"; hits=1; fi
}
scan_ipv4() {
  local line stripped
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    stripped=$(strip_allowed "$line")
    if printf '%s' "$stripped" | grep -qE "$IPV4"; then echo "$line  [ipv4]"; hits=1; fi
  done < <(grep -rnIE "${EXCL[@]}" -e "$IPV4" "${paths[@]}" 2>/dev/null | grep -v 'public-ok' | not_vendored)
}
IPV4='\b([0-9]{1,3}\.){3}[0-9]{1,3}\b'
scan_ipv4
scan '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' email
scan 'chat[_-]?id[^A-Za-z0-9]{1,4}-?[0-9]{6,}' telegram-chat-id
if [[ -f "$deny" ]]; then
  while IFS= read -r pat; do
    pat="${pat%$'\r'}"; pat="${pat%"${pat##*[![:space:]]}"}"
    [[ -z "$pat" || "$pat" == \#* ]] && continue
    out=$(grep -rnIF "${EXCL[@]}" -e "$pat" "${paths[@]}" 2>/dev/null | grep -v "public-ok" || true)
    if [[ -n "$out" ]]; then echo "$out" | sed 's/$/  [denylist]/'; hits=1; fi
  done < "$deny"
fi
exit $hits
