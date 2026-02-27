/**
 * Dashboard Outbound Call Integration Tests
 *
 * A2A-70: Covers POST /contacts/:contactId/call — the most complex dashboard
 * endpoint. Tests happy path, conversation persistence, contact status updates,
 * and all documented error paths.
 */

module.exports = function (test, assert, helpers) {
  let tmp = null;
  let client = null;
  let loggerModule = null;
  let convStore = null;
  let mockServer = null;

  /**
   * Start a minimal Express server that mimics a remote A2A agent.
   * Responds to POST /api/a2a/invoke with a canned response.
   * Returns { server, port, close() }.
   */
  function startMockRemote(handler) {
    const http = require('http');
    const express = require('express');
    const mockApp = express();
    mockApp.use(express.json());
    mockApp.post('/api/a2a/invoke', handler || ((req, res) => {
      res.json({
        response: 'Hello from mock remote',
        can_continue: true,
        trace_id: 'trace_mock_001',
        request_id: 'req_mock_001'
      });
    }));

    return new Promise((resolve) => {
      const srv = mockApp.listen(0, '127.0.0.1', () => {
        const port = srv.address().port;
        resolve({
          server: srv,
          port,
          close() {
            return new Promise((r) => srv.close(r));
          }
        });
      });
    });
  }

  async function setup(options = {}) {
    tmp = helpers.tmpConfigDir('dash-call');

    // Bust caches for all modules that capture CONFIG_DIR at load time.
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
      component: 'test.dashboard.call',
      configDir: tmp.dir,
      stdout: false,
      minLevel: 'trace'
    });

    const tokenStore = new TokenStore(tmp.dir);
    convStore = new ConversationStore(tmp.dir);

    // Start mock remote server if requested.
    if (options.mockHandler !== undefined || options.startMock !== false) {
      mockServer = await startMockRemote(options.mockHandler || null);
    }

    // Seed a contact pointing at the mock remote.
    if (mockServer && options.seedContact !== false) {
      tokenStore.addContact(
        `a2a://127.0.0.1:${mockServer.port}/fed_testtoken123`,
        { name: 'MockRemote' }
      );
    }

    // Seed an inbound-only contact (no host/token) if requested.
    if (options.seedInboundOnly) {
      const tokensPath = require('path').join(tmp.dir, 'a2a.json');
      require('fs').writeFileSync(tokensPath, JSON.stringify({
        tokens: [],
        contacts: [{
          id: 'inbound_only_001',
          name: 'InboundOnly',
          host: null,
          token_hash: null,
          token_enc: null,
          status: null,
          tags: [],
          fields: {}
        }],
        calls: []
      }, null, 2));
    }

    const app = express();
    app.use('/api/a2a/dashboard', createDashboardApiRouter({
      tokenStore,
      logger,
      convStore
    }));
    client = helpers.request(app);

    return { tokenStore, convStore };
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
    if (mockServer) {
      await mockServer.close();
      mockServer = null;
    }
    if (tmp) tmp.cleanup();
    tmp = null;
  }

  // ── Happy Path ─────────────────────────────────────────────────────

  test('outbound call: happy path returns success with conversation_id and response', async () => {
    const { tokenStore } = await setup();

    // Find the seeded contact ID.
    const contacts = tokenStore.listContacts();
    const contact = contacts.find(c => c.name === 'MockRemote');
    assert.ok(contact, 'seeded contact should exist');

    const res = await client.post(`/api/a2a/dashboard/contacts/${contact.id}/call`, {
      body: { message: 'Hello from dashboard test' }
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.ok(res.body.conversation_id);
    assert.ok(res.body.conversation_id.startsWith('conv_'));
    assert.equal(res.body.response, 'Hello from mock remote');
    assert.equal(res.body.can_continue, true);
    assert.equal(res.body.remote_trace_id, 'trace_mock_001');
    assert.equal(res.body.remote_request_id, 'req_mock_001');

    await teardown();
  });

  // ── Conversation Persistence ───────────────────────────────────────

  test('outbound call: conversation and messages are recorded in convStore', async () => {
    const { tokenStore } = await setup();

    const contacts = tokenStore.listContacts();
    const contact = contacts.find(c => c.name === 'MockRemote');

    const res = await client.post(`/api/a2a/dashboard/contacts/${contact.id}/call`, {
      body: { message: 'Persistence check' }
    });
    assert.equal(res.statusCode, 200);

    const convId = res.body.conversation_id;

    // Verify conversation exists with outbound direction and messages.
    const conv = convStore.getConversation(convId, { includeMessages: true });
    assert.ok(conv, 'conversation should exist in store');
    assert.equal(conv.direction, 'outbound');
    assert.equal(conv.messages.length, 2);

    const outMsg = conv.messages.find(m => m.direction === 'outbound');
    assert.ok(outMsg, 'outbound message should exist');
    assert.equal(outMsg.content, 'Persistence check');

    const inMsg = conv.messages.find(m => m.direction === 'inbound');
    assert.ok(inMsg, 'inbound response message should exist');
    assert.equal(inMsg.content, 'Hello from mock remote');

    await teardown();
  });

  test('outbound call: conversation is auto-concluded after one-shot call', async () => {
    const { tokenStore } = await setup();

    const contacts = tokenStore.listContacts();
    const contact = contacts.find(c => c.name === 'MockRemote');

    const res = await client.post(`/api/a2a/dashboard/contacts/${contact.id}/call`, {
      body: { message: 'One-shot test' }
    });
    assert.equal(res.statusCode, 200);

    const conv = convStore.getConversation(res.body.conversation_id);
    assert.ok(conv);
    assert.equal(conv.status, 'concluded');

    await teardown();
  });

  // ── Contact Status Updates ─────────────────────────────────────────

  test('outbound call: contact status set to online on success', async () => {
    const { tokenStore } = await setup();

    const contacts = tokenStore.listContacts();
    const contact = contacts.find(c => c.name === 'MockRemote');

    await client.post(`/api/a2a/dashboard/contacts/${contact.id}/call`, {
      body: { message: 'Status check' }
    });

    // Re-fetch the contact to check status.
    const updated = tokenStore.getContact(contact.id);
    assert.equal(updated.status, 'online');

    await teardown();
  });

  // ── Error Paths ────────────────────────────────────────────────────

  test('outbound call: missing message returns 400 message_required', async () => {
    const { tokenStore } = await setup();

    const contacts = tokenStore.listContacts();
    const contact = contacts.find(c => c.name === 'MockRemote');

    const res = await client.post(`/api/a2a/dashboard/contacts/${contact.id}/call`, {
      body: {}
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.success, false);
    assert.equal(res.body.error, 'message_required');

    await teardown();
  });

  test('outbound call: unknown contactId returns 404 contact_not_found', async () => {
    await setup();

    const res = await client.post('/api/a2a/dashboard/contacts/nonexistent_id_999/call', {
      body: { message: 'Hello?' }
    });
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.success, false);
    assert.equal(res.body.error, 'contact_not_found');

    await teardown();
  });

  test('outbound call: inbound-only contact (no host/token) returns 400 contact_not_callable', async () => {
    await setup({ seedInboundOnly: true });

    const res = await client.post('/api/a2a/dashboard/contacts/inbound_only_001/call', {
      body: { message: 'Try to call inbound-only' }
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.success, false);
    assert.equal(res.body.error, 'contact_not_callable');

    await teardown();
  });

  test('outbound call: remote failure returns 502 contact_call_failed and sets offline', async () => {
    const { tokenStore } = await setup({
      mockHandler: (req, res) => {
        // Simulate a remote server error.
        res.status(500).json({ error: 'internal_error', message: 'Remote exploded' });
      }
    });

    const contacts = tokenStore.listContacts();
    const contact = contacts.find(c => c.name === 'MockRemote');

    const res = await client.post(`/api/a2a/dashboard/contacts/${contact.id}/call`, {
      body: { message: 'Should fail' }
    });
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.success, false);
    assert.equal(res.body.error, 'contact_call_failed');

    // Contact should now be marked offline.
    const updated = tokenStore.getContact(contact.id);
    assert.equal(updated.status, 'offline');

    await teardown();
  });
};
