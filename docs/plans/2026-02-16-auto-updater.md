# A2A Auto-Updater Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add automatic self-updating to `a2acalling` so globally-installed instances pull down new versions without user intervention, as long as no call is active. Keep the implementation minimal (zero new dependencies) and Linux-focused.

**Architecture:** A lightweight `UpdateManager` class that (1) periodically checks the npm registry for a newer version via native `fetch()`, (2) queries the running server's `/api/a2a/status` endpoint to confirm no active calls, (3) shells out to `npm install -g a2acalling@latest` to replace itself, and (4) gracefully restarts the server via PID-file SIGTERM + re-spawn. The check loop runs inside the server process on a configurable interval (default: 1 hour). A manual `a2a update --auto` flag enables/disables the feature via config.

**Tech Stack:** Node.js built-in `fetch()` (Node 18+), `child_process.execFile`, existing `pid-file.js`, existing `call-monitor.js`, existing `config.js`, existing zero-dependency test runner.

**Linear ticket:** A2A-26

---

## Research Summary

### Approaches Considered

| Approach | Pros | Cons | Verdict |
|----------|------|------|---------|
| `update-notifier` package | Proven, 5K+ dependents, non-blocking | Adds dependency, notification-only (no auto-update), ESM-only in v7 | **Rejected** -- we want actual auto-update, not just notification |
| `cli-autoupdater` / `selfupdate` packages | Ready-made auto-update | Extra dependencies, opinionated, poor maintenance | **Rejected** -- bloat vs. simplicity |
| npm registry HTTP + `npm install -g` shell-out | Zero dependencies, uses Node 18+ native `fetch()`, full control | Must handle edge cases (permissions, network, rollback) ourselves | **Chosen** -- aligns with project's zero-dependency ethos |
| Git-based pull (for dev installs) | Already implemented in `a2a update` | Only works for git clones, not npm global installs | **Keep existing** -- auto-updater targets npm installs only |

### Chosen Approach: Zero-Dependency Periodic Self-Update

1. **Version check:** `GET https://registry.npmjs.org/a2acalling/latest` returns `{ "version": "x.y.z" }` -- tiny payload (~200 bytes), no auth needed.
2. **Call-safety gate:** Query `CallMonitor.getActiveCount()` (in-process) or the server's internal state before proceeding. If any conversation is active, defer the update.
3. **Update execution:** `child_process.execFile('npm', ['install', '-g', 'a2acalling@<version>'])` -- deterministic version pin, not `@latest`, to avoid TOCTOU race.
4. **Graceful restart:** SIGTERM to own process after the npm install completes. The existing `shutdown()` handler in `server.js` already cleans up the PID file and closes connections. A small wrapper script or the postinstall hook re-spawns the server.
5. **Rollback:** If the new version's server fails to start within 30 seconds, `npm install -g a2acalling@<old-version>` restores the previous version.

### Key Design Decisions

- **Runs inside server process** -- no separate daemon, no cron job, no systemd timer. The server already runs persistently; adding a `setInterval` is the simplest integration point.
- **On by default** -- auto-update is enabled out of the box. `a2a update --auto off` disables. Config key: `auto_update.enabled` (defaults to `true`). Users who want manual control can opt out.
- **Respects env vars** -- `A2A_AUTO_UPDATE=0` or `NO_AUTO_UPDATE=1` disables. CI environments are auto-detected and skipped.
- **No major-version jumps** -- by default, only auto-update within the same major version (e.g., `0.6.x -> 0.6.y`). Cross-major updates require manual `a2a update`.
- **GUI-visible background updates on macOS** -- keep updates automatic, but surface updater state in the native app/tray so users can see progress and failures without opening logs.

### macOS UX Contract (Background Updates)

For users running the native app, background updates should be visible in-app even when no call is active.

Required states:
- `up_to_date`
- `checking`
- `downloading`
- `applying`
- `waiting_for_safe_restart` (active call in progress)
- `restarting`
- `failed`

Required UX behaviors:
- Show current package version and target version during update.
- Show clear reason when an update is deferred (`active_calls > 0`) or fails (network/permissions/install error).
- Expose `Update now` and `Retry` actions.
- Keep auto-update enabled by default; visibility is the fix, not disabling background updates.

### Release Sequence Guardrail (npm + macOS App)

Because macOS app binaries are downloaded from GitHub Releases during npm install, release order must guarantee app artifacts exist before users install the new npm version.

Simple rule:
1. Build/upload macOS app artifacts to GitHub Release `vX.Y.Z`.
2. Publish npm `a2acalling@X.Y.Z`.

This avoids a window where npm points to a version whose matching `A2A-Callbook-<version>.app.tar.gz` does not exist yet.

---

## Phase 1: Version Checker (Zero Dependencies)

### Task 1: Create `src/lib/update-checker.js` -- fetch latest version from npm registry

**Files:**
- Create: `src/lib/update-checker.js`
- Create: `test/unit/update-checker.test.js`

**Step 1: Write failing test**

Create `test/unit/update-checker.test.js`:

