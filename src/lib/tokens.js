/**
 * Token management for A2A
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createLogger } = require('./logger');

// Default config path
const DEFAULT_CONFIG_DIR = process.env.A2A_CONFIG_DIR || 
  process.env.OPENCLAW_CONFIG_DIR || 
  path.join(process.env.HOME || '/tmp', '.config', 'openclaw');

const DB_FILENAME = 'a2a.json';
const logger = createLogger({ component: 'a2a.tokens' });

function sanitizeCustomFields(fields, options = {}) {
  const maxFields = Number.isFinite(options.maxFields) ? options.maxFields : 200;
  const keyMaxLength = Number.isFinite(options.keyMaxLength) ? options.keyMaxLength : 80;
  const valMaxLength = Number.isFinite(options.valMaxLength) ? options.valMaxLength : 800;

  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    return {};
  }

  const cleaned = {};
  const keys = Object.keys(fields);
  let count = 0;

  for (const rawKey of keys) {
    if (count >= maxFields) break;
    const key = String(rawKey || '').replace(/\s+/g, ' ').trim().slice(0, keyMaxLength);
    if (!key) continue;

    const rawVal = fields[rawKey];
    let value = '';
    if (rawVal === null || rawVal === undefined) {
      value = '';
    } else if (typeof rawVal === 'string') {
      value = rawVal;
    } else if (typeof rawVal === 'number' || typeof rawVal === 'boolean') {
      value = String(rawVal);
    } else {
      try {
        value = JSON.stringify(rawVal);
      } catch (err) {
        value = String(rawVal);
      }
    }

    cleaned[key] = String(value).replace(/\s+/g, ' ').trim().slice(0, valMaxLength);
    count++;
  }

  return cleaned;
}

function parsePositiveTimeoutMs(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

class TokenStore {
  constructor(configDir = DEFAULT_CONFIG_DIR) {
    this.configDir = configDir;
    this.dbPath = path.join(configDir, DB_FILENAME);
    this._ensureDir();
  }

  _ensureDir() {
    if (!fs.existsSync(this.configDir)) {
      fs.mkdirSync(this.configDir, { recursive: true });
    }
  }

  _load() {
    if (fs.existsSync(this.dbPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.dbPath, 'utf8'));
        const db = parsed && typeof parsed === 'object' ? parsed : {};
        db.tokens = Array.isArray(db.tokens) ? db.tokens : [];
        db.calls = Array.isArray(db.calls) ? db.calls : [];
        db.contacts = Array.isArray(db.contacts) ? db.contacts : [];

        // Backward compat: legacy "remotes" is now "contacts".
        const legacyRemotes = Array.isArray(db.remotes) ? db.remotes : [];
        if (legacyRemotes.length) {
          const keyFor = (row) => {
            if (!row || typeof row !== 'object') return null;
            if (row.id) return `id:${row.id}`;
            const host = row.host ? String(row.host) : '';
            const hash = row.token_hash ? String(row.token_hash) : '';
            if (host && hash) return `hosthash:${host}#${hash}`;
            if (host) return `host:${host}`;
            return null;
          };

          const merged = db.contacts.slice();
          const seen = new Set();
          for (const row of merged) {
            const key = keyFor(row);
            if (key) seen.add(key);
          }
          for (const row of legacyRemotes) {
            const key = keyFor(row);
            if (key && seen.has(key)) continue;
            if (key) seen.add(key);
            merged.push(row);
          }
          db.contacts = merged;
        }

        // Persisted schema is intentionally minimal during prototyping.
        return { tokens: db.tokens, contacts: db.contacts, calls: db.calls };
      } catch (e) {
        // Corrupted file - backup and start fresh
        const backupPath = `${this.dbPath}.corrupt.${Date.now()}`;
        fs.renameSync(this.dbPath, backupPath);
        logger.error('Token database was corrupted and moved to backup', {
          event: 'token_db_corrupt_backup_created',
          error: e,
          error_code: 'TOKEN_DB_CORRUPTED',
          hint: 'Inspect the backup file, then restore valid JSON schema in a2a.json.',
          data: {
            db_path: this.dbPath,
            backup_path: backupPath
          }
        });
        return { tokens: [], contacts: [], calls: [] };
      }
    }
    return { tokens: [], contacts: [], calls: [] };
  }

  _save(db) {
    const persisted = {
      tokens: Array.isArray(db.tokens) ? db.tokens : [],
      contacts: Array.isArray(db.contacts) ? db.contacts : [],
      calls: Array.isArray(db.calls) ? db.calls : []
    };

    // Atomic write: write to temp file, then rename
    const tmpPath = `${this.dbPath}.tmp.${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(persisted, null, 2), { mode: 0o600 });
    fs.renameSync(tmpPath, this.dbPath);
    try {
      fs.chmodSync(this.dbPath, 0o600);
    } catch (err) {
      // Best effort - ignore on platforms without chmod support.
    }
  }

  /**
   * Generate a secure A2A token
   */
  static generateToken() {
    const bytes = crypto.randomBytes(24);
    return 'fed_' + bytes.toString('base64url');
  }

  /**
   * Hash a token for storage
   */
  static hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  /**
   * Parse duration string (1h, 1d, 7d, 30d, never) to milliseconds
   */
  static parseDuration(str) {
    if (!str || str === 'never') return null;
    const match = str.match(/^(\d+)(h|d)$/);
    if (!match) throw new Error(`Invalid duration: ${str}`);
    const [, num, unit] = match;
    return unit === 'h' 
      ? parseInt(num) * 60 * 60 * 1000 
      : parseInt(num) * 24 * 60 * 60 * 1000;
  }

  /**
   * Create a new A2A token
   * 
   * Default limits (anti-abuse):
   * - Expires in 1 day
   * - Max 100 calls total
   * - Rate limited: 10/min, 100/hr, 1000/day (enforced server-side)
   * - Timeout: 5-300 seconds (enforced server-side)
   */
  create(options = {}) {
    // A2A-41: disclosure field removed from tokens. Was never used by
    // prompt generation. Existing tokens with disclosure field are harmless
    // — the field is simply not read.
    const {
      name = 'unnamed',
      owner = null,
      expires = '1d',
      permissions = 'public',
      notify = 'all',
      maxCalls = 100,  // Default limit, not unlimited
      capabilities = null,  // Array of capability strings, snapshotted at creation
      // Snapshot of actual capabilities at creation time
      allowedTopics = null,  // Array of topic strings, e.g. ['chat', 'calendar.read']
      allowedGoals = null,   // Array of goal strings, e.g. ['grow-network', 'find-collaborators']
      allowedTools = null,   // Array of tool names, e.g. ['Read', 'Grep', 'Glob']
      tierSettings = null,   // Object with tier-specific settings
      timeoutMs = null
    } = options;

    const tier = String(permissions || 'public').trim() || 'public';
    if (!TokenStore.VALID_TIERS.includes(tier)) {
      throw new Error(`Invalid permissions tier: ${tier}. Expected: ${TokenStore.VALID_TIERS.join('|')}`);
    }

    const token = TokenStore.generateToken();
    const tokenHash = TokenStore.hashToken(token);
    const durationMs = TokenStore.parseDuration(expires);
    const expiresAt = durationMs ? new Date(Date.now() + durationMs).toISOString() : null;

    // Load tier definitions from config (if available)
    let configTiers = {};
    try {
      const configPath = path.join(this.configDir, 'a2a-config.json');
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (config.tiers) {
          configTiers = config.tiers;
        }
      }
    } catch (e) {
      // Config not available, use defaults
    }

    // Default topics based on tier label (snapshot at creation)
    // User config overrides these defaults
    const defaultTopics = {
      'public': configTiers.public?.topics || ['chat'],
      'friends': configTiers.friends?.topics || ['chat', 'calendar.read', 'email.read', 'search'],
      'family': configTiers.family?.topics || ['chat', 'calendar', 'email', 'search', 'tools'],
      'custom': configTiers.custom?.topics || ['chat']
    };

    // Default goals based on tier label (snapshot at creation)
    const defaultGoals = {
      'public': configTiers.public?.goals || [],
      'friends': configTiers.friends?.goals || [],
      'family': configTiers.family?.goals || [],
      'custom': configTiers.custom?.goals || []
    };

    // Default tool allowlist based on tier label (snapshot at creation).
    const defaultTools = {
      'public': configTiers.public?.allowed_tools || TokenStore.DEFAULT_ALLOWED_TOOLS.public,
      'friends': configTiers.friends?.allowed_tools || TokenStore.DEFAULT_ALLOWED_TOOLS.friends,
      'family': configTiers.family?.allowed_tools || TokenStore.DEFAULT_ALLOWED_TOOLS.family,
      'custom': configTiers.custom?.allowed_tools || TokenStore.DEFAULT_ALLOWED_TOOLS.custom
    };

    // Resolve capabilities: explicit > config > defaults
    const defaultCapabilities = (configTiers[tier]?.capabilities?.length)
      ? configTiers[tier].capabilities
      : (TokenStore.DEFAULT_CAPABILITIES[tier] || ['context-read']);

    // Use separate random ID (not derived from token) to prevent prefix attacks
    const record = {
      id: 'tok_' + crypto.randomBytes(8).toString('hex'),
      token_hash: tokenHash,
      name,
      owner,
      tier,
      capabilities: capabilities || defaultCapabilities,
      allowed_topics: allowedTopics || defaultTopics[tier] || ['chat'],
      allowed_goals: allowedGoals || defaultGoals[tier] || [],
      allowed_tools: allowedTools || defaultTools[tier] || TokenStore.DEFAULT_ALLOWED_TOOLS.public,
      timeout_ms: parsePositiveTimeoutMs(timeoutMs),
      tier_settings: tierSettings || {},  // Snapshot of settings at creation
      notify,
      max_calls: maxCalls,
      calls_made: 0,
      created_at: new Date().toISOString(),
      expires_at: expiresAt,
      revoked: false
    };

    const db = this._load();
    db.tokens.push(record);
    this._save(db);

    return { token, record };
  }

  /**
   * List all tokens (optionally including revoked)
   */
  list(includeRevoked = false) {
    const db = this._load();
    return includeRevoked ? db.tokens : db.tokens.filter(t => !t.revoked);
  }

  /**
   * Find a token by ID prefix
   */
  findById(idPrefix) {
    const db = this._load();
    return db.tokens.find(t => t.id === idPrefix || t.id.startsWith(idPrefix));
  }

  /**
   * Validate an incoming token, returns validation result
   */
  validate(token) {
    const db = this._load();
    const tokenHash = TokenStore.hashToken(token);
    const record = db.tokens.find(t => t.token_hash === tokenHash);

    if (!record) {
      return { valid: false, error: 'token_not_found' };
    }

    if (record.revoked) {
      return { valid: false, error: 'token_revoked' };
    }

    if (record.expires_at && new Date(record.expires_at) < new Date()) {
      return { valid: false, error: 'token_expired' };
    }

    if (record.max_calls && record.calls_made >= record.max_calls) {
      return { valid: false, error: 'max_calls_exceeded' };
    }

    // Increment call count
    record.calls_made++;
    record.last_used = new Date().toISOString();
    this._save(db);

    const tier = record.tier || 'public';
    if (!TokenStore.VALID_TIERS.includes(tier)) {
      return { valid: false, error: 'invalid_token_tier' };
    }

    // Resolve capabilities: stored > defaults
    const capabilities = record.capabilities
      || TokenStore.DEFAULT_CAPABILITIES[tier]
      || ['context-read'];

    const timeoutMs = parsePositiveTimeoutMs(record.timeout_ms)
      || parsePositiveTimeoutMs(record.tier_settings?.timeout_ms)
      || parsePositiveTimeoutMs(record.tier_settings?.timeoutMs);

    return {
      valid: true,
      id: record.id,
      name: record.name,
      tier,
      capabilities,
      allowed_topics: record.allowed_topics || ['chat'],
      allowed_goals: record.allowed_goals || [],
      allowed_tools: record.allowed_tools || TokenStore.DEFAULT_ALLOWED_TOOLS[tier] || TokenStore.DEFAULT_ALLOWED_TOOLS.public,
      timeout_ms: timeoutMs,
      tier_settings: record.tier_settings || {},
      notify: record.notify,
      calls_remaining: record.max_calls ? record.max_calls - record.calls_made : null
    };
  }

  /**
   * Revoke a token by ID
   */
  revoke(idPrefix) {
    const db = this._load();
    const record = db.tokens.find(t => t.id === idPrefix || t.id.startsWith(idPrefix));
    
    if (!record) {
      return { success: false, error: 'not_found' };
    }

    record.revoked = true;
    record.revoked_at = new Date().toISOString();
    this._save(db);

    return { success: true, record };
  }

  /**
   * Add a remote agent endpoint (contact)
   * Note: Token is encrypted at rest using a derived key
   * 
   * @param {string} inviteUrl - a2a://host/token format
   * @param {object} options - Contact metadata
   * @param {string} options.name - Agent name
   * @param {string} options.owner - Human owner name
   * @param {string} options.server_name - Server label (owner-local / optional)
   * @param {string} options.notes - Freeform notes
   * @param {string[]} options.tags - Grouping tags
   * @param {object} options.fields - Flexible CRM-like fields (key/value)
   * @param {string} options.trust - Trust level (trusted, verified, unknown)
   */
	  addContact(inviteUrl, options = {}) {
    const match = String(inviteUrl || '').match(/^a2a:\/\/([^/]+)\/(.+)$/);
    if (!match) {
      throw new Error(`Invalid invite URL: ${inviteUrl}. Expected format: a2a://host/token`);
    }

	    const [, host, token] = match;
	    const agentName = options.name || host;
	    const rawMine = options.is_mine !== undefined ? options.is_mine : options.isMine;
	    const isMine = (() => {
	      if (rawMine === null || rawMine === undefined) return false;
	      if (typeof rawMine === 'boolean') return rawMine;
	      if (typeof rawMine === 'string') {
	        const s = rawMine.trim().toLowerCase();
	        if (['true', '1', 'yes', 'y', 'on'].includes(s)) return true;
	        if (['false', '0', 'no', 'n', 'off', ''].includes(s)) return false;
	      }
	      return Boolean(rawMine);
	    })();

    const db = this._load();

    // Check for duplicate by host + token hash
    const tokenHash = TokenStore.hashToken(token);
    const existing = (db.contacts || []).find(r => r.host === host && r.token_hash === tokenHash);
    if (existing) {
      return { success: false, error: 'duplicate', existing };
    }

    // Encrypt token for storage (simple XOR with derived key - not production-grade but better than plaintext).
    // Keep using the legacy key suffix so older "remotes" records remain decryptable.
    const encryptionKey = crypto.createHash('sha256').update(this.dbPath + TokenStore.LEGACY_REMOTE_KEY_SUFFIX).digest();
    const tokenBuffer = Buffer.from(token, 'utf8');
    const encrypted = Buffer.alloc(tokenBuffer.length);
    for (let i = 0; i < tokenBuffer.length; i++) {
      encrypted[i] = tokenBuffer[i] ^ encryptionKey[i % encryptionKey.length];
    }

	    const contact = {
	      id: crypto.randomBytes(8).toString('hex'),
	      name: agentName,
	      owner: options.owner || null,
	      is_mine: isMine,
	      host,
	      token_hash: tokenHash,
	      token_enc: encrypted.toString('base64'),
	      server_name: options.server_name || options.serverName || null,
	      notes: options.notes || null,
      tags: Array.isArray(options.tags) ? options.tags : [],
      fields: sanitizeCustomFields(options.fields || options.custom_fields || options.customFields),
      linked_token_id: options.linkedTokenId || options.linked_token_id || null,  // Token you gave them
      public_key: options.public_key || options.publicKey || null,  // A2A-52: Ed25519 public key (base64 DER)
      status: 'unknown',
      last_seen: null,
      added_at: new Date().toISOString(),
      updated_at: null
    };

    db.contacts = db.contacts || [];
    db.contacts.push(contact);
    this._save(db);

    return { success: true, contact: { ...contact, token: undefined, token_enc: undefined } };
  }

  // Legacy wrapper.
  addRemote(inviteUrl, options = {}) {
    const result = this.addContact(inviteUrl, options);
    if (!result.success) return result;
    return { success: true, remote: result.contact };
  }

  /**
   * Decrypt a contact token
   */
  _decryptContactToken(contact) {
    if (!contact.token_enc) return null;

    let encrypted;
    try {
      encrypted = Buffer.from(contact.token_enc, 'base64');
    } catch (err) {
      return null;
    }

    // Try legacy key first, then the newer "contact-key" suffix (in case we ever wrote it).
    const suffixes = [
      TokenStore.LEGACY_REMOTE_KEY_SUFFIX,
      TokenStore.CONTACT_KEY_SUFFIX
    ].filter(Boolean);

    for (const suffix of [...new Set(suffixes)]) {
      const encryptionKey = crypto.createHash('sha256').update(this.dbPath + suffix).digest();
      const decrypted = Buffer.alloc(encrypted.length);
      for (let i = 0; i < encrypted.length; i++) {
        decrypted[i] = encrypted[i] ^ encryptionKey[i % encryptionKey.length];
      }
      const token = decrypted.toString('utf8');
      if (/^fed_[A-Za-z0-9_-]{10,}$/.test(token)) {
        return token;
      }
    }

    return null;
  }

  /**
   * List contacts (optionally with linked token info / secrets)
   */
  listContacts(options = {}) {
    const includeLinkedToken = options.includeLinkedToken !== false;
    const includeSecrets = options.includeSecrets === true;
    const db = this._load();

    const contacts = Array.isArray(db.contacts) ? db.contacts : [];
    return contacts.map(row => {
      const base = { ...row };
      if (!includeSecrets) {
        base.token_hash = undefined;
        base.token_enc = undefined;
      }

      if (includeLinkedToken && base.linked_token_id) {
        const token = (db.tokens || []).find(t => t.id === base.linked_token_id);
        if (token) {
          base.linked_token = token;
        }
      }

      return base;
    });
  }

  // Legacy wrapper.
  listRemotes(options = {}) {
    return this.listContacts(options);
  }

  /**
   * Link a token to a contact
   */
  linkTokenToContact(contactNameOrId, tokenId) {
    const db = this._load();
    const remote = (db.contacts || []).find(r =>
      r.name === contactNameOrId || r.id === contactNameOrId
    );
    const token = db.tokens.find(t => 
      t.id === tokenId || t.id.startsWith(tokenId)
    );

    if (!remote) return { success: false, error: 'contact_not_found' };
    if (!token) return { success: false, error: 'token_not_found' };

    remote.linked_token_id = token.id;
    this._save(db);
    return { success: true, contact: remote, remote, token };
  }

  /**
   * Get a contact by name/host/id (with decrypted token)
   */
  getContact(nameOrHost) {
    const db = this._load();
    const remote = (db.contacts || []).find(r =>
      r.name === nameOrHost || 
      r.host === nameOrHost ||
      r.id === nameOrHost
    );
    if (!remote) return null;
    
    // Return with decrypted token
    return {
      ...remote,
      token: this._decryptContactToken(remote),
      token_enc: undefined
    };
  }

  /**
   * Legacy wrapper.
   */
  getRemote(nameOrHost) {
    return this.getContact(nameOrHost);
  }

  /**
   * Update a contact's metadata
   */
	  updateContact(nameOrHost, updates) {
	    const db = this._load();
	    const remote = (db.contacts || []).find(r =>
	      r.name === nameOrHost || 
	      r.host === nameOrHost ||
	      r.id === nameOrHost
	    );
    
    if (!remote) {
      return { success: false, error: 'not_found' };
	    }

	    // Only allow updating specific fields
	    // A2A-52: 'public_key' added for Ed25519 identity verification (TOFU pinning)
	    const allowed = ['name', 'owner', 'is_mine', 'notes', 'tags', 'linked_token_id', 'server_name', 'fields', 'public_key'];
	    for (const key of allowed) {
	      if (updates[key] !== undefined) {
	        if (key === 'fields') {
	          if (updates.fields === null) {
	            remote.fields = {};
	          } else {
	            remote.fields = {
	              ...(remote.fields && typeof remote.fields === 'object' ? remote.fields : {}),
	              ...sanitizeCustomFields(updates.fields)
	            };
	          }
	        } else if (key === 'is_mine') {
	          const raw = updates.is_mine;
	          if (raw === null) {
	            remote.is_mine = false;
	          } else if (typeof raw === 'boolean') {
	            remote.is_mine = raw;
	          } else if (typeof raw === 'string') {
	            const s = raw.trim().toLowerCase();
	            if (['true', '1', 'yes', 'y', 'on'].includes(s)) remote.is_mine = true;
	            else if (['false', '0', 'no', 'n', 'off', ''].includes(s)) remote.is_mine = false;
	            else remote.is_mine = Boolean(raw);
	          } else {
	            remote.is_mine = Boolean(raw);
	          }
	        } else {
	          remote[key] = updates[key];
	        }
	      }
	    }
    remote.updated_at = new Date().toISOString();

    this._save(db);
    return { success: true, contact: remote, remote };
  }

  /**
   * Legacy wrapper.
   */
  updateRemote(nameOrHost, updates) {
    return this.updateContact(nameOrHost, updates);
  }

  /**
   * Update contact status after ping/call
   */
  updateContactStatus(nameOrHost, status, error = null) {
    const db = this._load();
    const remote = (db.contacts || []).find(r =>
      r.name === nameOrHost || 
      r.host === nameOrHost ||
      r.id === nameOrHost
    );
    
    if (!remote) return;

    remote.status = status; // 'online', 'offline', 'error'
    remote.last_seen = status === 'online' ? new Date().toISOString() : remote.last_seen;
    remote.last_error = error;
    remote.last_check = new Date().toISOString();
    
    this._save(db);
  }

  /**
   * Legacy wrapper.
   */
  updateRemoteStatus(nameOrHost, status, error = null) {
    return this.updateContactStatus(nameOrHost, status, error);
  }

  /**
   * Remove a contact
   */
  removeContact(nameOrHost) {
    const db = this._load();
    const idx = (db.contacts || []).findIndex(r =>
      r.name === nameOrHost || 
      r.host === nameOrHost ||
      r.id === nameOrHost
    );
    
    if (idx === -1) {
      return { success: false, error: 'not_found' };
    }

    const [removed] = db.contacts.splice(idx, 1);
    this._save(db);
    return { success: true, contact: removed, remote: removed };
  }

  // Legacy wrapper.
  removeRemote(nameOrHost) {
    return this.removeContact(nameOrHost);
  }

  /**
   * Ensure an inbound caller is present in contacts.
   *
   * Inbound callers authenticate with a token we issued; we usually don't
   * have their endpoint URL, so these records are "placeholders" with:
   * - host: "inbound"
   * - no token stored
   * - linked_token_id: token id used to call us (tok_...)
   *
   * This allows mapping call history (SQLite contact_id=tok_...) to a contact
   * row in the dashboard via linked_token_id.
   */
	  ensureInboundContact(caller, tokenId) {
    if (!caller || !caller.name) {
      return null;
    }

    const name = String(caller.name || '').trim().slice(0, 120);
    const owner = caller.owner ? String(caller.owner).trim().slice(0, 120) : null;

    const db = this._load();
    db.contacts = db.contacts || [];

    // Prefer stable linking by the token used for inbound auth.
    let remote = tokenId
      ? db.contacts.find(r => r.linked_token_id === tokenId)
      : null;

    // Fallback match by agent name/owner (less reliable, but helpful).
    if (!remote) {
      remote = db.contacts.find(r => r.name === name || (owner && r.owner === owner));
    }

	    if (remote) {
	      remote.name = remote.name || name;
	      if (owner && !remote.owner) {
	        remote.owner = owner;
	      }
	      if (remote.is_mine === undefined) {
	        remote.is_mine = false;
	      }
	      if (tokenId && !remote.linked_token_id) {
	        remote.linked_token_id = tokenId;
	      }
      remote.host = remote.host || 'inbound';
      remote.tags = Array.isArray(remote.tags) ? remote.tags : [];
      if (!remote.tags.includes('inbound')) {
        remote.tags.push('inbound');
      }
      remote.fields = remote.fields && typeof remote.fields === 'object' ? remote.fields : {};
      remote.server_name = remote.server_name || null;
      remote.status = remote.status || 'unknown';
      remote.updated_at = new Date().toISOString();
      this._save(db);
      return remote;
    }

	    const contact = {
	      id: crypto.randomBytes(8).toString('hex'),
	      name,
	      owner,
	      is_mine: false,
	      host: 'inbound',
	      token_hash: null,
	      token_enc: null,
	      server_name: null,
      notes: tokenId ? `Inbound caller via token ${tokenId}` : 'Inbound caller',
      tags: ['inbound'],
      fields: {},
      linked_token_id: tokenId || null,
      public_key: null,  // A2A-52: populated via TOFU on first verified call
      status: 'unknown',
      last_seen: null,
      added_at: new Date().toISOString(),
      updated_at: null
    };

    db.contacts.push(contact);
    this._save(db);
    return contact;
  }
}

TokenStore.VALID_TIERS = ['public', 'friends', 'family', 'custom'];
TokenStore.LEGACY_REMOTE_KEY_SUFFIX = 'remote-key';
TokenStore.CONTACT_KEY_SUFFIX = 'contact-key';

// Default capabilities per tier label (used when config has none)
TokenStore.DEFAULT_CAPABILITIES = {
  'public': ['context-read'],
  'friends': ['context-read', 'calendar.read', 'email.read', 'search'],
  'family': ['context-read', 'calendar', 'email', 'search', 'tools', 'memory'],
  'custom': ['context-read']
};

TokenStore.DEFAULT_ALLOWED_TOOLS = {
  'public': ['Read', 'Grep', 'Glob'],
  'friends': ['Bash(readonly)', 'Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'],
  'family': ['Bash', 'Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'],
  'custom': ['Read', 'Grep', 'Glob']
};

module.exports = { TokenStore };
