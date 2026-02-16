#!/usr/bin/env node

// ============================================================================
// npm postinstall hook — silent server setup
//
// OBJECTIVE: When `npm install -g a2acalling` runs, this script silently
// starts the A2A server and saves the initial config. No output is produced
// because npm v7+ captures all lifecycle script stdio.
//
// The VERBOSE onboarding (disclosure prompt, workspace scan instructions)
// happens when the agent runs any `a2a` command — enforceOnboarding detects
// incomplete setup and runs the full quickstart flow inline with direct stdio.
//
// This split exists because:
//   - npm postinstall: stdio is piped/captured, output is invisible to agents
//   - `a2a <command>`: agent runs directly, stdio is clean, output is visible
//
// So postinstall handles the parts that don't need output (server start),
// and the a2a binary handles the parts that DO need output (disclosure prompt).
// ============================================================================

if (process.env.CI || process.env.CONTINUOUS_INTEGRATION) process.exit(0);
if (process.env.DOCKER) process.exit(0);
if (process.env.npm_config_global !== 'true') process.exit(0);

const path = require('path');
const { spawnSync } = require('child_process');

const initCwd = process.env.INIT_CWD || process.env.HOME || process.cwd();
const cliPath = path.join(__dirname, '..', 'bin', 'cli.js');

// Run quickstart silently — starts server, saves config, detects hostname.
// All prompts auto-accept defaults (stdin is piped with no input).
// Output is captured (not shown) because npm would swallow it anyway.
const result = spawnSync(process.execPath, [cliPath, 'quickstart'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: initCwd,
  env: {
    ...process.env,
    A2A_WORKSPACE: process.env.A2A_WORKSPACE || initCwd
  }
});

if (result.error) {
  // Don't fail the install — the agent will get onboarding when it runs `a2a`.
  installMacOSApp();
  process.exit(0);
}

installMacOSApp();
process.exit(result.status || 0);

// Download and install the native macOS app from GitHub Releases
function installMacOSApp() {
  const os = require('os');
  const fs = require('fs');

  if (os.platform() !== 'darwin') return;

  try {
    const version = require('../package.json').version;
    const appDir = path.join(os.homedir(), 'Applications');
    const appPath = path.join(appDir, 'A2A Callbook.app');

    // Skip if already installed at same version
    const plistPath = path.join(appPath, 'Contents', 'Info.plist');
    if (fs.existsSync(plistPath)) {
      try {
        const plist = fs.readFileSync(plistPath, 'utf8');
        if (plist.includes(version)) {
          return; // Same version already installed
        }
      } catch (_) {}
    }

    const tarUrl = `https://github.com/onthegonow/a2a_calling/releases/download/v${version}/A2A-Callbook-${version}.app.tar.gz`;
    const tmpFile = path.join(os.tmpdir(), `a2a-callbook-${version}.tar.gz`);

    // Download
    const { execSync } = require('child_process');
    execSync(`curl -sL -o "${tmpFile}" "${tarUrl}"`, { timeout: 30000 });

    if (!fs.existsSync(tmpFile) || fs.statSync(tmpFile).size < 1000) {
      return; // Download failed or too small — skip silently
    }

    // Ensure ~/Applications exists
    fs.mkdirSync(appDir, { recursive: true });

    // Extract
    execSync(`tar -xzf "${tmpFile}" -C "${appDir}"`, { timeout: 15000 });

    // Cleanup
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  } catch (_) {
    // Silently fail — native app is optional
  }
}
