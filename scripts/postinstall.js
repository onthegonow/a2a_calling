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
  installSkillFiles();
  process.exit(0);
}

installSkillFiles();
process.exit(result.status || 0);

// Best-effort: install Claude Code + Codex skills into the workspace
function installSkillFiles() {
  try {
    const { installSkills } = require('./install-skills');
    installSkills(initCwd);
  } catch (e) {
    // Silent — skills can be installed later with `a2a skills`
  }
}
