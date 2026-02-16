module.exports = function (test, assert, helpers) {
  test('createE2EEnv returns isolated dir with cleanup', () => {
    const { createE2EEnv } = require('./env');
    const env = createE2EEnv('test-basic');

    assert.ok(env.dir, 'Should have a directory');
    assert.ok(env.configDir, 'Should have a config directory');
    assert.ok(env.env.A2A_CONFIG_DIR, 'Should set A2A_CONFIG_DIR');

    const fs = require('fs');
    assert.ok(fs.existsSync(env.dir), 'Directory should exist');
    assert.ok(fs.existsSync(env.configDir), 'Config dir should exist');

    env.cleanup();
    assert.equal(fs.existsSync(env.dir), false, 'Should clean up');
  });

  test('createE2EEnv provides isolated process env', () => {
    const { createE2EEnv } = require('./env');
    const envA = createE2EEnv('env-a');
    const envB = createE2EEnv('env-b');

    assert.ok(envA.configDir !== envB.configDir, 'Should be different dirs');

    envA.cleanup();
    envB.cleanup();
  });

  test('createE2EEnv finds available port', async () => {
    const { createE2EEnv } = require('./env');
    const env = createE2EEnv('port-test');

    const port = await env.findAvailablePort();
    assert.ok(port >= 1024 && port <= 65535, 'Should return valid port');

    env.cleanup();
  });
};
