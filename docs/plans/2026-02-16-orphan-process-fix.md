# Orphaned Server Process Fix (A2A-25) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prevent `a2a quickstart` from leaking orphaned server processes by adding PID file tracking, pre-start cleanup, and robust uninstall scanning.

**Architecture:** Four complementary changes: (1) Server writes a PID file on startup and cleans it on exit, (2) Quickstart reads the PID file and kills any existing server before spawning a new one, (3) Uninstall scans for ALL a2a server processes (not just the config PID), (4) Config tracks multiple PIDs for defense-in-depth. All changes are in three files: `src/server.js`, `bin/cli.js`, and a new test file.

**Tech Stack:** Node.js built-ins (`fs`, `path`, `process`, `child_process`), existing zero-dependency test runner at `test/run.js`, existing test helpers at `test/helpers.js`.

---

## Key Constants

```
PID file location: CONFIG_DIR/a2a-server.pid
CONFIG_DIR = process.env.A2A_CONFIG_DIR || ~/.config/openclaw
```

---

### Task 1: Write the PID file module

**Files:**
- Create: `src/lib/pid-file.js`
- Test: `test/unit/pid-file.test.js`

**Step 1: Write the failing tests**

Create `test/unit/pid-file.test.js`:

```javascript
/**
 * PID File Tests
 *
 * Covers: writePidFile, readPidFile, removePidFile, isProcessAlive, killExistingServer
 */

module.exports = function (test, assert, helpers) {
  const fs = require('fs');
  const path = require('path');
  const { spawn } = require('child_process');
  const net = require('net');

  // Fresh require helper — pid-file reads CONFIG_DIR at require time
  function requirePidFile(configDir) {
    // Clear cached module so it picks up the new A2A_CONFIG_DIR
    const modPath = require.resolve('../../src/lib/pid-file');
    delete require.cache[modPath];
    process.env.A2A_CONFIG_DIR = configDir;
    return require('../../src/lib/pid-file');
  }

  test('writePidFile writes PID to a2a-server.pid', () => {
    const tmp = helpers.tmpConfigDir('pid-write');
    const pf = requirePidFile(tmp.dir);

    pf.writePidFile(12345);

    const pidPath = path.join(tmp.dir, 'a2a-server.pid');
    assert.ok(fs.existsSync(pidPath), 'PID file should exist');
    const content = fs.readFileSync(pidPath, 'utf8').trim();
    assert.equal(content, '12345', 'PID file should contain the PID');

    tmp.cleanup();
  });

  test('readPidFile returns the PID as a number', () => {
    const tmp = helpers.tmpConfigDir('pid-read');
    const pf = requirePidFile(tmp.dir);

    fs.writeFileSync(path.join(tmp.dir, 'a2a-server.pid'), '42\n');
    const pid = pf.readPidFile();
    assert.equal(pid, 42, 'Should parse PID as number');

    tmp.cleanup();
  });

  test('readPidFile returns null when file missing', () => {
    const tmp = helpers.tmpConfigDir('pid-read-missing');
    const pf = requirePidFile(tmp.dir);

    const pid = pf.readPidFile();
    assert.equal(pid, null, 'Should return null when no PID file');

    tmp.cleanup();
  });

  test('readPidFile returns null for corrupt content', () => {
    const tmp = helpers.tmpConfigDir('pid-read-corrupt');
    const pf = requirePidFile(tmp.dir);

    fs.writeFileSync(path.join(tmp.dir, 'a2a-server.pid'), 'not-a-number\n');
    const pid = pf.readPidFile();
    assert.equal(pid, null, 'Should return null for non-numeric content');

    tmp.cleanup();
  });

  test('removePidFile deletes the file', () => {
    const tmp = helpers.tmpConfigDir('pid-remove');
    const pf = requirePidFile(tmp.dir);

    const pidPath = path.join(tmp.dir, 'a2a-server.pid');
    fs.writeFileSync(pidPath, '99\n');
    pf.removePidFile();
    assert.ok(!fs.existsSync(pidPath), 'PID file should be removed');

    tmp.cleanup();
  });

  test('removePidFile is safe when file does not exist', () => {
    const tmp = helpers.tmpConfigDir('pid-remove-noop');
    const pf = requirePidFile(tmp.dir);

    // Should not throw
    pf.removePidFile();

    tmp.cleanup();
  });

  test('isProcessAlive returns true for current process', () => {
    const tmp = helpers.tmpConfigDir('pid-alive');
    const pf = requirePidFile(tmp.dir);

    assert.ok(pf.isProcessAlive(process.pid), 'Current process should be alive');

    tmp.cleanup();
  });

  test('isProcessAlive returns false for non-existent PID', () => {
    const tmp = helpers.tmpConfigDir('pid-dead');
    const pf = requirePidFile(tmp.dir);

    assert.ok(!pf.isProcessAlive(999999999), 'Fake PID should not be alive');

    tmp.cleanup();
  });

  test('killExistingServer kills a live process from PID file', async () => {
    const tmp = helpers.tmpConfigDir('pid-kill');
    const pf = requirePidFile(tmp.dir);

    // Spawn a detached sleep process
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
    const pid = child.pid;

    // Write PID file
    pf.writePidFile(pid);

    // Kill it
    const result = pf.killExistingServer();
    assert.ok(result.killed, 'Should report killed');
    assert.equal(result.pid, pid, 'Should report the PID');

    // Verify dead
    await new Promise(r => setTimeout(r, 200));
    assert.ok(!pf.isProcessAlive(pid), 'Process should be dead');

    tmp.cleanup();
  });

  test('killExistingServer returns no-op when no PID file', () => {
    const tmp = helpers.tmpConfigDir('pid-kill-noop');
    const pf = requirePidFile(tmp.dir);

    const result = pf.killExistingServer();
    assert.ok(!result.killed, 'Should not report killed');

    tmp.cleanup();
  });

  test('killExistingServer returns no-op when PID is stale', () => {
    const tmp = helpers.tmpConfigDir('pid-kill-stale');
    const pf = requirePidFile(tmp.dir);

    fs.writeFileSync(path.join(tmp.dir, 'a2a-server.pid'), '999999999\n');
    const result = pf.killExistingServer();
    assert.ok(!result.killed, 'Should not report killed for dead process');

    // PID file should be cleaned up
    assert.equal(pf.readPidFile(), null, 'Stale PID file should be removed');

    tmp.cleanup();
  });
};
```

