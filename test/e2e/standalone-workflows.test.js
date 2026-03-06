/**
 * Standalone Workflow E2E Tests (A2A-103)
 *
 * Tests core dashboard workflows after onboarding:
 *   - Create token → list tokens → verify token
 *   - Settings accessible and modifiable
 *   - Logs endpoint returns data
 */

module.exports = function (test, assert, helpers, ctx) {
  const { createStandaloneEnv } = require('./helpers/standalone-env');
  let env;

  async function setupOnboarded() {
    env = await createStandaloneEnv();
    await env.request('POST', '/api/a2a/dashboard/onboarding/complete', {
      agentName: 'Workflow Agent',
      defaultTier: 'public',
      port: 3097,
      topics: ['coding']
    });
    return env;
  }

  ctx.afterEach(async () => {
    if (env) { env.cleanup(); env = null; }
  });

  test('standalone workflow: create and list tokens', async () => {
    await setupOnboarded();

    // Create a token via invites endpoint
    const create = await env.request('POST', '/api/a2a/dashboard/invites', {
      name: 'E2E-Token',
      permissions: 'public',
      expires: '1h'
    });
    assert.equal(create.status, 200);
    assert.equal(create.body.success, true);
    assert.ok(create.body.token);

    // List tokens
    const list = await env.request('GET', '/api/a2a/dashboard/invites');
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.body.invites));
    assert.ok(list.body.invites.length >= 1, 'Should have at least 1 token');
  });

  test('standalone workflow: create and list contacts', async () => {
    await setupOnboarded();

    // Create a contact via invite URL
    const create = await env.request('POST', '/api/a2a/dashboard/contacts', {
      invite_url: 'a2a://localhost:9999/fed_test_contact_123',
      name: 'E2E Contact',
      owner: 'Test Owner'
    });
    assert.equal(create.status, 200);
    assert.equal(create.body.success, true);
    assert.ok(create.body.contact, 'Should return created contact');
    assert.equal(create.body.contact.name, 'E2E Contact');

    // List contacts — should include the one we just created
    const list = await env.request('GET', '/api/a2a/dashboard/contacts');
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.body.contacts));
    assert.ok(list.body.contacts.length >= 1, 'Should have at least 1 contact');
    const found = list.body.contacts.find(c => c.name === 'E2E Contact');
    assert.ok(found, 'Created contact should appear in list');
  });

  test('standalone workflow: contact creation requires invite_url', async () => {
    await setupOnboarded();
    const res = await env.request('POST', '/api/a2a/dashboard/contacts', {
      name: 'No URL Contact'
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.success, false);
    assert.equal(res.body.error, 'invite_url_required');
  });

  test('standalone workflow: settings endpoint works', async () => {
    await setupOnboarded();
    const res = await env.request('GET', '/api/a2a/dashboard/settings');
    assert.equal(res.status, 200);
  });

  test('standalone workflow: logs endpoint returns data', async () => {
    await setupOnboarded();
    const res = await env.request('GET', '/api/a2a/dashboard/logs');
    assert.equal(res.status, 200);
    assert.ok(res.body.success !== false);
  });

  test('standalone workflow: status endpoint returns data', async () => {
    await setupOnboarded();
    const res = await env.request('GET', '/api/a2a/dashboard/status');
    assert.equal(res.status, 200);
  });
};
