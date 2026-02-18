/**
 * A2A Skill Installer
 *
 * Copies Claude Code commands, CLAUDE.md context, SKILL.md reference, and
 * Codex AGENTS.md into a target project directory. Idempotent: skips files
 * that already exist with identical content.
 *
 * CLAUDE.md is the key file — Claude Code reads it automatically, giving the
 * agent full context about the a2a CLI, native app, and onboarding flow
 * immediately after npm install.
 *
 * SKILL.md is the deep reference for A2A — invite formatting templates,
 * incoming call handling, disclosure manifest flow, and protocol details.
 * We copy it to .claude/ so Claude Code can discover it naturally without
 * having to grep through node_modules. The .claude/ directory is already
 * used for slash commands, so this is a natural home for reference docs.
 *
 * Unlike CLAUDE.md (which is auto-loaded), the skill reference file is only
 * read when the agent explicitly looks in .claude/ — so it serves as opt-in
 * deep reference rather than always-loaded context (avoiding token bloat).
 */

const fs = require('fs');
const path = require('path');

const PACKAGE_ROOT = path.join(__dirname, '..');

// Section delimiter used to bound the A2A block inside CLAUDE.md.
// This allows safe replacement of ONLY the A2A content when updating,
// preserving any user content before or after the A2A section.
const A2A_SECTION_END_MARKER = '<!-- END A2A CALLING SECTION -->';

const SKILL_FILES = [
  // CLAUDE.md — gives Claude Code instant context about the a2a CLI
  { src: 'CLAUDE-INSTALL.md', dest: 'CLAUDE.md', mergeKey: '# A2A Calling' },
  // SKILL.md — deep reference for A2A (invite formatting, call handling, etc.)
  // Copied to .claude/ so Claude Code discovers it naturally without grepping
  // node_modules. This is opt-in context: only loaded when the agent looks.
  { src: 'SKILL.md', dest: '.claude/a2a-skill-reference.md' },
  // Claude Code slash commands — core (A2A-28)
  { src: '.claude/commands/a2a-call.md', dest: '.claude/commands/a2a-call.md' },
  { src: '.claude/commands/a2a-invite.md', dest: '.claude/commands/a2a-invite.md' },
  { src: '.claude/commands/a2a-contacts.md', dest: '.claude/commands/a2a-contacts.md' },
  { src: '.claude/commands/a2a-status.md', dest: '.claude/commands/a2a-status.md' },
  { src: '.claude/commands/a2a-setup.md', dest: '.claude/commands/a2a-setup.md' },
  // Claude Code slash commands — extended (A2A-43)
  { src: '.claude/commands/a2a-update.md', dest: '.claude/commands/a2a-update.md' },
  { src: '.claude/commands/a2a-uninstall.md', dest: '.claude/commands/a2a-uninstall.md' },
  { src: '.claude/commands/a2a-app.md', dest: '.claude/commands/a2a-app.md' },
  { src: '.claude/commands/a2a-conversations.md', dest: '.claude/commands/a2a-conversations.md' },
  { src: '.claude/commands/a2a-gui.md', dest: '.claude/commands/a2a-gui.md' },
  { src: '.claude/commands/a2a-skills.md', dest: '.claude/commands/a2a-skills.md' },
  // Codex agent instructions
  { src: '.codex/AGENTS.md', dest: '.codex/AGENTS.md' }
];

