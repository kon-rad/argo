#!/usr/bin/env bash
# Build AgentDock.app: the SwiftUI window plus the agent-dock CLI it calls, in one bundle.
#
#   ./build.sh                          build into ./build/AgentDock.app
#   ./build.sh --vault ~/my-vault       remember this vault as the default
#   ./build.sh --icon ~/logo.png        use a square PNG (1024 px is best) as the Dock icon
#   ./build.sh --install                also copy the app to /Applications
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
vault=""
icon="$here/Resources/AgentDockIcon.png"
install=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --vault) vault="$(cd "$2" && pwd)"; shift 2 ;;
    --icon) icon="$2"; shift 2 ;;
    --install) install=1; shift ;;
    *) echo "usage: build.sh [--vault DIR] [--icon PNG] [--install]" >&2; exit 2 ;;
  esac
done

cd "$here"
swift build -c release
bin="$(swift build -c release --show-bin-path)/AgentDock"

app="$here/build/AgentDock.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$bin" "$app/Contents/MacOS/AgentDock"
cp "$here/../bin/agent-dock" "$app/Contents/Resources/agent-dock"
chmod +x "$app/Contents/Resources/agent-dock"

set_dir="$(mktemp -d)/AppIcon.iconset"
mkdir -p "$set_dir"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$icon" --out "$set_dir/icon_${size}x${size}.png" >/dev/null
  sips -z "$((size * 2))" "$((size * 2))" "$icon" --out "$set_dir/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$set_dir" -o "$app/Contents/Resources/AppIcon.icns"

vault_key=""
if [ -n "$vault" ]; then
  escaped="$(printf '%s' "$vault" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g')"
  vault_key="<key>SBVaultPath</key><string>$escaped</string>"
fi

cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Agent Dock</string>
<key>CFBundleDisplayName</key><string>Agent Dock</string>
<key>CFBundleIdentifier</key><string>org.secondbrain.agent-dock</string>
<key>CFBundleExecutable</key><string>AgentDock</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSAppleEventsUsageDescription</key><string>Agent Dock opens a terminal tab for the agent you click.</string>
<key>CFBundleIconFile</key><string>AppIcon</string>
$vault_key
</dict></plist>
PLIST

codesign --force --sign - "$app" >/dev/null 2>&1
echo "built $app"
if [ "$install" -eq 1 ]; then
  rm -rf "/Applications/AgentDock.app"
  cp -R "$app" "/Applications/AgentDock.app"
  echo "installed /Applications/AgentDock.app"
fi
