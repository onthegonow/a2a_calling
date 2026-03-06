/**
 * Standalone Updater E2E Tests (A2A-103)
 *
 * Tests update detection via the dashboard API using a mock UpdateManager:
 *   - Update status returns current version and state
 *   - Manual check transitions state from up_to_date → available when newer version exists
 *   - Manual check stays up_to_date when version is current
 *   - Update check without manager returns 503
 */

module.exports = function (test, assert, helpers, ctx) {
  const { createStandaloneEnv } = require('./helpers/standalone-env');
  const pkg = require('../../package.json');
  let env;

  ctx.afterEach(async () => {
    if (env) { env.cleanup(); env = null; }
  });

  /**
   * Create a mock UpdateManager that simulates the real manager's interface.
   * triggerCheck() updates internal state based on the configured latestVersion.
   */
  function createMockUpdateManager(latestVersion) {
    const state = {
      enabled: true,
      state: 'up_to_date',
      current_version: pkg.version,
      latest_version: null,
      target_version: null,
      active_calls: 0,
      interval_ms: 3600000,
      allow_major: false,
      last_checked_at: null,
      last_success_at: null,
      last_error: null,
      defer_reason: null
    };

    return {
      getStatus() { return { ...state }; },
      async triggerCheck() {
        state.last_checked_at = new Date().toISOString();
        state.last_success_at = state.last_checked_at;
        state.latest_version = latestVersion;
        // Compare versions: if latest > current, state becomes 'available'
        const { compareVersions } = require('../../src/lib/update-checker');
        if (compareVersions(pkg.version, latestVersion) < 0) {
          state.state = 'available';
          state.target_version = latestVersion;
        } else {
          state.state = 'up_to_date';
          state.target_version = null;
        }
      },
      async triggerUpdate() {
        state.state = 'updating';
      }
    };
  }

  test('standalone updater: status returns current version before check', async () => {
    const mockManager = createMockUpdateManager(pkg.version);
    env = await createStandaloneEnv({ getUpdateManager: () => mockManager });
    await env.request('POST', '/api/a2a/dashboard/onboarding/complete', {
      agentName: 'Update Test Agent',
      defaultTier: 'public',
      port: 3096
    });

    const res = await env.request('GET', '/api/a2a/dashboard/update/status');
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.auto_update.current_version, pkg.version);
    assert.equal(res.body.auto_update.state, 'up_to_date');
    assert.equal(res.body.auto_update.latest_version, null, 'No latest version before check');
  });

  test('standalone updater: check with newer version transitions to available', async () => {
    const mockManager = createMockUpdateManager('99.0.0');
    env = await createStandaloneEnv({ getUpdateManager: () => mockManager });
    await env.request('POST', '/api/a2a/dashboard/onboarding/complete', {
      agentName: 'Update Test Agent',
      defaultTier: 'public',
      port: 3096
    });

    // Trigger manual check
    const checkRes = await env.request('POST', '/api/a2a/dashboard/update/check');
    assert.equal(checkRes.status, 200);
    assert.equal(checkRes.body.success, true);
    assert.equal(checkRes.body.auto_update.state, 'available', 'State should be available after finding newer version');
    assert.equal(checkRes.body.auto_update.latest_version, '99.0.0');
    assert.equal(checkRes.body.auto_update.target_version, '99.0.0');
    assert.ok(checkRes.body.auto_update.last_checked_at, 'last_checked_at should be set');
  });

  test('standalone updater: check with current version stays up_to_date', async () => {
    const mockManager = createMockUpdateManager(pkg.version);
    env = await createStandaloneEnv({ getUpdateManager: () => mockManager });
    await env.request('POST', '/api/a2a/dashboard/onboarding/complete', {
      agentName: 'Update Test Agent',
      defaultTier: 'public',
      port: 3096
    });

    const checkRes = await env.request('POST', '/api/a2a/dashboard/update/check');
    assert.equal(checkRes.status, 200);
    assert.equal(checkRes.body.auto_update.state, 'up_to_date', 'State should remain up_to_date');
    assert.equal(checkRes.body.auto_update.latest_version, pkg.version);
    assert.equal(checkRes.body.auto_update.target_version, null, 'No target when up to date');
  });

  test('standalone updater: check without manager returns 503', async () => {
    env = await createStandaloneEnv(); // No getUpdateManager provided
    await env.request('POST', '/api/a2a/dashboard/onboarding/complete', {
      agentName: 'Update Test Agent',
      defaultTier: 'public',
      port: 3096
    });

    const res = await env.request('POST', '/api/a2a/dashboard/update/check');
    assert.equal(res.status, 503);
    assert.equal(res.body.success, false);
    assert.equal(res.body.error, 'updater_unavailable');
  });
};