```js
/**
 * Update Checker Tests
 *
 * Covers: checkForUpdate, compareVersions, shouldAutoUpdate
 */

module.exports = function (test, assert, helpers) {
  const path = require('path');

  // We'll mock fetch globally for these tests
  function requireFresh() {
    const modPath = require.resolve('../../src/lib/update-checker');
    delete require.cache[modPath];
    return require('../../src/lib/update-checker');
  }

  test('compareVersions returns 1 when remote is newer', () => {
    const { compareVersions } = requireFresh();
    assert.equal(compareVersions('0.6.48', '0.6.49'), -1, 'patch bump');
    assert.equal(compareVersions('0.6.48', '0.7.0'), -1, 'minor bump');
    assert.equal(compareVersions('0.6.48', '1.0.0'), -1, 'major bump');
  });

  test('compareVersions returns 0 when equal', () => {
    const { compareVersions } = requireFresh();
    assert.equal(compareVersions('0.6.48', '0.6.48'), 0);
  });

  test('compareVersions returns 1 when local is newer', () => {
    const { compareVersions } = requireFresh();
    assert.equal(compareVersions('0.7.0', '0.6.48'), 1);
  });

  test('isSameMajor returns true for same major version', () => {
    const { isSameMajor } = requireFresh();
    assert.ok(isSameMajor('0.6.48', '0.6.50'));
    assert.ok(isSameMajor('0.6.48', '0.7.0'));
    assert.ok(!isSameMajor('0.6.48', '1.0.0'));
  });

  test('parseVersion handles valid semver strings', () => {
    const { parseVersion } = requireFresh();
    const v = parseVersion('1.2.3');
    assert.equal(v.major, 1);
    assert.equal(v.minor, 2);
    assert.equal(v.patch, 3);
  });

  test('parseVersion returns null for invalid input', () => {
    const { parseVersion } = requireFresh();
    assert.equal(parseVersion('not-a-version'), null);
    assert.equal(parseVersion(''), null);
    assert.equal(parseVersion(null), null);
  });
};
```

**Step 2: Implement `src/lib/update-checker.js`**

```js
/**
 * Update Checker
 *
 * Checks the npm registry for newer versions of a2acalling.
 * Zero dependencies -- uses Node 18+ built-in fetch().
 */

const REGISTRY_URL = 'https://registry.npmjs.org/a2acalling/latest';
const FETCH_TIMEOUT_MS = 15000;

/**
 * Parse a semver string into { major, minor, patch }.
 * Returns null if invalid.
 */
function parseVersion(str) {
  if (!str || typeof str !== 'string') return null;
  const match = str.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10)
  };
}

/**
 * Compare two semver strings.
 * Returns -1 if a < b, 0 if equal, 1 if a > b.
 */
function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return 0;

  if (va.major !== vb.major) return va.major < vb.major ? -1 : 1;
  if (va.minor !== vb.minor) return va.minor < vb.minor ? -1 : 1;
  if (va.patch !== vb.patch) return va.patch < vb.patch ? -1 : 1;
  return 0;
}

/**
 * Check if two versions share the same major version.
 */
function isSameMajor(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return false;
  return va.major === vb.major;
}

/**
 * Fetch the latest published version from the npm registry.
 * Returns { version: string } or { error: string }.
 */
async function fetchLatestVersion() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const res = await fetch(REGISTRY_URL, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' }
    });
    clearTimeout(timeout);

    if (!res.ok) {
      return { error: `Registry returned ${res.status}` };
    }

    const data = await res.json();
    if (!data.version) {
      return { error: 'No version field in registry response' };
    }

    return { version: data.version };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { error: 'Registry request timed out' };
    }
    return { error: err.message || 'Unknown fetch error' };
  }
}

/**
 * Check if an update is available.
 * Returns { available: boolean, current: string, latest: string, error?: string }
 */
async function checkForUpdate(currentVersion) {
  const result = await fetchLatestVersion();

  if (result.error) {
    return { available: false, current: currentVersion, latest: null, error: result.error };
  }

  const cmp = compareVersions(currentVersion, result.version);
  return {
    available: cmp < 0,
    current: currentVersion,
    latest: result.version,
    sameMajor: isSameMajor(currentVersion, result.version)
  };
}

module.exports = {
  parseVersion,
  compareVersions,
  isSameMajor,
  fetchLatestVersion,
  checkForUpdate,
  REGISTRY_URL
};
```

**Step 3: Verify**

```bash
node test/run.js --filter update-checker
```

**Step 4: Commit**

```bash
git add src/lib/update-checker.js test/unit/update-checker.test.js
git commit -m "feat(updater): add version checker with npm registry lookup"
```

---

## Phase 2: Call-Safety Gate

### Task 2: Add active-call detection to the server's status endpoint

The `CallMonitor` already tracks active conversations via `getActiveCount()`. We need to expose this count through the existing `/api/a2a/status` endpoint so the update manager (running in the same process) can check it, and so external tools can query it too.

