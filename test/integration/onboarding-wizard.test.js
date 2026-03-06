/**
 * Onboarding Wizard Integration Tests
 *
 * A2A-99: Verifies the onboarding wizard API endpoints exposed
 * before the dashboard auth middleware.
 */

module.exports = function (test, assert, helpers) {
  let tmp = null;
  let client = null;
  let loggerModule = null;

  async function setup(options = {}) {
    tmp = helpers.tmpConfigDir('onboard-wizard');

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
    loggerModule = require('../../src/lib/logger');

    // Seed config — no onboarding complete by default unless overridden.
    const configData = options.config || {
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
    };
    helpers.writeA2AConfig(tmp.dir, configData);

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
      component: 'test.onboarding.wizard',
      configDir: tmp.dir,
      stdout: false,
      minLevel: 'trace'
    });

    const { TokenStore } = require('../../src/lib/tokens');
    const tokenStore = new TokenStore(tmp.dir);

    const app = express();
    app.use('/api/a2a/dashboard', createDashboardApiRouter({
      tokenStore,
      logger
    }));
    client = helpers.request(app);
  }

  async function teardown() {
    if (client) await client.close();
    client = null;
    if (loggerModule && typeof loggerModule.closeAllLoggerStores === 'function') {
      loggerModule.closeAllLoggerStores();
    }
    loggerModule = null;
    if (tmp) tmp.cleanup();
    tmp = null;
  }

  // ── GET /onboarding ──────────────────────────────────────────

  test('onboarding: GET /onboarding returns 200 with HTML', async () => {
    await setup();

    const res = await client.get('/api/a2a/dashboard/onboarding');
    assert.equal(res.statusCode, 200);
    assert.ok(
      res.headers['content-type'] && res.headers['content-type'].includes('html'),
      'Expected HTML content-type'
    );

    await teardown();
  });

  // ── GET /onboarding/status ───────────────────────────────────

  test('onboarding: status shows onboarded=false on fresh install', async () => {
    await setup();

    const res = await client.get('/api/a2a/dashboard/onboarding/status');
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.onboarded, false);

    await teardown();
  });

  // ── GET /onboarding/detect-port ──────────────────────────────

  test('onboarding: detect-port returns port and candidates', async () => {
    await setup();

    const res = await client.get('/api/a2a/dashboard/onboarding/detect-port');
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    // Port may be null if all candidate ports are in use on this host.
    assert.ok(
      res.body.port === null || typeof res.body.port === 'number',
      'port should be a number or null'
    );
    assert.equal(Array.isArray(res.body.candidates), true);
    assert.greaterThan(res.body.candidates.length, 0);

    await teardown();
  });

  // ── POST /onboarding/complete (valid) ────────────────────────

  test('onboarding: complete with valid data returns success', async () => {
    await setup();

    const res = await client.post('/api/a2a/dashboard/onboarding/complete', {
      body: {
        agentName: 'TestBot',
        defaultTier: 'public',
        port: 3001,
        hostname: 'localhost:3001',
        topics: ['coding', 'research']
      }
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);

    // Verify config was actually written by checking status
    const status = await client.get('/api/a2a/dashboard/onboarding/status');
    assert.equal(status.body.onboarded, true);

    await teardown();
  });

  // ── POST /onboarding/complete — validation errors ────────────

  test('onboarding: complete rejects missing agent name', async () => {
    await setup();

    const res = await client.post('/api/a2a/dashboard/onboarding/complete', {
      body: {
        defaultTier: 'public',
        port: 3001
      }
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.success, false);
    assert.equal(res.body.error.code, 'missing_agent_name');

    await teardown();
  });

  test('onboarding: complete rejects invalid tier', async () => {
    await setup();

    const res = await client.post('/api/a2a/dashboard/onboarding/complete', {
      body: {
        agentName: 'TestBot',
        defaultTier: 'superadmin',
        port: 3001
      }
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.success, false);
    assert.equal(res.body.error.code, 'invalid_tier');

    await teardown();
  });

  test('onboarding: complete rejects invalid port', async () => {
    await setup();

    const res = await client.post('/api/a2a/dashboard/onboarding/complete', {
      body: {
        agentName: 'TestBot',
        defaultTier: 'public',
        port: 99999
      }
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.success, false);
    assert.equal(res.body.error.code, 'invalid_port');

    await teardown();
  });

  // ── Status after completion ──────────────────────────────────

  test('onboarding: after completing, status shows onboarded=true', async () => {
    await setup();

    // Initially not onboarded
    const before = await client.get('/api/a2a/dashboard/onboarding/status');
    assert.equal(before.body.onboarded, false);

    // Complete onboarding
    const complete = await client.post('/api/a2a/dashboard/onboarding/complete', {
      body: {
        agentName: 'WizardBot',
        defaultTier: 'friends',
        port: 8080,
        topics: ['general']
      }
    });
    assert.equal(complete.statusCode, 200);
    assert.equal(complete.body.success, true);

    // Now onboarded
    const after = await client.get('/api/a2a/dashboard/onboarding/status');
    assert.equal(after.body.onboarded, true);
    assert.ok(after.body.onboarding);

    await teardown();
  });
};
