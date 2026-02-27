/**
 * Structured logger with SQLite persistence and stdout output.
 *
 * - Writes structured entries to a local SQLite DB
 * - Prints concise lines to stdout/stderr for operator visibility
 * - Supports filtering and trace retrieval for dashboard APIs
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

function resolveDefaultConfigDir() {
  return process.env.A2A_CONFIG_DIR ||
    process.env.OPENCLAW_CONFIG_DIR ||
    path.join(process.env.HOME || '/tmp', '.config', 'openclaw');
}

const LOG_DB_FILENAME = 'a2a-logs.db';
const LOG_LEVEL_ORDER = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50
};

function envBool(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') {
    return fallback;
  }
  const normalized = String(raw).trim().toLowerCase();
  return !(normalized === '0' || normalized === 'false' || normalized === 'no');
}

function normalizeLevel(level) {
  const normalized = String(level || '').trim().toLowerCase();
  return LOG_LEVEL_ORDER[normalized] ? normalized : 'info';
}

function shouldLog(level, minimumLevel) {
  const current = LOG_LEVEL_ORDER[normalizeLevel(level)] || LOG_LEVEL_ORDER.info;
  const threshold = LOG_LEVEL_ORDER[normalizeLevel(minimumLevel)] || LOG_LEVEL_ORDER.info;
  return current >= threshold;
}

function sanitizeText(value, maxLength = 1000) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function serializeError(error, options = {}) {
  if (!error) return null;
  if (error instanceof Error) {
    const payload = {
      name: error.name || 'Error',
      message: sanitizeText(error.message || 'Unknown error', 2000)
    };
    if (error.code) payload.code = String(error.code);
    if (error.cause) payload.cause = sanitizeText(String(error.cause), 400);
    if (options.includeStacks && error.stack) {
      payload.stack = String(error.stack).slice(0, 8000);
    }
    return payload;
  }
  if (typeof error === 'object') {
    try {
      return JSON.parse(JSON.stringify(error));
    } catch (err) {
      return { message: sanitizeText(String(error), 2000) };
    }
  }
  return { message: sanitizeText(String(error), 2000) };
}

function normalizeContext(context = {}, options = {}) {
  const entry = context && typeof context === 'object' ? { ...context } : {};
  const errorDetails = serializeError(entry.error, { includeStacks: options.includeStacks });
  const baseData = entry.data && typeof entry.data === 'object' ? { ...entry.data } : {};
  if (errorDetails) {
    baseData.error = errorDetails;
  }
  const hasData = Object.keys(baseData).length > 0;
  const statusCodeRaw = entry.status_code ?? entry.statusCode;
  const statusCode = Number.isFinite(Number(statusCodeRaw)) ? Number(statusCodeRaw) : null;
  const explicitErrorCode = entry.error_code || entry.errorCode || null;
  const inferredErrorCode = explicitErrorCode || (errorDetails && errorDetails.code ? errorDetails.code : null);
  return {
    event: entry.event ? sanitizeText(entry.event, 120) : null,
    trace_id: entry.trace_id || entry.traceId || null,
    conversation_id: entry.conversation_id || entry.conversationId || null,
    token_id: entry.token_id || entry.tokenId || null,
    request_id: entry.request_id || entry.requestId || null,
    error_code: inferredErrorCode ? sanitizeText(inferredErrorCode, 120) : null,
    hint: entry.hint ? sanitizeText(entry.hint, 500) : null,
    status_code: statusCode,
    component: entry.component ? sanitizeText(entry.component, 120) : null,
    data: hasData ? baseData : null
  };
}

class LogStore {
  constructor(configDir = resolveDefaultConfigDir()) {
    this.configDir = configDir;
    this.dbPath = path.join(configDir, LOG_DB_FILENAME);
    this.db = null;
    this._dbError = null;
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
      const ok = this._ensureSchema();
      if (!ok) {
        // Prototyping mode: do not attempt DB migrations; keep the old file and start fresh.
        const backupPath = `${this.dbPath}.legacy.${Date.now()}`;
        try {
          this.db.close();
        } catch (err) {
          // ignore
        }
        fs.renameSync(this.dbPath, backupPath);
        this.db = new Database(this.dbPath);
        try {
          fs.chmodSync(this.dbPath, 0o600);
        } catch (err) {
          // best effort
        }
        const ok2 = this._ensureSchema();
        if (!ok2) {
          this._dbError = 'failed_to_initialize_log_db_schema';
          return null;
        }
      }
      this._prepareStatements();
      return this.db;
    } catch (err) {
      this._dbError = err.message || 'failed_to_initialize_log_db';
      return null;
    }
  }

  _ensureSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        level TEXT NOT NULL,
        component TEXT NOT NULL,
        event TEXT,
        message TEXT NOT NULL,
        trace_id TEXT,
        conversation_id TEXT,
        token_id TEXT,
        request_id TEXT,
        error_code TEXT,
        status_code INTEGER,
        hint TEXT,
        data TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);
      CREATE INDEX IF NOT EXISTS idx_logs_component ON logs(component);
      CREATE INDEX IF NOT EXISTS idx_logs_trace ON logs(trace_id);
      CREATE INDEX IF NOT EXISTS idx_logs_conversation ON logs(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_logs_token ON logs(token_id);
      CREATE INDEX IF NOT EXISTS idx_logs_error_code ON logs(error_code);
    `);

    const columns = this.db.prepare(`PRAGMA table_info(logs)`).all();
    const names = new Set(columns.map(c => c && c.name).filter(Boolean));
    const required = ['timestamp', 'level', 'component', 'message', 'error_code', 'status_code', 'hint', 'data'];
    return required.every((name) => names.has(name));
  }

  _prepareStatements() {
    this.insertStmt = this.db.prepare(`
      INSERT INTO logs (
        timestamp, level, component, event, message,
        trace_id, conversation_id, token_id, request_id, error_code, status_code, hint, data
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    // A2A-64: Prepared statement for time-based retention pruning
    this.pruneStmt = this.db.prepare('DELETE FROM logs WHERE timestamp < ?');
  }

  isAvailable() {
    return this._initDb() !== null;
  }

  getError() {
    this._initDb();
    return this._dbError;
  }

  write(entry) {
    const db = this._initDb();
    if (!db) return false;
    const dataText = entry.data ? JSON.stringify(entry.data) : null;
    try {
      this.insertStmt.run(
        entry.timestamp,
        entry.level,
        entry.component,
        entry.event,
        entry.message,
        entry.trace_id,
        entry.conversation_id,
        entry.token_id,
        entry.request_id,
        entry.error_code,
        entry.status_code,
        entry.hint,
        dataText
      );

      // A2A-64: Auto-prune on every 1000th write (dashboard-events.js pattern).
      // Best effort — prune failures must not affect write operations.
      this._writeCount = (this._writeCount || 0) + 1;
      if (this._writeCount % 1000 === 0 && !this._pruning) {
        try {
          const threshold = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
          this.pruneStmt.run(threshold);
        } catch (_) {
          // A2A-64: Best effort — silent catch like dashboard-events.js:149
        }
      }

      return true;
    } catch (err) {
      this._dbError = err.message || 'failed_to_write_log_entry';
      return false;
    }
  }

  list(options = {}) {
    const db = this._initDb();
    if (!db) return [];

    const limit = Math.min(1000, Math.max(1, Number.parseInt(options.limit || '200', 10) || 200));
    const where = [];
    const params = [];

    if (options.level) {
      where.push('level = ?');
      params.push(normalizeLevel(options.level));
    }
    if (options.component) {
      where.push('component = ?');
      params.push(String(options.component));
    }
    if (options.event) {
      where.push('event = ?');
      params.push(String(options.event));
    }
    if (options.errorCode) {
      where.push('error_code = ?');
      params.push(String(options.errorCode));
    }
    if (options.statusCode !== undefined && options.statusCode !== null && options.statusCode !== '') {
      where.push('status_code = ?');
      params.push(Number(options.statusCode));
    }
    if (options.traceId) {
      where.push('trace_id = ?');
      params.push(String(options.traceId));
    }
    if (options.conversationId) {
      where.push('conversation_id = ?');
      params.push(String(options.conversationId));
    }
    if (options.tokenId) {
      where.push('token_id = ?');
      params.push(String(options.tokenId));
    }
    if (options.from) {
      where.push('timestamp >= ?');
      params.push(String(options.from));
    }
    if (options.to) {
      where.push('timestamp <= ?');
      params.push(String(options.to));
    }
    if (options.search) {
      where.push('(message LIKE ? OR data LIKE ?)');
      const like = `%${String(options.search).replace(/%/g, '')}%`;
      params.push(like, like);
    }

    const query = `
      SELECT id, timestamp, level, component, event, message,
             trace_id, conversation_id, token_id, request_id, error_code, status_code, hint, data
      FROM logs
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY id DESC
      LIMIT ?
    `;
    params.push(limit);

    return db.prepare(query).all(...params).map(row => ({
      id: row.id,
      timestamp: row.timestamp,
      level: row.level,
      component: row.component,
      event: row.event,
      message: row.message,
      trace_id: row.trace_id,
      conversation_id: row.conversation_id,
      token_id: row.token_id,
      request_id: row.request_id,
      error_code: row.error_code,
      status_code: row.status_code,
      hint: row.hint,
      data: row.data ? safeJsonParse(row.data) : null
    }));
  }

  getTrace(traceId, options = {}) {
    const db = this._initDb();
    if (!db || !traceId) return [];
    const limit = Math.min(1000, Math.max(1, Number.parseInt(options.limit || '500', 10) || 500));
    return db.prepare(`
      SELECT id, timestamp, level, component, event, message,
             trace_id, conversation_id, token_id, request_id, error_code, status_code, hint, data
      FROM logs
      WHERE trace_id = ?
      ORDER BY id ASC
      LIMIT ?
    `).all(String(traceId), limit).map(row => ({
      id: row.id,
      timestamp: row.timestamp,
      level: row.level,
      component: row.component,
      event: row.event,
      message: row.message,
      trace_id: row.trace_id,
      conversation_id: row.conversation_id,
      token_id: row.token_id,
      request_id: row.request_id,
      error_code: row.error_code,
      status_code: row.status_code,
      hint: row.hint,
      data: row.data ? safeJsonParse(row.data) : null
    }));
  }

  stats(options = {}) {
    const db = this._initDb();
    if (!db) {
      return {
        total: 0,
        by_level: {},
        by_component: {}
      };
    }

    const where = [];
    const params = [];
    if (options.from) {
      where.push('timestamp >= ?');
      params.push(String(options.from));
    }
    if (options.to) {
      where.push('timestamp <= ?');
      params.push(String(options.to));
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const totalRow = db.prepare(`SELECT COUNT(*) AS count FROM logs ${clause}`).get(...params);
    const levelRows = db.prepare(`
      SELECT level, COUNT(*) AS count
      FROM logs ${clause}
      GROUP BY level
    `).all(...params);
    const componentRows = db.prepare(`
      SELECT component, COUNT(*) AS count
      FROM logs ${clause}
      GROUP BY component
    `).all(...params);

    const byLevel = {};
    for (const row of levelRows) {
      byLevel[row.level] = row.count;
    }
    const byComponent = {};
    for (const row of componentRows) {
      byComponent[row.component] = row.count;
    }

    return {
      total: totalRow?.count || 0,
      by_level: byLevel,
      by_component: byComponent
    };
  }

  close() {
    if (this.db) {
      try {
        this.db.close();
      } catch (err) {
        // best effort
      }
      this.db = null;
    }
  }

  /**
   * A2A-64: Delete log entries older than the retention period.
   *
   * @param {object} [options]
   * @param {number} [options.days=30] - Retention period in days
   * @returns {{ deleted: number }}
   */
  pruneOld(options = {}) {
    const db = this._initDb();
    if (!db) return { deleted: 0 };

    const days = Number.isFinite(options.days) ? options.days : 30;
    const threshold = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    // A2A-64: Set _pruning flag to prevent auto-prune recursion if the
    // cleanup logger writes back to this same store.
    this._pruning = true;
    let deleted = 0;
    try {
      const result = this.pruneStmt.run(threshold);
      deleted = result.changes;

      // A2A-64: Only VACUUM after bulk deletions (>100 rows) to avoid unnecessary I/O
      if (deleted > 100) {
        db.exec('VACUUM');
      }
    } finally {
      this._pruning = false;
    }

    // A2A-64: Log prune results AFTER prune completes to avoid recursion.
    // Use a Logger instance with stdout:false for the cleanup component.
    try {
      const cleanupLogger = new Logger(this, { component: 'a2a.cleanup', stdout: true, minLevel: 'info' });
      cleanupLogger.info(`Pruned ${deleted} log entries older than ${days} days`, {
        event: 'logs_pruned',
        data: { deleted, days, threshold }
      });
    } catch (_) {
      // A2A-64: Best effort — logging about prune results must not throw
    }

    return { deleted };
  }

  /**
   * A2A-64: Return database-level stats for monitoring.
   * Complements the existing stats() method which provides level/component breakdowns.
   *
   * @returns {{ total: number, oldest_entry: string|null, newest_entry: string|null }}
   */
  getDatabaseStats() {
    const db = this._initDb();
    if (!db) return { total: 0, oldest_entry: null, newest_entry: null };

    const row = db.prepare(
      'SELECT COUNT(*) AS total, MIN(timestamp) AS oldest, MAX(timestamp) AS newest FROM logs'
    ).get();

    return {
      total: row?.total || 0,
      oldest_entry: row?.oldest || null,
      newest_entry: row?.newest || null
    };
  }
}

