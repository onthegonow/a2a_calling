#!/usr/bin/env node

// ============================================================================
// npm postinstall hook — skill installation + silent server setup
//
// TWO MODES:
//
// 1. Global install (npm install -g a2acalling):
//    - Silently runs quickstart to start the server and save config
//    - Installs Claude Code skills into INIT_CWD (if available)
//    - Prints getting-started summary
//
// 2. Local install (npm install a2acalling):
//    - Installs Claude Code skills (.claude/commands/) into the project
//    - Prints getting-started summary so the assisting agent has context
//    - Does NOT start the server (local installs are usually for development)
//
// The verbose onboarding (disclosure prompt, workspace scan) happens when the
// agent runs `a2a quickstart` — enforceOnboarding detects incomplete setup
// and runs the full flow inline with direct stdio.
// ============================================================================

if (process.env.CI || process.env.CONTINUOUS_INTEGRATION) process.exit(0);
if (process.env.DOCKER) process.exit(0);

const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const isGlobal = process.env.npm_config_global === 'true';
const initCwd = process.env.INIT_CWD || process.env.HOME || process.cwd();
const cliPath = path.join(__dirname, '..', 'bin', 'cli.js');

// ── Global install: silently run quickstart ──────────────────────────────
if (isGlobal) {
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
  }
}

// ── Install skill files (both global and local) ─────────────────────────
installSkillFiles();

// ── Print getting-started summary ───────────────────────────────────────
printGettingStarted();

process.exit(0);

// ── Helpers ─────────────────────────────────────────────────────────────

function installSkillFiles() {
  try {
    const { installSkills } = require('./install-skills');
    installSkills(initCwd);
  } catch (e) {
    // Silent — skills can be installed later with `a2a skills`
  }
}

function printGettingStarted() {
  const isMac = os.platform() === 'darwin';
  const pkg = require('../package.json');

  const lines = [
    '',
    '╔══════════════════════════════════════════════════════════════╗',
    '║                  A2A Calling — Installed                    ║',
    '╚══════════════════════════════════════════════════════════════╝',
    '',
    `  Version: ${pkg.version}`,
    '',
    '  ── Getting Started ──────────────────────────────────────────',
    '',
    '  1. Run onboarding (REQUIRED first step):',
    '',
    '     a2a quickstart',
    '',
    '     This starts the A2A server, detects your hostname,',
    '     and prompts you to configure what your agent shares.',
    '',
    '  2. Create an invite to share with other agents:',
    '',
    '     a2a create --name "YourAgent" --tier public --expires 7d',
    '',
    '  3. Add a contact and call them:',
    '',
    '     a2a add "a2a://host/fed_xxx" "AgentName"',
    '     a2a call "AgentName" "Hello!"',
    '',
  ];

  if (isMac) {
    lines.push(
      '  ── Native macOS App ─────────────────────────────────────────',
      '',
      '  A native Callbook app is available for macOS:',
      '',
      '     a2a app install',
      '',
      '  Installs to ~/Applications/A2A Callbook.app',
      '  (Downloads pre-built binary from GitHub releases)',
      '',
    );
  }

  lines.push(
    '  ── Full CLI Reference ───────────────────────────────────────',
    '',
    '  Onboarding & Setup:',
    '    a2a quickstart              First-time setup (port, hostname, disclosure)',
    '    a2a quickstart --force      Re-run onboarding from scratch',
    '    a2a setup                   Auto setup (gateway-aware dashboard install)',
    '    a2a status <url>            Check A2A agent status',
    '    a2a version                 Show installed version',
    '',
    '  Tokens & Invites:',
    '    a2a create [options]        Create an invite token',
    '      --name, -n  NAME         Token label',
    '      --tier, -p  TIER         public | friends | family',
    '      --expires   DURATION     1h | 1d | 7d | 30d | never',
    '    a2a list                    List active tokens',
    '    a2a revoke <id>             Revoke a token',
    '',
    '  Contacts & Calling:',
    '    a2a add <url> [name]        Add a contact from invite URL',
    '    a2a contacts                List all contacts',
    '    a2a call <contact> <msg>    Call a contact (multi-turn)',
    '      --single                  One-shot call (no back-and-forth)',
    '    a2a ping <url>              Check if agent is reachable',
    '',
    '  Dashboard & GUI:',
    '    a2a gui                     Open dashboard in browser',
    '    a2a gui --tab logs          Open specific tab',
    '',
    '  Server:',
    '    a2a server --port 3001      Start server manually',
    '    a2a update                  Update to latest version',
    '    a2a uninstall               Stop server and remove config',
    '',
  );

  if (isMac) {
    lines.push(
      '  Native App (macOS):',
      '    a2a app status              Check native app installation',
      '    a2a app install             Install/update from GitHub releases',
      '    a2a app uninstall           Remove from ~/Applications',
      '',
    );
  }

  lines.push(
    '  Skills:',
    '    a2a skills                  Install Claude Code + Codex skills',
    '    a2a skills --force          Overwrite existing skill files',
    '',
    '  ── Claude Code Skills Installed ────────────────────────────',
    '',
    '  The following slash commands are now available:',
    '    /a2a-setup     — Run onboarding or reset configuration',
    '    /a2a-call      — Call another A2A agent',
    '    /a2a-invite    — Create and share an invite token',
    '    /a2a-contacts  — List and manage contacts',
    '    /a2a-status    — Check server and agent health',
    '',
    '══════════════════════════════════════════════════════════════',
    '',
  );

  // Print to stderr — npm v7+ captures stdout from lifecycle scripts,
  // but stderr is still visible in many agent contexts
  console.error(lines.join('\n'));
  // Also print to stdout for contexts where stderr is filtered
  console.log(lines.join('\n'));
}
