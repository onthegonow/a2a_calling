/**
 * A2A Client - Make calls to remote agents
 */

const https = require('https');
const http = require('http');
const { signRequest } = require('./crypto');
// A2A-54: structured logging for retry warnings and size-cap violations
const { createLogger } = require('./logger');

const logger = createLogger({ component: 'a2a.client' });

// A2A-54: response size cap prevents OOM from unbounded accumulation
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

// A2A-54: only transient network errors are retryable — HTTP 4xx/5xx are not
const RETRYABLE_CODES = ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN'];

// A2A-54: exponential backoff — first retry is immediate, then 1s, then 2s
const RETRY_DELAYS = [0, 1000, 2000];

// A2A-80: Agent Card cache — module-level Map with TTL and prune-on-access
// Each entry: { card: object|null, cachedAt: number }
// null card = negative cache (failed fetch)
const _agentCardCache = new Map();

function _readPositiveIntEnv(name, defaultVal) {
  const raw = process.env[name];
  if (!raw) return defaultVal;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : defaultVal;
}

const AGENT_CARD_TTL_MS = _readPositiveIntEnv('A2A_AGENT_CARD_TTL_MS', 300000);
const AGENT_CARD_MAX_ENTRIES = _readPositiveIntEnv('A2A_AGENT_CARD_MAX_ENTRIES', 200);
const AGENT_CARD_FETCH_TIMEOUT_MS = 3000;

// A2A-80: Prune-on-access eviction (pattern from A2A-69, NOT imported)
function _pruneAgentCardCache() {
  const now = Date.now();
  for (const [key, entry] of _agentCardCache.entries()) {
    if (now - entry.cachedAt > AGENT_CARD_TTL_MS) {
      _agentCardCache.delete(key);
    }
  }

  if (_agentCardCache.size <= AGENT_CARD_MAX_ENTRIES) {
    return;
  }

  const oldest = Array.from(_agentCardCache.entries())
    .sort((a, b) => a[1].cachedAt - b[1].cachedAt);
  const toDelete = _agentCardCache.size - AGENT_CARD_MAX_ENTRIES;
  for (let i = 0; i < toDelete; i++) {
    _agentCardCache.delete(oldest[i][0]);
  }
}

// A2A-80: Cache key is always hostname:port
function _agentCardCacheKey(host) {
  const parsed = splitHostPort(host);
  const hostname = parsed.hostname;
  const port = Number.isFinite(parsed.port) ? parsed.port : 80;
  return `${hostname}:${port}`;
}

// A2A-80: Validate Agent Card — needs non-empty interfaces[] with { type: 'rest' }
function _parseAgentCard(json) {
  if (!json || typeof json !== 'object') return null;
  if (!Array.isArray(json.interfaces) || json.interfaces.length === 0) return null;

  const restInterface = json.interfaces.find(
    iface => iface && iface.type === 'rest'
  );
  if (!restInterface) return null;

  return json;
}

// A2A-80: Fetch Agent Card (GET /.well-known/a2a-agent-card, 3s timeout, cached with TTL).
// TODO: Concurrent call() to same uncached host may duplicate Agent Card fetches.
function fetchRemoteAgentCard(host) {
  _pruneAgentCardCache();

  const cacheKey = _agentCardCacheKey(host);
  const cached = _agentCardCache.get(cacheKey);
  if (cached) {
    return Promise.resolve(cached.card);
  }

  const { protocol, hostname, port } = resolveProtocolAndPort(host);

  return new Promise((resolve) => {
    const req = protocol.request({
      hostname,
      port,
      path: '/.well-known/a2a-agent-card',
      method: 'GET',
      timeout: AGENT_CARD_FETCH_TIMEOUT_MS
    }, (res) => {
      let data = '';
      let bytes = 0;
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          res.destroy();
          _agentCardCache.set(cacheKey, { card: null, cachedAt: Date.now() });
          resolve(null);
          return;
        }
        data += chunk;
      });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          _agentCardCache.set(cacheKey, { card: null, cachedAt: Date.now() });
          resolve(null);
          return;
        }
        try {
          const json = JSON.parse(data);
          const card = _parseAgentCard(json);
          _agentCardCache.set(cacheKey, { card, cachedAt: Date.now() });
          resolve(card);
        } catch {
          _agentCardCache.set(cacheKey, { card: null, cachedAt: Date.now() });
          resolve(null);
        }
      });
    });

    req.on('error', () => {
      _agentCardCache.set(cacheKey, { card: null, cachedAt: Date.now() });
      resolve(null);
    });
    req.on('timeout', () => {
      req.destroy();
      _agentCardCache.set(cacheKey, { card: null, cachedAt: Date.now() });
      resolve(null);
    });
    req.end();
  });
}

