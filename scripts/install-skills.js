/**
 * A2A Skill Installer
 *
 * Copies Claude Code commands, CLAUDE.md context, and Codex AGENTS.md into a
 * target project directory. Idempotent: skips files that already exist with
 * identical content.
 *
 * CLAUDE.md is the key file — Claude Code reads it automatically, giving the
 * agent full context about the a2a CLI, native app, and onboarding flow
 * immediately after npm install.
 */

const fs = require('fs');
const path = require('path');

const PACKAGE_ROOT = path.join(__dirname, '..');

const SKILL_FILES = [
  // CLAUDE.md — gives Claude Code instant context about the a2a CLI
  { src: 'CLAUDE-INSTALL.md', dest: 'CLAUDE.md', mergeKey: '# A2A Calling' },
  // Claude Code slash commands
  { src: '.claude/commands/a2a-call.md', dest: '.claude/commands/a2a-call.md' },
  { src: '.claude/commands/a2a-invite.md', dest: '.claude/commands/a2a-invite.md' },
  { src: '.claude/commands/a2a-contacts.md', dest: '.claude/commands/a2a-contacts.md' },
  { src: '.claude/commands/a2a-status.md', dest: '.claude/commands/a2a-status.md' },
  { src: '.claude/commands/a2a-setup.md', dest: '.claude/commands/a2a-setup.md' },
  // Codex agent instructions
  { src: '.codex/AGENTS.md', dest: '.codex/AGENTS.md' }
];

function installSkills(targetDir, options = {}) {
  const result = { installed: [], skipped: [], errors: [] };

  for (const file of SKILL_FILES) {
    const srcPath = path.join(PACKAGE_ROOT, file.src);
    const destPath = path.join(targetDir, file.dest);

    try {
      if (!fs.existsSync(srcPath)) {
        result.errors.push({ file: file.src, error: 'Source file not found' });
        continue;
      }

      const srcContent = fs.readFileSync(srcPath, 'utf8');

      if (fs.existsSync(destPath)) {
        const existing = fs.readFileSync(destPath, 'utf8');

        // Merge mode: if the file has a mergeKey, append/replace the A2A section
        // in an existing file rather than overwriting it entirely.
        if (file.mergeKey) {
          if (existing.includes(file.mergeKey)) {
            // A2A section already present — extract and compare
            const sectionStart = existing.indexOf(file.mergeKey);
            const existingSection = existing.slice(sectionStart);
            if (!options.force && existingSection.trim() === srcContent.trim()) {
              result.skipped.push(file.dest);
              continue;
            }
            // Replace the A2A section with updated content
            const before = existing.slice(0, sectionStart).trimEnd();
            const merged = before ? before + '\n\n' + srcContent : srcContent;
            fs.writeFileSync(destPath, merged);
            result.installed.push(file.dest + ' (updated A2A section)');
          } else {
            // Existing CLAUDE.md without A2A section — append
            const merged = existing.trimEnd() + '\n\n' + srcContent;
            fs.writeFileSync(destPath, merged);
            result.installed.push(file.dest + ' (appended A2A section)');
          }
          continue;
        }

        // Standard mode: skip if identical
        if (!options.force && existing === srcContent) {
          result.skipped.push(file.dest);
          continue;
        }
      }

      // Create directory and write file
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, srcContent);
      result.installed.push(file.dest);
    } catch (err) {
      result.errors.push({ file: file.dest, error: err.message });
    }
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
