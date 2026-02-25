const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const DEFAULT_CONFIG_DIR = process.env.A2A_CONFIG_DIR ||
  process.env.OPENCLAW_CONFIG_DIR ||
  path.join(process.env.HOME || '/tmp', '.config', 'openclaw');

const DB_FILENAME = 'a2a-events.db';
const DEFAULT_RETENTION_COUNT = 5000;

function nowIso() {
  return new Date().toISOString();
}

class DashboardEventStore {
  constructor(configDir = DEFAULT_CONFIG_DIR, options = {}) {
    this.configDir = configDir;
    this.dbPath = options.dbPath || path.join(configDir, DB_FILENAME);
    this.retentionCount = Number.isFinite(options.retentionCount)
      ? Math.max(100, Math.floor(options.retentionCount))
      : DEFAULT_RETENTION_COUNT;
    this.db = null;
    this._dbError = null;
    this._stmts = null;
    this._emitter = new EventEmitter();
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
      } catch (_) {
        // Best effort.
      }
      this._migrate();
      this._prepareStatements();
      return this.db;
    } catch (err) {
      this._dbError = err && err.message ? err.message : 'failed_to_initialize_event_db';
      return null;
    }
  }

  _migrate() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS dashboard_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        conversation_id TEXT,
        contact_id TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_dashboard_events_created ON dashboard_events(created_at);
      CREATE INDEX IF NOT EXISTS idx_dashboard_events_type ON dashboard_events(event_type);
      CREATE INDEX IF NOT EXISTS idx_dashboard_events_conversation ON dashboard_events(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_dashboard_events_contact ON dashboard_events(contact_id);
    `);
  }

  _prepareStatements() {
    this._stmts = {
      insertEvent: this.db.prepare(`
        INSERT INTO dashboard_events (event_type, created_at, payload_json, conversation_id, contact_id)
        VALUES (@event_type, @created_at, @payload_json, @conversation_id, @contact_id)
      `),
      listSince: this.db.prepare(`
        SELECT id, event_type, created_at, payload_json, conversation_id, contact_id
        FROM dashboard_events
        WHERE id > @since_id
        ORDER BY id ASC
        LIMIT @limit
      `),
      listLatest: this.db.prepare(`
        SELECT id, event_type, created_at, payload_json, conversation_id, contact_id
        FROM dashboard_events
        ORDER BY id DESC
        LIMIT @limit
      `),
      prune: this.db.prepare(`
        DELETE FROM dashboard_events
        WHERE id NOT IN (
          SELECT id FROM dashboard_events
          ORDER BY id DESC
          LIMIT @retention
        )
      `)
    };
  }

  isAvailable() {
    return Boolean(this._initDb());
  }

  getDbError() {
    this._initDb();
    return this._dbError;
  }

  emitEvent(eventType, payload = {}, meta = {}) {
    const db = this._initDb();
    if (!db) {
      return { success: false, error: 'event_storage_unavailable', message: this._dbError };
    }

    const event_type = String(eventType || '').trim().slice(0, 80);
    if (!event_type) {
      return { success: false, error: 'event_type_required' };
    }

    const created_at = nowIso();
    const row = {
      event_type,
      created_at,
      payload_json: JSON.stringify(payload || {}),
      conversation_id: meta && meta.conversationId ? String(meta.conversationId).slice(0, 120) : null,
      contact_id: meta && meta.contactId ? String(meta.contactId).slice(0, 120) : null
    };

    const info = this._stmts.insertEvent.run(row);
    const id = Number(info.lastInsertRowid);
    const event = {
      id,
      type: event_type,
      created_at,
      conversation_id: row.conversation_id,
      contact_id: row.contact_id,
      payload: payload || {}
    };

    if (id % 100 === 0) {
      try {
        this._stmts.prune.run({ retention: this.retentionCount });
      } catch (_) {
        // Best effort.
      }
    }

    this._emitter.emit('event', event);
    return { success: true, event };
  }

  listSince(sinceId, options = {}) {
    const db = this._initDb();
    if (!db) return [];
    const limit = Math.min(500, Math.max(1, Number.parseInt(String(options.limit || '200'), 10) || 200));
    const parsedSince = Number.parseInt(String(sinceId || '0'), 10);
    if (Number.isFinite(parsedSince) && parsedSince > 0) {
      const rows = this._stmts.listSince.all({ since_id: parsedSince, limit });
      return rows.map((row) => this._toEvent(row));
    }
    const rows = this._stmts.listLatest.all({ limit }).reverse();
    return rows.map((row) => this._toEvent(row));
  }

  subscribe(listener) {
    const safe = (event) => {
      try {
        listener(event);
      } catch (_) {
        // Keep stream robust.
      }
    };
    this._emitter.on('event', safe);
    return () => {
      this._emitter.off('event', safe);
    };
  }

  // A2A-57: Close the SQLite database and flush WAL on shutdown
  close() {
    if (this.db) {
      try { this.db.close(); } catch (_) {}
      this.db = null;
    }
  }

  _toEvent(row) {
    let payload = {};
    try {
      payload = row.payload_json ? JSON.parse(row.payload_json) : {};
    } catch (_) {
      payload = {};
    }
    return {
      id: row.id,
      type: row.event_type,
      created_at: row.created_at,
      conversation_id: row.conversation_id || null,
      contact_id: row.contact_id || null,
      payload
    };
  }
}

module.exports = {
  DashboardEventStore
};
