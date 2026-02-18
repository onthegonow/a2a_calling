// ============================================================================
// Shared cleanup function used by both:
//   1. npm preuninstall hook (scripts/preuninstall.js)
//   2. `a2a uninstall` CLI command (bin/cli.js)
//
// Reads .a2a-manifest.json to determine which files to remove.
// CLAUDE.md section removal uses the same boundary markers as the
// merge logic in installSkills() — "# A2A Calling" start marker
// and "<!-- END A2A CALLING SECTION -->" end marker.
//
// Returns { removed: string[], preserved: string[], errors: string[] }
// so callers can print a meaningful summary.
// ============================================================================

const fs = require('fs');
const path = require('path');

// These markers must match the ones used in install-skills.js merge logic.
// If they diverge, cleanup will fail to find the section boundaries.
const A2A_SECTION_START = '# A2A Calling';
const A2A_SECTION_END = '<!-- END A2A CALLING SECTION -->';

/**
 * cleanupProjectFiles — manifest-driven removal of all postinstall artifacts
 *
 * Reads .a2a-manifest.json from targetDir, then removes every file listed in
 * the manifest. CLAUDE.md gets special handling: only the A2A section is
 * removed, preserving any user content before/after. Empty directories
 * (.claude/commands/, .claude/) are cleaned up if no non-a2a files remain.
 *
 * @param {string} targetDir - The project directory containing .a2a-manifest.json
 * @returns {{ removed: string[], preserved: string[], errors: string[] }}
 */
function cleanupProjectFiles(targetDir) {
  const result = { removed: [], preserved: [], errors: [] };
  const manifestPath = path.join(targetDir, '.a2a-manifest.json');

  // If manifest doesn't exist, skip cleanup gracefully.
  // This happens for manual installs, old versions, or projects where the
  // manifest was already cleaned up. Better to leave files than crash.
  if (!fs.existsSync(manifestPath)) {
    return result;
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    // Corrupt or unreadable manifest — can't determine what to clean up.
    // Return gracefully so npm uninstall doesn't fail.
    result.errors.push(`.a2a-manifest.json: could not parse (${err.message})`);
    return result;
  }

  const files = manifest.files || [];

  for (const entry of files) {
    // Skip the manifest itself — we remove it last, after all other files
    if (entry.path === '.a2a-manifest.json') continue;

    const filePath = path.join(targetDir, entry.path);

    // If a file listed in manifest doesn't exist on disk, skip it silently.
    // This handles cases where the user manually deleted files, or a previous
    // partial cleanup already removed some files.
    if (!fs.existsSync(filePath)) continue;

    // ── CLAUDE.md: section removal, not whole-file deletion ──────────────
    //
    // The user may have their own project-specific content in CLAUDE.md.
    // We only remove the A2A section (bounded by start/end markers), leaving
    // everything else intact.
    if (entry.path === 'CLAUDE.md') {
      try {
        const cleaned = removeA2ASectionFromClaudeMd(filePath);
        if (cleaned === 'deleted') {
          result.removed.push('CLAUDE.md (was A2A-only, deleted entirely)');
        } else if (cleaned === 'trimmed') {
          result.preserved.push('CLAUDE.md (A2A section removed, user content preserved)');
        } else {
          // 'no-section' — CLAUDE.md exists but has no A2A section.
          // This shouldn't happen if the manifest says it was installed, but
          // could occur if the user manually edited it. Leave it alone.
          result.preserved.push('CLAUDE.md (no A2A section found, left unchanged)');
        }
      } catch (err) {
        result.errors.push(`CLAUDE.md: ${err.message}`);
      }
      continue;
    }

    // ── All other files: delete entirely ─────────────────────────────────
    try {
      fs.rmSync(filePath, { force: true });
      result.removed.push(entry.path);
    } catch (err) {
      // If file permissions prevent deletion, log warning and continue.
      // We don't want a single permission error to abort the entire cleanup.
      result.errors.push(`${entry.path}: ${err.message}`);
    }
  }

  // ── Empty directory cleanup ──────────────────────────────────────────────
  //
  // After removing .claude/commands/a2a-*.md and .claude/a2a-skill-reference.md,
  // the directories may be empty. We clean them up to avoid leaving empty dirs,
  // but ONLY if they contain no non-a2a files (user's own commands, settings, etc.).
  cleanupEmptyDir(path.join(targetDir, '.claude', 'commands'), result);
  cleanupEmptyDir(path.join(targetDir, '.claude'), result);
  cleanupEmptyDir(path.join(targetDir, '.codex'), result);

  // ── Remove the install log ───────────────────────────────────────────────
  //
  // .a2a-install.log is written by postinstall.js as a convenience log.
  // It's listed in the manifest but we also try to remove it explicitly
  // in case the manifest entry was missing (belt and suspenders).
  const logPath = path.join(targetDir, '.a2a-install.log');
  if (fs.existsSync(logPath)) {
    try {
      fs.rmSync(logPath, { force: true });
      // Only add to removed list if not already tracked from manifest iteration
      if (!result.removed.includes('.a2a-install.log')) {
        result.removed.push('.a2a-install.log');
      }
    } catch (err) {
      result.errors.push(`.a2a-install.log: ${err.message}`);
    }
  }

  // ── Remove the manifest itself last ──────────────────────────────────────
  //
  // The manifest is the cleanup driver, so we remove it after everything else.
  // If this fails, the manifest is left behind — which is acceptable since
  // a stale manifest is harmless and helps debug failed cleanups.
  try {
    fs.rmSync(manifestPath, { force: true });
    result.removed.push('.a2a-manifest.json');
  } catch (err) {
    result.errors.push(`.a2a-manifest.json: ${err.message}`);
  }

  return result;
}

