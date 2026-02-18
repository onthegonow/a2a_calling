/**
 * Test Helpers
 *
 * Provides isolated temp directories, cleanup, and shared fixtures
 * so every test file gets a fresh environment.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

/**
 * Create an isolated temp directory for a test run.
 * Sets A2A_CONFIG_DIR so all modules write there instead of ~/.config/openclaw.
 *
 * Returns { dir, cleanup } — call cleanup() in afterEach.
 */
function tmpConfigDir(prefix = 'a2a-test') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  process.env.A2A_CONFIG_DIR = dir;
  return {
    dir,
    cleanup() {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (e) {
        // best-effort
      }
      delete process.env.A2A_CONFIG_DIR;
    }
  };
}

/**
 * Build the Golda Deluxe test agent profile.
 *
 * This is the canonical test agent: a well-specified profile
 * that exercises every tier, topic category, and permission.
 *
 * Profile spec:
 *   Name:        Golda Deluxe
 *   Owner:       unnamed (null)
 *   Personality: Refined, analytical, with a taste for the finer things.
 *
 * See test/profiles/golda-deluxe.js for the full breakdown.
 */
function goldaDeluxeProfile() {
  return require('./profiles/golda-deluxe');
}

/**
 * Create a pre-populated TokenStore in a temp directory.
 * Returns { store, token, record, dir, cleanup }.
 */
function tokenStoreWithGolda() {
  const { dir, cleanup } = tmpConfigDir('a2a-golda');
  // Fresh require to pick up new config dir
  delete require.cache[require.resolve('../src/lib/tokens')];
  const { TokenStore } = require('../src/lib/tokens');
  const store = new TokenStore(dir);
  const profile = goldaDeluxeProfile();

  const { token, record } = store.create({
    name: profile.agent.name,
    owner: profile.agent.owner,
    permissions: profile.token.tier,
    expires: profile.token.expires,
    maxCalls: profile.token.maxCalls,
    allowedTopics: profile.token.allowedTopics,
    allowedGoals: profile.token.allowedGoals,
    tierSettings: profile.token.tierSettings
  });

  return { store, token, record, dir, cleanup, profile };
}

/**
 * Write a disclosure manifest to the given config dir.
 */
function writeDisclosureManifest(dir, manifest) {
  const manifestPath = path.join(dir, 'a2a-disclosure.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

/**
 * Write an A2A config to the given config dir.
 */
function writeA2AConfig(dir, config) {
  const configPath = path.join(dir, 'a2a-config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

/**
 * Create a minimal Express app with A2A routes for integration tests.
 * Returns { app, tokenStore, server: null }.
 * Call .listen() on the app to start it, or use supertest-style testing.
 */
function createTestApp(options = {}) {
  delete require.cache[require.resolve('../src/routes/a2a')];
  delete require.cache[require.resolve('../src/lib/tokens')];

  const express = require('express');
  const { createRoutes } = require('../src/routes/a2a');
  const { TokenStore } = require('../src/lib/tokens');

  const { dir, cleanup } = tmpConfigDir('a2a-app');
  const tokenStore = new TokenStore(dir);

  const app = express();
  app.use(express.json({ limit: '100kb' }));

  const handleMessage = options.handleMessage || async function (message, context) {
    return {
      text: `Echo from test: ${message}`,
      canContinue: true
    };
  };

  app.use('/api/a2a', createRoutes({
    tokenStore,
    handleMessage,
    notifyOwner: options.notifyOwner || (() => Promise.resolve()),
    summarizer: options.summarizer || null
  }));

  return { app, tokenStore, dir, cleanup };
}

/**
 * Make an HTTP request to a local Express app (no external deps).
 * Returns { statusCode, headers, body }.
 */
function request(app) {
  const http = require('http');

  // Start server on ephemeral port
  let server;
  const ready = new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });

  const methods = {};
  for (const method of ['get', 'post', 'put', 'delete']) {
    methods[method] = async (urlPath, options = {}) => {
      await ready;
      const addr = server.address();
      const body = options.body ? JSON.stringify(options.body) : null;

      return new Promise((resolve, reject) => {
        const req = http.request({
          hostname: addr.address,
          port: addr.port,
          path: urlPath,
          method: method.toUpperCase(),
          headers: {
            'Content-Type': 'application/json',
            ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
            ...(options.headers || {})
          }
        }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            let parsed;
            try { parsed = JSON.parse(data); } catch { parsed = data; }
            resolve({ statusCode: res.statusCode, headers: res.headers, body: parsed });
          });
        });

        req.on('error', reject);
        if (body) req.write(body);
        req.end();
      });
    };
  }

  methods.close = () => {
    return new Promise((resolve) => {
      if (server) server.close(resolve);
      else resolve();
    });
  };

  return methods;
}

module.exports = {
  tmpConfigDir,
  goldaDeluxeProfile,
  tokenStoreWithGolda,
  writeDisclosureManifest,
  writeA2AConfig,
  createTestApp,
  request
};