**Step 2: Run tests to verify they fail**

Run: `node test/run.js --filter pid-file`
Expected: FAIL — module `src/lib/pid-file` does not exist

**Step 3: Write the implementation**

Create `src/lib/pid-file.js`:

```javascript
/**
 * PID File Management
 *
 * Writes/reads/removes a PID file for the A2A server process.
 * Used by server.js on startup and cli.js for pre-start cleanup.
 */

const fs = require('fs');
const path = require('path');

const CONFIG_DIR = process.env.A2A_CONFIG_DIR ||
  process.env.OPENCLAW_CONFIG_DIR ||
  path.join(process.env.HOME || '/tmp', '.config', 'openclaw');

const PID_FILE = path.join(CONFIG_DIR, 'a2a-server.pid');

function writePidFile(pid) {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    fs.writeFileSync(PID_FILE, String(pid) + '\n', { mode: 0o600 });
  } catch (e) {
    // Best effort — don't crash the server if PID file write fails
  }
}

function readPidFile() {
  try {
    const content = fs.readFileSync(PID_FILE, 'utf8').trim();
    const pid = parseInt(content, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch (e) {
    return null;
  }
}

function removePidFile() {
  try {
    fs.rmSync(PID_FILE, { force: true });
  } catch (e) {
    // Best effort
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Kill the server process recorded in the PID file.
 * Returns { killed: boolean, pid: number|null }.
 */
function killExistingServer() {
  const pid = readPidFile();
  if (!pid) return { killed: false, pid: null };

  if (!isProcessAlive(pid)) {
    // Stale PID file — clean up
    removePidFile();
    return { killed: false, pid };
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch (e) {
    removePidFile();
    return { killed: false, pid };
  }

  // Wait up to 3s for graceful exit
  const start = Date.now();
  while (Date.now() - start < 3000) {
    if (!isProcessAlive(pid)) {
      removePidFile();
      return { killed: true, pid };
    }
    // Busy-wait in small increments (sync — this runs before server spawn)
    const { spawnSync } = require('child_process');
    spawnSync('sleep', ['0.1'], { timeout: 500 });
  }

  // Force kill
  try {
    process.kill(pid, 'SIGKILL');
  } catch (e) {}

  removePidFile();
  return { killed: true, pid };
}

module.exports = {
  writePidFile,
  readPidFile,
  removePidFile,
  isProcessAlive,
  killExistingServer,
  PID_FILE
};
```

