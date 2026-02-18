#!/usr/bin/env node

// ============================================================================
// npm preuninstall hook — manifest-driven cleanup
//
// When `npm uninstall a2acalling` runs, npm calls this script BEFORE
// removing the package from node_modules. We read .a2a-manifest.json
// to find every file our postinstall created and remove them cleanly.
//
// CLAUDE.md gets special handling: we only remove the A2A section
// (between "# A2A Calling" and "<!-- END A2A CALLING SECTION -->"),
// preserving any project-specific content the user added before/after.
//
// If the manifest doesn't exist (manual install, old version), we
// skip cleanup gracefully — better to leave files than crash the uninstall.
// ============================================================================

// Skip in CI environments — cleanup is not needed in ephemeral containers
if (process.env.CI || process.env.CONTINUOUS_INTEGRATION) process.exit(0);
if (process.env.DOCKER) process.exit(0);

try {
  const path = require('path');
  const { cleanupProjectFiles } = require('./cleanup');

  // INIT_CWD is set by npm to the directory where `npm uninstall` was run.
  // This is the project root where postinstall placed the skill files.
  // Falls back to cwd() which should also be the project root during npm lifecycle.
  const targetDir = process.env.INIT_CWD || process.cwd();

  const result = cleanupProjectFiles(targetDir);

  // Print a short summary so the user (or agent) knows what was cleaned up.
  // This output may be suppressed by npm v7+ unless --foreground-scripts is used,
  // but it's still useful for debugging and for agents that capture stderr.
  if (result.removed.length > 0) {
    console.error(`a2acalling: cleaned up ${result.removed.length} file(s):`);
    for (const f of result.removed) {
      console.error(`  - ${f}`);
    }
  }
  if (result.preserved.length > 0) {
    for (const f of result.preserved) {
      console.error(`  ~ ${f}`);
    }
  }
  if (result.errors.length > 0) {
    console.error(`  Warnings (${result.errors.length}):`);
    for (const e of result.errors) {
      console.error(`  ! ${e}`);
    }
  }
  if (result.removed.length === 0 && result.preserved.length === 0 && result.errors.length === 0) {
    // No manifest found or manifest was empty — nothing to clean up.
    // This is expected for fresh installs that never ran postinstall,
    // or for projects where cleanup was already done via `a2a uninstall`.
    console.error('a2acalling: no install manifest found, skipping project cleanup.');
    console.error('  Tip: run `a2a uninstall` to also remove server config and database.');
  }
} catch (err) {
  // CRITICAL: Never crash the npm uninstall process.
  // If our cleanup fails for any reason, npm should still be able to remove
  // the package from node_modules. A failed cleanup leaves orphaned files,
  // which is annoying but not harmful. A crashed uninstall is much worse.
  console.error(`a2acalling: cleanup warning — ${err.message}`);
}

process.exit(0);
