/**
 * Callbook Remote Auth
 *
 * Purpose:
 * - Allow a remote owner UI ("Callbook Remote") to manage the dashboard safely.
 * - Provisioning codes are short-lived and one-time use (safe-ish to share as an install link).
 * - Sessions are long-lived (no expiration by default) and revocable.
 *
 * Storage:
 * - SQLite DB at ~/.config/openclaw/a2a-callbook.db (or $A2A_CONFIG_DIR).
 *
 * Notes:
 * - Secrets are never stored plaintext: only SHA-256 hashes are persisted.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_CONFIG_DIR = process.env.A2A_CONFIG_DIR ||
  process.env.OPENCLAW_CONFIG_DIR ||
  path.join(process.env.HOME || '/tmp', '.config', 'openclaw');

const DB_FILENAME = 'a2a-callbook.db';

function nowIso() {
  return new Date().toISOString();
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function randomToken(prefix = '') {
  const token = crypto.randomBytes(32).toString('base64url');
  return prefix ? `${prefix}${token}` : token;
}

class CallbookStore {
  constructor(configDir = DEFAULT_CONFIG_DIR, options = {}) {
    this.configDir = configDir;
    this.dbPath = options.dbPath || path.join(configDir, DB_FILENAME);
    this.db = null;
    this._dbError = null;
    this._stmts = null;
    this._ensureDir();
  }

  _ensureDir() {
    if (!fs.existsSync(this.configDir)) {
      fs.mkdirSync(this.configDir, { recursive: true });
    }
  }

  _initDb() {
    if (this.db) return this.db;
    if (this._dbError) return null;
    try {
      const Database = require('better-sqlite3');
      this.db = new Database(this.dbPath);
      try {
        fs.chmodSync(this.dbPath, 0o600);
      } catch (err) {
        // best effort
      }
      this._migrate();
      this._prepareStatements();
      return this.db;
    } catch (err) {
      this._dbError = err && err.message ? err.message : 'failed_to_initialize_callbook_db';
      return null;
    }
  }

  _migrate() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS provision_codes (
        id TEXT PRIMARY KEY,
        code_hash TEXT NOT NULL UNIQUE,
        label TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_provision_codes_expires ON provision_codes(expires_at);
      CREATE INDEX IF NOT EXISTS idx_provision_codes_used ON provision_codes(used_at);

      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        label TEXT,
        created_at TEXT NOT NULL,
        revoked_at TEXT,
        last_used_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_devices_revoked ON devices(revoked_at);

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        revoked_at TEXT,
        last_used_at TEXT,
        FOREIGN KEY(device_id) REFERENCES devices(id)
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_device_id ON sessions(device_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_revoked ON sessions(revoked_at);
    `);
  }

  _prepareStatements() {
    this._stmts = {
      insertProvision: this.db.prepare(
        `INSERT INTO provision_codes (id, code_hash, label, created_at, expires_at, used_at)
         VALUES (@id, @code_hash, @label, @created_at, @expires_at, NULL)`
      ),
      findProvisionByHash: this.db.prepare(
        `SELECT * FROM provision_codes WHERE code_hash = ?`
      ),
      markProvisionUsed: this.db.prepare(
        `UPDATE provision_codes SET used_at = @used_at WHERE id = @id AND used_at IS NULL`
      ),

      insertDevice: this.db.prepare(
        `INSERT INTO devices (id, label, created_at, revoked_at, last_used_at)
         VALUES (@id, @label, @created_at, NULL, NULL)`
      ),
      getDevice: this.db.prepare(
        `SELECT * FROM devices WHERE id = ?`
      ),
      listDevices: this.db.prepare(
        `SELECT
           d.id,
           d.label,
           d.created_at,
           d.revoked_at,
           d.last_used_at,
           (SELECT COUNT(*) FROM sessions s WHERE s.device_id = d.id AND s.revoked_at IS NULL) AS active_sessions
         FROM devices d
         ORDER BY d.created_at DESC
         LIMIT ?`
      ),
      updateDeviceLastUsed: this.db.prepare(
        `UPDATE devices SET last_used_at = ? WHERE id = ?`
      ),
      revokeDevice: this.db.prepare(
        `UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`
      ),

      insertSession: this.db.prepare(
        `INSERT INTO sessions (id, device_id, token_hash, created_at, revoked_at, last_used_at)
         VALUES (@id, @device_id, @token_hash, @created_at, NULL, NULL)`
      ),
      findSessionByHash: this.db.prepare(
        `SELECT * FROM sessions WHERE token_hash = ?`
      ),
      updateSessionLastUsed: this.db.prepare(
        `UPDATE sessions SET last_used_at = ? WHERE id = ?`
      ),
      revokeSessionsByDevice: this.db.prepare(
        `UPDATE sessions SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL`
      )
    };
  }

  isAvailable() {
    return Boolean(this._initDb());
  }

  getDbError() {
    this._initDb();
    return this._dbError;
  }

  /**
   * Create a one-time provisioning code (default TTL: 24 hours).
   * Returns { code, record } where code is plaintext (show once).
   */
  createProvisionCode(options = {}) {
    const db = this._initDb();
    if (!db) {
      return { success: false, error: 'callbook_storage_unavailable', message: this._dbError };
    }

    const label = options.label ? String(options.label).trim().slice(0, 120) : null;
    const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : (24 * 60 * 60 * 1000);
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + Math.max(1, ttlMs)).toISOString();

    const code = randomToken('cbk_');
    const record = {
      id: `cbkprov_${crypto.randomBytes(10).toString('hex')}`,
      code_hash: sha256Hex(code),
      label,
      created_at: createdAt,
      expires_at: expiresAt
    };

    this._stmts.insertProvision.run(record);

    return {
      success: true,
      code,
      record: {
        id: record.id,
        label: record.label,
        created_at: record.created_at,
        expires_at: record.expires_at,
        used_at: null
      }
    };
  }

  /**
   * Exchange a provisioning code for a long-lived session token.
   * Returns { sessionToken, device } on success.
   */
  exchangeProvisionCode(code, options = {}) {
    const db = this._initDb();
    if (!db) {
      return { success: false, error: 'callbook_storage_unavailable', message: this._dbError };
    }

    const raw = String(code || '').trim();
    if (!raw) {
      return { success: false, error: 'missing_code' };
    }

    const codeHash = sha256Hex(raw);
    const found = this._stmts.findProvisionByHash.get(codeHash);
    if (!found) {
      return { success: false, error: 'invalid_code' };
    }

    const now = Date.now();
    const expiresMs = Date.parse(found.expires_at);
    if (Number.isFinite(expiresMs) && now > expiresMs) {
      return { success: false, error: 'code_expired' };
    }
    if (found.used_at) {
      return { success: false, error: 'code_already_used' };
    }

    const usedAt = nowIso();
    const tx = db.transaction(() => {
      const marked = this._stmts.markProvisionUsed.run({ id: found.id, used_at: usedAt });
      if (!marked || marked.changes !== 1) {
        // Another request raced us.
        return { success: false, error: 'code_already_used' };
      }

      const deviceId = `cbkdev_${crypto.randomBytes(10).toString('hex')}`;
      const deviceLabel = (options.label ? String(options.label).trim().slice(0, 120) : null) || found.label || null;
      this._stmts.insertDevice.run({
        id: deviceId,
        label: deviceLabel,
        created_at: usedAt
      });

      const sessionToken = randomToken('cbksess_');
      const sessionId = `cbks_${crypto.randomBytes(10).toString('hex')}`;
      this._stmts.insertSession.run({
        id: sessionId,
        device_id: deviceId,
        token_hash: sha256Hex(sessionToken),
        created_at: usedAt
      });

      return {
        success: true,
        sessionToken,
        device: {
          id: deviceId,
          label: deviceLabel,
          created_at: usedAt,
          revoked_at: null,
          last_used_at: null
        }
      };
    });

    return tx();
  }

  /**
   * Validate a session token from a cookie.
   * Returns { valid, session, device }.
   */
  validateSession(sessionToken) {
    const db = this._initDb();
    if (!db) {
      return { valid: false, error: 'callbook_storage_unavailable' };
    }

    const raw = String(sessionToken || '').trim();
    if (!raw) return { valid: false, error: 'missing_session' };

    const session = this._stmts.findSessionByHash.get(sha256Hex(raw));
    if (!session) return { valid: false, error: 'invalid_session' };
    if (session.revoked_at) return { valid: false, error: 'session_revoked' };

    const device = this._stmts.getDevice.get(session.device_id);
    if (!device) return { valid: false, error: 'device_not_found' };
    if (device.revoked_at) return { valid: false, error: 'device_revoked' };

    const usedAt = nowIso();
    try {
      this._stmts.updateSessionLastUsed.run(usedAt, session.id);
      this._stmts.updateDeviceLastUsed.run(usedAt, device.id);
    } catch (err) {
      // best effort
    }

    return { valid: true, session: { id: session.id, device_id: session.device_id }, device };
  }

  listDevices(options = {}) {
    const db = this._initDb();
    if (!db) {
      return { success: false, error: 'callbook_storage_unavailable', message: this._dbError, devices: [] };
    }
    const limit = Math.min(500, Math.max(1, Number.parseInt(String(options.limit || '200'), 10) || 200));
    const rows = this._stmts.listDevices.all(limit);
    const includeRevoked = Boolean(options.includeRevoked);
    const devices = includeRevoked ? rows : rows.filter(r => !r.revoked_at);
    return { success: true, devices };
  }

  revokeDevice(deviceId) {
    const db = this._initDb();
    if (!db) {
      return { success: false, error: 'callbook_storage_unavailable', message: this._dbError };
    }
    const id = String(deviceId || '').trim();
    if (!id) return { success: false, error: 'device_id_required' };
    const revokedAt = nowIso();
    const tx = db.transaction(() => {
      const dev = this._stmts.getDevice.get(id);
      if (!dev) return { success: false, error: 'device_not_found' };
      this._stmts.revokeDevice.run(revokedAt, id);
      this._stmts.revokeSessionsByDevice.run(revokedAt, id);
      return { success: true, device: { ...dev, revoked_at: revokedAt } };
    });
    return tx();
  }

  // A2A-57: Close the SQLite database and flush WAL on shutdown
  close() {
    if (this.db) {
      try { this.db.close(); } catch (_) {}
      this.db = null;
    }
  }
}

module.exports = {
  DEFAULT_CONFIG_DIR,
  DB_FILENAME,
  CallbookStore
};