**Step 4: Run tests to verify they pass**

Run: `node test/run.js --filter pid-file`
Expected: All 10 tests PASS

**Step 5: Also run the full suite to check for regressions**

Run: `node test/run.js`
Expected: All 285+ tests PASS

**Step 6: Commit**

```bash
git add src/lib/pid-file.js test/unit/pid-file.test.js
git commit -m "feat(pid-file): add PID file management module with tests (A2A-25)"
```

---

### Task 2: Server writes PID file on startup, cleans on exit

**Files:**
- Modify: `src/server.js:895-922` (startup and end of file)
- Test: `test/unit/pid-file.test.js` (add integration-style test)

**Step 1: Write the failing test**

Add to `test/unit/pid-file.test.js`:

```javascript
  test('server.js writes PID file on startup and removes on exit', async () => {
    const tmp = helpers.tmpConfigDir('pid-server-lifecycle');
    const pidPath = path.join(tmp.dir, 'a2a-server.pid');
    const { spawnSync } = require('child_process');

    // Start the real server with a random high port
    const port = 19870 + Math.floor(Math.random() * 100);
    const child = spawn(process.execPath, [
      path.join(__dirname, '../../src/server.js')
    ], {
      env: { ...process.env, A2A_CONFIG_DIR: tmp.dir, PORT: String(port) },
      detached: true,
      stdio: 'ignore'
    });
    child.unref();

    // Wait for server to start and write PID file
    let pidWritten = false;
    for (let i = 0; i < 30; i++) {
      if (fs.existsSync(pidPath)) {
        pidWritten = true;
        break;
      }
      await new Promise(r => setTimeout(r, 200));
    }

    assert.ok(pidWritten, 'Server should write PID file on startup');
    const writtenPid = parseInt(fs.readFileSync(pidPath, 'utf8').trim(), 10);
    assert.equal(writtenPid, child.pid, 'PID file should contain server PID');

    // Send SIGTERM and verify PID file is cleaned up
    process.kill(child.pid, 'SIGTERM');
    let pidRemoved = false;
    for (let i = 0; i < 30; i++) {
      if (!fs.existsSync(pidPath)) {
        pidRemoved = true;
        break;
      }
      await new Promise(r => setTimeout(r, 200));
    }

    assert.ok(pidRemoved, 'Server should remove PID file on SIGTERM');

    // Cleanup: ensure process is dead
    try { process.kill(child.pid, 'SIGKILL'); } catch (e) {}

    tmp.cleanup();
  });
```

**Step 2: Run the new test to verify it fails**

Run: `node test/run.js --filter pid-file`
Expected: The new lifecycle test FAILS because server.js doesn't write a PID file yet

**Step 3: Modify `src/server.js`**

Add PID file write after `app.listen()` callback (after line 906) and signal handlers at end of `startServer()`:

At the top of `src/server.js` (after the existing requires around line 24), add:

```javascript
const { writePidFile, removePidFile } = require('./lib/pid-file');
```

Inside the `app.listen()` callback (after the logger.info call at line 905), add:

```javascript
    writePidFile(process.pid);
```

Before the closing `}` of `startServer()` (before line 920), add signal handlers:

```javascript
  // Graceful shutdown: clean up PID file
  function shutdown(signal) {
    removePidFile();
    server.close(() => process.exit(0));
    // Force exit after 5s if connections won't close
    setTimeout(() => process.exit(0), 5000).unref();
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
```

**Step 4: Run tests to verify they pass**

Run: `node test/run.js --filter pid-file`
Expected: All tests PASS including the lifecycle test

**Step 5: Run full suite**

Run: `node test/run.js`
Expected: All 285+ tests PASS

**Step 6: Commit**

```bash
git add src/server.js test/unit/pid-file.test.js
git commit -m "feat(server): write PID file on startup, remove on shutdown (A2A-25)"
```

---

### Task 3: Pre-start cleanup in quickstart

