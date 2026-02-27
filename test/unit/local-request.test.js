/**
 * Local Request Detection Tests
 *
 * Covers: isLoopbackAddress and isDirectLocalRequest from src/lib/local-request.js
 * A2A-73: Ensures proxy-aware local detection rejects forwarded traffic.
 */

module.exports = function (test, assert) {
  const { isLoopbackAddress, isDirectLocalRequest } = require('../../src/lib/local-request');

  // --- isLoopbackAddress ---

  test('isLoopbackAddress returns true for IPv4 loopback', () => {
    assert.equal(isLoopbackAddress('127.0.0.1'), true);
  });

  test('isLoopbackAddress returns true for IPv6 loopback', () => {
    assert.equal(isLoopbackAddress('::1'), true);
  });

  test('isLoopbackAddress returns true for IPv4-mapped IPv6 loopback', () => {
    assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  });

  test('isLoopbackAddress returns true for ::ffff:127.x range', () => {
    assert.equal(isLoopbackAddress('::ffff:127.0.0.2'), true);
    assert.equal(isLoopbackAddress('::ffff:127.255.255.255'), true);
  });

  test('isLoopbackAddress returns false for non-loopback addresses', () => {
    assert.equal(isLoopbackAddress('192.168.1.1'), false);
    assert.equal(isLoopbackAddress('10.0.0.1'), false);
    assert.equal(isLoopbackAddress('8.8.8.8'), false);
    assert.equal(isLoopbackAddress('::ffff:192.168.1.1'), false);
  });

  test('isLoopbackAddress returns false for null/undefined/empty', () => {
    assert.equal(isLoopbackAddress(null), false);
    assert.equal(isLoopbackAddress(undefined), false);
    assert.equal(isLoopbackAddress(''), false);
  });

  // --- isDirectLocalRequest ---

  function mockReq(opts = {}) {
    return {
      ip: opts.ip || '127.0.0.1',
      socket: { remoteAddress: opts.socketAddr || opts.ip || '127.0.0.1' },
      headers: Object.assign({ host: opts.host || 'localhost:3001' }, opts.headers || {})
    };
  }

  test('isDirectLocalRequest allows direct local request', () => {
    assert.equal(isDirectLocalRequest(mockReq()), true);
  });

  test('isDirectLocalRequest allows localhost with various formats', () => {
    assert.equal(isDirectLocalRequest(mockReq({ host: 'localhost' })), true);
    assert.equal(isDirectLocalRequest(mockReq({ host: 'localhost:8080' })), true);
    assert.equal(isDirectLocalRequest(mockReq({ host: '127.0.0.1:3001' })), true);
    assert.equal(isDirectLocalRequest(mockReq({ host: '[::1]:3001' })), true);
    assert.equal(isDirectLocalRequest(mockReq({ host: '::1' })), true);
  });

  test('isDirectLocalRequest rejects non-loopback socket address', () => {
    assert.equal(isDirectLocalRequest(mockReq({ socketAddr: '192.168.1.1' })), false);
  });

  test('isDirectLocalRequest rejects public hostname (proxy scenario)', () => {
    assert.equal(isDirectLocalRequest(mockReq({ host: 'example.com' })), false);
    assert.equal(isDirectLocalRequest(mockReq({ host: 'myapp.ngrok.io' })), false);
  });

  test('isDirectLocalRequest rejects when x-forwarded-for present', () => {
    const req = mockReq({ headers: { 'x-forwarded-for': '203.0.113.50' } });
    assert.equal(isDirectLocalRequest(req), false);
  });

  test('isDirectLocalRequest rejects when x-forwarded-proto present', () => {
    const req = mockReq({ headers: { 'x-forwarded-proto': 'https' } });
    assert.equal(isDirectLocalRequest(req), false);
  });

  test('isDirectLocalRequest rejects when x-forwarded-host present', () => {
    const req = mockReq({ headers: { 'x-forwarded-host': 'example.com' } });
    assert.equal(isDirectLocalRequest(req), false);
  });

  test('isDirectLocalRequest rejects when cf-connecting-ip present', () => {
    const req = mockReq({ headers: { 'cf-connecting-ip': '203.0.113.50' } });
    assert.equal(isDirectLocalRequest(req), false);
  });

  test('isDirectLocalRequest rejects when x-forwarded-by present', () => {
    const req = mockReq({ headers: { 'x-forwarded-by': '10.0.0.1' } });
    assert.equal(isDirectLocalRequest(req), false);
  });

  test('isDirectLocalRequest falls back to req.ip when socket missing', () => {
    const req = { ip: '127.0.0.1', socket: {}, headers: { host: 'localhost:3001' } };
    assert.equal(isDirectLocalRequest(req), true);
  });

  test('isDirectLocalRequest rejects nginx reverse-proxy scenario', () => {
    // Simulates: nginx on 443 → Express on 3007. Socket is local but
    // nginx adds x-forwarded-for, so this must be rejected.
    const req = mockReq({
      socketAddr: '127.0.0.1',
      host: 'example.com',
      headers: {
        'x-forwarded-for': '203.0.113.50',
        'x-forwarded-proto': 'https'
      }
    });
    assert.equal(isDirectLocalRequest(req), false);
  });
};
