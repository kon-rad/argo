#!/usr/bin/env bash
# org-notify: one Telegram line to the owner from Claude Code's Telegram channel bot.
# Called by `cli-org ask-owner --urgent` with the message text as the only argument
# (ORG_NOTIFY_CMD points cli-org at another notifier).
#
# Uses the Claude Code Telegram channel's own token and allowlist, so the urgent
# question arrives in the chat the owner already answers Claude Code in, and the
# reply is handled by that session. Keep it off any bot other jobs depend on.
#
# Runs as the app user on the server. Prints nothing secret. Exit 0 on a 200 from Telegram.
set -euo pipefail

TEXT="${1:-}"
[ -n "$TEXT" ] || { echo "usage: org-notify.sh \"<text>\"" >&2; exit 2; }
CHANNEL_DIR="${CLAUDE_TELEGRAM_DIR:-$HOME/.claude/channels/telegram}"
ENV_FILE="$CHANNEL_DIR/.env"
ACCESS="$CHANNEL_DIR/access.json"
[ -r "$ENV_FILE" ] || { echo "no readable $ENV_FILE (run as the app user on the server)" >&2; exit 3; }
[ -r "$ACCESS" ] || { echo "no readable $ACCESS" >&2; exit 3; }

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
TOKEN="${TELEGRAM_BOT_TOKEN:-${BOT_TOKEN:-}}"
[ -n "$TOKEN" ] || { echo "no TELEGRAM_BOT_TOKEN in the channel .env" >&2; exit 3; }

# The first allowed Telegram user is the owner; a private chat's id equals the user id.
CHAT_ID="${ORG_NOTIFY_CHAT_ID:-$(jq -r '.allowFrom[0] // empty' "$ACCESS")}"
[ -n "$CHAT_ID" ] || { echo "no allowFrom user in access.json" >&2; exit 3; }

# Telegram caps a message at 4096 characters; keep well under it.
TEXT="${TEXT:0:3500}"

RESP=$(curl -sS --max-time 15 -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${CHAT_ID}" \
  --data-urlencode "text=${TEXT}" \
  --data-urlencode "disable_web_page_preview=true")
if echo "$RESP" | jq -e '.ok == true' >/dev/null 2>&1; then
  echo "telegram message $(echo "$RESP" | jq -r '.result.message_id')"
else
  echo "telegram refused: $(echo "$RESP" | jq -r '.description // "no response"' 2>/dev/null || echo "$RESP" | head -c 200)" >&2
  exit 4
fi