**Files:**
- Modify: `bin/cli.js:1956-1966` (before the `spawn` call in quickstart)
- Test: `test/unit/pid-file.test.js` (add pre-start test)

**Step 1: Write the failing test**

Add to `test/unit/pid-file.test.js`:

```javascript
  test('quickstart kills existing server before starting a new one', async () => {
    const tmp = helpers.tmpConfigDir('pid-prestart');
    const pf = requirePidFile(tmp.dir);
    const pidPath = path.join(tmp.dir, 'a2a-server.pid');

    // Spawn a fake "old server" (just a sleep process)
    const oldServer = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      detached: true,
      stdio: 'ignore'
    });
    oldServer.unref();
    const oldPid = oldServer.pid;

    // Write its PID to the PID file (simulating a previous quickstart)
    pf.writePidFile(oldPid);
    assert.ok(pf.isProcessAlive(oldPid), 'Old server should be alive');

    // Call killExistingServer (what quickstart will do)
    const result = pf.killExistingServer();
    assert.ok(result.killed, 'Should kill the old server');

    await new Promise(r => setTimeout(r, 200));
    assert.ok(!pf.isProcessAlive(oldPid), 'Old server should be dead after cleanup');
    assert.equal(pf.readPidFile(), null, 'PID file should be cleaned up');

    tmp.cleanup();
  });
```

**Step 2: Run test to verify it passes (it should — killExistingServer already works)**

Run: `node test/run.js --filter pid-file`
Expected: PASS — this is testing the module integration, the next step wires it into cli.js

**Step 3: Modify `bin/cli.js` quickstart to call pre-start cleanup**

In `bin/cli.js`, around line 1958 (after the `isAlreadyListening` check, before the spawn block), add pre-start cleanup:

Replace the block at lines 1956-1968:
```javascript
    const isAlreadyListening = await isPortListening(serverPort, '127.0.0.1', { timeoutMs: 250 });
    let serverPid = null;
    if (!isAlreadyListening.listening) {
      const serverScript = path.join(__dirname, '../src/server.js');
      const child = spawn(process.execPath, [serverScript], {
        env: { ...process.env, PORT: String(serverPort) },
        detached: true,
        stdio: 'ignore'
      });
      serverPid = child.pid;
      child.unref();
    } else {
      console.log('  Existing server detected on this port.');
    }
```

With:
```javascript
    // Pre-start cleanup: kill any existing a2a server from a previous run
    try {
      const { killExistingServer } = require('../src/lib/pid-file');
      const cleanup = killExistingServer();
      if (cleanup.killed) {
        console.log(`  Stopped previous server (PID ${cleanup.pid}).`);
        // Brief pause to let the port free up
        await new Promise(r => setTimeout(r, 500));
      }
    } catch (e) {
      // Best effort — continue with startup
    }

    const isAlreadyListening = await isPortListening(serverPort, '127.0.0.1', { timeoutMs: 250 });
    let serverPid = null;
    if (!isAlreadyListening.listening) {
      const serverScript = path.join(__dirname, '../src/server.js');
      const child = spawn(process.execPath, [serverScript], {
        env: { ...process.env, PORT: String(serverPort) },
        detached: true,
        stdio: 'ignore'
      });
      serverPid = child.pid;
      child.unref();
    } else {
      console.log('  Existing server detected on this port.');
    }
```

**Step 4: Run full suite**

