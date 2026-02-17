module.exports = function(test, assert, helpers) {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');

  test('installSkills creates .claude/commands directory and copies files', () => {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-skills-'));
    try {
      const { installSkills } = require('../../scripts/install-skills');
      const result = installSkills(targetDir);

      assert.ok(result.installed.length > 0, 'Should install at least one file');
      assert.ok(fs.existsSync(path.join(targetDir, '.claude', 'commands', 'a2a-call.md')),
        'Should create a2a-call.md');
      assert.ok(fs.existsSync(path.join(targetDir, '.codex', 'AGENTS.md')),
        'Should create AGENTS.md');
    } finally {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
  });

  test('installSkills skips existing identical files', () => {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-skills-'));
    try {
      const { installSkills } = require('../../scripts/install-skills');
      installSkills(targetDir);
      const result2 = installSkills(targetDir);

      assert.ok(result2.skipped.length > 0, 'Should skip files on second run');
      assert.equal(result2.installed.length, 0, 'Should not re-install identical files');
    } finally {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
  });

  test('installSkills with force overwrites existing files', () => {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-skills-'));
    try {
      const { installSkills } = require('../../scripts/install-skills');
      installSkills(targetDir);
      const result2 = installSkills(targetDir, { force: true });

      assert.ok(result2.installed.length > 0, 'Should overwrite files with force');
    } finally {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
  });

  test('installSkills returns summary with correct counts', () => {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-skills-'));
    try {
      const { installSkills } = require('../../scripts/install-skills');
      const result = installSkills(targetDir);

      assert.ok(Array.isArray(result.installed), 'Should have installed array');
      assert.ok(Array.isArray(result.skipped), 'Should have skipped array');
      assert.ok(Array.isArray(result.errors), 'Should have errors array');
      assert.equal(result.errors.length, 0, 'Should have no errors');
    } finally {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
  });
};