function installSkills(targetDir, options = {}) {
  const result = { installed: [], skipped: [], errors: [] };

  // Install manifest: .a2a-manifest.json
  //
  // After installing skill files, we write a manifest recording every file
  // we touched, what action was taken, and the package version. This serves
  // three purposes:
  //   1. Transparency — user can see exactly what the package added
  //   2. Clean uninstall — `a2a uninstall` reads the manifest to remove files
  //   3. Upgrade tracking — on re-install, we can compare versions and
  //      only update files that actually changed
  //
  // The manifest is written to the project root (same level as CLAUDE.md)
  // so it's easy to find.
  const manifestEntries = [];

  for (const file of SKILL_FILES) {
    const srcPath = path.join(PACKAGE_ROOT, file.src);
    const destPath = path.join(targetDir, file.dest);

    try {
      if (!fs.existsSync(srcPath)) {
        result.errors.push({ file: file.src, error: 'Source file not found' });
        manifestEntries.push({ path: file.dest, action: 'error', detail: 'Source file not found' });
        continue;
      }

      const srcContent = fs.readFileSync(srcPath, 'utf8');

      if (fs.existsSync(destPath)) {
        const existing = fs.readFileSync(destPath, 'utf8');

        // ── CLAUDE.md merge strategy ──────────────────────────────────────
        //
        // The a2acalling package installs context into the project's CLAUDE.md so
        // Claude Code has immediate awareness of the CLI, commands, and native app.
        // But projects often have their own CLAUDE.md with project-specific instructions.
        //
        // To avoid clobbering user content, we use a section-delimited merge:
        //   1. If CLAUDE.md doesn't exist: write CLAUDE-INSTALL.md as-is
        //   2. If CLAUDE.md exists WITHOUT an A2A section: append at the end
        //   3. If CLAUDE.md exists WITH an A2A section: replace only between
        //      "# A2A Calling" and "<!-- END A2A CALLING SECTION -->"
        //
        // The end marker ensures user content after the A2A block is preserved.
        // Legacy installs without the marker fall back to replace-to-EOF (old behavior)
        // but the marker is added during the update so future updates are safe.
        if (file.mergeKey) {
          if (existing.includes(file.mergeKey)) {
            // A2A section already present — find its boundaries
            const sectionStart = existing.indexOf(file.mergeKey);

            // Check if the end marker exists to determine section boundaries.
            // If found, we only replace the bounded section, preserving any
            // user content after the marker. If not found (legacy installs
            // that predate the marker), we replace from the header to EOF
            // and add the marker so future updates are safe.
            const endMarkerIndex = existing.indexOf(A2A_SECTION_END_MARKER, sectionStart);

            let existingSection;
            let after = '';

            if (endMarkerIndex !== -1) {
              // End marker found — extract only the bounded A2A section
              const sectionEnd = endMarkerIndex + A2A_SECTION_END_MARKER.length;
              existingSection = existing.slice(sectionStart, sectionEnd);
              // Preserve everything after the end marker (user's trailing content)
              after = existing.slice(sectionEnd);
            } else {
              // Legacy install without end marker — take everything from header to EOF
              // The new content includes the marker, so future updates will be safe
              existingSection = existing.slice(sectionStart);
            }

            // Compare the existing A2A section with the new source content.
            // Skip the update if they're identical (idempotent behavior).
            if (!options.force && existingSection.trim() === srcContent.trim()) {
              result.skipped.push(file.dest);
              manifestEntries.push({ path: file.dest, action: 'skipped' });
              continue;
            }

            // Replace only the A2A section, preserving content before and after
            const before = existing.slice(0, sectionStart).trimEnd();
            let merged = before ? before + '\n\n' + srcContent : srcContent;
            // Re-attach any trailing content that was after the end marker
            if (after) {
              merged = merged.trimEnd() + '\n' + after;
            }
            fs.writeFileSync(destPath, merged);
            result.installed.push(file.dest + ' (updated A2A section)');
            manifestEntries.push({ path: file.dest, action: 'updated A2A section' });
          } else {
            // Existing CLAUDE.md without A2A section — append at the end
            const merged = existing.trimEnd() + '\n\n' + srcContent;
            fs.writeFileSync(destPath, merged);
            result.installed.push(file.dest + ' (appended A2A section)');
            manifestEntries.push({ path: file.dest, action: 'appended A2A section' });
          }
          continue;
        }

        // Standard mode: skip if identical (non-merge files)
        if (!options.force && existing === srcContent) {
          result.skipped.push(file.dest);
          manifestEntries.push({ path: file.dest, action: 'skipped' });
          continue;
        }
      } else {
        // File doesn't exist yet — will be created below
      }

      // Create directory and write file
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, srcContent);
      result.installed.push(file.dest);
      manifestEntries.push({ path: file.dest, action: 'created' });
    } catch (err) {
      result.errors.push({ file: file.dest, error: err.message });
      manifestEntries.push({ path: file.dest, action: 'error', detail: err.message });
    }
  }

  // ── Write install manifest ────────────────────────────────────────────
  //
  // The manifest records every file we touched so the user (or `a2a uninstall`)
  // knows exactly what was installed. We include the manifest itself in the list
  // for completeness.
  try {
    const pkg = require('../package.json');
    const manifestPath = path.join(targetDir, '.a2a-manifest.json');

    // Add the manifest file itself to the entries list
    manifestEntries.push({ path: '.a2a-manifest.json', action: 'created' });
    // Add the install log file (written by postinstall.js)
    manifestEntries.push({ path: '.a2a-install.log', action: 'created' });

    const manifest = {
      version: pkg.version,
      installed_at: new Date().toISOString(),
      files: manifestEntries,
    };

    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  } catch (err) {
    // Non-fatal — the manifest is a convenience for cleanup, not required
    // for the skill files to work. Failure here (e.g., read-only dir)
    // should not break the install.
    result.errors.push({ file: '.a2a-manifest.json', error: err.message });
  }

  return result;
}

// CLI mode: node scripts/install-skills.js [targetDir] [--force]
if (require.main === module) {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const targetDir = args.find(a => !a.startsWith('-')) || process.cwd();

  const result = installSkills(targetDir, { force });

  if (result.installed.length) {
    console.log(`Installed ${result.installed.length} A2A skill file(s):`);
    result.installed.forEach(f => console.log(`  + ${f}`));
  }
  if (result.skipped.length) {
    console.log(`Skipped ${result.skipped.length} unchanged file(s)`);
  }
  if (result.errors.length) {
    console.error(`Errors: ${result.errors.length}`);
    result.errors.forEach(e => console.error(`  ! ${e.file}: ${e.error}`));
    process.exit(1);
  }
}

module.exports = { installSkills, SKILL_FILES };
