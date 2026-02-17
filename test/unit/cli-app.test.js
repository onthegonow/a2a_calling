module.exports = function (test, assert, helpers) {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { spawnSync } = require('child_process');

  function run(args) {
    const tmp = helpers.tmpConfigDir('cli-app');
    const result = spawnSync(process.execPath, ['bin/cli.js', ...args], {
      encoding: 'utf8',
      timeout: 20000,
      env: { ...process.env, A2A_CONFIG_DIR: tmp.dir }
    });
    tmp.cleanup();
    return result;
  }

  test('help output documents app command', () => {
    const res = run(['help']);
    assert.equal(res.status, 0, `expected exit 0, got ${res.status}`);
    assert.includes(res.stdout, 'app                 Manage native macOS app');
    assert.includes(res.stdout, 'a2a app status');
  });

  test('app status exits successfully', () => {
    const res = run(['app', 'status']);
    assert.equal(res.status, 0, `expected exit 0, got ${res.status}. stderr=${(res.stderr || '').trim()}`);
    assert.includes(res.stdout, 'A2A Native App Status');
  });

  test('app unknown action exits with usage', () => {
    const res = run(['app', 'wat']);
    assert.equal(res.status, 1, `expected exit 1, got ${res.status}`);
    assert.includes(res.stderr, 'Usage: a2a app <status|install|uninstall>');
  });

  test('app install fails fast on non-macOS', () => {
    if (os.platform() === 'darwin') {
      assert.ok(true, 'skipped on macOS');
      return;
    }

    const res = run(['app', 'install']);
    assert.equal(res.status, 1, `expected exit 1, got ${res.status}`);
    assert.includes(res.stderr, 'only available on macOS');
  });

  test('app install gate requires onboarding unless --force (source check)', () => {
    const cliSource = fs.readFileSync(
      path.join(__dirname, '..', '..', 'bin', 'cli.js'),
      'utf8'
    );
    assert.includes(cliSource, 'Onboarding not complete. Run `a2a quickstart` first, then install the app.');
    assert.includes(cliSource, 'a2a app install --force');
  });

  test('quickstart completion offers native app install on macOS (source check)', () => {
    const cliSource = fs.readFileSync(
      path.join(__dirname, '..', '..', 'bin', 'cli.js'),
      'utf8'
    );
    assert.includes(cliSource, 'Install the native macOS app? [Y/n]');
    assert.includes(cliSource, 'You can install the native app later with: a2a app install');
  });

  test('app uninstall targets both user and system Applications paths', () => {
    const cliSource = fs.readFileSync(
      path.join(__dirname, '..', '..', 'bin', 'cli.js'),
      'utf8'
    );
    assert.includes(cliSource, "path.join(os.homedir(), 'Applications', 'A2A Callbook.app')");
    assert.includes(cliSource, "'/Applications/A2A Callbook.app'");
  });
};