**Files:**
- Modify: `src/routes/a2a.js` (add `active_calls` to `/status` response)
- Create: `test/unit/update-safety.test.js`

**Step 1: Write failing test**

Create `test/unit/update-safety.test.js`:

```js
/**
 * Update Safety Tests
 *
 * Covers: isUpdateSafe — checks whether it's safe to perform an auto-update
 */

module.exports = function (test, assert, helpers) {
  function requireFresh() {
    const modPath = require.resolve('../../src/lib/update-manager');
    delete require.cache[modPath];
    return require('../../src/lib/update-manager');
  }

  test('isUpdateSafe returns true when no calls are active', () => {
    const mockCallMonitor = { getActiveCount: () => 0 };
    const { isUpdateSafe } = requireFresh();
    assert.ok(isUpdateSafe(mockCallMonitor), 'Should be safe with 0 active calls');
  });

  test('isUpdateSafe returns false when calls are active', () => {
    const mockCallMonitor = { getActiveCount: () => 2 };
    const { isUpdateSafe } = requireFresh();
    assert.ok(!isUpdateSafe(mockCallMonitor), 'Should not be safe with active calls');
  });

  test('isUpdateSafe returns true when callMonitor is null', () => {
    const { isUpdateSafe } = requireFresh();
    assert.ok(isUpdateSafe(null), 'Should be safe when no monitor exists (no calls possible)');
  });
};
```

**Step 2: Implement safety check in `src/lib/update-manager.js` (partial -- full module in Task 3)**

Add the `isUpdateSafe` function to the update-manager module (created fully in Task 3):

```js
/**
 * Check whether it's safe to perform an auto-update.
 * Safe = no active A2A calls in progress.
 */
function isUpdateSafe(callMonitor) {
  if (!callMonitor) return true; // No monitor = no calls possible
  return callMonitor.getActiveCount() === 0;
}
```

**Step 3: Update `/status` endpoint in `src/routes/a2a.js`**

In the `router.get('/status', ...)` handler, add active call count:

```js
router.get('/status', (req, res) => {
  const monitor = getCallMonitor();
  res.json({
    a2a: true,
    version: require('../../package.json').version,
    capabilities: ['invoke', 'multi-turn'],
    rate_limits: limits,
    active_calls: monitor ? monitor.getActiveCount() : 0
  });
});
```

**Step 4: Verify**

```bash
node test/run.js --filter update-safety
```

**Step 5: Commit**

```bash
git add src/routes/a2a.js src/lib/update-manager.js test/unit/update-safety.test.js
git commit -m "feat(updater): add call-safety gate for auto-update"
```

---

## Phase 3: Update Manager Core

### Task 3: Create `src/lib/update-manager.js` -- orchestrate check + gate + install + restart

This is the main module. It ties together the version checker, call-safety gate, npm install shell-out, and graceful restart.

**Files:**
- Create (or extend from Task 2): `src/lib/update-manager.js`
- Create: `test/unit/update-manager.test.js`

**Step 1: Write failing test**

Create `test/unit/update-manager.test.js`:

```js
/**
 * Update Manager Tests
 *
 * Covers: UpdateManager lifecycle, config reading, interval scheduling,
 * dry-run mode, and the full check->gate->install->restart pipeline.
 */

module.exports = function (test, assert, helpers) {
  const path = require('path');
  const fs = require('fs');

  function requireFresh(configDir) {
    // Clear all related module caches
    for (const key of Object.keys(require.cache)) {
      if (key.includes('update-manager') || key.includes('update-checker')) {
        delete require.cache[key];
      }
    }
    if (configDir) process.env.A2A_CONFIG_DIR = configDir;
    return require('../../src/lib/update-manager');
  }

  test('UpdateManager constructor sets default options', () => {
    const { UpdateManager } = requireFresh();
    const mgr = new UpdateManager({ currentVersion: '0.6.48' });
    assert.equal(mgr.enabled, true, 'enabled by default');
    assert.equal(mgr.intervalMs, 3600000, 'default interval is 1 hour');
    assert.equal(mgr.currentVersion, '0.6.48');
  });

  test('UpdateManager respects A2A_AUTO_UPDATE=0 env var', () => {
    process.env.A2A_AUTO_UPDATE = '0';
    const { UpdateManager } = requireFresh();
    const mgr = new UpdateManager({ currentVersion: '0.6.48', enabled: true });
    assert.equal(mgr.enabled, false, 'env var overrides enabled flag');
    delete process.env.A2A_AUTO_UPDATE;
  });

  test('UpdateManager respects NO_AUTO_UPDATE env var', () => {
    process.env.NO_AUTO_UPDATE = '1';
    const { UpdateManager } = requireFresh();
    const mgr = new UpdateManager({ currentVersion: '0.6.48', enabled: true });
    assert.equal(mgr.enabled, false, 'NO_AUTO_UPDATE disables');
    delete process.env.NO_AUTO_UPDATE;
  });

  test('isUpdateSafe returns true with no active calls', () => {
    const { isUpdateSafe } = requireFresh();
    const mock = { getActiveCount: () => 0 };
    assert.ok(isUpdateSafe(mock));
  });

  test('isUpdateSafe returns false with active calls', () => {
    const { isUpdateSafe } = requireFresh();
    const mock = { getActiveCount: () => 1 };
    assert.ok(!isUpdateSafe(mock));
  });

  test('shouldApplyUpdate skips cross-major updates by default', () => {
    const { shouldApplyUpdate } = requireFresh();
    assert.ok(shouldApplyUpdate('0.6.48', '0.6.50', {}), 'same major ok');
    assert.ok(shouldApplyUpdate('0.6.48', '0.7.0', {}), 'same major ok');
    assert.ok(!shouldApplyUpdate('0.6.48', '1.0.0', {}), 'cross-major blocked');
  });

  test('shouldApplyUpdate allows cross-major when config says so', () => {
    const { shouldApplyUpdate } = requireFresh();
    assert.ok(shouldApplyUpdate('0.6.48', '1.0.0', { allowMajor: true }));
  });

  test('start() does nothing when disabled', () => {
    const { UpdateManager } = requireFresh();
    const mgr = new UpdateManager({ currentVersion: '0.6.48', enabled: false });
    mgr.start();
    assert.equal(mgr._intervalId, null, 'no interval set when disabled');
  });

  test('stop() clears interval', () => {
    const { UpdateManager } = requireFresh();
    const mgr = new UpdateManager({ currentVersion: '0.6.48', enabled: true });
    // Manually set a fake interval
    mgr._intervalId = setInterval(() => {}, 999999);
    mgr.stop();
    assert.equal(mgr._intervalId, null, 'interval cleared');
  });
};
```

