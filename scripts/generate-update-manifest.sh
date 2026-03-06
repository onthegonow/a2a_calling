#!/usr/bin/env bash
# A2A-100: Generate Tauri updater manifest (latest.json) for GitHub Releases.
# Usage: bash scripts/generate-update-manifest.sh <version> <signature_file> [notes]

set -euo pipefail

VERSION="${1:?Usage: generate-update-manifest.sh <version> <sig_file> [notes]}"
SIG_FILE="${2:?Signature file path required}"
NOTES="${3:-Release v${VERSION}}"

REPO="onthegonow/a2a_calling"
TAR_NAME="A2A-Callbook-${VERSION}.app.tar.gz"
URL="https://github.com/${REPO}/releases/download/v${VERSION}/${TAR_NAME}"

if [ ! -f "${SIG_FILE}" ]; then
  echo "Signature file not found: ${SIG_FILE}" >&2
  exit 1
fi

SIGNATURE=$(cat "${SIG_FILE}")

cat <<EOF
{
  "version": "${VERSION}",
  "notes": "${NOTES}",
  "pub_date": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "platforms": {
    "darwin-universal": {
      "signature": "${SIGNATURE}",
      "url": "${URL}"
    },
    "darwin-aarch64": {
      "signature": "${SIGNATURE}",
      "url": "${URL}"
    },
    "darwin-x86_64": {
      "signature": "${SIGNATURE}",
      "url": "${URL}"
    }
  }
}
EOF
