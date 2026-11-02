#!/usr/bin/env bash
# ExecStartPost for the Claude Code Telegram unit: wait up to 60 s for the Telegram channel plugin's process
# (`bun server.ts`) to start. Some Claude Code versions start the session but never launch it (/mcp shows the
# plugin as failed, no message arrives). Exiting non-zero fails the start, so Restart=on-failure tries again.
set -u
for _ in $(seq 1 30); do
  pgrep -u "$(id -un)" -f 'bun server.ts' >/dev/null && exit 0
  sleep 2
done
echo "claude-telegram: Telegram plugin did not start within 60 s" >&2
exit 1