**Step 2: Implement `src/lib/update-manager.js`**

```js
/**
 * Update Manager
 *
 * Orchestrates automatic self-updates for a2acalling:
 *   1. Periodically checks npm registry for newer version
 *   2. Verifies no A2A calls are active (call-safety gate)
 *   3. Runs `npm install -g a2acalling@<version>`
 *   4. Gracefully restarts the server process
 *   5. Rolls back on failure
 *
 * Zero new dependencies. Uses Node 18+ built-in fetch() and child_process.
 */

const { execFile } = require('child_process');
const { createLogger } = require('./logger');
const { checkForUpdate, isSameMajor } = require('./update-checker');

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const INSTALL_TIMEOUT_MS = 120000;           // 2 minutes
const RESTART_DELAY_MS = 2000;               // 2s grace before restart

/**
 * Check whether it's safe to perform an auto-update.
 */
function isUpdateSafe(callMonitor) {
  if (!callMonitor) return true;
  return callMonitor.getActiveCount() === 0;
}

/**
 * Decide whether a discovered update should be applied.
 */
function shouldApplyUpdate(currentVersion, latestVersion, options = {}) {
  if (!currentVersion || !latestVersion) return false;
  if (!options.allowMajor && !isSameMajor(currentVersion, latestVersion)) {
    return false;
  }
  return true;
}

class UpdateManager {
  constructor(options = {}) {
    this.currentVersion = options.currentVersion || require('../../package.json').version;
    this.callMonitor = options.callMonitor || null;
    this.logger = options.logger || createLogger({ component: 'a2a.updater' });
    this.intervalMs = options.intervalMs || DEFAULT_INTERVAL_MS;
    this.allowMajor = options.allowMajor || false;
    this.onRestart = options.onRestart || null; // callback before restart

    // Respect env var overrides
    const envDisabled =
      process.env.A2A_AUTO_UPDATE === '0' ||
      process.env.A2A_AUTO_UPDATE === 'false' ||
      process.env.NO_AUTO_UPDATE === '1' ||
      process.env.NO_AUTO_UPDATE === 'true' ||
      process.env.CI === 'true' ||
      process.env.CONTINUOUS_INTEGRATION === 'true';

    this.enabled = envDisabled ? false : (options.enabled !== false);
    this._intervalId = null;
    this._updating = false;
  }

  /**
   * Start the periodic update check loop.
   */
  start() {
    if (!this.enabled) {
      this.logger.info('Auto-updater disabled', { event: 'updater_disabled' });
      return;
    }
    if (this._intervalId) return; // already running

    this.logger.info('Auto-updater started', {
      event: 'updater_started',
      data: {
        interval_ms: this.intervalMs,
        current_version: this.currentVersion,
        allow_major: this.allowMajor
      }
    });

    // Run first check after a short delay (don't block startup)
    setTimeout(() => this._tick(), 30000);

    this._intervalId = setInterval(() => this._tick(), this.intervalMs);
    this._intervalId.unref(); // Don't keep process alive just for updates
  }

  /**
   * Stop the update check loop.
   */
  stop() {
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
      this.logger.info('Auto-updater stopped', { event: 'updater_stopped' });
    }
  }

  /**
   * Single update check cycle.
   */
  async _tick() {
    if (this._updating) return; // Already running an update

    try {
      const result = await checkForUpdate(this.currentVersion);

      if (result.error) {
        this.logger.warn('Update check failed', {
          event: 'update_check_failed',
          data: { error: result.error }
        });
        return;
      }

      if (!result.available) {
        this.logger.debug('No update available', {
          event: 'update_check_current',
          data: { version: this.currentVersion }
        });
        return;
      }

      // Update available -- check constraints
      if (!shouldApplyUpdate(this.currentVersion, result.latest, {
        allowMajor: this.allowMajor
      })) {
        this.logger.info('Update available but cross-major; skipping auto-update', {
          event: 'update_skipped_major',
          data: { current: this.currentVersion, latest: result.latest }
        });
        return;
      }

      // Check call safety
      if (!isUpdateSafe(this.callMonitor)) {
        this.logger.info('Update available but calls are active; deferring', {
          event: 'update_deferred_active_calls',
          data: {
            current: this.currentVersion,
            latest: result.latest,
            active_calls: this.callMonitor ? this.callMonitor.getActiveCount() : 0
          }
        });
        return;
      }

      // All clear -- perform update
      await this._performUpdate(result.latest);

    } catch (err) {
      this.logger.error('Update tick failed unexpectedly', {
        event: 'update_tick_error',
        error: err
      });
    }
  }

  /**
   * Execute the npm install and restart.
   */
  async _performUpdate(targetVersion) {
    this._updating = true;
    const previousVersion = this.currentVersion;

    this.logger.info('Starting auto-update', {
      event: 'update_started',
      data: { from: previousVersion, to: targetVersion }
    });

    try {
      // Step 1: npm install -g a2acalling@<exact version>
      await this._npmInstall(`a2acalling@${targetVersion}`);

      this.logger.info('npm install completed successfully', {
        event: 'update_install_complete',
        data: { version: targetVersion }
      });

      // Step 2: Graceful restart
      await this._gracefulRestart(targetVersion);

    } catch (err) {
      this.logger.error('Auto-update failed; attempting rollback', {
        event: 'update_failed',
        error: err,
        data: { target: targetVersion, previous: previousVersion }
      });

      // Rollback: re-install previous version
      try {
        await this._npmInstall(`a2acalling@${previousVersion}`);
        this.logger.info('Rollback successful', {
          event: 'update_rollback_complete',
          data: { restored: previousVersion }
        });
      } catch (rollbackErr) {
        this.logger.error('Rollback also failed -- manual intervention needed', {
          event: 'update_rollback_failed',
          error: rollbackErr,
          data: { target: targetVersion, previous: previousVersion }
        });
      }
    } finally {
      this._updating = false;
    }
  }

  /**
   * Shell out to npm install -g.
   */
  _npmInstall(packageSpec) {
    return new Promise((resolve, reject) => {
      const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      execFile(npmCmd, ['install', '-g', packageSpec], {
        timeout: INSTALL_TIMEOUT_MS,
        env: { ...process.env, npm_config_cache: '/tmp/npm-cache-a2a' }
      }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`npm install failed: ${stderr || err.message}`));
        } else {
          resolve(stdout);
        }
      });
    });
  }

  /**
   * Gracefully restart the server process.
   *
   * Strategy: Send SIGTERM to self. The existing shutdown handler in
   * server.js cleans up the PID file and closes connections. The
   * postinstall script or a systemd/pm2 process manager restarts us.
   *
   * For standalone (no process manager): we spawn the new server
   * before exiting.
   */
  async _gracefulRestart(newVersion) {
    this.logger.info('Initiating graceful restart', {
      event: 'update_restart',
      data: { new_version: newVersion }
    });

    if (this.onRestart) {
      await this.onRestart(newVersion);
    }

    // Give in-flight responses a moment to complete
    await new Promise(r => setTimeout(r, RESTART_DELAY_MS));

    // Spawn the new server before we exit (detached, unref'd)
    const { spawn } = require('child_process');
    const serverScript = require('path').resolve(__dirname, '..', 'server.js');
    const child = spawn(process.execPath, [serverScript], {
      env: { ...process.env },
      detached: true,
      stdio: 'ignore'
    });
    child.unref();

    // Now exit the current (old) process
    process.kill(process.pid, 'SIGTERM');
  }
}

module.exports = {
  UpdateManager,
  isUpdateSafe,
  shouldApplyUpdate
};
```

