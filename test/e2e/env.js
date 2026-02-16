const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');

/**
 * Create a fully isolated E2E test environment.
 *
 * Returns { dir, configDir, env, findAvailablePort, cleanup }.
 *
 * - dir: root temp directory for this test run
 * - configDir: path that A2A_CONFIG_DIR points to
 * - env: process.env clone with A2A_CONFIG_DIR set
 * - findAvailablePort(): resolves to an unused port
 * - cleanup(): removes all temp files
 */
function createE2EEnv(prefix = 'a2a-e2e') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  const configDir = path.join(dir, 'config');
  fs.mkdirSync(configDir, { recursive: true });

  const env = {
    ...process.env,
    A2A_CONFIG_DIR: configDir,
    // Prevent postinstall from running quickstart
    CI: 'true'
  };

  function findAvailablePort() {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        server.close(() => resolve(port));
      });
      server.on('error', reject);
    });
  }

  function cleanup() {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) { /* best-effort */ }
  }

  return { dir, configDir, env, findAvailablePort, cleanup };
}

module.exports = { createE2EEnv };
