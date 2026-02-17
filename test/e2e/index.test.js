module.exports = function (test, assert) {
  const { createE2EEnv } = require('./env');
  const { CLIRunner } = require('./cli-runner');
  const { TwoServerHarness } = require('./two-server');
  const { TestReport } = require('./report');

  test('E2E modules load successfully', () => {
    assert.ok(createE2EEnv, 'createE2EEnv should be defined');
    assert.ok(CLIRunner, 'CLIRunner should be defined');
    assert.ok(TwoServerHarness, 'TwoServerHarness should be defined');
    assert.ok(TestReport, 'TestReport should be defined');
  });

  test('E2E modules are constructable', () => {
    assert.type(createE2EEnv, 'function', 'createE2EEnv should be a function');
    assert.type(CLIRunner, 'function', 'CLIRunner should be a constructor');
    assert.type(TwoServerHarness, 'function', 'TwoServerHarness should be a constructor');
    assert.type(TestReport, 'function', 'TestReport should be a constructor');
  });
};