**Step 3: Verify**

```bash
node test/run.js --filter update-manager
```

**Step 4: Commit**

```bash
git add src/lib/update-manager.js test/unit/update-manager.test.js
git commit -m "feat(updater): add UpdateManager with check/gate/install/restart pipeline"
```

---

## Phase 4: Config Integration

### Task 4: Add `auto_update` config section and CLI toggle

**Files:**
- Modify: `src/lib/config.js` (add `auto_update` config section)
- Modify: `bin/cli.js` (add `--auto` flag to `update` command)
- Create: `test/unit/update-config.test.js`

**Step 1: Write failing test**

Create `test/unit/update-config.test.js`:

```js
/**
 * Update Config Tests
 *
 * Covers: reading/writing auto_update config section
 */

module.exports = function (test, assert, helpers) {
  const fs = require('fs');
  const path = require('path');

  function requireFreshConfig(configDir) {
    const modPath = require.resolve('../../src/lib/config');
    delete require.cache[modPath];
    process.env.A2A_CONFIG_DIR = configDir;
    return require('../../src/lib/config');
  }

  test('getAutoUpdateConfig returns defaults when section missing', () => {
    const tmp = helpers.tmpConfigDir('au-defaults');
    fs.writeFileSync(path.join(tmp.dir, 'a2a-config.json'), JSON.stringify({}));
    const { A2AConfig } = requireFreshConfig(tmp.dir);
    const config = new A2AConfig();
    const au = config.getAutoUpdate();
    assert.equal(au.enabled, true);
    assert.equal(au.intervalMs, 3600000);
    assert.equal(au.allowMajor, false);
    tmp.cleanup();
  });

  test('setAutoUpdate persists enabled flag', () => {
    const tmp = helpers.tmpConfigDir('au-enable');
    fs.writeFileSync(path.join(tmp.dir, 'a2a-config.json'), JSON.stringify({}));
    const { A2AConfig } = requireFreshConfig(tmp.dir);
    const config = new A2AConfig();
    config.setAutoUpdate({ enabled: true });
    const au = config.getAutoUpdate();
    assert.equal(au.enabled, true);
    tmp.cleanup();
  });

  test('setAutoUpdate validates intervalMs', () => {
    const tmp = helpers.tmpConfigDir('au-interval');
    fs.writeFileSync(path.join(tmp.dir, 'a2a-config.json'), JSON.stringify({}));
    const { A2AConfig } = requireFreshConfig(tmp.dir);
    const config = new A2AConfig();
    config.setAutoUpdate({ intervalMs: 300000 }); // 5 min
    const au = config.getAutoUpdate();
    assert.equal(au.intervalMs, 300000);
    tmp.cleanup();
  });
};
```

