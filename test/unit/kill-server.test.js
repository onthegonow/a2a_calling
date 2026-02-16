/**
 * Kill Server Tests
 *
 * Covers: killServerPid() port-verification logic in uninstall.
 * Spawns real detached servers and verifies that uninstall --force
 * actually frees the port (not just sends SIGTERM to a stale PID).
 */

module.exports = function (test, assert, helpers) {
  const net = require('net');
  const fs = require('fs');
  const path = require('path');
  const { spawn, spawnSync } = require('child_process');

  function waitForPort(port, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      function attempt() {
        const socket = net.connect({ host: '127.0.0.1', port });
        socket.once('connect', () => {
          socket.destroy();
          resolve(true);
        });
        socket.once('error', () => {
          if (Date.now() - start > timeoutMs) return resolve(false);
          setTimeout(attempt, 100);
        });
        socket.setTimeout(200, () => {
          socket.destroy();
          if (Date.now() - start > timeoutMs) return resolve(false);
          setTimeout(attempt, 100);
        });
      }
      attempt();
    });
  }

  function isPortFree(port) {
    return new Promise((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port });
      socket.setTimeout(300, () => { socket.destroy(); resolve(true); });
      socket.once('connect', () => { socket.destroy(); resolve(false); });
      socket.once('error', () => resolve(true));
    });
  }

  // Spawn a simple TCP server as a detached process on a given port
  function spawnDetachedServer(port) {
    const script = `
      const net = require('net');
      const server = net.createServer((c) => c.end('hello'));
      server.listen(${port}, '127.0.0.1', () => {
        if (process.send) process.send('ready');
      });
    `;
    const child = spawn(process.execPath, ['-e', script], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore']
    });
    child.unref();
    return child.pid;
  }

  test('uninstall --force kills detached server and frees port', async () => {
    const port = 19876;
    const tmp = helpers.tmpConfigDir('kill-server-test');

    // Write onboarding config with server_pid and server_port
    const pid = spawnDetachedServer(port);

    // Wait for server to bind
    const up = await waitForPort(port, 5000);
    assert.ok(up, `Detached server should be listening on port ${port}`);

    // Write config that the uninstall code will read
    const configPath = path.join(tmp.dir, 'a2a-config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      onboarding: {
        version: 2,
        server_pid: pid,
        server_port: port
      }
    }));

    // Run uninstall --force
    const res = spawnSync(process.execPath, ['bin/cli.js', 'uninstall', '--force'], {
      env: { ...process.env, A2A_CONFIG_DIR: tmp.dir },
      encoding: 'utf8',
      timeout: 20000
    });

    assert.equal(res.status, 0, `Expected exit 0, got ${res.status}. stderr=${(res.stderr || '').trim()}`);
    assert.includes(res.stdout, '✅', 'Should show success checkmark for stopping server');

    // Verify port is actually freed
    const free = await isPortFree(port);
    assert.ok(free, `Port ${port} should be free after uninstall`);

    tmp.cleanup();
  });

  test('uninstall --force with stale PID still kills process on port', async () => {
    const port = 19877;
    const tmp = helpers.tmpConfigDir('kill-server-stale');

    // Spawn a real server on the port
    const realPid = spawnDetachedServer(port);
    const up = await waitForPort(port, 5000);
    assert.ok(up, `Server should be listening on port ${port}`);

    // Write config with a WRONG (stale) PID but correct port
    const configPath = path.join(tmp.dir, 'a2a-config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      onboarding: {
        version: 2,
        server_pid: 999999999, // fake PID — doesn't exist
        server_port: port
      }
    }));

    // Run uninstall --force
    const res = spawnSync(process.execPath, ['bin/cli.js', 'uninstall', '--force'], {
      env: { ...process.env, A2A_CONFIG_DIR: tmp.dir },
      encoding: 'utf8',
      timeout: 20000
    });

    assert.equal(res.status, 0, `Expected exit 0, got ${res.status}. stderr=${(res.stderr || '').trim()}`);

    // Verify port is freed (the port-based fallback should have found and killed it)
    const free = await isPortFree(port);
    assert.ok(free, `Port ${port} should be free even with stale PID config`);

    // Safety: make sure the real process is gone
    try {
      process.kill(realPid, 0);
      // Still alive? Force kill as cleanup
      process.kill(realPid, 'SIGKILL');
    } catch (e) {
      // Already dead — good
    }

    tmp.cleanup();
  });

  test('uninstall --force with no server_port still works (backwards compat)', async () => {
    const tmp = helpers.tmpConfigDir('kill-server-noport');

    // Write config with only server_pid (no port)
    const configPath = path.join(tmp.dir, 'a2a-config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      onboarding: {
        version: 2,
        server_pid: 999999999 // doesn't exist
      }
    }));

    // Run uninstall --force
    const res = spawnSync(process.execPath, ['bin/cli.js', 'uninstall', '--force'], {
      env: { ...process.env, A2A_CONFIG_DIR: tmp.dir },
      encoding: 'utf8',
      timeout: 20000
    });

    assert.equal(res.status, 0, `Expected exit 0, got ${res.status}. stderr=${(res.stderr || '').trim()}`);
    assert.includes(res.stdout, '✅', 'Should still succeed when no port is configured');

    tmp.cleanup();
  });

  test('uninstall --force with no onboarding config succeeds gracefully', async () => {
    const tmp = helpers.tmpConfigDir('kill-server-noconfig');

    // Write minimal config with no onboarding section
    const configPath = path.join(tmp.dir, 'a2a-config.json');
    fs.writeFileSync(configPath, JSON.stringify({}));

    const res = spawnSync(process.execPath, ['bin/cli.js', 'uninstall', '--force'], {
      env: { ...process.env, A2A_CONFIG_DIR: tmp.dir },
      encoding: 'utf8',
      timeout: 20000
    });

    assert.equal(res.status, 0, `Expected exit 0, got ${res.status}. stderr=${(res.stderr || '').trim()}`);
    assert.includes(res.stdout, '✅', 'Should succeed with no onboarding config');

    tmp.cleanup();
  });

  test('uninstall --force reads PID file and kills the server', async () => {
    const port = 19878;
    const tmp = helpers.tmpConfigDir('kill-server-pidfile');

    // Spawn a real server on the port
    const pid = spawnDetachedServer(port);
    const up = await waitForPort(port, 5000);
    assert.ok(up, `Server should be listening on port ${port}`);

    // Write PID file (what server.js now does)
    const pidPath = path.join(tmp.dir, 'a2a-server.pid');
    fs.writeFileSync(pidPath, String(pid) + '\n');

    // Write config with NO server_pid (PID file is the primary mechanism)
    const configPath = path.join(tmp.dir, 'a2a-config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      onboarding: { version: 2, server_port: port }
    }));

    // Run uninstall --force
    const res = spawnSync(process.execPath, ['bin/cli.js', 'uninstall', '--force'], {
      env: { ...process.env, A2A_CONFIG_DIR: tmp.dir },
      encoding: 'utf8',
      timeout: 20000
    });

    assert.equal(res.status, 0, `Expected exit 0, got ${res.status}. stderr=${(res.stderr || '').trim()}`);

    // Verify port is freed
    const free = await isPortFree(port);
    assert.ok(free, `Port ${port} should be free after uninstall`);

    // Verify PID file is cleaned up
    assert.ok(!fs.existsSync(pidPath), 'PID file should be removed after uninstall');

    tmp.cleanup();
  });

  test('uninstall --force kills multiple tracked PIDs from config', async () => {
    const port1 = 19879;
    const port2 = 19880;
    const tmp = helpers.tmpConfigDir('kill-server-multi');

    // Spawn two servers on different ports
    const pid1 = spawnDetachedServer(port1);
    const pid2 = spawnDetachedServer(port2);
    const up1 = await waitForPort(port1, 5000);
    const up2 = await waitForPort(port2, 5000);
    assert.ok(up1, `Server 1 should be listening on port ${port1}`);
    assert.ok(up2, `Server 2 should be listening on port ${port2}`);

    // Write config with server_pids array
    const configPath = path.join(tmp.dir, 'a2a-config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      onboarding: {
        version: 2,
        server_pid: pid2,
        server_pids: [pid1, pid2],
        server_port: port2
      }
    }));

    const res = spawnSync(process.execPath, ['bin/cli.js', 'uninstall', '--force'], {
      env: { ...process.env, A2A_CONFIG_DIR: tmp.dir },
      encoding: 'utf8',
      timeout: 20000
    });

    assert.equal(res.status, 0, `Expected exit 0, got ${res.status}`);

    // Both ports should be freed
    const free1 = await isPortFree(port1);
    const free2 = await isPortFree(port2);
    assert.ok(free1, `Port ${port1} should be free`);
    assert.ok(free2, `Port ${port2} should be free`);

    // Safety cleanup
    try { process.kill(pid1, 'SIGKILL'); } catch (e) {}
    try { process.kill(pid2, 'SIGKILL'); } catch (e) {}

    tmp.cleanup();
  });
};