class Logger {
  constructor(store, options = {}) {
    this.store = store;
    this.component = options.component || 'a2a';
    this.bindings = options.bindings || {};
    this.stdout = options.stdout !== false;
    this.minLevel = normalizeLevel(options.minLevel || process.env.A2A_LOG_LEVEL || 'info');
    this.includeStacks = options.includeStacks !== undefined
      ? Boolean(options.includeStacks)
      : envBool('A2A_LOG_STACKS', process.env.NODE_ENV !== 'production');
  }

  child(bindings = {}) {
    return new Logger(this.store, {
      component: bindings.component || this.component,
      bindings: { ...this.bindings, ...bindings },
      stdout: this.stdout,
      minLevel: this.minLevel,
      includeStacks: this.includeStacks
    });
  }

  trace(message, context = {}) {
    return this.log('trace', message, context);
  }

  debug(message, context = {}) {
    return this.log('debug', message, context);
  }

  info(message, context = {}) {
    return this.log('info', message, context);
  }

  warn(message, context = {}) {
    return this.log('warn', message, context);
  }

  error(message, context = {}) {
    return this.log('error', message, context);
  }

  log(level, message, context = {}) {
    const normalizedLevel = normalizeLevel(level);
    if (!shouldLog(normalizedLevel, this.minLevel)) {
      return null;
    }

    const now = new Date().toISOString();
    const mergedContext = {
      ...(this.bindings || {}),
      ...(context || {})
    };
    const normalized = normalizeContext(mergedContext, {
      includeStacks: this.includeStacks
    });

    const entry = {
      timestamp: now,
      level: normalizedLevel,
      component: normalized.component || this.component || 'a2a',
      event: normalized.event,
      message: sanitizeText(message, 2000) || '(empty)',
      trace_id: normalized.trace_id ? String(normalized.trace_id) : null,
      conversation_id: normalized.conversation_id ? String(normalized.conversation_id) : null,
      token_id: normalized.token_id ? String(normalized.token_id) : null,
      request_id: normalized.request_id ? String(normalized.request_id) : null,
      error_code: normalized.error_code,
      status_code: normalized.status_code,
      hint: normalized.hint,
      data: normalized.data
    };

    this.store.write(entry);
    if (this.stdout) {
      this._print(entry);
    }
    return entry;
  }