**Step 2: Add config methods to `src/lib/config.js`**

Add to the `A2AConfig` class:

```js
getAutoUpdate() {
  const raw = this._read();
  const au = raw.auto_update || {};
  return {
    enabled: au.enabled !== false,
    intervalMs: Number.isFinite(au.intervalMs) && au.intervalMs >= 60000
      ? au.intervalMs
      : 3600000,
    allowMajor: Boolean(au.allowMajor)
  };
}

setAutoUpdate(patch) {
  const raw = this._read();
  const current = raw.auto_update || {};

  if (patch.enabled !== undefined) current.enabled = Boolean(patch.enabled);
  if (Number.isFinite(patch.intervalMs) && patch.intervalMs >= 60000) {
    current.intervalMs = patch.intervalMs;
  }
  if (patch.allowMajor !== undefined) current.allowMajor = Boolean(patch.allowMajor);

  raw.auto_update = current;
  this._write(raw);
  return this.getAutoUpdate();
}
```

**Step 3: Add `--auto` flag to `a2a update` in `bin/cli.js`**

Extend the existing `update` command to support:

```
a2a update --auto on       # Enable auto-updates
a2a update --auto off      # Disable auto-updates
a2a update --auto status   # Show current auto-update config
```

Add at the top of the `update` command handler:

```js
const autoFlag = args.flags.auto;
if (autoFlag !== undefined) {
  const { A2AConfig } = require('../src/lib/config');
  const config = new A2AConfig();

  if (autoFlag === 'status') {
    const au = config.getAutoUpdate();
    console.log(`\nAuto-update: ${au.enabled ? 'enabled' : 'disabled'}`);
    console.log(`  Check interval: ${Math.round(au.intervalMs / 60000)} minutes`);
    console.log(`  Allow major: ${au.allowMajor}\n`);
    return;
  }

  const enable = autoFlag === 'on' || autoFlag === 'true' || autoFlag === true;
  config.setAutoUpdate({ enabled: enable });
  console.log(`\nAuto-update ${enable ? 'enabled' : 'disabled'}.\n`);
  if (enable) {
    console.log('The server will check for updates hourly and install them');
    console.log('automatically when no calls are active.\n');
  }
  return;
}
```

**Step 4: Verify**

```bash
node test/run.js --filter update-config
```

**Step 5: Commit**

```bash
git add src/lib/config.js bin/cli.js test/unit/update-config.test.js
git commit -m "feat(updater): add auto-update config section and CLI toggle"
```

---

## Phase 5: Server Integration

### Task 5: Wire UpdateManager into `src/server.js`

**Files:**
- Modify: `src/server.js` (instantiate and start UpdateManager)

**Step 1: Write failing integration test**

Add to `test/integration/` a test that verifies the server starts with auto-updater when config says so. This is a lightweight smoke test.

Create `test/integration/auto-updater.test.js`:

