/**
 * A2A Client - Make calls to remote agents
 */

const https = require('https');
const http = require('http');
const { signRequest } = require('./crypto');

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

class A2AClient {
  constructor(options = {}) {
    this.timeout = options.timeout || 60000;
    this.caller = options.caller || {};
    // A2A-52: Ed25519 identity keys for request signing
    this.privateKey = options.privateKey || null;
    this.publicKey = options.publicKey || null;
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

    return new Promise((resolve, reject) => {
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
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (res.statusCode >= 400) {
              reject(new A2AError(json.error || 'request_failed', json.message || data, res.statusCode));
            } else {
              resolve(json);
            }
          } catch (e) {
            reject(new A2AError('parse_error', `Failed to parse response: ${data}`, res.statusCode));
          }
        });
      });

      req.on('error', (e) => {
        reject(new A2AError('network_error', e.message));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new A2AError('timeout', 'Request timed out'));
      });

      req.write(body);
      req.end();
    });
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

    return new Promise((resolve, reject) => {
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
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (res.statusCode >= 400) {
              reject(new A2AError(json.error || 'request_failed', json.message || data, res.statusCode));
            } else {
              resolve(json);
            }
          } catch (e) {
            reject(new A2AError('parse_error', `Failed to parse response: ${data}`, res.statusCode));
          }
        });
      });

      req.on('error', (e) => {
        reject(new A2AError('network_error', e.message));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new A2AError('timeout', 'Request timed out'));
      });

      req.write(body);
      req.end();
    });
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

    return new Promise((resolve, reject) => {
      const req = protocol.request({
        hostname,
        port,
        path: '/api/a2a/ping',
        method: 'GET',
        timeout: 5000
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve({ pong: res.statusCode === 200 });
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

    return new Promise((resolve, reject) => {
      const req = protocol.request({
        hostname,
        port,
        path: '/api/a2a/status',
        method: 'GET',
        timeout: 5000
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new A2AError('parse_error', 'Invalid status response'));
          }
        });
      });

      req.on('error', (e) => reject(new A2AError('network_error', e.message)));
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

module.exports = { A2AClient, A2AError };
