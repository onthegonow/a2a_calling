/**
 * Standalone Onboarding E2E Tests (A2A-103)
 *
 * Tests the first-run onboarding flow:
 *   - Fresh install shows not-onboarded status
 *   - Port detection returns available port
 *   - Completing onboarding writes config and disclosure
 *   - After onboarding, status shows complete
 *   - Dashboard endpoints become accessible
 */

module.exports = function (test, assert, helpers, ctx) {
  const { createStandaloneEnv } = require('./helpers/standalone-env');
  let env;

  ctx.afterEach(async () => {
    if (env) { env.cleanup(); env = null; }
  });

  test('standalone: fresh install shows not-onboarded', async () => {
    env = await createStandaloneEnv();
    const res = await env.request('GET', '/api/a2a/dashboard/onboarding/status');
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.onboarded, false);
  });

  test('standalone: port detection returns candidates', async () => {
    env = await createStandaloneEnv();
    const res = await env.request('GET', '/api/a2a/dashboard/onboarding/detect-port');
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.ok(Array.isArray(res.body.candidates));
  });

  test('standalone: complete onboarding writes config', async () => {
    env = await createStandaloneEnv();
    const res = await env.request('POST', '/api/a2a/dashboard/onboarding/complete', {
      agentName: 'E2E Test Agent',
      defaultTier: 'public',
      port: 3099,
      hostname: 'localhost:3099',
      topics: ['coding', 'research']
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);

    // Verify status now shows onboarded
    const status = await env.request('GET', '/api/a2a/dashboard/onboarding/status');
    assert.equal(status.body.onboarded, true);
  });

  test('standalone: full onboarding → dashboard flow', async () => {
    env = await createStandaloneEnv();

    // Step 1: Complete onboarding
    await env.request('POST', '/api/a2a/dashboard/onboarding/complete', {
      agentName: 'Flow Test Agent',
      defaultTier: 'friends',
      port: 3098,
      topics: ['general']
    });

    // Step 2: Dashboard settings should reflect onboarding
    const settings = await env.request('GET', '/api/a2a/dashboard/settings');
    assert.equal(settings.status, 200);
    assert.ok(settings.body.success !== false, 'Settings endpoint accessible after onboarding');
  });

  test('standalone: onboarding rejects empty agent name', async () => {
    env = await createStandaloneEnv();
    const res = await env.request('POST', '/api/a2a/dashboard/onboarding/complete', {
      agentName: '',
      defaultTier: 'public',
      port: 3099
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.success, false);
  });
};
