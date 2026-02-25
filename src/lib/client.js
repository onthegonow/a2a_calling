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

/**
 * A2A-54: Retry wrapper for transient network failures.
 * Only retries on RETRYABLE_CODES and timeout errors — HTTP status errors
 * bubble up immediately since the remote explicitly rejected the request.
 *
 * @param {Function} fn - async function to retry
 * @param {object} options
 * @param {number[]} options.delays - delay sequence in ms (default: RETRY_DELAYS)
 * @returns {Promise<*>}
 */
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

/**
 * A2A-54: Create a size-capped response handler.
 * Tracks accumulated bytes and destroys the socket if the cap is exceeded,
 * preventing OOM from malicious or misconfigured remote agents.
 *
 * @param {http.IncomingMessage} res - the response stream
 * @param {Function} resolve - promise resolve
 * @param {Function} reject - promise reject
 * @param {Function} onComplete - called with (data, statusCode) when response ends within cap
 */
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

  /**
   * A2A-52: Build signature headers if keypair is available.
   * Shared helper used by both call() and end().
   */
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

  /**
   * Parse an a2a:// URL
   */
  static parseInvite(inviteUrl) {
    const match = inviteUrl.match(/^a2a:\/\/([^/]+)\/(.+)$/);
    if (!match) {
      throw new Error(`Invalid invite URL: ${inviteUrl}`);
    }
    return { host: match[1], token: match[2] };
  }

  /**
   * Call a remote agent
   *
   * @param {string|object} endpoint - a2a:// URL or {host, token}
   * @param {string} message - Message to send
   * @param {object} options - Additional options
   * @returns {Promise<object>} Response from remote agent
   */
  async call(endpoint, message, options = {}) {
    let host, token;

    if (typeof endpoint === 'string') {
      ({ host, token } = A2AClient.parseInvite(endpoint));
    } else {
      ({ host, token } = endpoint);
    }

    const { conversationId, context, timeoutSeconds } = options;

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

  /**
   * Explicitly end a remote conversation and trigger call conclusion
   *
   * @param {string|object} endpoint - a2a:// URL or {host, token}
   * @param {string} conversationId - Conversation ID to conclude
   * @returns {Promise<object>} End response from remote agent
   */
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

  /**
   * Check if a remote agent is available
   */
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

  /**
   * Get A2A status of a remote
   */
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
module.exports = {
  A2AClient,
  A2AError,
  _splitHostPort: splitHostPort,
  _resolveProtocolAndPort: resolveProtocolAndPort,
  _MAX_RESPONSE_BYTES: MAX_RESPONSE_BYTES,
  _RETRYABLE_CODES: RETRYABLE_CODES,
  _RETRY_DELAYS: RETRY_DELAYS
};
