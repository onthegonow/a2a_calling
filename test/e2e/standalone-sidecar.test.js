/**
 * Standalone Sidecar Lifecycle E2E Tests (A2A-103)
 *
 * Tests server lifecycle without requiring the native Tauri app:
 *   - Server starts on expected port and health endpoint responds
 *   - Server shutdown is graceful
 *   - Crash recovery: kill server, verify it can be restarted
 */

module.exports = function (test, assert, helpers, ctx) {
  const { spawn } = require('child_process');
  const http = require('http');
  const { createE2EEnv } = require('./env');
  const path = require('path');

  let env;
  let serverProc;

  function httpGet(port, urlPath) {
    return new Promise((resolve, reject) => {
      const req = http.get({ hostname: '127.0.0.1', port, path: urlPath, timeout: 3000 }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
  }

  function waitForServer(port, maxWait = 5000) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
      function check() {
        httpGet(port, '/api/a2a/status')
          .then(res => {
            if (res.status === 200) return resolve(res);
            if (Date.now() - start > maxWait) return reject(new Error('Server did not start'));
            setTimeout(check, 200);
          })
          .catch(() => {
            if (Date.now() - start > maxWait) return reject(new Error('Server did not start'));
            setTimeout(check, 200);
          });
      }
      check();
    });
  }

  ctx.afterEach(async () => {
    if (serverProc && !serverProc.killed) {
      serverProc.kill('SIGTERM');
      serverProc = null;
    }
    if (env) { env.cleanup(); env = null; }
  });

  test('standalone sidecar: server starts and responds to health check', async () => {
    env = createE2EEnv('sidecar');
    const port = await env.findAvailablePort();

    serverProc = spawn(process.execPath, [
      path.join(__dirname, '../../bin/cli.js'), 'server', '--port', String(port)
    ], {
      env: { ...env.env, A2A_RUNTIME: 'test' },
      stdio: 'pipe'
    });

    // try/finally ensures process cleanup even if assertions fail
    // (the test runner's afterEach only fires on success)
    try {
      const res = await waitForServer(port);
      assert.equal(res.status, 200, 'Health endpoint responds 200');
    } catch (err) {
      if (serverProc && !serverProc.killed) { serverProc.kill('SIGKILL'); serverProc = null; }
      throw err;
    }
  });

  test('standalone sidecar: server handles SIGTERM gracefully', async () => {
    env = createE2EEnv('sidecar-term');
    const port = await env.findAvailablePort();

    serverProc = spawn(process.execPath, [
      path.join(__dirname, '../../bin/cli.js'), 'server', '--port', String(port)
    ], {
      env: { ...env.env, A2A_RUNTIME: 'test' },
      stdio: 'pipe'
    });

    try {
      await waitForServer(port);

      // Send SIGTERM and wait for exit
      const exitPromise = new Promise(resolve => {
        serverProc.on('exit', (code, signal) => resolve({ code, signal }));
      });
      serverProc.kill('SIGTERM');
      const result = await exitPromise;
      serverProc = null;

      // Server should exit cleanly (code 0 or signal SIGTERM)
      assert.ok(
        result.code === 0 || result.signal === 'SIGTERM',
        'Server should exit gracefully on SIGTERM'
      );
    } catch (err) {
      if (serverProc && !serverProc.killed) { serverProc.kill('SIGKILL'); serverProc = null; }
      throw err;
    }
  });

  test('standalone sidecar: restart after crash', async () => {
    env = createE2EEnv('sidecar-crash');
    const port = await env.findAvailablePort();

    try {
      // Start server
      serverProc = spawn(process.execPath, [
        path.join(__dirname, '../../bin/cli.js'), 'server', '--port', String(port)
      ], {
        env: { ...env.env, A2A_RUNTIME: 'test' },
        stdio: 'pipe'
      });

      await waitForServer(port);

      // Kill with SIGKILL (simulate crash)
      serverProc.kill('SIGKILL');
      await new Promise(resolve => serverProc.on('exit', resolve));

      // Restart on same port
      serverProc = spawn(process.execPath, [
        path.join(__dirname, '../../bin/cli.js'), 'server', '--port', String(port)
      ], {
        env: { ...env.env, A2A_RUNTIME: 'test' },
        stdio: 'pipe'
      });

      const res = await waitForServer(port);
      assert.equal(res.status, 200, 'Server restarts after crash');
    } catch (err) {
      if (serverProc && !serverProc.killed) { serverProc.kill('SIGKILL'); serverProc = null; }
      throw err;
    }
  });
};
