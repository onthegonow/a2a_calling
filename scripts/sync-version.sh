#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TAURI_CONF="$PROJECT_DIR/native/macos/src-tauri/tauri.conf.json"

PACKAGE_VERSION="$(node -p "require('$PROJECT_DIR/package.json').version")"

# A2A-95: force native bundle version to match npm package version for release parity.
node - "$TAURI_CONF" "$PACKAGE_VERSION" <<'NODE'
const fs = require('fs');
const tauriConfPath = process.argv[2];
const nextVersion = process.argv[3];

const raw = fs.readFileSync(tauriConfPath, 'utf8');
const config = JSON.parse(raw);
const prevVersion = config.version;

if (prevVersion === nextVersion) {
  console.log(`Tauri version already in sync: ${nextVersion}`);
  process.exit(0);
}

config.version = nextVersion;
fs.writeFileSync(tauriConfPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
console.log(`Updated tauri.conf.json version: ${prevVersion} -> ${nextVersion}`);
NODE
