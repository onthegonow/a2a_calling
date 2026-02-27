/**
 * Local Request Detection Utilities
 *
 * A2A-73: Extracted from dashboard.js and a2a.js to provide a single,
 * proxy-aware implementation of local request detection. The previous
 * isLoopbackAddress(req.ip) check was insufficient behind reverse proxies
 * because Express (without trust proxy) reports the proxy's IP, not the
 * real client IP.
 */

'use strict';

/**
 * Check if an IP address is a loopback address.
 * Handles IPv4, IPv6, and IPv4-mapped IPv6 formats.
 */
function isLoopbackAddress(ip) {
  if (!ip) return false;
  if (ip === '::1' || ip === '127.0.0.1' || ip === '::ffff:127.0.0.1') {
    return true;
  }
  return ip.startsWith('::ffff:127.');
}

/**
 * Determine if a request is a direct local connection (not proxied).
 *
 * A2A-73: This is the security-critical check. A request is only considered
 * "direct local" if ALL of these conditions hold:
 * 1. Socket remote address is loopback (the TCP connection is local)
 * 2. Host header targets localhost (not a public hostname)
 * 3. No proxy-forwarding headers are present (rules out nginx/CDN traffic)
 *
 * Without condition 3, any request through a reverse proxy would pass
 * because the proxy connects from 127.0.0.1 to the backend.
 */
function isDirectLocalRequest(req) {
  const ip = (req && req.socket && req.socket.remoteAddress) ? req.socket.remoteAddress : req.ip;
  if (!isLoopbackAddress(ip)) return false;

  const host = String(req.headers.host || '').toLowerCase();
  const isLocalHost = host.startsWith('localhost') ||
    host.startsWith('127.0.0.1') ||
    host.startsWith('[::1]') ||
    host.startsWith('::1');
  if (!isLocalHost) return false;

  // A2A-73: Reject requests with any proxy-forwarding header. These indicate
  // the request was relayed by nginx, a CDN, or another reverse proxy —
  // even though the socket address is loopback (proxy → backend is local).
  const forwarded = req.headers['x-forwarded-for'] ||
    req.headers['x-forwarded-proto'] ||
    req.headers['x-forwarded-host'] ||
    req.headers['cf-connecting-ip'] ||
    req.headers['x-forwarded-by'];
  if (forwarded) return false;

  return true;
}

module.exports = { isLoopbackAddress, isDirectLocalRequest };
