#!/usr/bin/env bash
# A2A-42: Cron/CI wrapper for E2E test orchestrator.
# Runs orchestration, persists results, optionally alerts on failure.
#
# Usage:
#   scripts/run-e2e.sh              # run + persist
#   scripts/run-e2e.sh --alert      # run + persist + alert on failure
#
# Cron example (every 6 hours):
#   0 */6 * * * /root/a2acalling/scripts/run-e2e.sh --alert >> /var/log/a2a-e2e.log 2>&1

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ALERT_SCRIPT="/root/maestro/scripts/alert.sh"
ALERT_ON_FAILURE=false

for arg in "$@"; do
  case "$arg" in
    --alert) ALERT_ON_FAILURE=true ;;
    --standalone) RUN_STANDALONE=true ;;
  esac
done

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Starting E2E orchestration..."

cd "$PROJECT_DIR"

# A2A-103: Standalone E2E lane — runs only standalone app tests.
if [ "${RUN_STANDALONE:-false}" = true ]; then
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Running standalone E2E tests..."
  node test/run.js --e2e --filter standalone
  exit $?
fi

# A2A-42: Run orchestrator with JSON output and persistence.
# stdout (JSON) goes to /dev/null; stderr (regression messages, logs) passes through
# so cron log captures warnings like "REGRESSION DETECTED: ..."
if node test/e2e/orchestrate.js --json --persist > /dev/null; then
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] E2E: PASSED"
  exit 0
else
  EXIT_CODE=$?
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] E2E: FAILED (exit $EXIT_CODE)"

  if [ "$ALERT_ON_FAILURE" = true ] && [ -x "$ALERT_SCRIPT" ]; then
    "$ALERT_SCRIPT" error "E2E test failure detected — check ~/.config/openclaw/test-results/latest.json"
  fi

  exit "$EXIT_CODE"
fi
