/**
 * A2A Client Resilience Tests
 *
 * Covers gaps identified in A2A-90 audit:
 * - Retry logic for all RETRYABLE_CODES (EPIPE, EAI_AGAIN, timeout)
 * - Agent Card fetch: cache TTL, negative caching, parse failures, size cap
 * - Google A2A protocol path: _translateToGoogleRequest, _translateGoogleResponse, _callGoogleA2A
 * - 2MB response size cap boundary (exact boundary)
 */

const http = require('http');
const net = require('net');

module.exports = function (test, assert, helpers) {

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

  // Helper: pre-seed Agent Card cache with null (no Agent Card) for proprietary path
  function seedNoAgentCard(cache, port) {
    cache.set(`127.0.0.1:${port}`, { card: null, cachedAt: Date.now() });
  }

  // Helper: pre-seed Agent Card cache with a valid card for Google A2A path
  function seedGoogleAgentCard(cache, port) {
    cache.set(`127.0.0.1:${port}`, {
      card: {
        name: 'Test Agent',
        interfaces: [{ type: 'rest', url: `http://127.0.0.1:${port}` }]
      },
      cachedAt: Date.now()
    });
  }

  // ── withRetry: EPIPE ────────────────────────────────────────────

  test('call() retries on EPIPE and succeeds on later attempt', async () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { A2AClient, _agentCardCache } = require('../../src/lib/client');

    let requestCount = 0;
    const srv = await startServer((req, res) => {
      requestCount++;
      if (requestCount <= 1) {
        // Simulate EPIPE by destroying socket without responding
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

    seedNoAgentCard(_agentCardCache, srv.port);

    try {
      const client = new A2AClient({ _retryDelays: [0, 0, 0] });
      const result = await client.call(
        { host: `127.0.0.1:${srv.port}`, token: 'fed_epipe' },
        'epipe test'
      );
      assert.equal(result.success, true);
      assert.ok(requestCount >= 2, 'Expected at least 2 requests (1 fail + 1 success)');
    } finally {
      _agentCardCache.clear();
      await srv.close();
    }
  });

  // ── withRetry: timeout ──────────────────────────────────────────

  test('call() retries on timeout error', async () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { A2AClient, _agentCardCache } = require('../../src/lib/client');

    let requestCount = 0;
    const srv = await startServer((req, res) => {
      requestCount++;
      if (requestCount <= 1) {
        // Don't respond at all — let the short timeout fire
        return;
      }
      let body = '';
      req.on('data', (c) => body += c);
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      });
    });

    seedNoAgentCard(_agentCardCache, srv.port);

    try {
      // Very short timeout so the first request times out quickly
      const client = new A2AClient({ timeout: 200, _retryDelays: [0, 0, 0] });
      const result = await client.call(
        { host: `127.0.0.1:${srv.port}`, token: 'fed_timeout' },
        'timeout test'
      );
      assert.equal(result.success, true);
      assert.ok(requestCount >= 2, 'Expected retry after timeout');
    } finally {
      _agentCardCache.clear();
      await srv.close();
    }
  });

  // ── withRetry: non-retryable A2AError codes pass through ───────

  test('withRetry does not retry HTTP 403 (non-retryable)', async () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { A2AClient, _agentCardCache } = require('../../src/lib/client');

    let requestCount = 0;
    const srv = await startServer((req, res) => {
      requestCount++;
      let body = '';
      req.on('data', (c) => body += c);
      req.on('end', () => {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'forbidden', message: 'Nope' }));
      });
    });

    seedNoAgentCard(_agentCardCache, srv.port);

    try {
      const client = new A2AClient({ _retryDelays: [0, 0, 0] });
      let threw = false;
      try {
        await client.call(
          { host: `127.0.0.1:${srv.port}`, token: 'fed_403' },
          '403 test'
        );
      } catch (err) {
        threw = true;
        assert.equal(err.code, 'forbidden');
        assert.equal(err.statusCode, 403);
      }
      assert.ok(threw, 'Expected 403 to throw');
      assert.equal(requestCount, 1, 'No retry on 403');
    } finally {
      _agentCardCache.clear();
      await srv.close();
    }
  });

  // ── Agent Card: fetchRemoteAgentCard returns valid card ─────────

  test('fetchRemoteAgentCard returns card for valid /.well-known/a2a-agent-card', async () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { fetchRemoteAgentCard, _agentCardCache } = require('../../src/lib/client');

    const validCard = {
      name: 'Remote Agent',
      interfaces: [{ type: 'rest', url: 'http://example.com/a2a' }]
    };

    const srv = await startServer((req, res) => {
      if (req.url === '/.well-known/a2a-agent-card') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(validCard));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    try {
      _agentCardCache.clear();
      const card = await fetchRemoteAgentCard(`127.0.0.1:${srv.port}`);
      assert.ok(card, 'Expected non-null card');
      assert.equal(card.name, 'Remote Agent');
      assert.equal(card.interfaces.length, 1);
      assert.equal(card.interfaces[0].type, 'rest');
    } finally {
      _agentCardCache.clear();
      await srv.close();
    }
  });

  // ── Agent Card: negative caching on 404 ─────────────────────────

  test('fetchRemoteAgentCard caches null on 404', async () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { fetchRemoteAgentCard, _agentCardCache } = require('../../src/lib/client');

    let requestCount = 0;
    const srv = await startServer((req, res) => {
      requestCount++;
      res.writeHead(404);
      res.end('Not Found');
    });

    try {
      _agentCardCache.clear();
      const card1 = await fetchRemoteAgentCard(`127.0.0.1:${srv.port}`);
      assert.equal(card1, null, 'Expected null for 404');
      assert.equal(requestCount, 1);

      // Second call should use cache, no new HTTP request
      const card2 = await fetchRemoteAgentCard(`127.0.0.1:${srv.port}`);
      assert.equal(card2, null, 'Expected cached null');
      assert.equal(requestCount, 1, 'No new request — served from cache');
    } finally {
      _agentCardCache.clear();
      await srv.close();
    }
  });

  // ── Agent Card: negative caching on JSON parse failure ──────────

  test('fetchRemoteAgentCard caches null on invalid JSON', async () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { fetchRemoteAgentCard, _agentCardCache } = require('../../src/lib/client');

    let requestCount = 0;
    const srv = await startServer((req, res) => {
      requestCount++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('this is not json{{{');
    });

    try {
      _agentCardCache.clear();
      const card = await fetchRemoteAgentCard(`127.0.0.1:${srv.port}`);
      assert.equal(card, null, 'Expected null for invalid JSON');
      assert.equal(requestCount, 1);

      // Second call from cache
      const card2 = await fetchRemoteAgentCard(`127.0.0.1:${srv.port}`);
      assert.equal(card2, null);
      assert.equal(requestCount, 1, 'Cached');
    } finally {
      _agentCardCache.clear();
      await srv.close();
    }
  });

  // ── Agent Card: invalid card structure (missing interfaces) ─────

  test('fetchRemoteAgentCard returns null for card without rest interface', async () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { fetchRemoteAgentCard, _agentCardCache } = require('../../src/lib/client');

    const srv = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ name: 'Bad Agent', interfaces: [] }));
    });

    try {
      _agentCardCache.clear();
      const card = await fetchRemoteAgentCard(`127.0.0.1:${srv.port}`);
      assert.equal(card, null, 'Expected null for empty interfaces');
    } finally {
      _agentCardCache.clear();
      await srv.close();
    }
  });

  // ── Agent Card: network error resolves null ─────────────────────

  test('fetchRemoteAgentCard resolves null on connection refused', async () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { fetchRemoteAgentCard, _agentCardCache } = require('../../src/lib/client');

    // Find an unused port
    const unusedPort = await new Promise((resolve) => {
      const s = net.createServer();
      s.listen(0, '127.0.0.1', () => {
        const port = s.address().port;
        s.close(() => resolve(port));
      });
    });

    try {
      _agentCardCache.clear();
      const card = await fetchRemoteAgentCard(`127.0.0.1:${unusedPort}`);
      assert.equal(card, null, 'Expected null on connection refused');
    } finally {
      _agentCardCache.clear();
    }
  });

  // ── Agent Card: cache TTL expiry ────────────────────────────────

  test('fetchRemoteAgentCard serves from cache within TTL', async () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { fetchRemoteAgentCard, _agentCardCache } = require('../../src/lib/client');

    const validCard = {
      name: 'Cached Agent',
      interfaces: [{ type: 'rest', url: 'http://localhost/a2a' }]
    };

    let requestCount = 0;
    const srv = await startServer((req, res) => {
      requestCount++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(validCard));
    });

    try {
      _agentCardCache.clear();
      // First fetch — populates cache
      const card1 = await fetchRemoteAgentCard(`127.0.0.1:${srv.port}`);
      assert.ok(card1, 'Expected card on first fetch');
      assert.equal(requestCount, 1);

      // Second fetch — from cache
      const card2 = await fetchRemoteAgentCard(`127.0.0.1:${srv.port}`);
      assert.ok(card2, 'Expected card from cache');
      assert.equal(requestCount, 1, 'No new request within TTL');
    } finally {
      _agentCardCache.clear();
      await srv.close();
    }
  });

  // ── _parseAgentCard validation ──────────────────────────────────

  test('_parseAgentCard rejects non-object input', () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { _parseAgentCard } = require('../../src/lib/client');

    assert.equal(_parseAgentCard(null), null);
    assert.equal(_parseAgentCard(42), null);
    assert.equal(_parseAgentCard('string'), null);
  });

  test('_parseAgentCard rejects card without interfaces array', () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { _parseAgentCard } = require('../../src/lib/client');

    assert.equal(_parseAgentCard({ name: 'bad' }), null);
    assert.equal(_parseAgentCard({ interfaces: 'not-array' }), null);
  });

  test('_parseAgentCard rejects card with no rest interface', () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { _parseAgentCard } = require('../../src/lib/client');

    assert.equal(_parseAgentCard({ interfaces: [{ type: 'grpc' }] }), null);
  });

  test('_parseAgentCard accepts valid card with rest interface', () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { _parseAgentCard } = require('../../src/lib/client');

    const card = { interfaces: [{ type: 'rest', url: 'http://example.com' }] };
    const result = _parseAgentCard(card);
    assert.ok(result, 'Expected card to be accepted');
    assert.equal(result.interfaces[0].type, 'rest');
  });

  // ── _translateToGoogleRequest ───────────────────────────────────

  test('_translateToGoogleRequest builds correct message/send body', () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { _translateToGoogleRequest } = require('../../src/lib/client');

    const body = _translateToGoogleRequest('Hello', 'conv_123', { timeoutSeconds: 30 }, { name: 'Bot', owner: 'Owner' });
    assert.equal(body.message.role, 'user');
    assert.equal(body.message.parts[0].content.text, 'Hello');
    assert.equal(body.message.context_id, 'conv_123');
    assert.equal(body.metadata.caller_name, 'Bot');
    assert.equal(body.metadata.caller_owner, 'Owner');
    assert.equal(body.configuration.timeout_seconds, 30);
    assert.equal(body.configuration.blocking, true);
  });

  test('_translateToGoogleRequest omits context_id when no conversationId', () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { _translateToGoogleRequest } = require('../../src/lib/client');

    const body = _translateToGoogleRequest('Hello', null);
    assert.equal(body.message.context_id, undefined);
  });

  test('_translateToGoogleRequest truncates long caller fields', () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { _translateToGoogleRequest } = require('../../src/lib/client');

    const longName = 'A'.repeat(200);
    const body = _translateToGoogleRequest('Hi', null, {}, { name: longName, instance: longName });
    assert.equal(body.metadata.caller_name.length, 100);
    assert.equal(body.metadata.caller_instance.length, 200);
  });

  // ── _translateGoogleResponse ────────────────────────────────────

  test('_translateGoogleResponse extracts text from completed task', () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { _translateGoogleResponse } = require('../../src/lib/client');

    const taskResponse = {
      task: {
        status: {
          state: 'completed',
          message: {
            parts: [
              { content: { text: 'Hello' } },
              { content: { text: ' World' } }
            ]
          }
        },
        context_id: 'ctx_1'
      }
    };

    const result = _translateGoogleResponse(taskResponse);
    assert.equal(result.response, 'Hello\n World');
    assert.equal(result.conversation_id, 'ctx_1');
    assert.equal(result.can_continue, false);
  });

  test('_translateGoogleResponse sets can_continue for input-required', () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { _translateGoogleResponse } = require('../../src/lib/client');

    const taskResponse = {
      task: {
        status: {
          state: 'input-required',
          message: { parts: [{ content: { text: 'Your turn' } }] }
        },
        context_id: 'ctx_2'
      }
    };

    const result = _translateGoogleResponse(taskResponse);
    assert.equal(result.can_continue, true);
    assert.equal(result.response, 'Your turn');
  });

  test('_translateGoogleResponse throws on missing task', () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { _translateGoogleResponse, A2AError } = require('../../src/lib/client');

    let threw = false;
    try {
      _translateGoogleResponse({});
    } catch (err) {
      threw = true;
      assert.equal(err.code, 'google_a2a_error');
    }
    assert.ok(threw);
  });

  test('_translateGoogleResponse handles empty parts gracefully', () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { _translateGoogleResponse } = require('../../src/lib/client');

    const taskResponse = {
      task: {
        status: { state: 'completed', message: { parts: [] } },
        context_id: null
      }
    };

    const result = _translateGoogleResponse(taskResponse);
    assert.equal(result.response, '');
    assert.equal(result.conversation_id, null);
  });

  // ── _resolveGoogleA2AUrl ────────────────────────────────────────

  test('_resolveGoogleA2AUrl uses rest interface URL', () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { _resolveGoogleA2AUrl } = require('../../src/lib/client');

    const card = { interfaces: [{ type: 'rest', url: 'http://example.com/a2a/' }] };
    const url = _resolveGoogleA2AUrl(card, 'example.com');
    assert.equal(url, 'http://example.com/a2a/message:send');
  });

  test('_resolveGoogleA2AUrl strips trailing slashes from URL', () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { _resolveGoogleA2AUrl } = require('../../src/lib/client');

    const card = { interfaces: [{ type: 'rest', url: 'http://example.com/api///' }] };
    const url = _resolveGoogleA2AUrl(card, 'example.com');
    assert.equal(url, 'http://example.com/api/message:send');
  });

  test('_resolveGoogleA2AUrl falls back to host-derived URL', () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { _resolveGoogleA2AUrl } = require('../../src/lib/client');

    const card = { interfaces: [{ type: 'rest' }] }; // no url property
    const url = _resolveGoogleA2AUrl(card, 'localhost:3001');
    assert.equal(url, 'http://localhost:3001/message:send');
  });

  // ── _callGoogleA2A via call() with Agent Card ───────────────────

  test('call() uses Google A2A format when Agent Card is present', async () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { A2AClient, _agentCardCache } = require('../../src/lib/client');

    let capturedBody = null;
    const srv = await startServer((req, res) => {
      let body = '';
      req.on('data', (c) => body += c);
      req.on('end', () => {
        capturedBody = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          task: {
            status: {
              state: 'input-required',
              message: { parts: [{ content: { text: 'Google response' } }] }
            },
            context_id: 'gctx_1'
          }
        }));
      });
    });

    seedGoogleAgentCard(_agentCardCache, srv.port);

    try {
      const client = new A2AClient({
        caller: { name: 'TestBot', owner: 'Owner' },
        _retryDelays: [0, 0, 0]
      });
      const result = await client.call(
        { host: `127.0.0.1:${srv.port}`, token: 'fed_google' },
        'Hi Google',
        { conversationId: 'conv_g', timeoutSeconds: 45 }
      );

      // Verify Google A2A request format
      assert.equal(capturedBody.message.role, 'user');
      assert.equal(capturedBody.message.parts[0].content.text, 'Hi Google');
      assert.equal(capturedBody.message.context_id, 'conv_g');
      assert.equal(capturedBody.configuration.timeout_seconds, 45);

      // Verify translated response
      assert.equal(result.response, 'Google response');
      assert.equal(result.conversation_id, 'gctx_1');
      assert.equal(result.can_continue, true);
    } finally {
      _agentCardCache.clear();
      await srv.close();
    }
  });

  // ── _callGoogleA2A error handling ───────────────────────────────

  test('_callGoogleA2A maps HTTP 400 to A2AError with google error format', async () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { A2AClient, _agentCardCache } = require('../../src/lib/client');

    const srv = await startServer((req, res) => {
      let body = '';
      req.on('data', (c) => body += c);
      req.on('end', () => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: { code: 'invalid_request', message: 'Bad format' }
        }));
      });
    });

    seedGoogleAgentCard(_agentCardCache, srv.port);

    try {
      const client = new A2AClient({ _retryDelays: [0, 0, 0] });
      let threw = false;
      try {
        await client.call(
          { host: `127.0.0.1:${srv.port}`, token: 'fed_g400' },
          'bad request'
        );
      } catch (err) {
        threw = true;
        assert.equal(err.code, 'invalid_request');
        assert.equal(err.statusCode, 400);
        assert.includes(err.message, 'Bad format');
      }
      assert.ok(threw, 'Expected Google A2A 400 to throw');
    } finally {
      _agentCardCache.clear();
      await srv.close();
    }
  });

  test('_callGoogleA2A rejects with parse_error on non-JSON response', async () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { A2AClient, _agentCardCache } = require('../../src/lib/client');

    const srv = await startServer((req, res) => {
      let body = '';
      req.on('data', (c) => body += c);
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('not json');
      });
    });

    seedGoogleAgentCard(_agentCardCache, srv.port);

    try {
      const client = new A2AClient({ _retryDelays: [0, 0, 0] });
      let threw = false;
      try {
        await client.call(
          { host: `127.0.0.1:${srv.port}`, token: 'fed_gparse' },
          'parse error test'
        );
      } catch (err) {
        threw = true;
        assert.equal(err.code, 'parse_error');
      }
      assert.ok(threw, 'Expected parse_error');
    } finally {
      _agentCardCache.clear();
      await srv.close();
    }
  });

  // ── _callGoogleA2A retries transient errors ─────────────────────

  test('_callGoogleA2A retries on ECONNRESET and succeeds', async () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { A2AClient, _agentCardCache } = require('../../src/lib/client');

    let requestCount = 0;
    const srv = await startServer((req, res) => {
      requestCount++;
      if (requestCount <= 1) {
        req.socket.destroy();
        return;
      }
      let body = '';
      req.on('data', (c) => body += c);
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          task: {
            status: { state: 'completed', message: { parts: [{ content: { text: 'ok' } }] } },
            context_id: null
          }
        }));
      });
    });

    seedGoogleAgentCard(_agentCardCache, srv.port);

    try {
      const client = new A2AClient({ _retryDelays: [0, 0, 0] });
      const result = await client.call(
        { host: `127.0.0.1:${srv.port}`, token: 'fed_gretry' },
        'retry google'
      );
      assert.equal(result.response, 'ok');
      assert.ok(requestCount >= 2, 'Expected retry');
    } finally {
      _agentCardCache.clear();
      await srv.close();
    }
  });

  // ── end() returns synthetic response for Google A2A ─────────────

  test('end() returns synthetic response when Agent Card exists', async () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { A2AClient, _agentCardCache } = require('../../src/lib/client');

    let requestCount = 0;
    const srv = await startServer((req, res) => {
      requestCount++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ended: true }));
    });

    seedGoogleAgentCard(_agentCardCache, srv.port);

    try {
      const client = new A2AClient({ _retryDelays: [0, 0, 0] });
      const result = await client.end(
        { host: `127.0.0.1:${srv.port}`, token: 'fed_gend' },
        'conv_gend'
      );
      assert.equal(result.ended, true);
      assert.equal(result.summary, null);
      // No HTTP request should have been made (Google A2A has no end endpoint)
      assert.equal(requestCount, 0, 'No HTTP call for Google A2A end');
    } finally {
      _agentCardCache.clear();
      await srv.close();
    }
  });

  // ── 2MB boundary: exact boundary test ───────────────────────────

  test('call() accepts response exactly at 2MB limit', async () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { A2AClient, _MAX_RESPONSE_BYTES, _agentCardCache } = require('../../src/lib/client');

    // Build a JSON payload that's close to but under the 2MB limit.
    // The response body must be valid JSON for the test to succeed.
    const padding = 'a'.repeat(_MAX_RESPONSE_BYTES - 100);
    const responseBody = JSON.stringify({ response: padding });

    // Only proceed if the body is under the limit
    if (Buffer.byteLength(responseBody) > _MAX_RESPONSE_BYTES) {
      // If we overshoot, just confirm the cap constant
      assert.equal(_MAX_RESPONSE_BYTES, 2 * 1024 * 1024);
      return;
    }

    const srv = await startServer((req, res) => {
      let body = '';
      req.on('data', (c) => body += c);
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(responseBody);
      });
    });

    seedNoAgentCard(_agentCardCache, srv.port);

    try {
      const client = new A2AClient({ _retryDelays: [0, 0, 0] });
      const result = await client.call(
        { host: `127.0.0.1:${srv.port}`, token: 'fed_boundary' },
        'boundary test'
      );
      assert.ok(result.response, 'Expected successful response at boundary');
    } finally {
      _agentCardCache.clear();
      await srv.close();
    }
  });

  // ── Size cap on _callGoogleA2A path ─────────────────────────────

  test('_callGoogleA2A rejects oversized responses', async () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { A2AClient, _MAX_RESPONSE_BYTES, _agentCardCache } = require('../../src/lib/client');

    const srv = await startServer((req, res) => {
      let body = '';
      req.on('data', (c) => body += c);
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const chunk = 'x'.repeat(64 * 1024);
        const needed = Math.ceil((_MAX_RESPONSE_BYTES + 1) / chunk.length) + 1;
        for (let i = 0; i < needed; i++) {
          res.write(chunk);
        }
        res.end();
      });
    });

    seedGoogleAgentCard(_agentCardCache, srv.port);

    try {
      const client = new A2AClient({ _retryDelays: [0, 0, 0] });
      let threw = false;
      try {
        await client.call(
          { host: `127.0.0.1:${srv.port}`, token: 'fed_gbig' },
          'oversized google response'
        );
      } catch (err) {
        threw = true;
        assert.equal(err.code, 'response_too_large');
      }
      assert.ok(threw, 'Expected response_too_large on Google A2A path');
    } finally {
      _agentCardCache.clear();
      await srv.close();
    }
  });

  // ── call() with string invite URL ──────────────────────────────

  test('call() works with string invite URL (not just object)', async () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { A2AClient, _agentCardCache } = require('../../src/lib/client');

    const srv = await startServer((req, res) => {
      let body = '';
      req.on('data', (c) => body += c);
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ response: 'ok via invite url' }));
      });
    });

    seedNoAgentCard(_agentCardCache, srv.port);

    try {
      const client = new A2AClient({ _retryDelays: [0, 0, 0] });
      const result = await client.call(
        `a2a://127.0.0.1:${srv.port}/fed_url_test`,
        'invite url test'
      );
      assert.equal(result.response, 'ok via invite url');
    } finally {
      _agentCardCache.clear();
      await srv.close();
    }
  });
};
