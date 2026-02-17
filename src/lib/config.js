/**
 * A2A Configuration Management
 * 
 * Stores permission tiers, default settings, and user preferences.
 */

const fs = require('fs');
const path = require('path');
const { createLogger } = require('./logger');

const CONFIG_DIR = process.env.A2A_CONFIG_DIR || 
  process.env.OPENCLAW_CONFIG_DIR || 
  path.join(process.env.HOME || '/tmp', '.config', 'openclaw');

const CONFIG_FILE = path.join(CONFIG_DIR, 'a2a-config.json');
const logger = createLogger({ component: 'a2a.config' });

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function configValidationError(code, message, hint, data) {
  const err = new Error(message);
  err.code = code;
  if (hint) err.hint = hint;
  if (data) err.data = data;
  return err;
}

function sanitizeString(value, maxLength = 200) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function validateStringArray(value, label, options = {}) {
  const maxItems = Number.isFinite(options.maxItems) ? options.maxItems : 200;
  const itemMaxLength = Number.isFinite(options.itemMaxLength) ? options.itemMaxLength : 160;

  if (!Array.isArray(value)) {
    throw configValidationError(
      'A2A_CONFIG_INVALID_ARRAY',
      `Invalid ${label}: expected an array of strings`,
      'Pass an array like ["chat","search"].',
      { label, received_type: typeof value }
    );
  }

  const unique = [];
  const seen = new Set();
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw configValidationError(
        'A2A_CONFIG_INVALID_ARRAY_ITEM',
        `Invalid ${label}: each item must be a string`,
        'Ensure your tier topics/goals are string arrays.',
        { label, received_item_type: typeof entry }
      );
    }
    const cleaned = sanitizeString(entry, itemMaxLength);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(cleaned);
    if (unique.length >= maxItems) break;
  }

  return unique;
}

function validateTierPatch(tierName, tierConfig) {
  if (!isPlainObject(tierConfig)) {
    throw configValidationError(
      'A2A_CONFIG_INVALID_TIER_PATCH',
      `Invalid tier config for "${tierName}": expected an object`,
      'Pass an object like { topics: [...], goals: [...] }.',
      { tier: tierName, received_type: typeof tierConfig }
    );
  }

  const out = {};

  if (tierConfig.name !== undefined) {
    if (typeof tierConfig.name !== 'string') {
      throw configValidationError(
        'A2A_CONFIG_INVALID_TIER_NAME',
        `Invalid tier name for "${tierName}": expected string`,
        null,
        { tier: tierName, received_type: typeof tierConfig.name }
      );
    }
    out.name = sanitizeString(tierConfig.name, 120);
  }

  if (tierConfig.description !== undefined) {
    if (typeof tierConfig.description !== 'string') {
      throw configValidationError(
        'A2A_CONFIG_INVALID_TIER_DESCRIPTION',
        `Invalid tier description for "${tierName}": expected string`,
        null,
        { tier: tierName, received_type: typeof tierConfig.description }
      );
    }
    out.description = sanitizeString(tierConfig.description, 300);
  }

  if (tierConfig.disclosure !== undefined) {
    if (typeof tierConfig.disclosure !== 'string') {
      throw configValidationError(
        'A2A_CONFIG_INVALID_TIER_DISCLOSURE',
        `Invalid tier disclosure for "${tierName}": expected string`,
        null,
        { tier: tierName, received_type: typeof tierConfig.disclosure }
      );
    }
    out.disclosure = sanitizeString(tierConfig.disclosure, 40) || 'minimal';
  }

  if (tierConfig.capabilities !== undefined) {
    out.capabilities = validateStringArray(tierConfig.capabilities, `${tierName}.capabilities`, {
      maxItems: 100,
      itemMaxLength: 120
    });
  }

  if (tierConfig.allowed_tools !== undefined) {
    out.allowed_tools = validateStringArray(tierConfig.allowed_tools, `${tierName}.allowed_tools`, {
      maxItems: 30,
      itemMaxLength: 80
    });
  }

  if (tierConfig.topics !== undefined) {
    out.topics = validateStringArray(tierConfig.topics, `${tierName}.topics`, {
      maxItems: 200,
      itemMaxLength: 160
    });
  }

  if (tierConfig.goals !== undefined) {
    out.goals = validateStringArray(tierConfig.goals, `${tierName}.goals`, {
      maxItems: 200,
      itemMaxLength: 160
    });
  }

  if (tierConfig.examples !== undefined) {
    out.examples = validateStringArray(tierConfig.examples, `${tierName}.examples`, {
      maxItems: 20,
      itemMaxLength: 120
    });
  }

  return out;
}