// A2A-80: Build Google A2A message/send body (ref: a2a.js translateInternalToGoogle)
function _translateToGoogleRequest(message, conversationId, options = {}, caller = {}) {
  return {
    message: {
      role: 'user',
      parts: [{ content: { text: message } }],
      ...(conversationId ? { context_id: conversationId } : {})
    },
    metadata: {
      caller_name: String(caller.name || '').slice(0, 100),
      caller_owner: String(caller.owner || '').slice(0, 100),
      caller_instance: String(caller.instance || '').slice(0, 200)
    },
    configuration: {
      timeout_seconds: options.timeoutSeconds || 60,
      blocking: true
    }
  };
}

// A2A-80: Translate Google A2A Task response to internal format (ref: a2a.js translateGoogleToInternal)
function _translateGoogleResponse(taskResponse) {
  const task = taskResponse?.task;
  if (!task || !task.status) {
    throw new A2AError('google_a2a_error', 'Invalid Google A2A response: missing task or status');
  }

  const parts = task.status.message?.parts || [];
  const textParts = [];
  for (const part of parts) {
    if (part?.content && typeof part.content.text === 'string') {
      textParts.push(part.content.text);
    }
  }

  const response = textParts.join('\n');
  const state = task.status.state;
  const canContinue = state === 'input-required';

  return {
    response,
    conversation_id: task.context_id || null,
    can_continue: canContinue
  };
}

// A2A-80: Resolve message:send URL from Agent Card REST interface (trailing slash stripped)
function _resolveGoogleA2AUrl(agentCard, host) {
  const restInterface = agentCard.interfaces.find(
    iface => iface && iface.type === 'rest'
  );

  if (restInterface && restInterface.url) {
    const baseUrl = restInterface.url.replace(/\/+$/, '');
    return `${baseUrl}/message:send`;
  }

  // Fallback: build from host
  const { hostname, port } = splitHostPort(host);
  const effectivePort = Number.isFinite(port) ? port : 80;
  const isLocalhost = hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname.startsWith('127.');
  const scheme = (isLocalhost || effectivePort === 80 || (Number.isFinite(port) && port !== 443))
    ? 'http' : 'https';
  return `${scheme}://${hostname}:${effectivePort}/message:send`;
}

// A2A-54: Retry on transient network errors only (not HTTP 4xx/5xx)
async function withRetry(fn, options = {}) {
  const delays = options.delays || RETRY_DELAYS;
  const maxAttempts = delays.length + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      // A2A-54: only retry transient network errors and timeouts.
      // HTTP 4xx/5xx errors have err.code set to the server's error code
      // (e.g. 'bad_request'), so they won't match network_error or timeout.
      const isRetryable = err instanceof A2AError && (
        (err.code === 'network_error' && RETRYABLE_CODES.some(c => err.message.includes(c))) ||
        err.code === 'timeout'
      );

      if (!isRetryable || attempt >= maxAttempts) {
        throw err;
      }

      // A2A-54: log each retry at warn level for operator visibility
      const delay = delays[attempt - 1];
      logger.warn(`Retrying request (attempt ${attempt + 1}/${maxAttempts})`, {
        event: 'retry',
        data: {
          error_code: err.code,
          error_message: err.message,
          attempt: attempt + 1,
          delay_ms: delay
        }
      });

      if (delay > 0) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
}