  list(options = {}) {
    return this.store.list(options);
  }

  getTrace(traceId, options = {}) {
    return this.store.getTrace(traceId, options);
  }

  stats(options = {}) {
    return this.store.stats(options);
  }

  _print(entry) {
    const parts = [
      `[a2a]`,
      entry.level.toUpperCase(),
      `${entry.component}${entry.event ? `:${entry.event}` : ''}`,
      entry.message
    ];
    if (entry.trace_id) parts.push(`trace=${entry.trace_id}`);
    if (entry.conversation_id) parts.push(`conv=${entry.conversation_id}`);
    if (entry.token_id) parts.push(`tok=${entry.token_id}`);
    if (entry.request_id) parts.push(`req=${entry.request_id}`);
    if (entry.error_code) parts.push(`code=${entry.error_code}`);
    if (entry.status_code !== null && entry.status_code !== undefined) parts.push(`status=${entry.status_code}`);
    if (entry.data && Object.keys(entry.data).length > 0) {
      parts.push(`data=${JSON.stringify(entry.data)}`);
    }
    if (entry.hint) parts.push(`hint=${entry.hint}`);
    const line = parts.join(' ');
    if (entry.level === 'error' || entry.level === 'warn') {
      console.error(line);
    } else {
      console.log(line);
    }
  }
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch (err) {
    return null;
  }
}

