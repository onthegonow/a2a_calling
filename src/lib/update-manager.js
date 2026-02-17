const { execFile } = require('child_process');
const { EventEmitter } = require('events');
const { createLogger } = require('./logger');
const { checkForUpdate, isSameMajor } = require('./update-checker');

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_NPM_TIMEOUT_MS = 2 * 60 * 1000;

function isUpdateSafe(callMonitor) {
  if (!callMonitor || typeof callMonitor.getActiveCount !== 'function') return true;
  return Number(callMonitor.getActiveCount()) === 0;
}

function shouldApplyUpdate(currentVersion, latestVersion, options = {}) {
  if (!latestVersion) return false;
  if (options.allowMajor) return true;
  return isSameMajor(currentVersion, latestVersion);
}

function autoUpdateDisabledByEnv() {
  if (String(process.env.CI || '').toLowerCase() === 'true') return true;
  if (String(process.env.A2A_AUTO_UPDATE || '').trim() === '0') return true;
  if (String(process.env.NO_AUTO_UPDATE || '').trim() === '1') return true;
  return false;
}

function execFilePromise(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, options, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

class UpdateManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.currentVersion = options.currentVersion;
    this.config = options.config || null;
    this.logger = options.logger || createLogger({ component: 'a2a.updater' });
    this.intervalMs = Number.isFinite(options.intervalMs) && options.intervalMs > 0
      ? options.intervalMs
      : DEFAULT_INTERVAL_MS;
    this.allowMajor = Boolean(options.allowMajor);
    this.enabled = options.enabled !== false;
    this.getCallMonitor = typeof options.getCallMonitor === 'function'
      ? options.getCallMonitor
      : (() => null);
    this.installTimeoutMs = Number.isFinite(options.installTimeoutMs) && options.installTimeoutMs > 0
      ? options.installTimeoutMs
      : DEFAULT_NPM_TIMEOUT_MS;
    this.restartFn = typeof options.restartFn === 'function' ? options.restartFn : null;
    this._execFile = options.execFile || execFilePromise;
    this._status = {
      state: 'up_to_date',
      enabled: this.enabled,
      current_version: this.currentVersion,
      latest_version: this.currentVersion,
      target_version: null,
      active_calls: 0,
      last_checked_at: null,
      last_success_at: null,
      last_error: null,
      defer_reason: null
    };
    this._timer = null;
    this._running = false;
    this._pendingManualUpdate = false;

    this._loadConfig();
    if (autoUpdateDisabledByEnv()) {
      this.enabled = false;
      this._status.enabled = false;
      this.logger.info('Auto-update disabled by environment', { event: 'updater_env_disabled' });
    }
  }

  _loadConfig() {
    if (!this.config || typeof this.config.getAutoUpdate !== 'function') return;
    const cfg = this.config.getAutoUpdate();
    if (cfg && typeof cfg === 'object') {
      if (typeof cfg.enabled === 'boolean') this.enabled = cfg.enabled;
      if (Number.isFinite(cfg.intervalMs) && cfg.intervalMs > 0) this.intervalMs = cfg.intervalMs;
      if (typeof cfg.allowMajor === 'boolean') this.allowMajor = cfg.allowMajor;
    }
    this._status.enabled = this.enabled;
  }

  _persistConfigPatch(patch) {
    if (!this.config || typeof this.config.setAutoUpdate !== 'function') return;
    try {
      this.config.setAutoUpdate(patch);
    } catch (err) {
      this.logger.warn('Failed to persist auto-update config patch', {
        event: 'updater_config_patch_failed',
        error: err
      });
    }
  }

  _setStatus(patch) {
    this._status = { ...this._status, ...patch };
    this.emit('status', this.getStatus());
  }

  getStatus() {
    return {
      ...this._status,
      enabled: this.enabled,
      interval_ms: this.intervalMs,
      allow_major: this.allowMajor
    };
  }

  async setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    this._setStatus({ enabled: this.enabled });
    this._persistConfigPatch({ enabled: this.enabled });
    if (this.enabled && !this._timer) {
      this.start();
      await this.triggerCheck({ reason: 'manual_enable' });
    }
    if (!this.enabled && this._timer) {
      this.stop();
    }
    return this.getStatus();
  }

  start() {
    if (this._timer) return;
    if (!this.enabled) {
      this.logger.info('Auto-updater disabled', { event: 'updater_disabled' });
      return;
    }

    this._timer = setInterval(() => {
      this.triggerCheck({ reason: 'interval' }).catch((err) => {
        this.logger.warn('Auto-update interval check failed', {
          event: 'updater_interval_failed',
          error: err
        });
      });
    }, this.intervalMs);

    this.logger.info('Auto-updater started', {
      event: 'updater_started',
      data: {
        interval_ms: this.intervalMs,
        allow_major: this.allowMajor
      }
    });
  }

  stop() {
    if (!this._timer) return;
    clearInterval(this._timer);
    this._timer = null;
    this.logger.info('Auto-updater stopped', { event: 'updater_stopped' });
  }

  async triggerCheck(options = {}) {
    return this._runCycle({ ...options, manualUpdate: false });
  }

  async triggerUpdate(options = {}) {
    this._pendingManualUpdate = true;
    return this._runCycle({ ...options, manualUpdate: true });
  }

  async _runCycle(options = {}) {
    if (this._running) {
      return this.getStatus();
    }
    if (!this.enabled && !options.manualUpdate) {
      return this.getStatus();
    }

    this._running = true;
    const nowIso = new Date().toISOString();
    this._setStatus({
      state: 'checking',
      last_checked_at: nowIso,
      last_error: null,
      defer_reason: null
    });

    try {
      const result = await checkForUpdate(this.currentVersion);
      if (result.error) {
        this._setStatus({
          state: 'failed',
          latest_version: this.currentVersion,
          last_error: result.error
        });
        return this.getStatus();
      }

      const latest = result.latest || this.currentVersion;
      if (!result.available) {
        this._setStatus({
          state: 'up_to_date',
          latest_version: latest,
          target_version: null
        });
        return this.getStatus();
      }

      if (!shouldApplyUpdate(this.currentVersion, latest, { allowMajor: this.allowMajor })) {
        this._setStatus({
          state: 'up_to_date',
          latest_version: latest,
          target_version: null,
          defer_reason: 'cross_major_blocked'
        });
        return this.getStatus();
      }

      const monitor = this.getCallMonitor();
      const activeCalls = monitor && typeof monitor.getActiveCount === 'function'
        ? Number(monitor.getActiveCount()) || 0
        : 0;
      if (!isUpdateSafe(monitor) && !options.force) {
        this._setStatus({
          state: 'waiting_for_safe_restart',
          latest_version: latest,
          target_version: latest,
          active_calls: activeCalls,
          defer_reason: 'active_calls'
        });
        return this.getStatus();
      }

      this._setStatus({
        state: 'downloading',
        latest_version: latest,
        target_version: latest,
        active_calls: activeCalls
      });

      await this._installVersion(latest);
      this.currentVersion = latest;
      this._persistConfigPatch({ lastGoodVersion: latest });

      this._setStatus({
        state: 'restarting',
        current_version: latest,
        latest_version: latest,
        target_version: latest,
        last_success_at: new Date().toISOString(),
        last_error: null,
        defer_reason: null,
        active_calls: 0
      });

      if (this.restartFn) {
        await this.restartFn(latest);
      } else {
        this._setStatus({
          state: 'up_to_date',
          current_version: latest,
          latest_version: latest,
          target_version: null
        });
      }

      return this.getStatus();
    } catch (err) {
      const message = err && err.message ? err.message : 'update_failed';
      this._setStatus({
        state: 'failed',
        last_error: message
      });
      this.logger.error('Auto-update failed', {
        event: 'updater_failed',
        error: err
      });
      return this.getStatus();
    } finally {
      this._running = false;
      this._pendingManualUpdate = false;
    }
  }

  async _installVersion(version) {
    const args = ['install', '-g', `a2acalling@${version}`];
    this._setStatus({ state: 'applying' });
    this.logger.info('Installing auto-update target', {
      event: 'updater_install_start',
      data: { version }
    });
    await this._execFile('npm', args, {
      timeout: this.installTimeoutMs,
      env: process.env
    });
    this.logger.info('Auto-update install complete', {
      event: 'updater_install_done',
      data: { version }
    });
  }
}

module.exports = {
  DEFAULT_INTERVAL_MS,
  isUpdateSafe,
  shouldApplyUpdate,
  UpdateManager
};

