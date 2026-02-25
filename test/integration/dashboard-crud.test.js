/**
 * Dashboard CRUD API Integration Tests
 *
 * Verifies contacts, settings/tiers, invites, and calls endpoints.
 * A2A-56: covers 35+ dashboard API endpoints that had zero test coverage.
 */

module.exports = function (test, assert, helpers) {
  let tmp = null;
  let client = null;
  let loggerModule = null;
  let convStore = null;

  async function setup(options = {}) {
    tmp = helpers.tmpConfigDir('dash-crud');

    // A2A-56: bust caches for all modules that capture CONFIG_DIR at load time.
    delete require.cache[require.resolve('../../src/routes/dashboard')];
    delete require.cache[require.resolve('../../src/lib/logger')];
    delete require.cache[require.resolve('../../src/lib/tokens')];
    delete require.cache[require.resolve('../../src/lib/config')];
    delete require.cache[require.resolve('../../src/lib/disclosure')];
    delete require.cache[require.resolve('../../src/lib/conversations')];
    delete require.cache[require.resolve('../../src/lib/callbook')];
    delete require.cache[require.resolve('../../src/lib/dashboard-events')];

    const express = require('express');
    const { createDashboardApiRouter } = require('../../src/routes/dashboard');
    const { TokenStore } = require('../../src/lib/tokens');
    const { ConversationStore } = require('../../src/lib/conversations');
    loggerModule = require('../../src/lib/logger');

    // Seed config with tier data so settings endpoints have content.
    helpers.writeA2AConfig(tmp.dir, {
      tiers: {
        public: {
          name: 'Public',
          topics: [],
          goals: [],
          capabilities: ['context-read']
        }
      },
      defaults: { expiration: '7d' },
      agent: { hostname: 'localhost' }
    });

    // Seed disclosure manifest.
    helpers.writeDisclosureManifest(tmp.dir, {
      tiers: {
        public: {
          topics: [],
          objectives: [],
          do_not_discuss: []
        }
      },
      never_disclose: [],
      personality_notes: ''
    });

    const logger = loggerModule.createLogger({
      component: 'test.dashboard.crud',
      configDir: tmp.dir,
      stdout: false,
      minLevel: 'trace'
    });

    const tokenStore = new TokenStore(tmp.dir);

    // A2A-56: create convStore and optionally seed conversations for calls tests.
    convStore = new ConversationStore(tmp.dir);
    if (options.seedConversations) {
      options.seedConversations(convStore);
    }

    const app = express();
    app.use('/api/a2a/dashboard', createDashboardApiRouter({
      tokenStore,
      logger,
      convStore
    }));
    client = helpers.request(app);
  }

  async function teardown() {
    if (client) await client.close();
    client = null;
    if (convStore) {
      try { convStore.close(); } catch (_) {}
    }
    convStore = null;
    if (loggerModule && typeof loggerModule.closeAllLoggerStores === 'function') {
      loggerModule.closeAllLoggerStores();
    }
    loggerModule = null;
    if (tmp) tmp.cleanup();
    tmp = null;
  }

  // ── Contacts CRUD ──────────────────────────────────────────────────

  test('contacts CRUD: create, list, update, delete', async () => {
    await setup();

    // Initially empty.
    const empty = await client.get('/api/a2a/dashboard/contacts');
    assert.equal(empty.statusCode, 200);
    assert.equal(empty.body.success, true);
    assert.equal(Array.isArray(empty.body.contacts), true);
    assert.equal(empty.body.contacts.length, 0);

    // Create a contact.
    const createRes = await client.post('/api/a2a/dashboard/contacts', {
      body: {
        url: 'a2a://test-host.example.com/fed_test123',
        name: 'TestAgent'
      }
    });
    assert.equal(createRes.statusCode, 200);
    assert.equal(createRes.body.success, true);
    assert.ok(createRes.body.contact);
    assert.equal(createRes.body.contact.name, 'TestAgent');
    const contactId = createRes.body.contact.id;
    assert.ok(contactId);

    // List should contain 1 contact.
    const listOne = await client.get('/api/a2a/dashboard/contacts');
    assert.equal(listOne.statusCode, 200);
    assert.equal(listOne.body.contacts.length, 1);
    assert.equal(listOne.body.contacts[0].name, 'TestAgent');

    // Update the contact name.
    const updateRes = await client.put(`/api/a2a/dashboard/contacts/${contactId}`, {
      body: { name: 'UpdatedName' }
    });
    assert.equal(updateRes.statusCode, 200);
    assert.equal(updateRes.body.success, true);
    assert.equal(updateRes.body.contact.name, 'UpdatedName');

    // Verify update via GET.
    const listUpdated = await client.get('/api/a2a/dashboard/contacts');
    assert.equal(listUpdated.body.contacts.length, 1);
    assert.equal(listUpdated.body.contacts[0].name, 'UpdatedName');

    // Delete the contact.
    const deleteRes = await client.delete(`/api/a2a/dashboard/contacts/${contactId}`);
    assert.equal(deleteRes.statusCode, 200);
    assert.equal(deleteRes.body.success, true);

    // List should be empty again.
    const listEmpty = await client.get('/api/a2a/dashboard/contacts');
    assert.equal(listEmpty.body.contacts.length, 0);

    await teardown();
  });

  test('contacts POST rejects missing invite_url', async () => {
    await setup();

    const res = await client.post('/api/a2a/dashboard/contacts', {
      body: { name: 'NoUrl' }
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.success, false);

    await teardown();
  });

  // ── Settings / Tiers ───────────────────────────────────────────────

  test('settings: GET returns tiers, defaults, and onboarding_complete', async () => {
    await setup();

    const res = await client.get('/api/a2a/dashboard/settings');
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(Array.isArray(res.body.tiers), true);
    assert.ok(res.body.tiers.length > 0);
    assert.ok(res.body.defaults !== undefined);
    assert.equal(typeof res.body.onboarding_complete, 'boolean');

    // Verify the seeded public tier is present.
    const publicTier = res.body.tiers.find(t => t.id === 'public');
    assert.ok(publicTier);
    assert.equal(publicTier.name, 'Public');

    await teardown();
  });

  test('settings/tiers: PUT update, POST create, and copy-from', async () => {
    await setup();

    // Update the public tier with topics and goals.
    const putRes = await client.put('/api/a2a/dashboard/settings/tiers/public', {
      body: { topics: ['test-topic'], goals: ['test-goal'] }
    });
    assert.equal(putRes.statusCode, 200);
    assert.equal(putRes.body.success, true);
    assert.equal(putRes.body.tier_id, 'public');

    // Verify the update via GET /settings.
    const settingsAfterPut = await client.get('/api/a2a/dashboard/settings');
    const updatedPublic = settingsAfterPut.body.tiers.find(t => t.id === 'public');
    assert.ok(updatedPublic);
    assert.equal(updatedPublic.topics.includes('test-topic'), true);
    assert.equal(updatedPublic.goals.includes('test-goal'), true);

    // Create a new custom tier.
    const postRes = await client.post('/api/a2a/dashboard/settings/tiers', {
      body: { id: 'custom-tier', name: 'Custom' }
    });
    assert.equal(postRes.statusCode, 200);
    assert.equal(postRes.body.success, true);
    assert.equal(postRes.body.tier_id, 'custom-tier');

    // Copy from public to custom-tier.
    const copyRes = await client.post('/api/a2a/dashboard/settings/tiers/custom-tier/copy-from/public', {
      body: {}
    });
    assert.equal(copyRes.statusCode, 200);
    assert.equal(copyRes.body.success, true);
    assert.equal(copyRes.body.from_tier, 'public');
    assert.equal(copyRes.body.to_tier, 'custom-tier');

    // Verify custom-tier now has the public tier's topics after copy.
    const settingsAfterCopy = await client.get('/api/a2a/dashboard/settings');
    const customTier = settingsAfterCopy.body.tiers.find(t => t.id === 'custom-tier');
    assert.ok(customTier);
    assert.equal(customTier.topics.includes('test-topic'), true);

    await teardown();
  });

  test('settings/tiers POST rejects duplicate tier id', async () => {
    await setup();

    // 'public' already exists from seeded config.
    const res = await client.post('/api/a2a/dashboard/settings/tiers', {
      body: { id: 'public', name: 'DuplicatePublic' }
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.success, false);
    assert.equal(res.body.error, 'tier_exists');

    await teardown();
  });

  // ── Invites ────────────────────────────────────────────────────────

  test('invites: create, list, revoke lifecycle', async () => {
    await setup();

    // Initially empty.
    const empty = await client.get('/api/a2a/dashboard/invites');
    assert.equal(empty.statusCode, 200);
    assert.equal(empty.body.success, true);
    assert.equal(Array.isArray(empty.body.invites), true);
    assert.equal(empty.body.invites.length, 0);

    // Create an invite.
    const createRes = await client.post('/api/a2a/dashboard/invites', {
      body: { name: 'Test Invite', permissions: 'public', expires: '7d' }
    });
    assert.equal(createRes.statusCode, 200);
    assert.equal(createRes.body.success, true);
    assert.ok(createRes.body.invite_url);
    assert.ok(createRes.body.token);
    const tokenId = createRes.body.token.id;
    assert.ok(tokenId);

    // List should have 1 invite.
    const listOne = await client.get('/api/a2a/dashboard/invites');
    assert.equal(listOne.body.invites.length, 1);

    // Revoke the invite.
    const revokeRes = await client.post(`/api/a2a/dashboard/invites/${tokenId}/revoke`);
    assert.equal(revokeRes.statusCode, 200);
    assert.equal(revokeRes.body.success, true);

    // List without include_revoked should be empty.
    const listAfterRevoke = await client.get('/api/a2a/dashboard/invites');
    assert.equal(listAfterRevoke.body.invites.length, 0);

    // List with include_revoked should still show it.
    const listWithRevoked = await client.get('/api/a2a/dashboard/invites?include_revoked=true');
    assert.equal(listWithRevoked.body.invites.length, 1);

    await teardown();
  });

  // ── Calls ──────────────────────────────────────────────────────────

  test('calls: list and detail with seeded conversation', async () => {
    const testConvId = 'conv_test_crud_001';

    await setup({
      seedConversations(store) {
        // A2A-56: seed a conversation and messages for the calls endpoint tests.
        store.startConversation({
          id: testConvId,
          contactName: 'SeedAgent',
          direction: 'inbound'
        });
        store.addMessage(testConvId, {
          direction: 'inbound',
          role: 'user',
          content: 'Hello from seed'
        });
        store.addMessage(testConvId, {
          direction: 'outbound',
          role: 'assistant',
          content: 'Hi, seed reply'
        });
      }
    });

    // GET /calls should include the seeded conversation.
    const listRes = await client.get('/api/a2a/dashboard/calls');
    assert.equal(listRes.statusCode, 200);
    assert.equal(listRes.body.success, true);
    assert.equal(Array.isArray(listRes.body.calls), true);
    assert.greaterThan(listRes.body.calls.length, 0);

    const seededCall = listRes.body.calls.find(c => c.id === testConvId);
    assert.ok(seededCall);
    assert.equal(seededCall.direction, 'inbound');
    assert.equal(seededCall.message_count, 2);

    // GET /calls/:conversationId should return conversation detail.
    const detailRes = await client.get(`/api/a2a/dashboard/calls/${testConvId}`);
    assert.equal(detailRes.statusCode, 200);
    assert.equal(detailRes.body.success, true);
    assert.ok(detailRes.body.call);
    assert.equal(detailRes.body.call.id, testConvId);
    assert.equal(Array.isArray(detailRes.body.call.recentMessages), true);
    assert.equal(detailRes.body.call.recentMessages.length, 2);
    assert.equal(detailRes.body.call.messageCount, 2);

    // Nonexistent conversation returns 404.
    const missingRes = await client.get('/api/a2a/dashboard/calls/conv_does_not_exist');
    assert.equal(missingRes.statusCode, 404);
    assert.equal(missingRes.body.success, false);

    await teardown();
  });
};
