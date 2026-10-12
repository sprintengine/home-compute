#!/usr/bin/env bash
# Builds "Home Compute Bar.app" into macos/build/. Pass --install to copy it to ~/Applications.
set -euo pipefail

cd "$(dirname "$0")"
APP_NAME="Home Compute Bar"
EXECUTABLE="HomeComputeBar"
BUNDLE_ID="dev.sprintengine.home-compute-bar"
VERSION="${VERSION:-0.1.0}"
BUILD_NUMBER="${BUILD_NUMBER:-1}"

INSTALL=0
for arg in "$@"; do
  case "$arg" in
    --install) INSTALL=1 ;;
    -h|--help) echo "usage: $0 [--install]"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 64 ;;
  esac
done

swift build -c release
BIN_DIR="$(swift build -c release --show-bin-path)"

APP="build/$APP_NAME.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN_DIR/$EXECUTABLE" "$APP/Contents/MacOS/$EXECUTABLE"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>$EXECUTABLE</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>$APP_NAME</string>
  <key>CFBundleDisplayName</key><string>$APP_NAME</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$BUILD_NUMBER</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key>
  <dict>
    <!-- The controller is usually plain http on loopback or a private network. -->
    <key>NSAllowsArbitraryLoads</key><true/>
  </dict>
  <key>NSLocalNetworkUsageDescription</key>
  <string>Home Compute Bar connects to your Home Compute controller on the local network.</string>
</dict>
</plist>
PLIST
printf 'APPL????' > "$APP/Contents/PkgInfo"

plutil -lint "$APP/Contents/Info.plist" >/dev/null
codesign --force --sign - "$APP"
codesign --verify --strict "$APP"
echo "Built $(pwd)/$APP"

if [[ $INSTALL -eq 1 ]]; then
  DEST="$HOME/Applications/$APP_NAME.app"
  mkdir -p "$HOME/Applications"
  if pgrep -xq "$EXECUTABLE"; then
    echo "Note: $APP_NAME is running; quit it and reopen to use the new build."
  fi
  rm -rf "$DEST"
  ditto "$APP" "$DEST"
  echo "Installed $DEST"
fi