/**
 * removeA2ASectionFromClaudeMd — surgically removes the A2A section from CLAUDE.md
 *
 * Three outcomes:
 *   - 'deleted'    : File was entirely A2A content, deleted the file
 *   - 'trimmed'    : A2A section removed, remaining user content preserved
 *   - 'no-section' : No A2A section found (file left unchanged)
 *
 * Edge case: CLAUDE.md becomes empty after A2A section removal.
 * If the only content was the A2A section, the file would be left as
 * whitespace-only, which is confusing. Delete it entirely instead.
 *
 * Edge case: Legacy installs without end marker.
 * Pre-A2A-34 installs wrote the A2A section without the
 * <!-- END A2A CALLING SECTION --> marker. For these, we fall back
 * to removing from "# A2A Calling" to EOF, same as the old merge
 * replacement behavior. This means any user content added after the
 * A2A section in a legacy install will be lost — but this is the
 * same behavior they already had on upgrade, so it's not a regression.
 */
function removeA2ASectionFromClaudeMd(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');

  // If the A2A section start marker isn't present, nothing to remove
  if (!content.includes(A2A_SECTION_START)) {
    return 'no-section';
  }

  const sectionStart = content.indexOf(A2A_SECTION_START);
  const endMarkerIndex = content.indexOf(A2A_SECTION_END, sectionStart);

  let before, after;

  if (endMarkerIndex !== -1) {
    // End marker found — extract content before and after the bounded section.
    // trimEnd/trimStart collapse the whitespace gap left by the removed section.
    const sectionEnd = endMarkerIndex + A2A_SECTION_END.length;
    before = content.slice(0, sectionStart).trimEnd();
    after = content.slice(sectionEnd).trimStart();
  } else {
    // Legacy install without end marker — remove from header to EOF.
    // Everything after "# A2A Calling" is considered part of the A2A section.
    before = content.slice(0, sectionStart).trimEnd();
    after = '';
  }

  // Reassemble the file from the non-A2A portions
  let cleaned;
  if (before && after) {
    // Content exists both before and after — join with double newline
    cleaned = before + '\n\n' + after;
  } else if (before) {
    cleaned = before;
  } else if (after) {
    cleaned = after;
  } else {
    cleaned = '';
  }

  // Collapse any triple+ blank lines into double blank lines.
  // This prevents ugly whitespace gaps where the A2A section used to be.
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

  // Edge case: CLAUDE.md becomes empty after A2A section removal.
  // If the only content was the A2A section, the file would be left as
  // whitespace-only, which is confusing. Delete it entirely instead.
  if (!cleaned.trim()) {
    fs.rmSync(filePath, { force: true });
    return 'deleted';
  }

  // Write the cleaned content back, ensuring the file ends with a newline
  fs.writeFileSync(filePath, cleaned.trimEnd() + '\n');
  return 'trimmed';
}

/**
 * cleanupEmptyDir — removes a directory if it exists and contains no files.
 *
 * After removing A2A skill files, directories like .claude/commands/ may be
 * empty. We remove them to avoid clutter, but ONLY if no user files remain.
 * This prevents accidentally deleting directories that contain the user's
 * own Claude Code commands or settings.
 */
function cleanupEmptyDir(dirPath, result) {
  try {
    if (!fs.existsSync(dirPath)) return;

    // Check if directory stat confirms it's actually a directory
    const stat = fs.statSync(dirPath);
    if (!stat.isDirectory()) return;

    const entries = fs.readdirSync(dirPath);

    // Only remove if the directory is completely empty.
    // Any remaining files (user's own commands, .gitkeep, etc.) mean we keep it.
    if (entries.length === 0) {
      fs.rmdirSync(dirPath);
      result.removed.push(dirPath.split(path.sep).slice(-2).join('/') + '/ (empty directory)');
    }
  } catch (err) {
    // Directory cleanup is best-effort. Failures here are non-fatal —
    // an empty directory is harmless, just slightly untidy.
  }
}

module.exports = { cleanupProjectFiles };
