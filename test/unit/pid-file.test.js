/**
 * PID File Tests
 *
 * Covers: writePidFile, readPidFile, removePidFile, isProcessAlive, killExistingServer
 */

module.exports = function (test, assert, helpers) {
  const fs = require('fs');
  const path = require('path');
  const { spawn } = require('child_process');

  // Fresh require helper — pid-file reads CONFIG_DIR at require time
  function requirePidFile(configDir) {
    const modPath = require.resolve('../../src/lib/pid-file');
    delete require.cache[modPath];
    process.env.A2A_CONFIG_DIR = configDir;
    return require('../../src/lib/pid-file');
  }

  test('writePidFile writes PID to a2a-server.pid', () => {
    const tmp = helpers.tmpConfigDir('pid-write');
    const pf = requirePidFile(tmp.dir);

    pf.writePidFile(12345);

    const pidPath = path.join(tmp.dir, 'a2a-server.pid');
    assert.ok(fs.existsSync(pidPath), 'PID file should exist');
    const content = fs.readFileSync(pidPath, 'utf8').trim();
    assert.equal(content, '12345', 'PID file should contain the PID');

    tmp.cleanup();
  });

  test('readPidFile returns the PID as a number', () => {
    const tmp = helpers.tmpConfigDir('pid-read');
    const pf = requirePidFile(tmp.dir);

    fs.writeFileSync(path.join(tmp.dir, 'a2a-server.pid'), '42\n');
    const pid = pf.readPidFile();
    assert.equal(pid, 42, 'Should parse PID as number');

    tmp.cleanup();
  });

  test('readPidFile returns null when file missing', () => {
    const tmp = helpers.tmpConfigDir('pid-read-missing');
    const pf = requirePidFile(tmp.dir);

    const pid = pf.readPidFile();
    assert.equal(pid, null, 'Should return null when no PID file');

    tmp.cleanup();
  });

  test('readPidFile returns null for corrupt content', () => {
    const tmp = helpers.tmpConfigDir('pid-read-corrupt');
    const pf = requirePidFile(tmp.dir);

    fs.writeFileSync(path.join(tmp.dir, 'a2a-server.pid'), 'not-a-number\n');
    const pid = pf.readPidFile();
    assert.equal(pid, null, 'Should return null for non-numeric content');

    tmp.cleanup();
  });

  test('removePidFile deletes the file', () => {
    const tmp = helpers.tmpConfigDir('pid-remove');
    const pf = requirePidFile(tmp.dir);

    const pidPath = path.join(tmp.dir, 'a2a-server.pid');
    fs.writeFileSync(pidPath, '99\n');
    pf.removePidFile();
    assert.ok(!fs.existsSync(pidPath), 'PID file should be removed');

    tmp.cleanup();
  });

  test('removePidFile is safe when file does not exist', () => {
    const tmp = helpers.tmpConfigDir('pid-remove-noop');
    const pf = requirePidFile(tmp.dir);

    // Should not throw
    pf.removePidFile();

    tmp.cleanup();
  });

  test('isProcessAlive returns true for current process', () => {
    const tmp = helpers.tmpConfigDir('pid-alive');
    const pf = requirePidFile(tmp.dir);

    assert.ok(pf.isProcessAlive(process.pid), 'Current process should be alive');

    tmp.cleanup();
  });

  test('isProcessAlive returns false for non-existent PID', () => {
    const tmp = helpers.tmpConfigDir('pid-dead');
    const pf = requirePidFile(tmp.dir);

    assert.ok(!pf.isProcessAlive(999999999), 'Fake PID should not be alive');

    tmp.cleanup();
  });

  test('killExistingServer kills a live process from PID file', async () => {
    const tmp = helpers.tmpConfigDir('pid-kill');
    const pf = requirePidFile(tmp.dir);

    // Spawn a detached sleep process
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
    const pid = child.pid;

    // Write PID file
    pf.writePidFile(pid);

    // Kill it
    const result = pf.killExistingServer();
    assert.ok(result.killed, 'Should report killed');
    assert.equal(result.pid, pid, 'Should report the PID');

    // Verify dead
    await new Promise(r => setTimeout(r, 200));
    assert.ok(!pf.isProcessAlive(pid), 'Process should be dead');

    tmp.cleanup();
  });

  test('killExistingServer returns no-op when no PID file', () => {
    const tmp = helpers.tmpConfigDir('pid-kill-noop');
    const pf = requirePidFile(tmp.dir);

    const result = pf.killExistingServer();
    assert.ok(!result.killed, 'Should not report killed');

    tmp.cleanup();
  });

  test('killExistingServer returns no-op when PID is stale', () => {
    const tmp = helpers.tmpConfigDir('pid-kill-stale');
    const pf = requirePidFile(tmp.dir);

    fs.writeFileSync(path.join(tmp.dir, 'a2a-server.pid'), '999999999\n');
    const result = pf.killExistingServer();
    assert.ok(!result.killed, 'Should not report killed for dead process');

    // PID file should be cleaned up
    assert.equal(pf.readPidFile(), null, 'Stale PID file should be removed');

    tmp.cleanup();
  });
};