function splitHostPort(rawHost) {
  const host = String(rawHost || '').trim();
  if (!host) return { hostname: '', port: null };

  // IPv6 in brackets: [::1]:3001
  const bracketed = host.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracketed) {
    return {
      hostname: bracketed[1],
      port: bracketed[2] ? Number.parseInt(bracketed[2], 10) : null
    };
  }

  // Only treat the last ":" as a port separator when there's exactly one colon.
  const lastColon = host.lastIndexOf(':');
  if (lastColon !== -1 && host.indexOf(':') === lastColon) {
    const maybePort = host.slice(lastColon + 1);
    if (/^\d+$/.test(maybePort)) {
      return {
        hostname: host.slice(0, lastColon),
        port: Number.parseInt(maybePort, 10)
      };
    }
  }

  return { hostname: host, port: null };
}

function resolveProtocolAndPort(host) {
  const parsed = splitHostPort(host);
  const hostname = parsed.hostname;
  const hasExplicitPort = Number.isFinite(parsed.port);
  const isLocalhost = hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname.startsWith('127.');

  const port = hasExplicitPort ? parsed.port : 80;
  // Use HTTP for localhost or explicit non-443 ports, HTTPS otherwise.
  const useHttp = isLocalhost || port === 80 || (hasExplicitPort && port !== 443);
  const protocol = useHttp ? http : https;

  return { protocol, hostname, port };
}

// A2A-54: Size-capped response handler — destroys socket if cap exceeded
function handleSizeCappedResponse(res, resolve, reject, onComplete) {
  let data = '';
  let bytes = 0;
  let destroyed = false;

  res.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > MAX_RESPONSE_BYTES) {
      if (!destroyed) {
        destroyed = true;
        res.destroy();
        // A2A-54: reject immediately — the remote sent more data than we allow
        reject(new A2AError('response_too_large', `Response exceeded ${MAX_RESPONSE_BYTES} bytes`));
      }
      return;
    }
    data += chunk;
  });

  res.on('end', () => {
    if (destroyed) return;
    onComplete(data, res.statusCode);
  });
}

class A2AClient {
  constructor(options = {}) {
    this.timeout = options.timeout || 60000;
    this.caller = options.caller || {};
    // A2A-52: Ed25519 identity keys for request signing
    this.privateKey = options.privateKey || null;
    this.publicKey = options.publicKey || null;
    // A2A-54: allow configurable retry delays for testing (fast tests use [0,0,0])
    this._retryDelays = options._retryDelays || RETRY_DELAYS;
  }

  // A2A-52: Build signature headers if keypair available
  _signHeaders(method, endpoint, body) {
    if (!this.privateKey || !this.publicKey) return {};
    return signRequest({
      privateKey: this.privateKey,
      publicKey: this.publicKey,
      method,
      endpoint,
      body
    });
  }

  static parseInvite(inviteUrl) {
    const match = inviteUrl.match(/^a2a:\/\/([^/]+)\/(.+)$/);
    if (!match) {
      throw new Error(`Invalid invite URL: ${inviteUrl}`);
    }
    return { host: match[1], token: match[2] };
  }

