/**
 * Standalone E2E environment helper (A2A-103)
 *
 * Spins up an isolated server instance with temp config for testing
 * the full standalone app user journey via HTTP API.
 */
const http = require('http');
const path = require('path');
const { createE2EEnv } = require('../env');

/**
 * Create a standalone test environment with a running server.
 * Returns { server, port, baseUrl, configDir, env, request, cleanup }
 */
async function createStandaloneEnv(opts = {}) {
  const e2e = createE2EEnv('standalone');

  // Point config to temp dir
  process.env.A2A_CONFIG_DIR = e2e.configDir;
  process.env.A2A_RUNTIME = 'test';

  // Bust module caches so each test gets fresh state
  const cacheBust = [
    '../../src/routes/dashboard',
    '../../src/lib/logger',
    '../../src/lib/tokens',
    '../../src/lib/config',
    '../../src/lib/disclosure',
    '../../src/lib/conversations',
    '../../src/lib/callbook',
    '../../src/lib/dashboard-events'
  ];
  for (const mod of cacheBust) {
    try { delete require.cache[require.resolve(mod)]; } catch (_) {}
  }

  const express = require('express');
  const { createDashboardApiRouter } = require('../../src/routes/dashboard');
  const loggerModule = require('../../src/lib/logger');

  const app = express();
  const logger = loggerModule.createLogger({
    component: 'test.standalone',
    configDir: e2e.configDir,
    stdout: false
  });

  const routerOpts = { logger };
  if (typeof opts.getUpdateManager === 'function') {
    routerOpts.getUpdateManager = opts.getUpdateManager;
  }
  app.use('/api/a2a/dashboard', createDashboardApiRouter(routerOpts));

  const port = await e2e.findAvailablePort();
  const server = await new Promise((resolve, reject) => {
    const srv = app.listen(port, '127.0.0.1', () => resolve(srv));
    srv.on('error', reject);
  });

  const baseUrl = `http://127.0.0.1:${port}/api/a2a/dashboard`;

  /**
   * Simple HTTP request helper.
   * NOTE: urlPath must be an absolute path (e.g. '/api/a2a/dashboard/status').
   * new URL(absolutePath, baseUrl) discards the base path — this is intentional.
   */
  function request(method, urlPath, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(urlPath, baseUrl);
      const data = body ? JSON.stringify(body) : null;
      const req = http.request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
        }
      }, (res) => {
        let chunks = '';
        res.on('data', c => chunks += c);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(chunks) }); }
          catch { resolve({ status: res.statusCode, headers: res.headers, body: chunks }); }
        });
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }

  function cleanup() {
    try { server.close(); } catch (_) {}
    try { loggerModule.closeAllLoggerStores(); } catch (_) {}
    e2e.cleanup();
    delete process.env.A2A_CONFIG_DIR;
    delete process.env.A2A_RUNTIME;
  }

  return { server, port, baseUrl, configDir: e2e.configDir, env: e2e.env, request, cleanup };
}

module.exports = { createStandaloneEnv };
