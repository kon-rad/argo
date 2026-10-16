#!/usr/bin/env bash
# app/bin/install-usage-push-mac.sh - run from the Mac after every change to the push code.
# launchd can't read ~/Documents (TCC), so the compiled push and the status-line wrapper are
# copied to ~/.local/share/secondbrain, the same way agent_activity.py is.
set -euo pipefail
APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$HOME/.local/share/secondbrain"
BUNDLE="$DEST/usage-push"
(cd "$APP_ROOT" && npm run -w server build >/dev/null)
rm -rf "$BUNDLE" && mkdir -p "$BUNDLE/usage" "$BUNDLE/archive"
cp "$APP_ROOT/server/dist/cli-usage-push.js" "$BUNDLE/"
for f in push readFrom walkFiles lines statusline types wire; do cp "$APP_ROOT/server/dist/usage/$f.js" "$BUNDLE/usage/"; done
for f in stage clean; do cp "$APP_ROOT/server/dist/archive/$f.js" "$BUNDLE/archive/"; done
printf '{"type":"module"}\n' > "$BUNDLE/package.json"
cp "$APP_ROOT/bin/statusline-usage.mjs" "$DEST/statusline-usage.mjs"
NODE="$(command -v node)"
PUSH_HOST="${USAGE_PUSH_HOST:?set USAGE_PUSH_HOST (ssh destination with root on the server)}"
LABEL="${USAGE_PUSH_LABEL:-com.secondbrain.usage-push}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>EnvironmentVariables</key><dict><key>USAGE_PUSH_HOST</key><string>$PUSH_HOST</string></dict>
  <key>ProgramArguments</key><array><string>$NODE</string><string>--no-warnings</string><string>$BUNDLE/cli-usage-push.js</string></array>
  <key>StartInterval</key><integer>900</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/usage-push.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/usage-push.log</string>
</dict></plist>
PLISTEOF
launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed: $BUNDLE, $DEST/statusline-usage.mjs, $PLIST"