Run: `node test/run.js`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add bin/cli.js
git commit -m "feat(quickstart): kill existing server before spawning new one (A2A-25)"
```

---

### Task 4: Uninstall scans for all a2a server processes

**Files:**
- Modify: `bin/cli.js:2320-2362` (killServerPid function in uninstall)
- Test: `test/unit/kill-server.test.js` (add PID file-aware test)

**Step 1: Write the failing test**

Add to `test/unit/kill-server.test.js`:

```javascript
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

    // Write config with NO server_pid (simulating PID file as primary mechanism)
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
```

**Step 2: Run test to verify it fails**

Run: `node test/run.js --filter kill-server`
Expected: The new test may pass (port-based fallback might save it) or fail if PID file cleanup is checked. Either way, we need to wire PID file into uninstall.

**Step 3: Modify `killServerPid` in uninstall**

In `bin/cli.js`, modify the `killServerPid()` function (around line 2322) to also check the PID file as an additional kill source:

Replace the beginning of `killServerPid()`:

```javascript
    async function killServerPid() {
      let pid, serverPort;
      try {
        const { A2AConfig } = require('../src/lib/config');
        const cfg = new A2AConfig();
        const onboarding = cfg.getOnboarding();
        pid = onboarding.server_pid;
        serverPort = onboarding.server_port;
      } catch (err) {
        // Config read failed — not fatal, continue with pm2 path
        return { ok: true, skipped: true };
      }

      // Step 1: Try to kill the PID from config
      if (pid) {
        killPidSync(pid);
      }
```

With:

```javascript
    async function killServerPid() {
      let pid, serverPort;
      try {
        const { A2AConfig } = require('../src/lib/config');
        const cfg = new A2AConfig();
        const onboarding = cfg.getOnboarding();
        pid = onboarding.server_pid;
        serverPort = onboarding.server_port;
      } catch (err) {
        // Config read failed — not fatal, continue
      }

      // Step 0: Try PID file first (most reliable source)
      try {
        const { readPidFile, removePidFile } = require('../src/lib/pid-file');
        const filePid = readPidFile();
        if (filePid) {
          killPidSync(filePid);
          removePidFile();
          // If config PID is the same, don't double-kill
          if (filePid === pid) pid = null;
        }
      } catch (e) {
        // pid-file module load failed — continue with config PID
      }

      // Step 1: Try to kill the PID from config
      if (pid) {
        killPidSync(pid);
      }
```

Also add PID file cleanup at the end — after the port check, before the return statements, add PID file removal. After the `return` statements in `killServerPid`, ensure PID file is always cleaned:

At the end of `killServerPid()`, before the final `return { ok: true, pid, port: serverPort, skipped: !pid };`, add:

```javascript
      // Clean up PID file if it still exists
      try {
        const { removePidFile } = require('../src/lib/pid-file');
        removePidFile();
      } catch (e) {}
```

**Step 4: Run tests**

Run: `node test/run.js --filter kill-server`
Expected: All tests PASS including the new PID file test

**Step 5: Run full suite**

Run: `node test/run.js`
Expected: All 285+ tests PASS

**Step 6: Commit**

```bash
git add bin/cli.js test/unit/kill-server.test.js
git commit -m "feat(uninstall): read PID file for robust server kill (A2A-25)"
```

---

### Task 5: Multi-PID tracking in config (defense-in-depth)

**Files:**
- Modify: `bin/cli.js:1987-1989` (save PID after spawn)
- Modify: `bin/cli.js:2328` (read PIDs in uninstall)

**Step 1: Write the failing test**

Add to `test/unit/kill-server.test.js`:

```javascript
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
```

**Step 2: Run test to verify it fails**

Run: `node test/run.js --filter kill-server`
Expected: FAIL — pid1's port won't be freed because uninstall only checks `server_pid` (singular) and the port for pid2

**Step 3: Modify quickstart to track `server_pids` array**

In `bin/cli.js`, replace line 1989:

```javascript
      config.setOnboarding({ server_pid: serverPid, server_port: serverPort });
```

With:

```javascript
      const existingPids = (config.getOnboarding().server_pids || []).filter(p => {
        try { process.kill(p, 0); return true; } catch (e) { return false; }
      });
      if (!existingPids.includes(serverPid)) existingPids.push(serverPid);
      config.setOnboarding({
        server_pid: serverPid,
        server_pids: existingPids,
        server_port: serverPort
      });
```

**Step 4: Modify uninstall to kill all tracked PIDs**

In `bin/cli.js`, in `killServerPid()`, after reading onboarding, modify the "Step 1: Try to kill the PID from config" section.

Replace:

```javascript
      // Step 1: Try to kill the PID from config
      if (pid) {
        killPidSync(pid);
      }
```

With:

```javascript
      // Step 1: Try to kill all tracked PIDs from config
      const allPids = new Set();
      if (pid) allPids.add(pid);
      try {
        const { A2AConfig: A2AConfigReload } = require('../src/lib/config');
        const cfgReload = new A2AConfigReload();
        const ob = cfgReload.getOnboarding();
        if (Array.isArray(ob.server_pids)) {
          for (const p of ob.server_pids) {
            if (typeof p === 'number' && p > 0) allPids.add(p);
          }
        }
      } catch (e) {}

      for (const p of allPids) {
        killPidSync(p);
      }
```

Note: We already loaded config once at the top of `killServerPid` — since that section now might set `pid = null` after the PID file block, we should capture `server_pids` in the initial config read. Simpler approach: capture it in the initial try/catch:

In the initial config read block, after `serverPort = onboarding.server_port;` add:

```javascript
        var serverPids = Array.isArray(onboarding.server_pids) ? onboarding.server_pids : [];
```

Then in Step 1, replace:

```javascript
      // Step 1: Try to kill the PID from config
      if (pid) {
        killPidSync(pid);
      }
```

With:

```javascript
      // Step 1: Try to kill all tracked PIDs from config
      const allPids = new Set();
      if (pid) allPids.add(pid);
      if (serverPids) {
        for (const p of serverPids) {
          if (typeof p === 'number' && p > 0) allPids.add(p);
        }
      }
      for (const p of allPids) {
        killPidSync(p);
      }
```

And initialize `serverPids` alongside `pid` and `serverPort` (default `[]`):

```javascript
      let pid, serverPort, serverPids = [];
```

And in the config read:

```javascript
        serverPids = Array.isArray(onboarding.server_pids) ? onboarding.server_pids : [];
```

**Step 5: Run tests**

Run: `node test/run.js --filter kill-server`
Expected: All tests PASS including multi-PID

**Step 6: Run full suite**

Run: `node test/run.js`
Expected: All 285+ tests PASS

**Step 7: Commit**

```bash
git add bin/cli.js test/unit/kill-server.test.js
git commit -m "feat(cli): track and kill multiple server PIDs (A2A-25)"
```

---

### Task 6: Final integration test — repeated quickstart doesn't leak

**Files:**
- Test: `test/unit/pid-file.test.js` (add end-to-end orphan test)

**Step 1: Write the integration test**

Add to `test/unit/pid-file.test.js`:

```javascript
  test('repeated spawn-and-kill does not leak processes', async () => {
    const tmp = helpers.tmpConfigDir('pid-no-leak');
    const pf = requirePidFile(tmp.dir);
    const pids = [];

    // Simulate 3 quickstart runs: spawn → write PID → kill previous → spawn new
    for (let i = 0; i < 3; i++) {
      // Kill previous (what quickstart now does)
      pf.killExistingServer();

      // Spawn new
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
        detached: true,
        stdio: 'ignore'
      });
      child.unref();
      pids.push(child.pid);
      pf.writePidFile(child.pid);

      await new Promise(r => setTimeout(r, 100));
    }

    // Only the LAST process should be alive
    await new Promise(r => setTimeout(r, 300));
    for (let i = 0; i < pids.length - 1; i++) {
      assert.ok(!pf.isProcessAlive(pids[i]), `Process ${i} (PID ${pids[i]}) should be dead`);
    }
    assert.ok(pf.isProcessAlive(pids[pids.length - 1]), 'Last process should be alive');

    // Cleanup
    pf.killExistingServer();
    for (const pid of pids) {
      try { process.kill(pid, 'SIGKILL'); } catch (e) {}
    }

    tmp.cleanup();
  });
```

**Step 2: Run to verify it passes**

Run: `node test/run.js --filter pid-file`
Expected: PASS — the full pipeline works

**Step 3: Run full suite one final time**

Run: `node test/run.js`
Expected: All tests PASS

**Step 4: Commit**

```bash
git add test/unit/pid-file.test.js
git commit -m "test: add repeated-quickstart orphan leak test (A2A-25)"
```

---

## Summary of Changes

| File | Change |
|------|--------|
| `src/lib/pid-file.js` | New module: write/read/remove PID file, kill existing server |
| `src/server.js` | Write PID file on startup, remove on SIGTERM/SIGINT |
| `bin/cli.js` (quickstart) | Call `killExistingServer()` before spawning new server |
| `bin/cli.js` (uninstall) | Read PID file + multi-PID array, kill all tracked processes |
| `test/unit/pid-file.test.js` | New: 12 tests covering PID file lifecycle |
| `test/unit/kill-server.test.js` | +2 tests: PID file kill, multi-PID kill |