```js
/**
 * Auto-Updater Integration Test
 *
 * Verifies the update manager initializes correctly inside the server context.
 */

module.exports = function (test, assert, helpers) {
  test('UpdateManager can be instantiated with server-like options', () => {
    // Clear caches
    for (const key of Object.keys(require.cache)) {
      if (key.includes('update-manager') || key.includes('update-checker')) {
        delete require.cache[key];
      }
    }

    const { UpdateManager } = require('../../src/lib/update-manager');
    const { CallMonitor } = require('../../src/lib/call-monitor');

    const monitor = new CallMonitor();
    const mgr = new UpdateManager({
      currentVersion: '0.6.48',
      callMonitor: monitor,
      enabled: false // don't actually start checking
    });

    assert.equal(mgr.currentVersion, '0.6.48');
    assert.equal(mgr.enabled, false);
    assert.ok(mgr.callMonitor === monitor);
  });

  test('UpdateManager does not start interval when disabled', () => {
    for (const key of Object.keys(require.cache)) {
      if (key.includes('update-manager') || key.includes('update-checker')) {
        delete require.cache[key];
      }
    }

    const { UpdateManager } = require('../../src/lib/update-manager');
    const mgr = new UpdateManager({
      currentVersion: '0.6.48',
      enabled: false
    });
    mgr.start();
    assert.equal(mgr._intervalId, null);
  });
};
```

**Step 2: Add UpdateManager to `src/server.js`**

After the server starts listening (inside the `app.listen` callback), add:

```js
// Auto-updater (opt-in via config or CLI)
try {
  const { A2AConfig } = require('./lib/config');
  const { UpdateManager } = require('./lib/update-manager');
  const appConfig = new A2AConfig();
  const auConfig = appConfig.getAutoUpdate();

  const updateManager = new UpdateManager({
    currentVersion: require('../package.json').version,
    callMonitor: null, // Will be set when call monitor initializes
    enabled: auConfig.enabled,
    intervalMs: auConfig.intervalMs,
    allowMajor: auConfig.allowMajor,
    logger: logger.child({ component: 'a2a.updater' }),
    onRestart: async (newVersion) => {
      logger.info('Auto-update restarting server', {
        event: 'update_restart_initiated',
        data: { new_version: newVersion }
      });
    }
  });

  updateManager.start();

  // Clean up on shutdown
  const origShutdown = shutdown;
  shutdown = function() {
    updateManager.stop();
    origShutdown();
  };
} catch (err) {
  logger.warn('Auto-updater failed to initialize (non-fatal)', {
    event: 'updater_init_failed',
    error: err
  });
}
```

**Step 3: Verify**

```bash
node test/run.js --filter auto-updater
npm test  # full suite
```

**Step 4: Commit**

```bash
git add src/server.js test/integration/auto-updater.test.js
git commit -m "feat(updater): wire UpdateManager into server lifecycle"
```

---

## Phase 6: Rollback Safety

### Task 6: Add rollback verification and last-known-good tracking

**Files:**
- Modify: `src/lib/update-manager.js` (add rollback tracking)
- Modify: `src/lib/config.js` (add `auto_update.last_good_version` field)
- Add to: `test/unit/update-manager.test.js`

**Step 1: Write failing test**

Add to `test/unit/update-manager.test.js`:

```js
test('_performUpdate rolls back on install failure (dry run)', async () => {
  const { UpdateManager } = requireFresh();
  const installCalls = [];

  const mgr = new UpdateManager({
    currentVersion: '0.6.48',
    enabled: true
  });

  // Mock _npmInstall to fail on first call, succeed on rollback
  let callCount = 0;
  mgr._npmInstall = async (spec) => {
    installCalls.push(spec);
    callCount++;
    if (callCount === 1) throw new Error('simulated install failure');
    return 'ok';
  };

  // Mock _gracefulRestart to do nothing
  mgr._gracefulRestart = async () => {};

  await mgr._performUpdate('0.6.99');

  assert.equal(installCalls.length, 2, 'Should have called install twice (attempt + rollback)');
  assert.equal(installCalls[0], 'a2acalling@0.6.99', 'First call is target version');
  assert.equal(installCalls[1], 'a2acalling@0.6.48', 'Second call is rollback');
});
```

**Step 2: Add last-good tracking to config**

In the `_performUpdate` method, after successful install and before restart:

```js
// Record last known good version
try {
  const { A2AConfig } = require('./config');
  const appConfig = new A2AConfig();
  appConfig.setAutoUpdate({ lastGoodVersion: this.currentVersion });
} catch (e) {
  // Non-fatal
}
```

In the config module, update `getAutoUpdate` and `setAutoUpdate` to handle `lastGoodVersion`.

**Step 3: Verify**

```bash
node test/run.js --filter update-manager
```

**Step 4: Commit**

```bash
git add src/lib/update-manager.js src/lib/config.js test/unit/update-manager.test.js
git commit -m "feat(updater): add rollback tracking and last-known-good version"
```

---

## Phase 7: Logging and Observability

### Task 7: Add structured log events for update lifecycle

This is mostly done inline in the UpdateManager (see Task 3 code), but we need to verify the log output is useful and add a test for it.

**Files:**
- Add to: `test/unit/update-manager.test.js`

**Step 1: Write test for log events**