const storeCache = new Map();

function getStore(configDir) {
  const resolved = path.resolve(configDir);
  if (!storeCache.has(resolved)) {
    storeCache.set(resolved, new LogStore(resolved));
  }
  return storeCache.get(resolved);
}

function createLogger(options = {}) {
  const configDir = options.configDir || resolveDefaultConfigDir();
  const store = getStore(configDir);
  return new Logger(store, {
    component: options.component || 'a2a',
    bindings: options.bindings || {},
    stdout: options.stdout !== false,
    minLevel: options.minLevel,
    includeStacks: options.includeStacks
  });
}

function createTraceId(prefix = 'trace') {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function closeAllLoggerStores() {
  for (const store of storeCache.values()) {
    store.close();
  }
  storeCache.clear();
}

// A2A-65: Prune old entries from all cached logger stores.
// Best effort — individual store failures are caught and logged.
function pruneAllLoggerStores(options = {}) {
  const results = [];
  for (const store of storeCache.values()) {
    try {
      results.push(store.pruneOld(options));
    } catch (_) {
      // A2A-65: Best effort — one store failure must not block others
    }
  }
  return results;
}

module.exports = {
  LOG_DB_FILENAME,
  LogStore,
  createLogger,
  createTraceId,
  closeAllLoggerStores,
  pruneAllLoggerStores
};