function deepMerge(base, override) {
  const baseIsObject = base && typeof base === 'object' && !Array.isArray(base);
  const overrideIsObject = override && typeof override === 'object' && !Array.isArray(override);
  if (!overrideIsObject) {
    return override === undefined ? base : override;
  }
  const out = baseIsObject ? { ...base } : {};
  for (const [key, value] of Object.entries(override)) {
    const baseValue = baseIsObject ? base[key] : undefined;
    const bothObjects = baseValue && typeof baseValue === 'object' && !Array.isArray(baseValue) &&
      value && typeof value === 'object' && !Array.isArray(value);
    out[key] = bothObjects ? deepMerge(baseValue, value) : value;
  }
  return out;
}

const DEFAULT_CONFIG = {
  onboarding: {
    version: 2,
    step: 'not_started', // not_started|tiers|ingress|verify|complete
    tiers_confirmed: false,
    ingress_confirmed: false,
    verify_confirmed: false,
    last_run_at: null
  },
  
  // Permission tiers
  tiers: {
    public: {
      name: 'Public',
      description: 'Basic networking - safe for anyone',
      capabilities: ['context-read'],
      allowed_tools: ['Read', 'Grep', 'Glob'],
      topics: ['chat'],
      goals: [],
      disclosure: 'minimal',
      examples: ['calendar availability', 'public social posts', 'general questions']
    },
    friends: {
      name: 'Friends',
      description: 'Most capabilities, no sensitive financial data',
      capabilities: ['context-read', 'calendar.read', 'email.read', 'search'],
      allowed_tools: ['Bash(readonly)', 'Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'],
      topics: ['chat', 'search', 'openclaw', 'a2a'],
      goals: [],
      disclosure: 'public',
      examples: ['email summaries', 'schedule meetings', 'project discussions']
    },
    family: {
      name: 'Family',
      description: 'Full access - only for your inner circle',
      capabilities: ['context-read', 'calendar', 'email', 'search', 'tools', 'memory'],
      allowed_tools: ['Bash', 'Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'],
      topics: ['chat', 'search', 'openclaw', 'a2a', 'tools', 'memory'],
      goals: [],
      disclosure: 'public',
      examples: ['deep collaboration', 'private project context', 'personal notes']
    },
    custom: {
      name: 'Custom',
      description: 'User-defined permissions',
      capabilities: ['context-read'],
      allowed_tools: ['Read', 'Grep', 'Glob'],
      topics: [],
      goals: [],
      disclosure: 'minimal',
      examples: []
    }
  },
  
  // Default token settings
  defaults: {
    expiration: 'never',        // never, 1d, 7d, 30d
    maxCalls: 100,              // per token
    rateLimit: {
      perMinute: 10,
      perHour: 100,
      perDay: 1000
    },
    turnTimeoutMs: 300000,      // default Claude turn timeout
    maxPendingRequests: 5       // max connection requests per hour
  },
  
  // Agent info
  agent: {
    name: '',
    description: '',
    hostname: ''
  },

  // Auto-updater
  auto_update: {
    enabled: true,
    intervalMs: 60 * 60 * 1000,
    allowMajor: false,
    lastGoodVersion: null
  },
  
  // Timestamps
  createdAt: null,
  updatedAt: null
};

class A2AConfig {
  constructor() {
    this._ensureDir();
    this.config = this._load();
  }

  _ensureDir() {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
  }

  _load() {
    if (fs.existsSync(CONFIG_FILE)) {
      try {
        const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        return deepMerge(JSON.parse(JSON.stringify(DEFAULT_CONFIG)), saved);
      } catch (e) {
        logger.error('A2A config is corrupted, using defaults', {
          event: 'a2a_config_corrupt',
          error: e,
          error_code: 'A2A_CONFIG_CORRUPTED',
          hint: 'Fix invalid JSON in a2a-config.json or regenerate it via setup.',
          data: {
            config_file: CONFIG_FILE
          }
        });
        return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
      }
    }
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }

  _save() {
    this.config.updatedAt = new Date().toISOString();
    if (!this.config.createdAt) {
      this.config.createdAt = this.config.updatedAt;
    }
    const tmpPath = `${CONFIG_FILE}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(this.config, null, 2), { mode: 0o600 });
    fs.renameSync(tmpPath, CONFIG_FILE);
    try {
      fs.chmodSync(CONFIG_FILE, 0o600);
    } catch (err) {
      // Best effort - ignore on platforms without chmod support.
    }
  }

  // Check if onboarding is complete
  isOnboarded() {
    return this.config.onboarding &&
      this.config.onboarding.version === 2 &&
      this.config.onboarding.step === 'complete';
  }

  // Mark onboarding complete
  completeOnboarding() {
    this.config.onboarding = this.config.onboarding || {};
    this.config.onboarding.version = 2;
    this.config.onboarding.step = 'complete';
    this.config.onboarding.tiers_confirmed = true;
    this.config.onboarding.ingress_confirmed = true;
    this.config.onboarding.verify_confirmed = true;
    this.config.onboarding.last_run_at = new Date().toISOString();
    this._save();
  }

  // Reset to run onboarding again
  resetOnboarding() {
    this.config.onboarding = this.config.onboarding || {};
    this.config.onboarding.version = 2;
    this.config.onboarding.step = 'not_started';
    this.config.onboarding.tiers_confirmed = false;
    this.config.onboarding.ingress_confirmed = false;
    this.config.onboarding.verify_confirmed = false;
    this.config.onboarding.last_run_at = new Date().toISOString();
    this._save();
  }

  getOnboarding() {
    const ob = (this.config && this.config.onboarding && typeof this.config.onboarding === 'object')
      ? this.config.onboarding
      : {};
    return deepMerge(DEFAULT_CONFIG.onboarding, ob);
  }

  setOnboarding(patch = {}) {
    const current = this.getOnboarding();
    const merged = deepMerge(current, patch);
    merged.version = 2;
    merged.last_run_at = new Date().toISOString();
    this.config.onboarding = merged;
    this._save();
  }

  // Get/set tiers
  getTiers() {
    return this.config.tiers;
  }

  setTier(tierName, tierConfig) {
    const id = String(tierName || '').trim();
    if (!id) {
      throw configValidationError(
        'A2A_CONFIG_INVALID_TIER_ID',
        'Tier name is required',
        'Use one of: public|friends|family|custom (or a non-empty custom tier id).'
      );
    }

    const patch = validateTierPatch(id, tierConfig);
    this.config.tiers = isPlainObject(this.config.tiers) ? this.config.tiers : {};
    const existing = isPlainObject(this.config.tiers[id]) ? this.config.tiers[id] : {};
    this.config.tiers[id] = { ...existing, ...patch };
    this._save();
  }

  // Get/set defaults
  getDefaults() {
    return this.config.defaults;
  }

  setDefaults(defaults) {
    this.config.defaults = { ...this.config.defaults, ...defaults };
    this._save();
  }

  // Get/set agent info
  getAgent() {
    return this.config.agent;
  }

  setAgent(agent) {
    this.config.agent = { ...this.config.agent, ...agent };
    this._save();
  }

  // Get full config
  getAll() {
    return this.config;
  }

  getAutoUpdate() {
    const current = (this.config && typeof this.config.auto_update === 'object' && this.config.auto_update)
      ? this.config.auto_update
      : {};
    return {
      enabled: current.enabled !== false,
      intervalMs: Number.isFinite(current.intervalMs) && current.intervalMs > 0
        ? current.intervalMs
        : DEFAULT_CONFIG.auto_update.intervalMs,
      allowMajor: Boolean(current.allowMajor),
      lastGoodVersion: current.lastGoodVersion || null
    };
  }

  setAutoUpdate(patch = {}) {
    const current = this.getAutoUpdate();
    const next = { ...current };
    if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
    if (patch.intervalMs !== undefined) {
      const parsed = Number.parseInt(String(patch.intervalMs), 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        next.intervalMs = parsed;
      }
    }
    if (patch.allowMajor !== undefined) next.allowMajor = Boolean(patch.allowMajor);
    if (patch.lastGoodVersion !== undefined) {
      next.lastGoodVersion = patch.lastGoodVersion ? String(patch.lastGoodVersion).trim() : null;
    }
    this.config.auto_update = next;
    this._save();
    return next;
  }

  // Export for sharing
  export() {
    return {
      tiers: this.config.tiers,
      defaults: this.config.defaults,
      agent: this.config.agent
    };
  }
}

module.exports = { A2AConfig, DEFAULT_CONFIG, CONFIG_FILE };