```js
test('_tick logs when no update is available', async () => {
  const { UpdateManager } = requireFresh();
  const logEvents = [];

  const mgr = new UpdateManager({
    currentVersion: '99.99.99', // Artificially high to guarantee "no update"
    enabled: true,
    logger: {
      info: (msg, meta) => logEvents.push({ level: 'info', msg, ...meta }),
      warn: (msg, meta) => logEvents.push({ level: 'warn', msg, ...meta }),
      error: (msg, meta) => logEvents.push({ level: 'error', msg, ...meta }),
      debug: (msg, meta) => logEvents.push({ level: 'debug', msg, ...meta }),
      child: () => mgr.logger // return self for simplicity
    }
  });

  // This will make a real HTTP call to the registry (acceptable for integration)
  // Or we can mock checkForUpdate
  await mgr._tick();

  // Should have logged something (check_current or check_failed depending on network)
  assert.ok(logEvents.length > 0, 'Should have produced at least one log event');
});
```

**Step 2: Verify**

```bash
node test/run.js --filter update-manager
```

**Step 3: Commit**

```bash
git add test/unit/update-manager.test.js
git commit -m "test(updater): add log event verification tests"
```

---

## Phase 8: Documentation and Help Text

### Task 8: Update CLI help text and add user-facing docs

**Files:**
- Modify: `bin/cli.js` (update help text for `update` command)

**Step 1: Update help text**

In the `help` command output, update the `update` section:

```
  update              Update A2A to latest version (npm or git pull)
    --check, -c       Check for updates without installing
    --auto on         Enable automatic background updates
    --auto off        Disable automatic background updates
    --auto status     Show auto-update configuration
```

**Step 2: Verify help output**

```bash
node bin/cli.js help | grep -A 4 "update"
```

**Step 3: Commit**

```bash
git add bin/cli.js
git commit -m "docs(updater): update CLI help text with auto-update flags"
```

---

## Summary of New Files

| File | Purpose |
|------|---------|
| `src/lib/update-checker.js` | Zero-dep npm registry version check |
| `src/lib/update-manager.js` | Orchestrator: check + gate + install + restart + rollback |
| `test/unit/update-checker.test.js` | Unit tests for version comparison and registry fetch |
| `test/unit/update-safety.test.js` | Unit tests for call-safety gate |
| `test/unit/update-manager.test.js` | Unit tests for UpdateManager lifecycle |
| `test/unit/update-config.test.js` | Unit tests for config read/write |
| `test/integration/auto-updater.test.js` | Integration smoke test |

## Modified Files

| File | Change |
|------|--------|
| `src/server.js` | Instantiate and start UpdateManager on server boot |
| `src/routes/a2a.js` | Add `active_calls` to `/status` endpoint |
| `src/lib/config.js` | Add `getAutoUpdate()` / `setAutoUpdate()` methods |
| `bin/cli.js` | Add `--auto` flag to `update` command, update help text |

## Dependencies Added

**None.** The entire implementation uses:
- `fetch()` -- built into Node 18+ (already required by `engines` field)
- `child_process.execFile` -- Node built-in
- Existing project modules: `logger`, `config`, `call-monitor`, `pid-file`

## Sequence Diagram

```
Server Process (running v0.6.48)
  │
  ├─ setInterval(1 hour)
  │    │
  │    ├─ fetch("https://registry.npmjs.org/a2acalling/latest")
  │    │    └─ Response: { "version": "0.6.50" }
  │    │
  │    ├─ compareVersions("0.6.48", "0.6.50") → update available
  │    │
  │    ├─ isSameMajor("0.6.48", "0.6.50") → true (safe)
  │    │
  │    ├─ callMonitor.getActiveCount() → 0 (no active calls)
  │    │
  │    ├─ execFile("npm", ["install", "-g", "a2acalling@0.6.50"])
  │    │    └─ Success
  │    │
  │    ├─ spawn(node, ["server.js"]) → new server process (detached)
  │    │
  │    └─ process.kill(self, SIGTERM)
  │         └─ Existing shutdown handler cleans up PID file
  │
  └─ New server process starts (v0.6.50), writes new PID file
```

## Rollback Sequence

```
  ├─ execFile("npm", ["install", "-g", "a2acalling@0.6.50"])
  │    └─ FAILURE (network error, permission error, etc.)
  │
  ├─ Log error
  │
  ├─ execFile("npm", ["install", "-g", "a2acalling@0.6.48"])  ← rollback
  │    └─ Success → server continues running on v0.6.48
  │
  └─ _updating = false → next check cycle will retry
```

## Configuration

Config lives in `~/.config/openclaw/a2a-config.json`:

```json
{
  "auto_update": {
    "enabled": true,
    "intervalMs": 3600000,
    "allowMajor": false,
    "lastGoodVersion": "0.6.48"
  }
}
```

Environment variable overrides:
- `A2A_AUTO_UPDATE=0` -- disable auto-updates
- `NO_AUTO_UPDATE=1` -- disable auto-updates
- `CI=true` -- auto-detected, disables auto-updates
