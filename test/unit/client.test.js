/**
 * A2A Client Tests
 *
 * Covers: invite URL parsing, protocol detection,
 * localhost handling, error types, retry logic (A2A-54),
 * response size cap (A2A-54), and HTTP round-trips.
 */

const http = require('http');
const net = require('net');

module.exports = function (test, assert, helpers) {

  // ── URL Parsing ───────────────────────────────────────────────

  test('parseInvite extracts host and token from a2a:// URL', () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { A2AClient } = require('../../src/lib/client');

    const { host, token } = A2AClient.parseInvite('a2a://myhost.com/fed_abc123');
    assert.equal(host, 'myhost.com');
    assert.equal(token, 'fed_abc123');
  });

  test('parseInvite rejects non-a2a schemes', () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { A2AClient } = require('../../src/lib/client');

    assert.throws(() => A2AClient.parseInvite('oclaw://legacy.host/fed_token456'));
    assert.throws(() => A2AClient.parseInvite('https://example.com/fed_token456'));
  });

  test('parseInvite handles host with port', () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { A2AClient } = require('../../src/lib/client');

    const { host, token } = A2AClient.parseInvite('a2a://localhost:3001/fed_xyz');
    assert.equal(host, 'localhost:3001');
    assert.equal(token, 'fed_xyz');
  });

  test('parseInvite throws on invalid URL', () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { A2AClient } = require('../../src/lib/client');

    assert.throws(() => A2AClient.parseInvite('https://bad.com/nope'));
    assert.throws(() => A2AClient.parseInvite('not-a-url'));
    assert.throws(() => A2AClient.parseInvite('a2a://'));
  });

  test('parseInvite handles long base64url tokens', () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { A2AClient } = require('../../src/lib/client');

    const longToken = 'fed_' + 'A'.repeat(100);
    const { token } = A2AClient.parseInvite(`a2a://host.com/${longToken}`);
    assert.equal(token, longToken);
  });

  // ── A2AError ──────────────────────────────────────────────────

  test('A2AError has code, message, and statusCode', () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { A2AError } = require('../../src/lib/client');

    const err = new A2AError('network_error', 'Connection refused', 503);
    assert.equal(err.code, 'network_error');
    assert.equal(err.message, 'Connection refused');
    assert.equal(err.statusCode, 503);
    assert.equal(err.name, 'A2AError');
    assert.ok(err instanceof Error);
  });

  test('A2AError statusCode defaults to null', () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { A2AError } = require('../../src/lib/client');

    const err = new A2AError('timeout', 'Request timed out');
    assert.equal(err.statusCode, null);
  });

  // ── Client Construction ───────────────────────────────────────

  test('client stores caller info', () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { A2AClient } = require('../../src/lib/client');

    const profile = helpers.goldaDeluxeProfile();
    const client = new A2AClient({
      caller: profile.callScenarios.claudebotCall.caller,
      timeout: 30000
    });

    assert.equal(client.caller.name, 'Golda Deluxe');
    assert.equal(client.timeout, 30000);
  });

  test('client defaults to empty caller and 60s timeout', () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { A2AClient } = require('../../src/lib/client');

    const client = new A2AClient();
    assert.deepEqual(client.caller, {});
    assert.equal(client.timeout, 60000);
  });

  // ── End method validation ─────────────────────────────────────

  test('end throws when conversationId missing', async () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { A2AClient } = require('../../src/lib/client');

    const client = new A2AClient();
    await assert.rejects(() => client.end('a2a://host/fed_tok', null));
  });

  // ── A2A-54: splitHostPort edge cases ──────────────────────────

  test('splitHostPort returns empty hostname for empty input', () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { _splitHostPort } = require('../../src/lib/client');

    const result = _splitHostPort('');
    assert.equal(result.hostname, '');
    assert.equal(result.port, null);
  });

  test('splitHostPort returns empty hostname for null input', () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { _splitHostPort } = require('../../src/lib/client');

    const result = _splitHostPort(null);
    assert.equal(result.hostname, '');
    assert.equal(result.port, null);
  });

  test('splitHostPort parses host:port', () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { _splitHostPort } = require('../../src/lib/client');

    const result = _splitHostPort('example.com:8080');
    assert.equal(result.hostname, 'example.com');
    assert.equal(result.port, 8080);
  });

  test('splitHostPort parses bare hostname without port', () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { _splitHostPort } = require('../../src/lib/client');

    const result = _splitHostPort('example.com');
    assert.equal(result.hostname, 'example.com');
    assert.equal(result.port, null);
  });

  test('splitHostPort parses bracketed IPv6 with port', () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { _splitHostPort } = require('../../src/lib/client');

    const result = _splitHostPort('[::1]:3001');
    assert.equal(result.hostname, '::1');
    assert.equal(result.port, 3001);
  });

  test('splitHostPort parses bracketed IPv6 without port', () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { _splitHostPort } = require('../../src/lib/client');

    const result = _splitHostPort('[::1]');
    assert.equal(result.hostname, '::1');
    assert.equal(result.port, null);
  });

  test('splitHostPort treats bare IPv6 as hostname (no port split)', () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { _splitHostPort } = require('../../src/lib/client');

    // Multiple colons without brackets — should not split
    const result = _splitHostPort('fe80::1');
    assert.equal(result.hostname, 'fe80::1');
    assert.equal(result.port, null);
  });

  // ── A2A-54: resolveProtocolAndPort localhost detection ────────

  test('resolveProtocolAndPort uses HTTP for localhost', () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { _resolveProtocolAndPort } = require('../../src/lib/client');

    const result = _resolveProtocolAndPort('localhost:3001');
    assert.equal(result.hostname, 'localhost');
    assert.equal(result.port, 3001);
    assert.equal(result.protocol, http);
  });

  test('resolveProtocolAndPort uses HTTP for 127.0.0.1', () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { _resolveProtocolAndPort } = require('../../src/lib/client');

    const result = _resolveProtocolAndPort('127.0.0.1:8080');
    assert.equal(result.hostname, '127.0.0.1');
    assert.equal(result.port, 8080);
    assert.equal(result.protocol, http);
  });

  test('resolveProtocolAndPort uses HTTP for 127.x.x.x addresses', () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { _resolveProtocolAndPort } = require('../../src/lib/client');

    const result = _resolveProtocolAndPort('127.0.1.1:9000');
    assert.equal(result.hostname, '127.0.1.1');
    assert.equal(result.protocol, http);
  });

  test('resolveProtocolAndPort defaults port to 80 without explicit port', () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { _resolveProtocolAndPort } = require('../../src/lib/client');

    const result = _resolveProtocolAndPort('example.com');
    assert.equal(result.port, 80);
    // port 80 => HTTP
    assert.equal(result.protocol, http);
  });

  test('resolveProtocolAndPort uses HTTPS for port 443', () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const https = require('https');
    const { _resolveProtocolAndPort } = require('../../src/lib/client');

    const result = _resolveProtocolAndPort('remote.agent.com:443');
    assert.equal(result.port, 443);
    assert.equal(result.protocol, https);
  });

  // ── A2A-54: Constants are exported correctly ──────────────────

  test('MAX_RESPONSE_BYTES is 2MB', () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { _MAX_RESPONSE_BYTES } = require('../../src/lib/client');

    assert.equal(_MAX_RESPONSE_BYTES, 2 * 1024 * 1024);
  });

  test('RETRYABLE_CODES contains expected error codes', () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { _RETRYABLE_CODES } = require('../../src/lib/client');

    assert.includes(_RETRYABLE_CODES, 'ECONNRESET');
    assert.includes(_RETRYABLE_CODES, 'ECONNREFUSED');
    assert.includes(_RETRYABLE_CODES, 'EPIPE');
    assert.includes(_RETRYABLE_CODES, 'ENOTFOUND');
    assert.includes(_RETRYABLE_CODES, 'EAI_AGAIN');
  });

  test('RETRY_DELAYS follows exponential backoff: 0, 1000, 2000', () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { _RETRY_DELAYS } = require('../../src/lib/client');

    assert.deepEqual(_RETRY_DELAYS, [0, 1000, 2000]);
  });

  // ── A2A-54: HTTP round-trip tests ─────────────────────────────
  // These use http.createServer on port 0 for real HTTP round-trips.

  /**
   * Helper: start a local HTTP server on an ephemeral port.
   * Returns { port, server, close() }.
   */
  function startServer(handler) {
    return new Promise((resolve) => {
      const server = http.createServer(handler);
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        resolve({
          port,
          server,
          close() {
            return new Promise((res) => server.close(res));
          }
        });
      });
    });
  }

  // ── call() happy path ─────────────────────────────────────────

  test('call() returns parsed JSON on 200 response', async () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { A2AClient } = require('../../src/lib/client');

    const srv = await startServer((req, res) => {
      let body = '';
      req.on('data', (c) => body += c);
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ response: 'hello', conversation_id: 'conv_1' }));
      });
    });

    try {
      const client = new A2AClient({ _retryDelays: [0, 0, 0] });
      const result = await client.call(
        { host: `127.0.0.1:${srv.port}`, token: 'fed_test' },
        'Hi there'
      );
      assert.equal(result.response, 'hello');
      assert.equal(result.conversation_id, 'conv_1');
    } finally {
      await srv.close();
    }
  });

  // ── call() retry on transient network error ───────────────────

  test('call() retries on ECONNRESET and succeeds on later attempt', async () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { A2AClient } = require('../../src/lib/client');

    let requestCount = 0;
    const srv = await startServer((req, res) => {
      requestCount++;
      if (requestCount <= 2) {
        // Simulate ECONNRESET by destroying the socket without response
        req.socket.destroy();
        return;
      }
      let body = '';
      req.on('data', (c) => body += c);
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, attempt: requestCount }));
      });
    });

    try {
      const client = new A2AClient({ _retryDelays: [0, 0, 0] });
      const result = await client.call(
        { host: `127.0.0.1:${srv.port}`, token: 'fed_retry' },
        'retry test'
      );
      assert.equal(result.success, true);
      assert.equal(result.attempt, 3);
      assert.equal(requestCount, 3);
    } finally {
      await srv.close();
    }
  });

  test('call() exhausts retries and throws on persistent ECONNRESET', async () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { A2AClient } = require('../../src/lib/client');

    let requestCount = 0;
    const srv = await startServer((req, res) => {
      requestCount++;
      // Always destroy socket — never respond
      req.socket.destroy();
    });

    try {
      const client = new A2AClient({ _retryDelays: [0, 0, 0] });
      let threw = false;
      try {
        await client.call(
          { host: `127.0.0.1:${srv.port}`, token: 'fed_fail' },
          'persistent failure'
        );
      } catch (err) {
        threw = true;
        assert.equal(err.code, 'network_error');
      }
      assert.ok(threw, 'Expected call to throw after exhausting retries');
      // 4 attempts: 1 initial + 3 retries
      assert.equal(requestCount, 4);
    } finally {
      await srv.close();
    }
  });

  // ── call() no-retry on HTTP 4xx ───────────────────────────────

  test('call() does NOT retry on HTTP 400', async () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { A2AClient } = require('../../src/lib/client');

    let requestCount = 0;
    const srv = await startServer((req, res) => {
      requestCount++;
      let body = '';
      req.on('data', (c) => body += c);
      req.on('end', () => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad_request', message: 'Invalid payload' }));
      });
    });

    try {
      const client = new A2AClient({ _retryDelays: [0, 0, 0] });
      let threw = false;
      try {
        await client.call(
          { host: `127.0.0.1:${srv.port}`, token: 'fed_4xx' },
          'bad request'
        );
      } catch (err) {
        threw = true;
        assert.equal(err.code, 'bad_request');
        assert.equal(err.statusCode, 400);
      }
      assert.ok(threw, 'Expected 400 to throw');
      // Exactly 1 request — no retry for HTTP errors
      assert.equal(requestCount, 1);
    } finally {
      await srv.close();
    }
  });

  test('call() does NOT retry on HTTP 500', async () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { A2AClient } = require('../../src/lib/client');

    let requestCount = 0;
    const srv = await startServer((req, res) => {
      requestCount++;
      let body = '';
      req.on('data', (c) => body += c);
      req.on('end', () => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal_error', message: 'Server failed' }));
      });
    });

    try {
      const client = new A2AClient({ _retryDelays: [0, 0, 0] });
      let threw = false;
      try {
        await client.call(
          { host: `127.0.0.1:${srv.port}`, token: 'fed_5xx' },
          'server error'
        );
      } catch (err) {
        threw = true;
        assert.equal(err.code, 'internal_error');
        assert.equal(err.statusCode, 500);
      }
      assert.ok(threw, 'Expected 500 to throw');
      assert.equal(requestCount, 1);
    } finally {
      await srv.close();
    }
  });

  // ── call() response size cap ──────────────────────────────────

  test('call() rejects with response_too_large when response exceeds 2MB', async () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { A2AClient, _MAX_RESPONSE_BYTES } = require('../../src/lib/client');

    const srv = await startServer((req, res) => {
      let body = '';
      req.on('data', (c) => body += c);
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // Send data exceeding 2MB — write in chunks to simulate streaming
        const chunk = 'x'.repeat(64 * 1024); // 64KB chunks
        const needed = Math.ceil((_MAX_RESPONSE_BYTES + 1) / chunk.length) + 1;
        for (let i = 0; i < needed; i++) {
          res.write(chunk);
        }
        res.end();
      });
    });

    try {
      const client = new A2AClient({ _retryDelays: [0, 0, 0] });
      let threw = false;
      try {
        await client.call(
          { host: `127.0.0.1:${srv.port}`, token: 'fed_big' },
          'big response'
        );
      } catch (err) {
        threw = true;
        assert.equal(err.code, 'response_too_large');
        assert.includes(err.message, String(_MAX_RESPONSE_BYTES));
      }
      assert.ok(threw, 'Expected response_too_large error');
    } finally {
      await srv.close();
    }
  });

  // ── end() happy path + retry ──────────────────────────────────

  test('end() returns parsed JSON on 200 response', async () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { A2AClient } = require('../../src/lib/client');

    const srv = await startServer((req, res) => {
      let body = '';
      req.on('data', (c) => body += c);
      req.on('end', () => {
        assert.equal(req.url, '/api/a2a/end');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ended: true, summary: 'Call concluded' }));
      });
    });

    try {
      const client = new A2AClient({ _retryDelays: [0, 0, 0] });
      const result = await client.end(
        { host: `127.0.0.1:${srv.port}`, token: 'fed_end' },
        'conv_123'
      );
      assert.equal(result.ended, true);
      assert.equal(result.summary, 'Call concluded');
    } finally {
      await srv.close();
    }
  });

  test('end() retries on ECONNRESET and succeeds', async () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { A2AClient } = require('../../src/lib/client');

    let requestCount = 0;
    const srv = await startServer((req, res) => {
      requestCount++;
      if (requestCount === 1) {
        req.socket.destroy();
        return;
      }
      let body = '';
      req.on('data', (c) => body += c);
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ended: true }));
      });
    });

    try {
      const client = new A2AClient({ _retryDelays: [0, 0, 0] });
      const result = await client.end(
        { host: `127.0.0.1:${srv.port}`, token: 'fed_end_retry' },
        'conv_retry'
      );
      assert.equal(result.ended, true);
      assert.equal(requestCount, 2);
    } finally {
      await srv.close();
    }
  });

  test('end() response size cap rejects oversized response', async () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { A2AClient, _MAX_RESPONSE_BYTES } = require('../../src/lib/client');

    const srv = await startServer((req, res) => {
      let body = '';
      req.on('data', (c) => body += c);
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const chunk = 'y'.repeat(64 * 1024);
        const needed = Math.ceil((_MAX_RESPONSE_BYTES + 1) / chunk.length) + 1;
        for (let i = 0; i < needed; i++) {
          res.write(chunk);
        }
        res.end();
      });
    });

    try {
      const client = new A2AClient({ _retryDelays: [0, 0, 0] });
      let threw = false;
      try {
        await client.end(
          { host: `127.0.0.1:${srv.port}`, token: 'fed_end_big' },
          'conv_big'
        );
      } catch (err) {
        threw = true;
        assert.equal(err.code, 'response_too_large');
      }
      assert.ok(threw, 'Expected response_too_large for end()');
    } finally {
      await srv.close();
    }
  });

  // ── ping() happy path ─────────────────────────────────────────

  test('ping() returns parsed JSON on 200', async () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { A2AClient } = require('../../src/lib/client');

    const srv = await startServer((req, res) => {
      assert.equal(req.url, '/api/a2a/ping');
      assert.equal(req.method, 'GET');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ pong: true, version: '0.6.66' }));
    });

    try {
      const client = new A2AClient();
      const result = await client.ping({ host: `127.0.0.1:${srv.port}` });
      assert.equal(result.pong, true);
      assert.equal(result.version, '0.6.66');
    } finally {
      await srv.close();
    }
  });

  // ── ping() unreachable ────────────────────────────────────────

  test('ping() returns { pong: false } when server is unreachable', async () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { A2AClient } = require('../../src/lib/client');

    // Find an unused port by binding then closing
    const unusedPort = await new Promise((resolve) => {
      const s = net.createServer();
      s.listen(0, '127.0.0.1', () => {
        const port = s.address().port;
        s.close(() => resolve(port));
      });
    });

    const client = new A2AClient();
    const result = await client.ping({ host: `127.0.0.1:${unusedPort}` });
    assert.equal(result.pong, false);
  });

  // ── ping() does NOT retry (verifying no retry) ────────────────

  test('ping() does not retry on connection error', async () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { A2AClient } = require('../../src/lib/client');

    let requestCount = 0;
    const srv = await startServer((req, res) => {
      requestCount++;
      req.socket.destroy();
    });

    try {
      const client = new A2AClient();
      const result = await client.ping({ host: `127.0.0.1:${srv.port}` });
      // ping resolves with { pong: false } on errors, no retry
      assert.equal(result.pong, false);
      // Should be exactly 1 request attempt (no retry)
      assert.equal(requestCount, 1);
    } finally {
      await srv.close();
    }
  });

  // ── ping() response size cap ──────────────────────────────────

  test('ping() rejects with response_too_large on oversized response', async () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { A2AClient, _MAX_RESPONSE_BYTES } = require('../../src/lib/client');

    const srv = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const chunk = 'z'.repeat(64 * 1024);
      const needed = Math.ceil((_MAX_RESPONSE_BYTES + 1) / chunk.length) + 1;
      for (let i = 0; i < needed; i++) {
        res.write(chunk);
      }
      res.end();
    });

    try {
      const client = new A2AClient();
      let threw = false;
      try {
        await client.ping({ host: `127.0.0.1:${srv.port}` });
      } catch (err) {
        threw = true;
        assert.equal(err.code, 'response_too_large');
      }
      assert.ok(threw, 'Expected response_too_large for oversized ping response');
    } finally {
      await srv.close();
    }
  });

  // ── status() happy path ───────────────────────────────────────

  test('status() returns parsed JSON on 200', async () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { A2AClient } = require('../../src/lib/client');

    const srv = await startServer((req, res) => {
      assert.equal(req.url, '/api/a2a/status');
      assert.equal(req.method, 'GET');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ a2a: true, version: '0.6.66', uptime: 42 }));
    });

    try {
      const client = new A2AClient();
      const result = await client.status({ host: `127.0.0.1:${srv.port}` });
      assert.equal(result.a2a, true);
      assert.equal(result.uptime, 42);
    } finally {
      await srv.close();
    }
  });

  // ── status() parse error ──────────────────────────────────────

  test('status() rejects with parse_error on non-JSON response', async () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { A2AClient } = require('../../src/lib/client');

    const srv = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('this is not json');
    });

    try {
      const client = new A2AClient();
      let threw = false;
      try {
        await client.status({ host: `127.0.0.1:${srv.port}` });
      } catch (err) {
        threw = true;
        assert.equal(err.code, 'parse_error');
        assert.equal(err.message, 'Invalid status response');
      }
      assert.ok(threw, 'Expected parse_error on non-JSON status response');
    } finally {
      await srv.close();
    }
  });

  // ── status() does NOT retry ───────────────────────────────────

  test('status() does not retry on connection error', async () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { A2AClient } = require('../../src/lib/client');

    let requestCount = 0;
    const srv = await startServer((req, res) => {
      requestCount++;
      req.socket.destroy();
    });

    try {
      const client = new A2AClient();
      let threw = false;
      try {
        await client.status({ host: `127.0.0.1:${srv.port}` });
      } catch (err) {
        threw = true;
        assert.equal(err.code, 'network_error');
      }
      assert.ok(threw, 'Expected network_error from status()');
      // Exactly 1 attempt, no retry
      assert.equal(requestCount, 1);
    } finally {
      await srv.close();
    }
  });

  // ── status() response size cap ────────────────────────────────

  test('status() rejects with response_too_large on oversized response', async () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { A2AClient, _MAX_RESPONSE_BYTES } = require('../../src/lib/client');

    const srv = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const chunk = 'w'.repeat(64 * 1024);
      const needed = Math.ceil((_MAX_RESPONSE_BYTES + 1) / chunk.length) + 1;
      for (let i = 0; i < needed; i++) {
        res.write(chunk);
      }
      res.end();
    });

    try {
      const client = new A2AClient();
      let threw = false;
      try {
        await client.status({ host: `127.0.0.1:${srv.port}` });
      } catch (err) {
        threw = true;
        assert.equal(err.code, 'response_too_large');
      }
      assert.ok(threw, 'Expected response_too_large for oversized status response');
    } finally {
      await srv.close();
    }
  });

  // ── call() sends correct request format ───────────────────────

  test('call() sends Authorization header and JSON body', async () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { A2AClient } = require('../../src/lib/client');

    let capturedHeaders = {};
    let capturedBody = '';
    const srv = await startServer((req, res) => {
      capturedHeaders = req.headers;
      let body = '';
      req.on('data', (c) => body += c);
      req.on('end', () => {
        capturedBody = body;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });

    try {
      const client = new A2AClient({
        caller: { name: 'TestBot' },
        _retryDelays: [0, 0, 0]
      });
      await client.call(
        { host: `127.0.0.1:${srv.port}`, token: 'fed_auth_test' },
        'verify headers',
        { conversationId: 'conv_42', timeoutSeconds: 30 }
      );
      assert.equal(capturedHeaders['authorization'], 'Bearer fed_auth_test');
      assert.equal(capturedHeaders['content-type'], 'application/json');

      const parsed = JSON.parse(capturedBody);
      assert.equal(parsed.message, 'verify headers');
      assert.equal(parsed.conversation_id, 'conv_42');
      assert.equal(parsed.timeout_seconds, 30);
      assert.equal(parsed.caller.name, 'TestBot');
    } finally {
      await srv.close();
    }
  });

  // ── call() ECONNREFUSED retry ─────────────────────────────────

  test('call() retries on ECONNREFUSED', async () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { A2AClient } = require('../../src/lib/client');

    // Get a port, then close the server so ECONNREFUSED happens
    let requestCount = 0;
    const tempSrv = net.createServer();
    const port = await new Promise((resolve) => {
      tempSrv.listen(0, '127.0.0.1', () => {
        resolve(tempSrv.address().port);
      });
    });
    // Close to guarantee ECONNREFUSED
    await new Promise((resolve) => tempSrv.close(resolve));

    const client = new A2AClient({ _retryDelays: [0, 0, 0] });
    let threw = false;
    try {
      await client.call(
        { host: `127.0.0.1:${port}`, token: 'fed_refused' },
        'refused test'
      );
    } catch (err) {
      threw = true;
      assert.equal(err.code, 'network_error');
      assert.includes(err.message, 'ECONNREFUSED');
    }
    assert.ok(threw, 'Expected ECONNREFUSED error after exhausting retries');
  });
};
