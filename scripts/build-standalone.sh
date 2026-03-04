#!/usr/bin/env bash
# Build standalone Node.js binary for the A2A server using @yao-pkg/pkg.
# Usage:
#   scripts/build-standalone.sh                  # Build for current arch
#   scripts/build-standalone.sh --universal      # Build macOS universal binary (aarch64 + x86_64)
#   scripts/build-standalone.sh --arch arm64     # Build for specific arch
#   scripts/build-standalone.sh --arch x64       # Build for specific arch
#
# Output: native/macos/src-tauri/binaries/a2a-server-<target-triple>
# Requires: Node.js 20+, npm, macOS (for native binary builds)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTPUT_DIR="$PROJECT_DIR/native/macos/src-tauri/binaries"
PKG_TARGET_NODE="node20"
BINARY_NAME="a2a-server"

cd "$PROJECT_DIR"

# ── Parse args ──
UNIVERSAL=false
TARGET_ARCH=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --universal) UNIVERSAL=true; shift ;;
    --arch) TARGET_ARCH="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

# ── Detect platform ──
OS="$(uname -s)"
if [[ "$OS" != "Darwin" ]]; then
  echo "Warning: This build script is designed for macOS. Binary will target macOS regardless." >&2
fi

NATIVE_ARCH="$(uname -m)"
case "$NATIVE_ARCH" in
  arm64|aarch64) NATIVE_ARCH="arm64" ;;
  x86_64)        NATIVE_ARCH="x64" ;;
  *) echo "Unsupported architecture: $NATIVE_ARCH" >&2; exit 1 ;;
esac

# ── Ensure @yao-pkg/pkg is available ──
if ! npx --no-install pkg --version >/dev/null 2>&1; then
  echo "Installing @yao-pkg/pkg..."
  npm install --save-dev @yao-pkg/pkg
fi

# ── Ensure production dependencies are built ──
echo "Rebuilding native modules..."
npm rebuild better-sqlite3

# ── Build function ──
build_arch() {
  local arch="$1"
  local target="${PKG_TARGET_NODE}-macos-${arch}"
  local triple

  case "$arch" in
    arm64)  triple="aarch64-apple-darwin" ;;
    x64)    triple="x86_64-apple-darwin" ;;
    *) echo "Unsupported arch: $arch" >&2; return 1 ;;
  esac

  local output_path="$OUTPUT_DIR/${BINARY_NAME}-${triple}"

  echo "Building standalone binary: $target → $output_path"

  npx pkg src/server.js \
    --config pkg.config.json \
    --target "$target" \
    --output "$output_path" \
    --compress GZip

  chmod +x "$output_path"
  echo "Built: $output_path ($(du -h "$output_path" | cut -f1))"
}

# ── Execute builds ──
mkdir -p "$OUTPUT_DIR"

if $UNIVERSAL; then
  echo "=== Building macOS universal binary ==="
  build_arch "arm64"
  build_arch "x64"

  ARM_BIN="$OUTPUT_DIR/${BINARY_NAME}-aarch64-apple-darwin"
  X64_BIN="$OUTPUT_DIR/${BINARY_NAME}-x86_64-apple-darwin"
  UNIVERSAL_BIN="$OUTPUT_DIR/${BINARY_NAME}-universal-apple-darwin"

  echo "Creating universal binary with lipo..."
  lipo -create "$ARM_BIN" "$X64_BIN" -output "$UNIVERSAL_BIN"
  chmod +x "$UNIVERSAL_BIN"
  echo "Universal: $UNIVERSAL_BIN ($(du -h "$UNIVERSAL_BIN" | cut -f1))"
elif [[ -n "$TARGET_ARCH" ]]; then
  build_arch "$TARGET_ARCH"
else
  build_arch "$NATIVE_ARCH"
fi

echo ""
echo "=== Build complete ==="
ls -lh "$OUTPUT_DIR"/${BINARY_NAME}-* 2>/dev/null || echo "(no binaries found)"
