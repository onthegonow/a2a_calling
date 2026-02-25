/**
 * A2A Dashboard Routes
 *
 * Provides a minimal management dashboard for:
 * - contacts and per-contact call summaries
 * - call history with contact context
 * - tier/topic/goal settings management
 * - invite generation and revocation
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { TokenStore } = require('../lib/tokens');
const { ConversationStore } = require('../lib/conversations');
const { A2AClient } = require('../lib/client');
const { A2AConfig } = require('../lib/config');
const { loadManifest, saveManifest } = require('../lib/disclosure');
const { resolveInviteHost } = require('../lib/invite-host');
const { CallbookStore } = require('../lib/callbook');
const { DashboardEventStore } = require('../lib/dashboard-events');
const { createLogger } = require('../lib/logger');

const DASHBOARD_STATIC_DIR = path.join(__dirname, '..', 'dashboard', 'public');

function isLoopbackAddress(ip) {
  if (!ip) return false;
  if (ip === '::1' || ip === '127.0.0.1' || ip === '::ffff:127.0.0.1') {
    return true;
  }
  return ip.startsWith('::ffff:127.');
}

function parseCookieHeader(headerValue) {
  const raw = String(headerValue || '').trim();
  if (!raw) return {};
  const cookies = {};
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function isDirectLocalRequest(req) {
  const ip = (req && req.socket && req.socket.remoteAddress) ? req.socket.remoteAddress : req.ip;
  if (!isLoopbackAddress(ip)) return false;
  const host = String(req.headers.host || '').toLowerCase();
  const isLocalHost = host.startsWith('localhost') ||
    host.startsWith('127.0.0.1') ||
    host.startsWith('[::1]') ||
    host.startsWith('::1');
  if (!isLocalHost) return false;
  // Avoid treating proxy-forwarded traffic as "local".
  const forwarded = req.headers['x-forwarded-for'] ||
    req.headers['x-forwarded-proto'] ||
    req.headers['x-forwarded-host'] ||
    req.headers['cf-connecting-ip'] ||
    req.headers['x-forwarded-by'];
  if (forwarded) return false;
  return true;
}

function isHttpsRequest(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  if (proto === 'https') return true;
  if (req && req.socket && req.socket.encrypted) return true;
  return false;
}

function buildSetCookie(name, value, options = {}) {
  const parts = [];
  parts.push(`${name}=${encodeURIComponent(String(value || ''))}`);
  parts.push('Path=/');
  if (options.httpOnly !== false) parts.push('HttpOnly');
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  if (options.secure) parts.push('Secure');
  if (Number.isFinite(options.maxAgeSeconds)) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`);
  }
  return parts.join('; ');
}

function sanitizeString(value, maxLength = 200) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function parseBoolean(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const s = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(s)) return true;
  if (['false', '0', 'no', 'n', 'off', ''].includes(s)) return false;
  return Boolean(value);
}

function resolveAgentContext(options = {}) {
  const provided = options.agentContext && typeof options.agentContext === 'object' ? options.agentContext : null;
  const name = sanitizeString(
    provided?.name || process.env.A2A_AGENT_NAME || process.env.AGENT_NAME || 'a2a-agent',
    80
  ) || 'a2a-agent';
  const owner = sanitizeString(
    provided?.owner || process.env.A2A_OWNER_NAME || process.env.USER || 'Agent Owner',
    120
  ) || 'Agent Owner';

  return { name, owner };
}

function normalizeTierId(value) {
  return sanitizeString(value, 80)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function sanitizeStringArray(values, maxItems = 100, itemMaxLength = 200) {
  if (!Array.isArray(values)) {
    return [];
  }
  const unique = [];
  const seen = new Set();
  for (const value of values) {
    const item = sanitizeString(value, itemMaxLength);
    if (!item || seen.has(item)) continue;
    seen.add(item);
    unique.push(item);
    if (unique.length >= maxItems) break;
  }
  return unique;
}

function parseTopicObjects(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  const cleaned = [];
  const seen = new Set();
  for (const entry of values) {
    let topic = '';
    let detail = '';

    if (typeof entry === 'string') {
      const parts = entry.split(':');
      topic = sanitizeString(parts[0], 120);
      detail = sanitizeString(parts.slice(1).join(':') || parts[0], 250);
    } else if (entry && typeof entry === 'object') {
      topic = sanitizeString(entry.topic, 120);
      detail = sanitizeString(entry.description || entry.topic, 250);
    }

    if (!topic) continue;
    if (seen.has(topic)) continue;
    seen.add(topic);
    cleaned.push({ topic, description: detail || topic });
    if (cleaned.length >= 100) break;
  }
  return cleaned;
}

function formatInviteMessage({ owner, agentName, inviteUrl, topics, goals, tools, expiresText }) {
  const ownerText = owner || 'Someone';
  const topicsList = topics.length > 0 ? topics.join(' · ') : 'chat';
  const goalsList = (goals || []).join(' · ');
  const toolsList = (tools || []).join(' · ');
  const expirationLine = expiresText === 'never' ? '' : `\n⏰ ${expiresText}`;
  return `📞🗣️ **Agent-to-Agent Call Invite**

👤 **${ownerText}** would like your agent to call **${agentName}** and explore where our owners might collaborate.

💬 ${topicsList}${goalsList ? `\n🎯 ${goalsList}` : ''}
${toolsList ? `\n🧰 ${toolsList}` : ''}

${inviteUrl}${expirationLine}

── setup ──
npm i -g a2acalling && a2a add "${inviteUrl}" "${agentName}" && a2a call "${agentName}" "Hello from my owner!"
https://github.com/onthegonow/a2a_calling`;
}

function buildContext(options = {}) {
  const tokenStore = options.tokenStore || new TokenStore();
  const config = options.config || new A2AConfig();
  const logger = options.logger || createLogger({ component: 'a2a.dashboard' });
  const callbookStore = options.callbookStore || new CallbookStore(tokenStore.configDir);
  const eventStore = options.eventStore || new DashboardEventStore(tokenStore.configDir);
  const agentContext = resolveAgentContext(options);
  let convStore = options.convStore || null;
  if (!convStore) {
    try {
      convStore = new ConversationStore(tokenStore.configDir, { eventStore });
      if (!convStore.isAvailable()) {
        convStore = null;
      }
    } catch (err) {
      convStore = null;
    }
  }

  return {
    tokenStore,
    config,
    convStore,
    callbookStore,
    eventStore,
    getUpdateManager: typeof options.getUpdateManager === 'function'
      ? options.getUpdateManager
      : (() => null),
    logger,
    agentContext,
    staticDir: DASHBOARD_STATIC_DIR
  };
}

function resolveAutoUpdateStatus(context) {
  const manager = context.getUpdateManager ? context.getUpdateManager() : null;
  const config = context.config && typeof context.config.getAutoUpdate === 'function'
    ? context.config.getAutoUpdate()
    : {
      enabled: true,
      intervalMs: 60 * 60 * 1000,
      allowMajor: false,
      lastGoodVersion: null
    };
  const runtime = manager && typeof manager.getStatus === 'function'
    ? manager.getStatus()
    : null;
  return {
    enabled: runtime ? Boolean(runtime.enabled) : Boolean(config.enabled),
    interval_ms: runtime && Number.isFinite(runtime.interval_ms) ? runtime.interval_ms : config.intervalMs,
    allow_major: runtime ? Boolean(runtime.allow_major) : Boolean(config.allowMajor),
    state: runtime ? runtime.state : 'up_to_date',
    current_version: runtime ? runtime.current_version : require('../../package.json').version,
    latest_version: runtime ? runtime.latest_version : null,
    target_version: runtime ? runtime.target_version : null,
    active_calls: runtime ? runtime.active_calls : 0,
    last_checked_at: runtime ? runtime.last_checked_at : null,
    last_success_at: runtime ? runtime.last_success_at : null,
    last_error: runtime ? runtime.last_error : null,
    defer_reason: runtime ? runtime.defer_reason : null,
    last_good_version: config.lastGoodVersion || null
  };
}

function buildContactIndex(contacts) {
  const byName = new Map();
  const byId = new Map();
  const byLinkedTokenId = new Map();

  for (const contact of contacts) {
    const nameKey = sanitizeString(contact.name, 120).toLowerCase();
    if (nameKey) {
      byName.set(nameKey, contact);
    }
    if (contact.id) {
      byId.set(contact.id, contact);
    }
    if (contact.linked_token_id) {
      byLinkedTokenId.set(contact.linked_token_id, contact);
    }
  }

  return { byName, byId, byLinkedTokenId };
}

function resolveConversationContact(conversation, contactIndex) {
  if (!conversation) return null;
  if (conversation.contact_id && contactIndex.byId.has(conversation.contact_id)) {
    return contactIndex.byId.get(conversation.contact_id);
  }
  if (conversation.contact_id && contactIndex.byLinkedTokenId.has(conversation.contact_id)) {
    return contactIndex.byLinkedTokenId.get(conversation.contact_id);
  }
  const nameKey = sanitizeString(conversation.contact_name, 120).toLowerCase();
  if (nameKey && contactIndex.byName.has(nameKey)) {
    return contactIndex.byName.get(nameKey);
  }
  return null;
}

function toDashboardContact(contact) {
  const canCall = Boolean(
    contact &&
    String(contact.host || '').trim() &&
    contact.token_enc &&
    contact.token_hash
  );

  return {
    id: contact.id,
    owner: contact.owner || null,
    name: contact.name || null,
    host: contact.host || null,
    web_address: contact.host || null,
    is_mine: Boolean(contact.is_mine),
    server_name: contact.server_name || null,
    notes: contact.notes || null,
    tags: Array.isArray(contact.tags) ? contact.tags : [],
    fields: (contact.fields && typeof contact.fields === 'object' && !Array.isArray(contact.fields)) ? contact.fields : {},
    linked_token_id: contact.linked_token_id || null,
    status: contact.status || 'unknown',
    last_seen: contact.last_seen || null,
    last_check: contact.last_check || null,
    last_error: contact.last_error || null,
    added_at: contact.added_at || null,
    updated_at: contact.updated_at || null,
    can_call: canCall
  };
}

function makeEnsureDashboardAccess(context) {
  return function ensureDashboardAccess(req, res, next) {
    const adminToken = process.env.A2A_ADMIN_TOKEN;
    const headerToken = req.headers['x-admin-token'];
    const queryToken = req.query?.admin_token;

    if (isDirectLocalRequest(req)) {
      return next();
    }

    if (adminToken && (headerToken === adminToken || queryToken === adminToken)) {
      return next();
    }

    const cookies = parseCookieHeader(req.headers.cookie || '');
    const sessionToken = cookies.a2a_callbook_session || null;
    if (sessionToken && context.callbookStore && context.callbookStore.isAvailable()) {
      const session = context.callbookStore.validateSession(sessionToken);
      if (session && session.valid) {
        req.callbook = session;
        return next();
      }
    }

    const wantsHtml = String(req.headers.accept || '').includes('text/html');
    if (wantsHtml) {
      return res.status(401).send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>A2A Dashboard</title>
  </head>
  <body style="font-family: system-ui, -apple-system, Segoe UI, sans-serif; padding: 2rem;">
    <h1>A2A Dashboard Locked</h1>
    <p>This dashboard requires owner access.</p>
    <ul>
      <li>Local access: open <code>http://127.0.0.1:PORT/dashboard/</code> on the server</li>
      <li>Remote access: generate a Callbook Remote install link on the server, then open it on your Mac</li>
      <li>Break-glass: set <code>A2A_ADMIN_TOKEN</code> and send <code>x-admin-token</code> header</li>
    </ul>
  </body>
</html>`);
    }

    if (!adminToken && !(context.callbookStore && context.callbookStore.isAvailable())) {
      return res.status(401).json({
        success: false,
        error: 'admin_token_required',
        message: 'Set A2A_ADMIN_TOKEN (or enable callbook session storage) to access dashboard from non-local addresses'
      });
    }

    return res.status(401).json({
      success: false,
      error: 'unauthorized',
      message: 'Admin token or callbook session required'
    });
  };
}

function summarizeDebugLogs(logs) {
  if (!Array.isArray(logs) || logs.length === 0) {
    return {
      event_count: 0,
      events: [],
      timestamps: [],
      error_count: 0,
      warning_count: 0
    };
  }

  const normalized = logs.slice().sort((a, b) => {
    const aTime = Number(new Date(a.timestamp));
    const bTime = Number(new Date(b.timestamp));
    if (Number.isNaN(aTime) && Number.isNaN(bTime)) return 0;
    if (Number.isNaN(aTime)) return 1;
    if (Number.isNaN(bTime)) return -1;
    return aTime - bTime;
  });

  const firstTimestamp = normalized[0]?.timestamp || null;
  const lastTimestamp = normalized[normalized.length - 1]?.timestamp || null;
  const firstMs = firstTimestamp ? Number(new Date(firstTimestamp)) : null;
  const lastMs = lastTimestamp ? Number(new Date(lastTimestamp)) : null;

  return {
    event_count: normalized.length,
    events: normalized.map(row => row.event).filter(Boolean),
    timestamps: normalized.map(row => row.timestamp),
    first_seen: firstTimestamp,
    last_seen: lastTimestamp,
    timeline_ms: Number.isFinite(firstMs) && Number.isFinite(lastMs) && lastMs >= firstMs
      ? lastMs - firstMs
      : null,
    trace_ids: [...new Set(normalized.map(row => row.trace_id).filter(Boolean))],
    conversation_ids: [...new Set(normalized.map(row => row.conversation_id).filter(Boolean))],
    token_ids: [...new Set(normalized.map(row => row.token_id).filter(Boolean))],
    request_ids: [...new Set(normalized.map(row => row.request_id).filter(Boolean))],
    error_count: normalized.filter(row => row.level === 'error').length,
    warning_count: normalized.filter(row => row.level === 'warn').length,
    hints: [...new Set(normalized
      .filter(row => row.hint)
      .map(row => String(row.hint)))]
  };
}

function findErrorHints(logs) {
  const hints = new Map();
  for (const row of logs) {
    if (!row.error_code) continue;
    if (!hints.has(row.error_code)) {
      hints.set(row.error_code, {
        error_code: row.error_code,
        status_code: row.status_code,
        count: 0
      });
    }
    const existing = hints.get(row.error_code);
    existing.count += 1;
  }
  return Array.from(hints.values());
}

function createDashboardApiRouter(options = {}) {
  const router = express.Router();
  const context = buildContext(options);
  router.use(express.json());

  // A2A-42: Load E2E persist layer for Health tab. Gracefully null if not available
  // (e.g., installed as npm package without test files).
  let persistModule = null;
  try {
    persistModule = require(path.join(__dirname, '..', '..', 'test', 'e2e', 'persist'));
  } catch {
    // test/e2e/persist.js not available — Health tab will show "no results"
  }

  const ensureDashboardAccess = makeEnsureDashboardAccess(context);
  const writeSseEvent = (res, event) => {
    const eventName = sanitizeString(event?.type || 'message', 80) || 'message';
    const eventId = Number.parseInt(String(event?.id || ''), 10);
    const payload = {
      id: eventId || null,
      type: eventName,
      created_at: event?.created_at || new Date().toISOString(),
      conversation_id: event?.conversation_id || null,
      contact_id: event?.contact_id || null,
      payload: event?.payload || {}
    };
    if (Number.isFinite(eventId) && eventId > 0) {
      res.write(`id: ${eventId}\n`);
    }
    res.write(`event: ${eventName}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  // Callbook Remote: exchange a short-lived provisioning code for a long-lived session cookie.
  // This route must be reachable BEFORE dashboard access is established.
  router.post('/callbook/exchange', (req, res) => {
    const body = req.body || {};
    const code = sanitizeString(body.code || '', 500);
    const label = sanitizeString(body.label || '', 120) || null;

    if (!context.callbookStore || !context.callbookStore.isAvailable()) {
      return res.status(500).json({
        success: false,
        error: 'callbook_storage_unavailable',
        message: 'Callbook session storage is not available on this server.',
        hint: context.callbookStore ? context.callbookStore.getDbError() : 'missing_callbook_store'
      });
    }

    const result = context.callbookStore.exchangeProvisionCode(code, { label });
    if (!result.success) {
      return res.status(401).json({
        success: false,
        error: result.error || 'invalid_code',
        message: 'Callbook install code is invalid, expired, or already used.'
      });
    }

    // "Never expires" in DB; for browsers we set a very long cookie lifetime.
    // (Browsers may still evict cookies; owner can always re-provision.)
    const maxAgeSeconds = 10 * 365 * 24 * 60 * 60; // ~10 years
    const cookie = buildSetCookie('a2a_callbook_session', result.sessionToken, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: isHttpsRequest(req),
      maxAgeSeconds
    });
    res.setHeader('Set-Cookie', cookie);

    if (context.eventStore && context.eventStore.isAvailable()) {
      context.eventStore.emitEvent('invite.used', {
        device_id: result.device?.id || null,
        device_label: result.device?.label || null,
        source: 'callbook_exchange'
      });
    }

    return res.json({
      success: true,
      device: result.device,
      dashboard_path: '/api/a2a/dashboard/'
    });
  });

  // All other dashboard API routes require owner access.
  router.use(ensureDashboardAccess);

  router.get('/events', (req, res) => {
    if (!context.eventStore || !context.eventStore.isAvailable()) {
      return res.status(503).json({
        success: false,
        error: 'event_stream_unavailable',
        message: context.eventStore ? context.eventStore.getDbError() : 'missing_event_store'
      });
    }

    const lastIdHeader = req.headers['last-event-id'];
    const since = sanitizeString(
      req.query.since || lastIdHeader || req.query.last_event_id || '',
      32
    );
    const replayLimit = Math.min(500, Math.max(1, Number.parseInt(req.query.replay || '200', 10) || 200));

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    let lastSentId = Number.parseInt(String(since || '0'), 10);
    if (!Number.isFinite(lastSentId) || lastSentId < 0) {
      lastSentId = 0;
    }

    const pendingLive = [];
    const unsubscribe = context.eventStore.subscribe((event) => {
      if (!event || !Number.isFinite(event.id)) return;
      if (event.id <= lastSentId) return;
      pendingLive.push(event);
    });

    const replay = context.eventStore.listSince(since, { limit: replayLimit });
    for (const row of replay) {
      writeSseEvent(res, row);
      if (Number.isFinite(row.id) && row.id > lastSentId) {
        lastSentId = row.id;
      }
    }
    while (pendingLive.length > 0) {
      const row = pendingLive.shift();
      if (!row || !Number.isFinite(row.id) || row.id <= lastSentId) continue;
      writeSseEvent(res, row);
      lastSentId = row.id;
    }
    res.write(': connected\n\n');

    const liveUnsubscribe = context.eventStore.subscribe((event) => {
      if (!event || !Number.isFinite(event.id) || event.id <= lastSentId) return;
      writeSseEvent(res, event);
      lastSentId = event.id;
    });
    const heartbeat = setInterval(() => {
      res.write(`: heartbeat ${Date.now()}\n\n`);
    }, 15000);

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      liveUnsubscribe();
      res.end();
    });
  });

  router.get('/status', async (req, res) => {
    context.logger.debug('Dashboard status requested', { event: 'dashboard_status' });
    const refreshIp = String(req.query.refresh_ip || 'false') === 'true';
    let resolvedHost = null;
    let warnings = [];
    let inviteResolution = null;
    try {
      // Determine default port based on config hostname:
      // - If hostname has no port (e.g., "149.28.213.47"), assume port 80 (reverse proxy)
      // - If hostname has explicit port, use that
      // - Otherwise fall back to server port or env
      const agent = context.config?.getAgent?.() || {};
      const hostname = agent.hostname || '';
      const hasExplicitPort = hostname.includes(':') && !hostname.startsWith('[');
      let defaultPort;
      if (hasExplicitPort) {
        defaultPort = null; // Will be parsed from hostname
      } else if (hostname && !hostname.includes('localhost')) {
        defaultPort = 80; // External hostname without port = assume reverse proxy on 80
      } else {
        defaultPort = process.env.PORT || process.env.A2A_PORT || 80;
      }
      
      const resolved = await resolveInviteHost({
        config: context.config,
        fallbackHost: req.headers.host || process.env.HOSTNAME || 'localhost',
        defaultPort,
        refreshExternalIp: refreshIp,
        forceRefreshExternalIp: refreshIp,
        alwaysLookupExternalIp: true,
        warnOnExternalIpFailure: refreshIp
      });
      inviteResolution = resolved;
      resolvedHost = resolved.host;
      warnings = resolved.warnings || [];
    } catch (err) {
      // Non-fatal: still return base status.
    }

    const schemeOverride = String(process.env.A2A_PUBLIC_SCHEME || '').trim();
    const inferredScheme = schemeOverride || (isHttpsRequest(req) ? 'https' : 'http');
    const publicBaseUrl = resolvedHost ? `${inferredScheme}://${resolvedHost}` : null;

    const devices = (context.callbookStore && context.callbookStore.isAvailable())
      ? context.callbookStore.listDevices({ includeRevoked: true, limit: 200 }).devices
      : [];

    return res.json({
      success: true,
      dashboard: true,
      conversations_enabled: Boolean(context.convStore),
      agent: {
        name: context.agentContext?.name || null,
        owner_name: context.agentContext?.owner || null,
        server_name: sanitizeString(context.config.getAgent?.().server_name || context.config.getAgent?.().serverName || '', 120) || null
      },
      config_file: require('../lib/config').CONFIG_FILE,
      manifest_file: require('../lib/disclosure').MANIFEST_FILE,
      public_base_url: publicBaseUrl,
      public_dashboard_url: publicBaseUrl ? `${publicBaseUrl}/dashboard/` : null,
      callbook_install_base: publicBaseUrl ? `${publicBaseUrl}/api/a2a/callbook/install` : null,
      invite_host: inviteResolution ? {
        host: inviteResolution.host,
        source: inviteResolution.source || null,
        original_host: inviteResolution.originalHost || null
      } : null,
      external_ip: inviteResolution && inviteResolution.externalIpInfo ? {
        ip: inviteResolution.externalIpInfo.ip || null,
        checked_at: inviteResolution.externalIpInfo.checkedAt || null,
        source: inviteResolution.externalIpInfo.source || null,
        from_cache: Boolean(inviteResolution.externalIpInfo.fromCache),
        stale: Boolean(inviteResolution.externalIpInfo.stale),
        error: inviteResolution.externalIpInfo.error || null,
        attempts: inviteResolution.externalIpInfo.attempts || null
      } : null,
      warnings,
      callbook: {
        enabled: Boolean(context.callbookStore && context.callbookStore.isAvailable()),
        device_count: Array.isArray(devices) ? devices.length : 0
      },
      auto_update: resolveAutoUpdateStatus(context)
    });
  });

  router.get('/update/status', (req, res) => {
    return res.json({
      success: true,
      auto_update: resolveAutoUpdateStatus(context)
    });
  });

  router.post('/update/check', async (req, res) => {
    const manager = context.getUpdateManager ? context.getUpdateManager() : null;
    if (!manager || typeof manager.triggerCheck !== 'function') {
      return res.status(503).json({
        success: false,
        error: 'updater_unavailable',
        message: 'Auto-updater is not initialized for this server.'
      });
    }
    await manager.triggerCheck({ reason: 'dashboard_manual_check', forceCheck: true });
    return res.json({
      success: true,
      auto_update: resolveAutoUpdateStatus(context)
    });
  });

  router.post('/update/now', async (req, res) => {
    const manager = context.getUpdateManager ? context.getUpdateManager() : null;
    if (!manager || typeof manager.triggerUpdate !== 'function') {
      return res.status(503).json({
        success: false,
        error: 'updater_unavailable',
        message: 'Auto-updater is not initialized for this server.'
      });
    }
    const force = parseBoolean(req.body && (req.body.force !== undefined ? req.body.force : req.body.force_update));
    await manager.triggerUpdate({
      reason: 'dashboard_manual_update',
      force
    });
    return res.json({
      success: true,
      auto_update: resolveAutoUpdateStatus(context)
    });
  });

  router.put('/update/config', async (req, res) => {
    const manager = context.getUpdateManager ? context.getUpdateManager() : null;
    const body = req.body || {};
    const enabled = body.enabled !== undefined ? parseBoolean(body.enabled) : undefined;

    if (enabled === undefined) {
      return res.status(400).json({
        success: false,
        error: 'enabled_required',
        message: 'Pass { enabled: true|false }.'
      });
    }

    if (manager && typeof manager.setEnabled === 'function') {
      await manager.setEnabled(enabled);
    } else if (context.config && typeof context.config.setAutoUpdate === 'function') {
      context.config.setAutoUpdate({ enabled });
    }

    return res.json({
      success: true,
      auto_update: resolveAutoUpdateStatus(context)
    });
  });

  // Callbook Remote: create a short-lived install link (24h by default).
  router.post('/callbook/provision', async (req, res) => {
    const body = req.body || {};
    const label = sanitizeString(body.label || 'Callbook Remote', 120) || null;
    const ttlHoursRaw = body.ttl_hours !== undefined ? body.ttl_hours : body.ttlHours;
    const ttlHours = Math.max(1, Math.min(168, Number.parseInt(String(ttlHoursRaw || '24'), 10) || 24));
    const ttlMs = ttlHours * 60 * 60 * 1000;

    if (!context.callbookStore || !context.callbookStore.isAvailable()) {
      return res.status(500).json({
        success: false,
        error: 'callbook_storage_unavailable',
        message: 'Callbook session storage is not available on this server.',
        hint: context.callbookStore ? context.callbookStore.getDbError() : 'missing_callbook_store'
      });
    }

    const created = context.callbookStore.createProvisionCode({ label, ttlMs });
    if (!created.success) {
      return res.status(500).json({
        success: false,
        error: created.error || 'callbook_provision_failed',
        message: created.message || 'Failed to create Callbook Remote install link.'
      });
    }

    let resolvedHost = null;
    let warnings = [];
    try {
      // Use same port logic as /status endpoint
      const agent = context.config?.getAgent?.() || {};
      const hostname = agent.hostname || '';
      const hasExplicitPort = hostname.includes(':') && !hostname.startsWith('[');
      let defaultPort;
      if (hasExplicitPort) {
        defaultPort = null;
      } else if (hostname && !hostname.includes('localhost')) {
        defaultPort = 80;
      } else {
        defaultPort = process.env.PORT || process.env.A2A_PORT || 80;
      }
      
      const resolved = await resolveInviteHost({
        config: context.config,
        fallbackHost: req.headers.host || process.env.HOSTNAME || 'localhost',
        defaultPort,
        refreshExternalIp: true,
        forceRefreshExternalIp: true
      });
      resolvedHost = resolved.host;
      warnings = resolved.warnings || [];
    } catch (err) {
      // Non-fatal: we can still return the code; owner can assemble URL manually.
    }

    const schemeOverride = String(process.env.A2A_PUBLIC_SCHEME || '').trim();
    const scheme = schemeOverride || (isHttpsRequest(req) ? 'https' : 'http');
    const baseUrl = resolvedHost ? `${scheme}://${resolvedHost}` : null;
    const installUrl = baseUrl ? `${baseUrl}/api/a2a/callbook/install#code=${created.code}` : null;

    return res.json({
      success: true,
      install_url: installUrl,
      expires_at: created.record.expires_at,
      token: {
        id: created.record.id,
        label: created.record.label
      },
      warnings
    });
  });

  router.get('/callbook/devices', (req, res) => {
    if (!context.callbookStore || !context.callbookStore.isAvailable()) {
      return res.json({ success: true, devices: [], message: 'Callbook storage not available' });
    }
    const includeRevoked = String(req.query.include_revoked || 'false') === 'true';
    const result = context.callbookStore.listDevices({ includeRevoked, limit: req.query.limit || 200 });
    if (!result.success) {
      return res.status(500).json({ success: false, error: result.error || 'callbook_list_failed', message: result.message });
    }
    return res.json({ success: true, devices: result.devices });
  });

  router.post('/callbook/devices/:deviceId/revoke', (req, res) => {
    if (!context.callbookStore || !context.callbookStore.isAvailable()) {
      return res.status(500).json({ success: false, error: 'callbook_storage_unavailable' });
    }
    const deviceId = sanitizeString(req.params.deviceId, 120);
    const result = context.callbookStore.revokeDevice(deviceId);
    if (!result.success) {
      return res.status(404).json({ success: false, error: result.error || 'device_not_found' });
    }
    return res.json({ success: true, device: result.device });
  });

  router.post('/callbook/logout', (req, res) => {
    const cookie = buildSetCookie('a2a_callbook_session', '', {
      httpOnly: true,
      sameSite: 'Lax',
      secure: isHttpsRequest(req),
      maxAgeSeconds: 0
    });
    res.setHeader('Set-Cookie', cookie);
    return res.json({ success: true });
  });

  router.get('/logs', (req, res) => {
    const limit = Math.min(1000, Math.max(1, Number.parseInt(req.query.limit || '200', 10) || 200));
    const logs = context.logger.list({
      limit,
      level: req.query.level || null,
      component: req.query.component || null,
      event: req.query.event || null,
      errorCode: req.query.error_code || req.query.errorCode || null,
      statusCode: req.query.status_code || req.query.statusCode || null,
      traceId: req.query.trace_id || req.query.traceId || null,
      conversationId: req.query.conversation_id || req.query.conversationId || null,
      tokenId: req.query.token_id || req.query.tokenId || null,
      search: req.query.search || null,
      from: req.query.from || null,
      to: req.query.to || null
    });
    return res.json({ success: true, logs });
  });

  router.get('/logs/trace/:traceId', (req, res) => {
    const traceId = sanitizeString(req.params.traceId, 120);
    if (!traceId) {
      return res.status(400).json({ success: false, error: 'trace_id_required' });
    }
    const limit = Math.min(1000, Math.max(1, Number.parseInt(req.query.limit || '500', 10) || 500));
    const logs = context.logger.getTrace(traceId, { limit });
    return res.json({ success: true, trace_id: traceId, logs });
  });

  router.get('/logs/stats', (req, res) => {
    const stats = context.logger.stats({
      from: req.query.from || null,
      to: req.query.to || null
    });
    return res.json({ success: true, stats });
  });

  // A2A-42: Serve E2E test results for the Health tab.
  // Reads from local persist layer — no external dependencies.
  router.get('/test-results', (req, res) => {
    if (!persistModule) {
      return res.json({
        success: true,
        latest: null,
        history: [],
        has_results: false,
        message: 'Test results module not available'
      });
    }

    const latest = persistModule.getLatest();
    const limit = Math.min(20, Math.max(1, Number.parseInt(req.query.limit || '10', 10) || 10));
    const history = persistModule.getHistory(limit);

    return res.json({
      success: true,
      latest,
      history: history.map(r => ({
        status: r.status,
        duration: r.duration,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        summary: r.summary,
        regression: r.regression || null
      })),
      has_results: latest !== null
    });
  });

  router.get('/debug/call', (req, res) => {
    const traceId = sanitizeString(req.query.trace_id || req.query.traceId || '', 120);
    const conversationId = sanitizeString(req.query.conversation_id || req.query.conversationId || '', 120);
    const limit = Math.min(1000, Math.max(1, Number.parseInt(req.query.limit || '500', 10) || 500));

    if (!traceId && !conversationId) {
      return res.status(400).json({
        success: false,
        error: 'missing_scope',
        message: 'Provide trace_id or conversation_id.'
      });
    }

    const logs = traceId
      ? context.logger.getTrace(traceId, { limit })
      : context.logger.list({
        limit,
        conversationId,
        sort_desc: false
      });

    if (!Array.isArray(logs) || logs.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'no_logs_found',
        message: traceId ? 'No logs for trace_id' : 'No logs for conversation_id'
      });
    }

    const summary = summarizeDebugLogs(logs);
    const errors = logs.filter(row => row.level === 'error' || row.level === 'warn').slice(0, 20);
    const callSignature = {
      trace_ids: summary.trace_ids,
      conversation_ids: summary.conversation_ids,
      token_ids: summary.token_ids,
      request_ids: summary.request_ids
    };

    return res.json({
      success: true,
      summary: {
        ...summary,
        ...callSignature,
        errors: errors.map(row => ({
          id: row.id,
          timestamp: row.timestamp,
          level: row.level,
          event: row.event,
          message: row.message,
          error_code: row.error_code,
          status_code: row.status_code,
          hint: row.hint
        })),
        error_codes: findErrorHints(logs)
      },
      logs: summary.timeline_ms === null ? logs : logs
    });
  });

  router.get('/contacts', (req, res) => {
    const contacts = context.tokenStore.listContacts({ includeLinkedToken: true, includeSecrets: true });
    const contactIndex = buildContactIndex(contacts);
    const conversations = context.convStore
      ? context.convStore.listConversations({
        limit: Number.parseInt(req.query.limit || '500', 10) || 500,
        includeMessages: false
      })
      : [];

    const callMap = new Map();
    for (const contact of contacts) {
      callMap.set(contact.id, []);
    }
    for (const conv of conversations) {
      const contact = resolveConversationContact(conv, contactIndex);
      if (!contact) continue;
      if (!callMap.has(contact.id)) {
        callMap.set(contact.id, []);
      }
      callMap.get(contact.id).push(conv);
    }

    const result = contacts.map(contact => {
      const calls = (callMap.get(contact.id) || []).sort((a, b) => {
        return String(b.last_message_at || '').localeCompare(String(a.last_message_at || ''));
      });
      const latest = calls[0] || null;

      return {
        ...toDashboardContact(contact),
        call_count: calls.length,
        last_call_at: latest?.last_message_at || null,
        last_call_id: latest?.id || null,
        last_summary: latest?.summary || null,
        last_owner_summary: latest?.owner_summary || null
      };
    });

    res.json({ success: true, contacts: result });
  });

  router.post('/contacts', (req, res) => {
    const body = req.body || {};
    const inviteUrl = sanitizeString(
      body.invite_url || body.inviteUrl || body.web_address || body.webAddress || body.url || '',
      600
    );
    const name = sanitizeString(body.name || '', 120) || null;
    const owner = sanitizeString(body.owner || '', 120) || null;
    const isMine = parseBoolean(body.is_mine !== undefined ? body.is_mine : body.isMine);
    const serverName = sanitizeString(body.server_name || body.serverName || '', 120) || null;
    const notes = sanitizeString(body.notes || '', 800) || null;
    const tags = sanitizeStringArray(body.tags || [], 30, 40);
    const fields = (body.fields && typeof body.fields === 'object' && !Array.isArray(body.fields)) ? body.fields : {};

    if (!inviteUrl) {
      return res.status(400).json({ success: false, error: 'invite_url_required' });
    }

    try {
      const result = context.tokenStore.addContact(inviteUrl, {
        name: name || undefined,
        owner: owner || undefined,
        is_mine: isMine,
        server_name: serverName || undefined,
        notes: notes || undefined,
        tags: tags || undefined,
        fields: fields || undefined
      });
      if (!result.success) {
        return res.status(409).json({ success: false, error: result.error || 'contact_add_failed', contact: result.existing || null });
      }
      const stored = context.tokenStore.listContacts({ includeLinkedToken: false, includeSecrets: true })
        .find(c => c.id === result.contact.id);
      return res.json({ success: true, contact: stored ? toDashboardContact(stored) : toDashboardContact(result.contact) });
    } catch (err) {
      return res.status(400).json({
        success: false,
        error: 'invalid_invite_url',
        message: err.message || 'Invalid invite URL'
      });
    }
  });

  router.put('/contacts/:contactId', (req, res) => {
    const contactId = sanitizeString(req.params.contactId, 120);
    if (!contactId) {
      return res.status(400).json({ success: false, error: 'contact_id_required' });
    }

    const body = req.body || {};
    const updates = {};
    if (body.name !== undefined) updates.name = sanitizeString(body.name, 120);
    if (body.owner !== undefined) updates.owner = sanitizeString(body.owner, 120);
    if (body.is_mine !== undefined) updates.is_mine = parseBoolean(body.is_mine);
    if (body.isMine !== undefined) updates.is_mine = parseBoolean(body.isMine);
    if (body.server_name !== undefined) updates.server_name = sanitizeString(body.server_name, 120);
    if (body.serverName !== undefined) updates.server_name = sanitizeString(body.serverName, 120);
    if (body.notes !== undefined) updates.notes = sanitizeString(body.notes, 800);
    if (body.tags !== undefined) updates.tags = sanitizeStringArray(body.tags, 30, 40);
    if (body.fields !== undefined) updates.fields = body.fields;
    if (body.linked_token_id !== undefined) updates.linked_token_id = sanitizeString(body.linked_token_id, 80);
    if (body.linkedTokenId !== undefined) updates.linked_token_id = sanitizeString(body.linkedTokenId, 80);

    const result = context.tokenStore.updateContact(contactId, updates);
    if (!result.success) {
      return res.status(404).json({ success: false, error: result.error || 'contact_not_found' });
    }

    const stored = context.tokenStore.listContacts({ includeLinkedToken: false, includeSecrets: true })
      .find(c => c.id === contactId);
    return res.json({ success: true, contact: stored ? toDashboardContact(stored) : toDashboardContact(result.contact) });
  });

  router.delete('/contacts/:contactId', (req, res) => {
    const contactId = sanitizeString(req.params.contactId, 120);
    if (!contactId) {
      return res.status(400).json({ success: false, error: 'contact_id_required' });
    }

    const result = context.tokenStore.removeContact(contactId);
    if (!result.success) {
      return res.status(404).json({ success: false, error: result.error || 'contact_not_found' });
    }

    return res.json({ success: true, contact: toDashboardContact(result.contact) });
  });

  router.post('/contacts/:contactId/call', async (req, res) => {
    const contactId = sanitizeString(req.params.contactId, 120);
    if (!contactId) {
      return res.status(400).json({ success: false, error: 'contact_id_required' });
    }

    const body = req.body || {};
    const message = sanitizeString(body.message || body.msg || '', 10000);
    const timeoutSeconds = Math.max(5, Math.min(300, Number.parseInt(String(body.timeout_seconds || body.timeoutSeconds || '60'), 10) || 60));
    if (!message) {
      return res.status(400).json({ success: false, error: 'message_required', message: 'Message is required' });
    }

    const contact = context.tokenStore.getContact(contactId);
    if (!contact) {
      return res.status(404).json({ success: false, error: 'contact_not_found' });
    }
    if (!contact.host || !contact.token) {
      return res.status(400).json({ success: false, error: 'contact_not_callable', message: 'This contact has no callable A2A endpoint stored.' });
    }

    const conversationId = ConversationStore.generateConversationId();
    const client = new A2AClient({
      caller: {
        name: context.agentContext?.name || 'Dashboard',
        owner: context.agentContext?.owner || 'Agent Owner',
        instance: context.config.getAgent?.().hostname || null
      }
    });

    // Track in local conversation DB (if enabled).
    if (context.convStore) {
      try {
        context.convStore.startConversation({
          id: conversationId,
          contactId: contact.id,
          contactName: contact.name || contact.host,
          tokenId: null,
          direction: 'outbound'
        });
        context.convStore.addMessage(conversationId, {
          direction: 'outbound',
          role: 'user',
          content: message
        });
      } catch (err) {
        // Best effort; call should still go through.
      }
    }

    const url = `a2a://${contact.host}/${contact.token}`;
    try {
      const result = await client.call(url, message, { conversationId, timeoutSeconds });
      const previousStatus = String(contact.status || '');
      context.tokenStore.updateContactStatus(contact.id, 'online');
      if (context.eventStore && context.eventStore.isAvailable() && previousStatus !== 'online') {
        context.eventStore.emitEvent('contact.status.changed', {
          contact_id: contact.id,
          contact_name: contact.name || contact.host || null,
          previous_status: previousStatus || null,
          status: 'online'
        }, { contactId: contact.id });
      }

      if (context.convStore) {
        try {
          context.convStore.addMessage(conversationId, {
            direction: 'inbound',
            role: 'assistant',
            content: String(result?.response || '')
          });
          // One-shot outbound dashboard calls should be considered concluded.
          await context.convStore.concludeConversation(conversationId, {});
        } catch (err) {
          // ignore
        }
      }

      return res.json({
        success: true,
        conversation_id: conversationId,
        response: result?.response || '',
        remote_trace_id: result?.trace_id || null,
        remote_request_id: result?.request_id || null,
        can_continue: result?.can_continue !== false
      });
    } catch (err) {
      const previousStatus = String(contact.status || '');
      context.tokenStore.updateContactStatus(contact.id, 'offline', err.message);
      if (context.eventStore && context.eventStore.isAvailable() && previousStatus !== 'offline') {
        context.eventStore.emitEvent('contact.status.changed', {
          contact_id: contact.id,
          contact_name: contact.name || contact.host || null,
          previous_status: previousStatus || null,
          status: 'offline',
          reason: err.message || null
        }, { contactId: contact.id });
      }
      return res.status(502).json({
        success: false,
        error: 'contact_call_failed',
        message: err.message || 'Call failed'
      });
    }
  });

  router.get('/contacts/:contactId/calls', (req, res) => {
    if (!context.convStore) {
      return res.json({ success: true, calls: [], message: 'Conversation storage not enabled' });
    }

    const contactId = req.params.contactId;
    const contacts = context.tokenStore.listContacts({ includeLinkedToken: false, includeSecrets: false });
    const contactIndex = buildContactIndex(contacts);
    const contact = contactIndex.byId.get(contactId);
    if (!contact) {
      return res.status(404).json({ success: false, error: 'contact_not_found' });
    }

    const all = context.convStore.listConversations({
      limit: Number.parseInt(req.query.limit || '500', 10) || 500,
      includeMessages: false
    });

    const calls = all
      .filter(conv => {
        const resolved = resolveConversationContact(conv, contactIndex);
        return resolved?.id === contact.id;
      })
      .sort((a, b) => String(b.last_message_at || '').localeCompare(String(a.last_message_at || '')))
      .map(conv => ({
        ...conv,
        contact
      }));

    return res.json({ success: true, contact, calls });
  });

  router.get('/calls', (req, res) => {
    if (!context.convStore) {
      return res.json({ success: true, calls: [], message: 'Conversation storage not enabled' });
    }

    const limit = Number.parseInt(req.query.limit || '100', 10) || 100;
    const status = req.query.status || null;
    const calls = context.convStore.listConversations({
      limit: Math.min(500, Math.max(1, limit)),
      status,
      includeMessages: false
    });

    const contacts = context.tokenStore.listContacts({ includeLinkedToken: false, includeSecrets: false });
    const contactIndex = buildContactIndex(contacts);
    const enriched = calls.map(conv => ({
      ...conv,
      contact: resolveConversationContact(conv, contactIndex)
    }));

    return res.json({ success: true, calls: enriched });
  });

  router.get('/calls/:conversationId', (req, res) => {
    if (!context.convStore) {
      return res.status(404).json({
        success: false,
        error: 'conversation_storage_disabled'
      });
    }

    const conversationId = req.params.conversationId;
    const contextData = context.convStore.getConversationContext(
      conversationId,
      Number.parseInt(req.query.messages || '30', 10) || 30
    );
    if (!contextData) {
      return res.status(404).json({ success: false, error: 'conversation_not_found' });
    }

    const contacts = context.tokenStore.listContacts({ includeLinkedToken: false, includeSecrets: false });
    const contactIndex = buildContactIndex(contacts);
    const contact = resolveConversationContact({
      contact_name: contextData.contact
    }, contactIndex);

    return res.json({ success: true, call: { ...contextData, contact } });
  });

  router.get('/settings', (req, res) => {
    const cfg = context.config.getAll();
    const manifest = loadManifest();
    const configTiers = cfg.tiers || {};
    const manifestTiers = manifest.tiers || {};
    const tierIds = new Set([...Object.keys(configTiers), ...Object.keys(manifestTiers)]);

    const tiers = Array.from(tierIds).sort().map(tierId => {
      const configTier = configTiers[tierId] || {};
      const manifestTier = manifestTiers[tierId] || {};
      return {
        id: tierId,
        name: configTier.name || tierId,
        description: configTier.description || '',
        capabilities: configTier.capabilities || [],
        allowed_tools: sanitizeStringArray(configTier.allowed_tools || [], 30, 80),
        topics: sanitizeStringArray(configTier.topics || []),
        goals: sanitizeStringArray(configTier.goals || []),
        examples: sanitizeStringArray(configTier.examples || [], 20, 120),
        manifest: {
          topics: manifestTier.topics || [],
          objectives: manifestTier.objectives || [],
          do_not_discuss: manifestTier.do_not_discuss || []
        }
      };
    });

    res.json({
      success: true,
      onboarding_complete: context.config.isOnboarded(),
      defaults: cfg.defaults || {},
      agent: (() => { const { private_key, ...pub } = cfg.agent || {}; return pub; })(),
      tiers,
      manifest: {
        never_disclose: manifest.never_disclose || [],
        personality_notes: manifest.personality_notes || '',
        updated_at: manifest.updated_at || null
      }
    });
  });

  router.put('/settings/tiers/:tierId', (req, res) => {
    const tierId = normalizeTierId(req.params.tierId);
    if (!tierId) {
      return res.status(400).json({ success: false, error: 'invalid_tier_id' });
    }

    const body = req.body || {};
    const update = {};
    if (body.name !== undefined) update.name = sanitizeString(body.name, 120);
    if (body.description !== undefined) update.description = sanitizeString(body.description, 300);
    if (body.capabilities !== undefined) update.capabilities = sanitizeStringArray(body.capabilities, 100, 120);
    if (body.allowed_tools !== undefined) update.allowed_tools = sanitizeStringArray(body.allowed_tools, 30, 80);
    if (body.examples !== undefined) update.examples = sanitizeStringArray(body.examples, 20, 120);
    if (body.topics !== undefined) update.topics = sanitizeStringArray(body.topics, 200, 160);
    if (body.goals !== undefined) update.goals = sanitizeStringArray(body.goals, 200, 160);

    try {
      context.config.setTier(tierId, update);
    } catch (err) {
      return res.status(400).json({
        success: false,
        error: 'invalid_tier_config',
        code: err.code || 'A2A_CONFIG_INVALID_TIER_CONFIG',
        message: err.message
      });
    }

    if (body.manifest) {
      const manifest = loadManifest();
      manifest.tiers = manifest.tiers || {};
      manifest.tiers[tierId] = {
        topics: parseTopicObjects(body.manifest.topics),
        objectives: parseTopicObjects(body.manifest.objectives),
        do_not_discuss: parseTopicObjects(body.manifest.do_not_discuss)
      };
      saveManifest(manifest);
    }

    return res.json({ success: true, tier_id: tierId });
  });

  router.post('/settings/tiers', (req, res) => {
    const body = req.body || {};
    const tierId = normalizeTierId(body.id || body.tier_id);
    if (!tierId) {
      return res.status(400).json({ success: false, error: 'tier_id_required' });
    }

    const cfg = context.config.getAll();
    if (cfg.tiers && cfg.tiers[tierId]) {
      return res.status(409).json({ success: false, error: 'tier_exists' });
    }

    const copyFrom = normalizeTierId(body.copy_from || '');
    if (copyFrom && cfg.tiers && cfg.tiers[copyFrom]) {
      try {
        context.config.setTier(tierId, { ...cfg.tiers[copyFrom] });
      } catch (err) {
        return res.status(400).json({
          success: false,
          error: 'invalid_tier_config',
          code: err.code || 'A2A_CONFIG_INVALID_TIER_CONFIG',
          message: err.message
        });
      }
    } else {
      try {
        context.config.setTier(tierId, {
          name: sanitizeString(body.name || tierId, 120),
          description: sanitizeString(body.description || 'Custom tier', 300),
          capabilities: sanitizeStringArray(body.capabilities || []),
          allowed_tools: sanitizeStringArray(body.allowed_tools || [], 30, 80),
          topics: sanitizeStringArray(body.topics || []),
          goals: sanitizeStringArray(body.goals || []),
          examples: sanitizeStringArray(body.examples || [], 20, 120)
        });
      } catch (err) {
        return res.status(400).json({
          success: false,
          error: 'invalid_tier_config',
          code: err.code || 'A2A_CONFIG_INVALID_TIER_CONFIG',
          message: err.message
        });
      }
    }

    return res.json({ success: true, tier_id: tierId });
  });

  router.post('/settings/tiers/:toTier/copy-from/:fromTier', (req, res) => {
    const toTier = normalizeTierId(req.params.toTier);
    const fromTier = normalizeTierId(req.params.fromTier);
    if (!toTier || !fromTier) {
      return res.status(400).json({ success: false, error: 'invalid_tier_ids' });
    }

    const cfg = context.config.getAll();
    if (!cfg.tiers || !cfg.tiers[fromTier]) {
      return res.status(404).json({ success: false, error: 'source_tier_not_found' });
    }

    try {
      context.config.setTier(toTier, { ...cfg.tiers[fromTier] });
    } catch (err) {
      return res.status(400).json({
        success: false,
        error: 'invalid_tier_config',
        code: err.code || 'A2A_CONFIG_INVALID_TIER_CONFIG',
        message: err.message
      });
    }

    const manifest = loadManifest();
    if (manifest.tiers && manifest.tiers[fromTier]) {
      manifest.tiers[toTier] = JSON.parse(JSON.stringify(manifest.tiers[fromTier]));
      saveManifest(manifest);
    }

    return res.json({ success: true, from_tier: fromTier, to_tier: toTier });
  });

  router.put('/settings/defaults', (req, res) => {
    context.config.setDefaults(req.body || {});
    return res.json({ success: true });
  });

  router.put('/settings/agent', (req, res) => {
    context.config.setAgent(req.body || {});
    return res.json({ success: true });
  });

  router.put('/settings/manifest', (req, res) => {
    const body = req.body || {};
    const manifest = loadManifest();
    if (body.never_disclose !== undefined) {
      manifest.never_disclose = sanitizeStringArray(body.never_disclose, 100, 200);
    }
    if (body.personality_notes !== undefined) {
      manifest.personality_notes = sanitizeString(body.personality_notes, 2000);
    }
    saveManifest(manifest);
    return res.json({ success: true });
  });

  router.get('/invites', (req, res) => {
    const includeRevoked = String(req.query.include_revoked || 'false') === 'true';
    const tokens = context.tokenStore.list(includeRevoked);
    return res.json({ success: true, invites: tokens });
  });

  router.post('/invites', async (req, res) => {
    const body = req.body || {};
    const cfg = context.config.getAll();
    const tierId = normalizeTierId(body.tier || body.permissions || 'public') || 'public';
    const tier = (cfg.tiers && cfg.tiers[tierId]) ? cfg.tiers[tierId] : {};

    const name = sanitizeString(body.name || tier.name || 'Agent Invite', 120);
    const owner = sanitizeString(body.owner || '', 120) || null;
    const expires = sanitizeString(body.expires || cfg.defaults?.expiration || '7d', 20);
    const disclosure = sanitizeString(body.disclosure || tier.disclosure || 'minimal', 40);
    const notify = sanitizeString(body.notify || 'all', 20);
    const maxCalls = body.max_calls === null || body.max_calls === 'unlimited'
      ? null
      : Math.max(1, Number.parseInt(body.max_calls || cfg.defaults?.maxCalls || 100, 10) || 100);

    const allowedTopics = sanitizeStringArray(body.topics || tier.topics || []);
    const allowedGoals = sanitizeStringArray(body.goals || tier.goals || []);
    const allowedTools = sanitizeStringArray(body.tools || body.allowed_tools || tier.allowed_tools || [], 30, 80);
    const { token, record } = context.tokenStore.create({
      name,
      owner,
      expires,
      permissions: tierId,
      disclosure,
      notify,
      maxCalls,
      allowedTopics: allowedTopics.length ? allowedTopics : null,
      allowedGoals: allowedGoals.length ? allowedGoals : null,
      allowedTools: allowedTools.length ? allowedTools : null,
      tierSettings: {
        tierId,
        ...tier
      }
    });

    const resolvedHost = await resolveInviteHost({
      config: context.config,
      fallbackHost: req.headers.host || process.env.HOSTNAME || 'localhost',
      defaultPort: process.env.PORT || process.env.A2A_PORT || 3001,
      refreshExternalIp: true
    });
    const host = resolvedHost.host;
    const inviteUrl = `a2a://${host}/${token}`;
    const expiresText = record.expires_at || 'never';
    const message = formatInviteMessage({
      owner,
      agentName: name,
      inviteUrl,
      topics: record.allowed_topics || [],
      goals: record.allowed_goals || [],
      tools: record.allowed_tools || [],
      expiresText
    });

    return res.json({
      success: true,
      invite_url: inviteUrl,
      invite_message: message,
      warnings: resolvedHost.warnings || [],
      token: record
    });
  });

  router.post('/invites/:tokenId/revoke', (req, res) => {
    const tokenId = sanitizeString(req.params.tokenId, 80);
    if (!tokenId) {
      return res.status(400).json({ success: false, error: 'token_id_required' });
    }

    const result = context.tokenStore.revoke(tokenId);
    if (!result.success) {
      return res.status(404).json({ success: false, error: result.error || 'token_not_found' });
    }

    return res.json({ success: true, token: result.record });
  });

  return router;
}

function createDashboardUiRouter(options = {}) {
  const router = express.Router();
  const context = buildContext(options);
  const ensureDashboardAccess = makeEnsureDashboardAccess(context);
  router.use(ensureDashboardAccess);

  router.use((req, res, next) => {
    const rawPath = String(req.originalUrl || '').split('?')[0];
    if (rawPath === req.baseUrl) {
      return res.redirect(302, `${req.baseUrl}/`);
    }
    return next();
  });

  router.get('/', (req, res) => {
    const indexPath = path.join(context.staticDir, 'index.html');
    if (!fs.existsSync(indexPath)) {
      return res.status(500).send('Dashboard UI missing');
    }
    return res.sendFile(indexPath);
  });

  router.use(express.static(context.staticDir, { index: false }));
  return router;
}

module.exports = {
  createDashboardApiRouter,
  createDashboardUiRouter,
  DASHBOARD_STATIC_DIR
};
