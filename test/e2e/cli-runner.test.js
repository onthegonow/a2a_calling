module.exports = function (test, assert, helpers) {
  const { createE2EEnv } = require('./env');

  test('CLIRunner.run executes a2a command and returns output', async () => {
    const env = createE2EEnv('cli-run');
    const { CLIRunner } = require('./cli-runner');
    const runner = new CLIRunner(env);

    // 'a2a help' should work without onboarding
    const result = await runner.run('help');
    assert.equal(result.exitCode, 0, 'Should exit 0');
    assert.ok(result.stdout.length > 0, 'Should have stdout');

    env.cleanup();
  });

  test('CLIRunner.run captures non-zero exit codes', async () => {
    const env = createE2EEnv('cli-fail');
    const { CLIRunner } = require('./cli-runner');
    const runner = new CLIRunner(env);

    // 'a2a call' without onboarding should fail
    const result = await runner.run('call', ['nobody', 'hello']);
    assert.ok(result.exitCode !== 0, 'Should exit non-zero');

    env.cleanup();
  });

  test('CLIRunner.run respects timeout', async () => {
    const env = createE2EEnv('cli-timeout');
    const { CLIRunner } = require('./cli-runner');
    const runner = new CLIRunner(env, { timeout: 500 });

    // Running a command that hangs should time out
    const result = await runner.run('server', ['99999'], { timeout: 500 });
    assert.ok(result.timedOut || result.exitCode !== 0, 'Should timeout or fail');

    env.cleanup();
  });

  test('CLIRunner.onboard completes full onboarding via --submit', async () => {
    const env = createE2EEnv('cli-onboard');
    const { CLIRunner } = require('./cli-runner');
    const runner = new CLIRunner(env);

    const fs = require('fs');
    const path = require('path');

    // Pre-set config to awaiting_disclosure (skip port detection step)
    const configPath = path.join(env.configDir, 'a2a-config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      onboarding: { version: 2, step: 'awaiting_disclosure' },
      agent: { hostname: 'localhost:3001', name: 'e2e-test-agent' },
      tiers: {}
    }));

    const result = await runner.onboard({
      personalityNotes: 'E2E test agent — direct and minimal',
      topics: [{ topic: 'Testing', description: 'Automated E2E tests' }]
    });

    assert.ok(result.success, 'Onboarding should succeed');
    assert.ok(result.stdout.includes('Onboarding complete'), 'Should say complete');

    env.cleanup();
  });
};