  // A2A-80: Send message via Google A2A protocol (message/send format)
  _callGoogleA2A(host, token, body, agentCard) {
    const url = _resolveGoogleA2AUrl(agentCard, host);
    // Parse the URL to extract components for http/https request
    const parsed = new URL(url);
    const proto = parsed.protocol === 'https:' ? https : http;
    const path = parsed.pathname;

    // A2A-52: attach signature headers when keypair available
    const sigHeaders = this._signHeaders('POST', path, body);

    const makeRequest = () => new Promise((resolve, reject) => {
      const req = proto.request({
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...sigHeaders
        },
        timeout: this.timeout
      }, (res) => {
        handleSizeCappedResponse(res, resolve, reject, (data, statusCode) => {
          try {
            const json = JSON.parse(data);
            if (statusCode >= 400) {
              // A2A-80: map Google A2A error format to A2AError
              const errObj = json.error || {};
              const code = errObj.code || json.error || 'google_a2a_error';
              const message = errObj.message || json.message || data;
              reject(new A2AError(String(code), message, statusCode));
            } else {
              resolve(_translateGoogleResponse(json));
            }
          } catch (e) {
            if (e instanceof A2AError) {
              reject(e);
            } else {
              reject(new A2AError('parse_error', `Failed to parse Google A2A response: ${data}`, statusCode));
            }
          }
        });
      });

      req.on('error', (e) => {
        reject(new A2AError('network_error', e.code ? `${e.code}: ${e.message}` : e.message));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new A2AError('timeout', 'Request timed out'));
      });

      req.write(body);
      req.end();
    });

    return withRetry(makeRequest, { delays: this._retryDelays });
  }

  // Call a remote agent — auto-detects Google A2A via Agent Card
  async call(endpoint, message, options = {}) {
    let host, token;

    if (typeof endpoint === 'string') {
      ({ host, token } = A2AClient.parseInvite(endpoint));
    } else {
      ({ host, token } = endpoint);
    }

    const { conversationId, context, timeoutSeconds } = options;

    // A2A-80: check Agent Card to decide Google A2A vs proprietary format
    const agentCard = await fetchRemoteAgentCard(host);

    if (agentCard) {
      // Google A2A format path
      const googleBody = JSON.stringify(
        _translateToGoogleRequest(message, conversationId, { timeoutSeconds }, this.caller)
      );
      return this._callGoogleA2A(host, token, googleBody, agentCard);
    }

    // Proprietary format path (unchanged)
    const body = JSON.stringify({
      message,
      conversation_id: conversationId,
      caller: this.caller,
      context,
      timeout_seconds: timeoutSeconds || 60
    });

    const { protocol, hostname, port } = resolveProtocolAndPort(host);
    // A2A-52: attach signature headers when keypair available
    const sigHeaders = this._signHeaders('POST', '/api/a2a/invoke', body);

    // A2A-54: wrap with retry for transient network failures
    const makeRequest = () => new Promise((resolve, reject) => {
      const req = protocol.request({
        hostname,
        port,
        path: '/api/a2a/invoke',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...sigHeaders
        },
        timeout: this.timeout
      }, (res) => {
        // A2A-54: size-capped response accumulation
        handleSizeCappedResponse(res, resolve, reject, (data, statusCode) => {
          try {
            const json = JSON.parse(data);
            if (statusCode >= 400) {
              reject(new A2AError(json.error || 'request_failed', json.message || data, statusCode));
            } else {
              resolve(json);
            }
          } catch (e) {
            reject(new A2AError('parse_error', `Failed to parse response: ${data}`, statusCode));
          }
        });
      });

      req.on('error', (e) => {
        reject(new A2AError('network_error', e.code ? `${e.code}: ${e.message}` : e.message));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new A2AError('timeout', 'Request timed out'));
      });

      req.write(body);
      req.end();
    });

    return withRetry(makeRequest, { delays: this._retryDelays });
  }

  // End a remote conversation — no-op for Google A2A remotes
  async end(endpoint, conversationId) {
    if (!conversationId) {
      throw new A2AError('missing_conversation_id', 'conversationId is required');
    }

    let host, token;

    if (typeof endpoint === 'string') {
      ({ host, token } = A2AClient.parseInvite(endpoint));
    } else {
      ({ host, token } = endpoint);
    }

    // A2A-80: Google A2A remotes don't have an end endpoint — return synthetic response
    const agentCard = await fetchRemoteAgentCard(host);
    if (agentCard) {
      logger.info('Skipping end() for Google A2A remote', {
        event: 'google_a2a_end_skipped',
        data: { conversationId, host }
      });
      return { ended: true, summary: null };
    }

    // Proprietary format path (unchanged)
    const body = JSON.stringify({
      conversation_id: conversationId
    });

    const { protocol, hostname, port } = resolveProtocolAndPort(host);
    // A2A-52: attach signature headers when keypair available
    const sigHeaders = this._signHeaders('POST', '/api/a2a/end', body);

    // A2A-54: wrap with retry for transient network failures
    const makeRequest = () => new Promise((resolve, reject) => {
      const req = protocol.request({
        hostname,
        port,
        path: '/api/a2a/end',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...sigHeaders
        },
        timeout: this.timeout
      }, (res) => {
        // A2A-54: size-capped response accumulation
        handleSizeCappedResponse(res, resolve, reject, (data, statusCode) => {
          try {
            const json = JSON.parse(data);
            if (statusCode >= 400) {
              reject(new A2AError(json.error || 'request_failed', json.message || data, statusCode));
            } else {
              resolve(json);
            }
          } catch (e) {
            reject(new A2AError('parse_error', `Failed to parse response: ${data}`, statusCode));
          }
        });
      });

      req.on('error', (e) => {
        reject(new A2AError('network_error', e.code ? `${e.code}: ${e.message}` : e.message));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new A2AError('timeout', 'Request timed out'));
      });

      req.write(body);
      req.end();
    });

    return withRetry(makeRequest, { delays: this._retryDelays });
  }

  async ping(endpoint) {
    let host;

    if (typeof endpoint === 'string') {
      ({ host } = A2AClient.parseInvite(endpoint));
    } else {
      ({ host } = endpoint);
    }

    const { protocol, hostname, port } = resolveProtocolAndPort(host);

    // A2A-54: no retry for ping — it's a lightweight probe, not a critical call
    return new Promise((resolve, reject) => {
      const req = protocol.request({
        hostname,
        port,
        path: '/api/a2a/ping',
        method: 'GET',
        timeout: 5000
      }, (res) => {
        // A2A-54: size-capped response accumulation
        handleSizeCappedResponse(res, resolve, reject, (data, statusCode) => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve({ pong: statusCode === 200 });
          }
        });
      });

      req.on('error', () => resolve({ pong: false }));
      req.on('timeout', () => {
        req.destroy();
        resolve({ pong: false });
      });
      req.end();
    });
  }

  async status(endpoint) {
    let host;

    if (typeof endpoint === 'string') {
      ({ host } = A2AClient.parseInvite(endpoint));
    } else {
      ({ host } = endpoint);
    }

    const { protocol, hostname, port } = resolveProtocolAndPort(host);

    // A2A-54: no retry for status — read-only probe, not a stateful operation
    return new Promise((resolve, reject) => {
      const req = protocol.request({
        hostname,
        port,
        path: '/api/a2a/status',
        method: 'GET',
        timeout: 5000
      }, (res) => {
        // A2A-54: size-capped response accumulation
        handleSizeCappedResponse(res, resolve, reject, (data) => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new A2AError('parse_error', 'Invalid status response'));
          }
        });
      });

      req.on('error', (e) => reject(new A2AError('network_error', e.code ? `${e.code}: ${e.message}` : e.message)));
      req.on('timeout', () => {
        req.destroy();
        reject(new A2AError('timeout', 'Request timed out'));
      });
      req.end();
    });
  }
}

class A2AError extends Error {
  constructor(code, message, statusCode = null) {
    super(message);
    this.name = 'A2AError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

// A2A-54: export internals for testing (splitHostPort, resolveProtocolAndPort, constants)
// A2A-80: export Agent Card cache and helpers for testing
module.exports = {
  A2AClient,
  A2AError,
  _splitHostPort: splitHostPort,
  _resolveProtocolAndPort: resolveProtocolAndPort,
  _MAX_RESPONSE_BYTES: MAX_RESPONSE_BYTES,
  _RETRYABLE_CODES: RETRYABLE_CODES,
  _RETRY_DELAYS: RETRY_DELAYS,
  _agentCardCache,
  _parseAgentCard,
  _translateToGoogleRequest,
  _translateGoogleResponse,
  _resolveGoogleA2AUrl,
  fetchRemoteAgentCard
};
