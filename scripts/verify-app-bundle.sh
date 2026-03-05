#!/usr/bin/env bash
set -euo pipefail

# A2A-97: verify packaged app has sidecar + expected metadata before release upload.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_PATH="${1:-$PROJECT_DIR/native/macos/src-tauri/target/universal-apple-darwin/release/bundle/macos/A2A Callbook.app}"

fail() {
  echo "App bundle verification failed: $1" >&2
  if [[ -d "$APP_PATH/Contents/MacOS" ]]; then
    echo "---- Contents/MacOS ----" >&2
    ls -la "$APP_PATH/Contents/MacOS" >&2 || true
  fi
  exit 1
}

[[ -d "$APP_PATH" ]] || fail "missing app bundle at $APP_PATH"
[[ -f "$APP_PATH/Contents/Info.plist" ]] || fail "missing Info.plist"
[[ -f "$APP_PATH/Contents/Resources/icon.icns" ]] || fail "missing icon.icns"

if ! ls "$APP_PATH/Contents/MacOS"/a2a-server-* >/dev/null 2>&1; then
  fail "missing bundled a2a-server sidecar binary"
fi

EXPECTED_VERSION="$(node -p "require('$PROJECT_DIR/package.json').version")"
ACTUAL_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP_PATH/Contents/Info.plist" 2>/dev/null || true)"
[[ -n "$ACTUAL_VERSION" ]] || fail "unable to read CFBundleShortVersionString"

if [[ "$ACTUAL_VERSION" != "$EXPECTED_VERSION" ]]; then
  fail "bundle version mismatch (expected $EXPECTED_VERSION, got $ACTUAL_VERSION)"
fi

echo "App bundle verification passed for $APP_PATH"
