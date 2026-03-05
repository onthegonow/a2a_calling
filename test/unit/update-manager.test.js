/**
 * Update Manager Tests
 */

module.exports = function (test, assert) {
  function requireFresh() {
    delete require.cache[require.resolve('../../src/lib/update-manager')];
    return require('../../src/lib/update-manager');
  }

  test('isUpdateSafe returns false when active calls exist', () => {
    const { isUpdateSafe } = requireFresh();
    assert.ok(!isUpdateSafe({ getActiveCount: () => 2 }));
    assert.ok(isUpdateSafe({ getActiveCount: () => 0 }));
    assert.ok(isUpdateSafe(null));
  });

  test('shouldApplyUpdate blocks cross-major when allowMajor is false', () => {
    const { shouldApplyUpdate } = requireFresh();
    assert.ok(shouldApplyUpdate('0.6.45', '0.6.46', { allowMajor: false }));
    assert.ok(!shouldApplyUpdate('0.6.45', '1.0.0', { allowMajor: false }));
    assert.ok(shouldApplyUpdate('0.6.45', '1.0.0', { allowMajor: true }));
  });

  test('UpdateManager defers update while calls are active', async () => {
    const { UpdateManager } = requireFresh();
    const manager = new UpdateManager({
      currentVersion: '0.6.45',
      enabled: true,
      allowMajor: false,
      getCallMonitor: () => ({ getActiveCount: () => 1 }),
      execFile: async () => ({ stdout: '', stderr: '' }),
      restartFn: async () => {}
    });

    const originalFetch = global.fetch;
    global.fetch = async () => ({ ok: true, json: async () => ({ version: '0.6.46' }) });
    try {
      // A2A-98: Force a check in CI so interval gating does not skip update detection.
      await manager.triggerCheck({ reason: 'test', forceCheck: true });
      const status = manager.getStatus();
      assert.equal(status.state, 'waiting_for_safe_restart');
      assert.equal(status.target_version, '0.6.46');
      assert.equal(status.active_calls, 1);
    } finally {
      global.fetch = originalFetch;
      manager.stop();
    }
  });
};
