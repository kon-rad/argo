#!/usr/bin/env bash
# Clear the context of Claude Code on its Telegram bot so one long chat does not compound. The bot is one
# interactive session in tmux (socket and session name in TG_SOCKET, default tg), so nothing ends a conversation
# unless this runs.
#
#   claude-telegram-clear.sh              wait until the session is idle (up to 15 min), then send /clear. The nightly timer.
#   claude-telegram-clear.sh --later      wait 8 s first so the bot's own reply ("clearing") goes out, then as above.
#                                         For the bot itself when the owner sends /clear in the chat.
#   claude-telegram-clear.sh --dry-run    report idle or busy and what it would send; send nothing.
#
# Idle = the pane shows the input prompt and no "esc to interrupt" line. Busy past the wait: exit 75 and send nothing.
# Log: ~/.claude/telegram-clear.log (no message text, only what this script did).
set -u
SOCK="${TG_SOCKET:-tg}"; SESS="$SOCK"
LOG="${HOME}/.claude/telegram-clear.log"
mode=now; dry=0
for a in "$@"; do case "$a" in --later) mode=later ;; --dry-run) dry=1 ;; *) echo "usage: $0 [--later] [--dry-run]" >&2; exit 2 ;; esac; done

log() { echo "$(date -u +%FT%TZ) clear[$mode]: $*" >> "$LOG"; echo "$*"; }
pane() { tmux -L "$SOCK" capture-pane -p -t "$SESS" 2>/dev/null; }
idle() { local p; p="$(pane)"; [[ -n "$p" ]] && grep -q '❯' <<<"$p" && ! grep -q 'esc to interrupt' <<<"$p"; }

tmux -L "$SOCK" has-session -t "$SESS" 2>/dev/null || { log "no tmux session $SESS (is the bot's unit running?)"; exit 1; }
[[ $mode == later && $dry == 0 ]] && sleep 8
for _ in $(seq 1 45); do idle && break; [[ $dry == 1 ]] && { log "busy (dry run, nothing sent)"; exit 0; }; sleep 20; done
idle || { log "still busy after the wait, not clearing"; exit 75; }
if [[ $dry == 1 ]]; then log "idle, would send /clear"; exit 0; fi
tmux -L "$SOCK" send-keys -t "$SESS" "/clear" Enter
sleep 3
log "sent /clear"
