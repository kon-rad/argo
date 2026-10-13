#!/usr/bin/env bash
# Builds dist/SecondBrain.app — a thin double-clickable wrapper that execs
# bin/secondbrain. All launcher logic lives in that one script; this bundle
# only exists so the tool has an icon in the Dock.
set -euo pipefail

APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE_ROOT="$(cd "$APP_ROOT/.." && pwd)"
# Inside a vault the engine is <vault>/.secondbrain; standalone, the vault is the folder above app/.
if [[ "$(basename "$ENGINE_ROOT")" == ".secondbrain" ]]; then VAULT_ROOT="$(dirname "$ENGINE_ROOT")"; else VAULT_ROOT="$ENGINE_ROOT"; fi
VAULT_ROOT="${SB_VAULT_ROOT:-$VAULT_ROOT}"
BUNDLE="$APP_ROOT/dist/SecondBrain.app"
ICON_SRC="${ICON_SRC:-$VAULT_ROOT/.secondbrain-icon.png}"   # any 1024 px PNG; none = default icon

rm -rf "$BUNDLE"
mkdir -p "$BUNDLE/Contents/MacOS" "$BUNDLE/Contents/Resources"

cat > "$BUNDLE/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>SecondBrain</string>
  <key>CFBundleDisplayName</key><string>Second Brain</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID:-io.github.secondbrain.app}</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>SecondBrain</string>
  <key>CFBundleIconFile</key><string>SecondBrain</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <!-- Without a purpose string macOS denies Documents access SILENTLY rather
       than prompting, so the app never appears under Privacy & Security at
       all. This key is what makes the permission dialog exist. -->
  <key>NSDocumentsFolderUsageDescription</key>
  <string>Second Brain reads the markdown vault stored in your Documents folder.</string>
</dict>
</plist>
PLIST

# A real binary, not a script. With a script as CFBundleExecutable the process
# macOS runs is /bin/bash, so TCC attributes file access to bash and this app
# never earns an identity it can be granted Documents access under.
CFLAGS_ARCH=(-arch arm64 -arch x86_64)
clang "${CFLAGS_ARCH[@]}" -O2 -Wall \
      -DSECONDBRAIN_SCRIPT="\"$APP_ROOT/bin/secondbrain\"" \
      -o "$BUNDLE/Contents/MacOS/SecondBrain" "$APP_ROOT/bin/launcher.c" 2>/dev/null ||
  clang -O2 -Wall \
        -DSECONDBRAIN_SCRIPT="\"$APP_ROOT/bin/secondbrain\"" \
        -o "$BUNDLE/Contents/MacOS/SecondBrain" "$APP_ROOT/bin/launcher.c" ||
  { echo "error: could not compile the launcher" >&2; exit 1; }
chmod +x "$BUNDLE/Contents/MacOS/SecondBrain"

if [[ -f "$ICON_SRC" ]]; then
  ICONSET="$(mktemp -d)/SecondBrain.iconset"
  mkdir -p "$ICONSET"
  for size in 16 32 64 128 256 512; do
    sips -z "$size" "$size" "$ICON_SRC" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
    sips -z "$((size * 2))" "$((size * 2))" "$ICON_SRC" \
      --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o "$BUNDLE/Contents/Resources/SecondBrain.icns"
  rm -rf "$(dirname "$ICONSET")"
  echo "icon built from $ICON_SRC"
else
  echo "warning: no icon at $ICON_SRC — the bundle will use the generic one" >&2
fi

# Ad-hoc signature. An unsigned bundle gets a fresh identity on every launch,
# so TCC cannot attribute a Documents-access grant to it and the launch fails
# with "Operation not permitted" — the vault lives under ~/Documents. Signing
# gives the bundle a stable designated requirement, so macOS can prompt once
# and remember the answer.
codesign --force --sign - "$BUNDLE" 2>/dev/null || \
  echo "warning: codesign failed; a Finder launch may be denied Documents access" >&2

# LaunchServices caches a bundle by path, executable and all. Replacing the
# old script-based bundle here without re-registering left `open` returning
# success while launching nothing at all.
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
[[ -x "$LSREGISTER" ]] && "$LSREGISTER" -f "$BUNDLE" 2>/dev/null || true

# Finder caches bundle metadata by path; touching it makes a rebuilt icon show.
touch "$BUNDLE"
echo "built $BUNDLE"
