/**
 * Dashboard Settings Write Integration Tests
 *
 * A2A-72: Covers PUT /settings/defaults, PUT /settings/agent, and
 * PUT /settings/manifest — the three untested settings write endpoints.
 * Tests happy paths with disk persistence verification and error/edge cases.
 */

module.exports = function (test, assert, helpers) {
  let tmp = null;
  let client = null;
  let loggerModule = null;
  let convStore = null;

  async function setup() {
    tmp = helpers.tmpConfigDir('dash-settings');

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
      component: 'test.dashboard.settings',
      configDir: tmp.dir,
      stdout: false,
      minLevel: 'trace'
    });

    const tokenStore = new TokenStore(tmp.dir);
    convStore = new ConversationStore(tmp.dir);

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

  function readConfigFromDisk() {
    const fs = require('fs');
    const path = require('path');
    return JSON.parse(fs.readFileSync(path.join(tmp.dir, 'a2a-config.json'), 'utf8'));
  }

  function readManifestFromDisk() {
    const fs = require('fs');
    const path = require('path');
    return JSON.parse(fs.readFileSync(path.join(tmp.dir, 'a2a-disclosure.json'), 'utf8'));
  }

  // ── PUT /settings/defaults ──────────────────────────────────────────

  test('PUT /settings/defaults: happy path updates defaults and persists to disk', async () => {
    await setup();

    const res = await client.put('/api/a2a/dashboard/settings/defaults', {
      body: {
        expiration: '30d',
        maxCalls: 500,
        rateLimit: { perMinute: 20, perHour: 200, perDay: 2000 },
        turnTimeoutMs: 600000,
        maxPendingRequests: 10
      }
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);

    // Verify persistence on disk.
    const config = readConfigFromDisk();
    assert.equal(config.defaults.expiration, '30d');
    assert.equal(config.defaults.maxCalls, 500);
    assert.equal(config.defaults.turnTimeoutMs, 600000);
    assert.equal(config.defaults.maxPendingRequests, 10);
    assert.equal(config.defaults.rateLimit.perMinute, 20);
    assert.equal(config.defaults.rateLimit.perHour, 200);
    assert.equal(config.defaults.rateLimit.perDay, 2000);

    await teardown();
  });

  test('PUT /settings/defaults: partial update merges with existing defaults', async () => {
    await setup();

    const res = await client.put('/api/a2a/dashboard/settings/defaults', {
      body: { maxCalls: 250 }
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);

    // maxCalls updated, expiration preserved from seed.
    const config = readConfigFromDisk();
    assert.equal(config.defaults.maxCalls, 250);
    assert.equal(config.defaults.expiration, '7d');

    await teardown();
  });

  test('PUT /settings/defaults: non-numeric turnTimeoutMs is accepted (no validation)', async () => {
    await setup();

    // Documents current behavior: the endpoint does NOT validate input types.
    const res = await client.put('/api/a2a/dashboard/settings/defaults', {
      body: { turnTimeoutMs: 'not-a-number' }
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);

    const config = readConfigFromDisk();
    assert.equal(config.defaults.turnTimeoutMs, 'not-a-number');

    await teardown();
  });

  test('PUT /settings/defaults: empty body is accepted (no-op)', async () => {
    await setup();

    const res = await client.put('/api/a2a/dashboard/settings/defaults', {
      body: {}
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);

    // Original seed value still present.
    const config = readConfigFromDisk();
    assert.equal(config.defaults.expiration, '7d');

    await teardown();
  });

  // ── PUT /settings/agent ─────────────────────────────────────────────

  test('PUT /settings/agent: happy path updates agent config and persists to disk', async () => {
    await setup();

    const res = await client.put('/api/a2a/dashboard/settings/agent', {
      body: {
        name: 'TestAgent',
        description: 'A test agent for integration tests',
        hostname: 'test.example.com'
      }
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);

    const config = readConfigFromDisk();
    assert.equal(config.agent.name, 'TestAgent');
    assert.equal(config.agent.description, 'A test agent for integration tests');
    assert.equal(config.agent.hostname, 'test.example.com');

    await teardown();
  });

  test('PUT /settings/agent: partial update merges with existing agent config', async () => {
    await setup();

    const res = await client.put('/api/a2a/dashboard/settings/agent', {
      body: { name: 'UpdatedName' }
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);

    // name updated, hostname preserved from seed.
    const config = readConfigFromDisk();
    assert.equal(config.agent.name, 'UpdatedName');
    assert.equal(config.agent.hostname, 'localhost');

    await teardown();
  });

  test('PUT /settings/agent: empty body is accepted (no-op)', async () => {
    await setup();

    const res = await client.put('/api/a2a/dashboard/settings/agent', {
      body: {}
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);

    const config = readConfigFromDisk();
    assert.equal(config.agent.hostname, 'localhost');

    await teardown();
  });

  // ── PUT /settings/manifest ──────────────────────────────────────────

  test('PUT /settings/manifest: happy path updates disclosure manifest and persists', async () => {
    await setup();

    const res = await client.put('/api/a2a/dashboard/settings/manifest', {
      body: {
        never_disclose: ['passwords', 'api-keys', 'internal-urls'],
        personality_notes: 'Friendly and helpful agent'
      }
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);

    const manifest = readManifestFromDisk();
    assert.equal(manifest.never_disclose.length, 3);
    assert.equal(manifest.never_disclose[0], 'passwords');
    assert.equal(manifest.never_disclose[1], 'api-keys');
    assert.equal(manifest.never_disclose[2], 'internal-urls');
    assert.equal(manifest.personality_notes, 'Friendly and helpful agent');
    assert.ok(manifest.updated_at);

    await teardown();
  });

  test('PUT /settings/manifest: partial update only changes provided fields', async () => {
    await setup();

    // First, set personality_notes via the manifest seed (already empty string).
    // Now update only never_disclose.
    const res = await client.put('/api/a2a/dashboard/settings/manifest', {
      body: { never_disclose: ['secrets'] }
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);

    const manifest = readManifestFromDisk();
    assert.equal(manifest.never_disclose.length, 1);
    assert.equal(manifest.never_disclose[0], 'secrets');
    // personality_notes preserved from seed.
    assert.equal(manifest.personality_notes, '');

    await teardown();
  });

  test('PUT /settings/manifest: empty body is accepted (preserves existing manifest)', async () => {
    await setup();

    const res = await client.put('/api/a2a/dashboard/settings/manifest', {
      body: {}
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);

    const manifest = readManifestFromDisk();
    // Seed values preserved.
    assert.equal(Array.isArray(manifest.never_disclose), true);
    assert.equal(manifest.never_disclose.length, 0);

    await teardown();
  });

  test('PUT /settings/manifest: non-array never_disclose is sanitized to empty array', async () => {
    await setup();

    const res = await client.put('/api/a2a/dashboard/settings/manifest', {
      body: { never_disclose: 'not-an-array' }
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);

    const manifest = readManifestFromDisk();
    // sanitizeStringArray returns [] for non-array input.
    assert.equal(Array.isArray(manifest.never_disclose), true);
    assert.equal(manifest.never_disclose.length, 0);

    await teardown();
  });

  // ── Cross-endpoint: GET /settings reads back written values ─────────

  test('settings round-trip: writes via PUT are reflected in GET /settings', async () => {
    await setup();

    // Write defaults, agent, and manifest.
    await client.put('/api/a2a/dashboard/settings/defaults', {
      body: { expiration: '1d', maxCalls: 42 }
    });
    await client.put('/api/a2a/dashboard/settings/agent', {
      body: { name: 'RoundTripAgent', hostname: 'roundtrip.test' }
    });
    await client.put('/api/a2a/dashboard/settings/manifest', {
      body: { never_disclose: ['secret-sauce'], personality_notes: 'Very round, very trip' }
    });

    // Read back via GET /settings.
    const res = await client.get('/api/a2a/dashboard/settings');
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);

    assert.equal(res.body.defaults.expiration, '1d');
    assert.equal(res.body.defaults.maxCalls, 42);
    assert.equal(res.body.agent.name, 'RoundTripAgent');
    assert.equal(res.body.agent.hostname, 'roundtrip.test');
    assert.equal(res.body.manifest.never_disclose.length, 1);
    assert.equal(res.body.manifest.never_disclose[0], 'secret-sauce');
    assert.equal(res.body.manifest.personality_notes, 'Very round, very trip');

    await teardown();
  });
};
