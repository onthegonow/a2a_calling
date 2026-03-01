/**
 * A2A-80: Google A2A Outbound Protocol Support — Unit Tests
 *
 * Covers: Agent Card parsing/validation, cache TTL/eviction/negative caching,
 * request building, response translation (single + multi-part), URL resolution,
 * format auto-detection, fallback to proprietary, end() no-op for Google A2A.
 */

module.exports = function (test, assert, helpers) {

  function freshRequire() {
    delete require.cache[require.resolve('../../src/lib/client')];
    return require('../../src/lib/client');
  }

  // ── _parseAgentCard ───────────────────────────────────────────

  test('_parseAgentCard returns card with valid REST interface', () => {
    const { _parseAgentCard } = freshRequire();
    const card = {
      name: 'test-agent',
      interfaces: [{ type: 'rest', url: 'http://example.com/api/a2a/' }]
    };
    const result = _parseAgentCard(card);
    assert.ok(result, 'should return the card');
    assert.equal(result.name, 'test-agent');
  });

  test('_parseAgentCard returns null for null input', () => {
    const { _parseAgentCard } = freshRequire();
    assert.equal(_parseAgentCard(null), null);
  });

  test('_parseAgentCard returns null for non-object input', () => {
    const { _parseAgentCard } = freshRequire();
    assert.equal(_parseAgentCard('string'), null);
    assert.equal(_parseAgentCard(42), null);
  });

  test('_parseAgentCard returns null for empty interfaces', () => {
    const { _parseAgentCard } = freshRequire();
    assert.equal(_parseAgentCard({ interfaces: [] }), null);
  });

  test('_parseAgentCard returns null for missing interfaces', () => {
    const { _parseAgentCard } = freshRequire();
    assert.equal(_parseAgentCard({ name: 'no-ifaces' }), null);
  });

  test('_parseAgentCard returns null when no REST interface exists', () => {
    const { _parseAgentCard } = freshRequire();
    const card = {
      interfaces: [{ type: 'grpc', url: 'grpc://example.com' }]
    };
    assert.equal(_parseAgentCard(card), null);
  });

  test('_parseAgentCard returns card with multiple interfaces including REST', () => {
    const { _parseAgentCard } = freshRequire();
    const card = {
      interfaces: [
        { type: 'grpc', url: 'grpc://example.com' },
        { type: 'rest', url: 'http://example.com/api/' }
      ]
    };
    const result = _parseAgentCard(card);
    assert.ok(result, 'should return card with REST interface present');
  });

  // ── _translateToGoogleRequest ─────────────────────────────────

  test('_translateToGoogleRequest builds correct message/send body', () => {
    const { _translateToGoogleRequest } = freshRequire();
    const result = _translateToGoogleRequest(
      'Hello!',
      'conv_123',
      { timeoutSeconds: 30 },
      { name: 'TestBot', owner: 'Owner' }
    );

    assert.equal(result.message.role, 'user');
    assert.equal(result.message.parts.length, 1);
    assert.equal(result.message.parts[0].content.text, 'Hello!');
    assert.equal(result.message.context_id, 'conv_123');
    assert.equal(result.metadata.caller_name, 'TestBot');
    assert.equal(result.metadata.caller_owner, 'Owner');
    assert.equal(result.configuration.timeout_seconds, 30);
    assert.equal(result.configuration.blocking, true);
  });

  test('_translateToGoogleRequest omits context_id when null', () => {
    const { _translateToGoogleRequest } = freshRequire();
    const result = _translateToGoogleRequest('Hi', null, {}, {});
    assert.equal(result.message.context_id, undefined);
  });

  test('_translateToGoogleRequest defaults timeout to 60', () => {
    const { _translateToGoogleRequest } = freshRequire();
    const result = _translateToGoogleRequest('Hi', null, {}, {});
    assert.equal(result.configuration.timeout_seconds, 60);
  });

  test('_translateToGoogleRequest truncates long caller fields', () => {
    const { _translateToGoogleRequest } = freshRequire();
    const result = _translateToGoogleRequest('Hi', null, {}, {
      name: 'A'.repeat(200),
      owner: 'B'.repeat(200),
      instance: 'C'.repeat(300)
    });
    assert.equal(result.metadata.caller_name.length, 100);
    assert.equal(result.metadata.caller_owner.length, 100);
    assert.equal(result.metadata.caller_instance.length, 200);
  });

  // ── _translateGoogleResponse ──────────────────────────────────

  test('_translateGoogleResponse translates single-part input-required', () => {
    const { _translateGoogleResponse } = freshRequire();
    const taskResponse = {
      task: {
        id: 'task_1',
        context_id: 'conv_abc',
        status: {
          state: 'input-required',
          message: {
            role: 'agent',
            parts: [{ content: { text: 'Hello back!' } }]
          }
        }
      }
    };
    const result = _translateGoogleResponse(taskResponse);
    assert.equal(result.response, 'Hello back!');
    assert.equal(result.conversation_id, 'conv_abc');
    assert.equal(result.can_continue, true);
  });

  test('_translateGoogleResponse translates completed state', () => {
    const { _translateGoogleResponse } = freshRequire();
    const taskResponse = {
      task: {
        id: 'task_2',
        context_id: 'conv_done',
        status: {
          state: 'completed',
          message: {
            role: 'agent',
            parts: [{ content: { text: 'Goodbye!' } }]
          }
        }
      }
    };
    const result = _translateGoogleResponse(taskResponse);
    assert.equal(result.response, 'Goodbye!');
    assert.equal(result.can_continue, false);
  });

  test('_translateGoogleResponse joins multiple text parts with newline', () => {
    const { _translateGoogleResponse } = freshRequire();
    const taskResponse = {
      task: {
        id: 'task_3',
        context_id: 'conv_multi',
        status: {
          state: 'input-required',
          message: {
            role: 'agent',
            parts: [
              { content: { text: 'Line 1' } },
              { content: { text: 'Line 2' } },
              { content: { text: 'Line 3' } }
            ]
          }
        }
      }
    };
    const result = _translateGoogleResponse(taskResponse);
    assert.equal(result.response, 'Line 1\nLine 2\nLine 3');
  });

  test('_translateGoogleResponse skips non-text parts', () => {
    const { _translateGoogleResponse } = freshRequire();
    const taskResponse = {
      task: {
        id: 'task_4',
        context_id: 'conv_mixed',
        status: {
          state: 'input-required',
          message: {
            role: 'agent',
            parts: [
              { content: { text: 'Text part' } },
              { content: { image: 'base64data' } },
              { blob: 'something' }
            ]
          }
        }
      }
    };
    const result = _translateGoogleResponse(taskResponse);
    assert.equal(result.response, 'Text part');
  });

  test('_translateGoogleResponse returns null conversation_id when absent', () => {
    const { _translateGoogleResponse } = freshRequire();
    const taskResponse = {
      task: {
        id: 'task_5',
        status: {
          state: 'completed',
          message: { role: 'agent', parts: [{ content: { text: 'Done' } }] }
        }
      }
    };
    const result = _translateGoogleResponse(taskResponse);
    assert.equal(result.conversation_id, null);
  });

  test('_translateGoogleResponse throws on missing task', () => {
    const { _translateGoogleResponse, A2AError } = freshRequire();
    let threw = false;
    try {
      _translateGoogleResponse({});
    } catch (err) {
      threw = true;
      assert.equal(err.code, 'google_a2a_error');
    }
    assert.ok(threw, 'Expected google_a2a_error for missing task');
  });

  test('_translateGoogleResponse throws on missing status', () => {
    const { _translateGoogleResponse } = freshRequire();
    let threw = false;
    try {
      _translateGoogleResponse({ task: { id: 'task_6' } });
    } catch (err) {
      threw = true;
      assert.equal(err.code, 'google_a2a_error');
    }
    assert.ok(threw, 'Expected google_a2a_error for missing status');
  });

  test('_translateGoogleResponse handles empty parts array', () => {
    const { _translateGoogleResponse } = freshRequire();
    const taskResponse = {
      task: {
        id: 'task_7',
        context_id: 'conv_empty',
        status: {
          state: 'completed',
          message: { role: 'agent', parts: [] }
        }
      }
    };
    const result = _translateGoogleResponse(taskResponse);
    assert.equal(result.response, '');
  });

  // ── _resolveGoogleA2AUrl ──────────────────────────────────────

  test('_resolveGoogleA2AUrl strips trailing slash and appends /message:send', () => {
    const { _resolveGoogleA2AUrl } = freshRequire();
    const card = {
      interfaces: [{ type: 'rest', url: 'http://example.com/api/a2a/' }]
    };
    const result = _resolveGoogleA2AUrl(card, 'example.com');
    assert.equal(result, 'http://example.com/api/a2a/message:send');
  });

  test('_resolveGoogleA2AUrl works without trailing slash', () => {
    const { _resolveGoogleA2AUrl } = freshRequire();
    const card = {
      interfaces: [{ type: 'rest', url: 'http://example.com/api' }]
    };
    const result = _resolveGoogleA2AUrl(card, 'example.com');
    assert.equal(result, 'http://example.com/api/message:send');
  });

  test('_resolveGoogleA2AUrl falls back to host root when url is absent', () => {
    const { _resolveGoogleA2AUrl } = freshRequire();
    const card = {
      interfaces: [{ type: 'rest' }]
    };
    const result = _resolveGoogleA2AUrl(card, 'localhost:3001');
    assert.equal(result, 'http://localhost:3001/message:send');
  });

  // ── Agent Card Cache ──────────────────────────────────────────

  test('Agent Card cache stores and retrieves entries', () => {
    const { _agentCardCache } = freshRequire();
    const card = { interfaces: [{ type: 'rest', url: 'http://test.com/' }] };
    _agentCardCache.set('test.com:80', { card, cachedAt: Date.now() });
    const entry = _agentCardCache.get('test.com:80');
    assert.ok(entry, 'cache should have entry');
    assert.equal(entry.card.interfaces[0].type, 'rest');
    _agentCardCache.clear();
  });

  test('Agent Card cache stores null for negative caching', () => {
    const { _agentCardCache } = freshRequire();
    _agentCardCache.set('bad.com:80', { card: null, cachedAt: Date.now() });
    const entry = _agentCardCache.get('bad.com:80');
    assert.ok(entry, 'cache should have entry');
    assert.equal(entry.card, null);
    _agentCardCache.clear();
  });

  // ── Agent Card Fetch (HTTP round-trip) ────────────────────────

  const http = require('http');

  function startServer(handler) {
    return new Promise((resolve) => {
      const server = http.createServer(handler);
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        resolve({ port, server, close() { return new Promise(r => server.close(r)); } });
      });
    });
  }

  test('fetchRemoteAgentCard returns valid card from server', async () => {
    const { fetchRemoteAgentCard, _agentCardCache } = freshRequire();
    _agentCardCache.clear();

    const card = {
      name: 'remote-agent',
      interfaces: [{ type: 'rest', url: 'http://localhost/api/' }]
    };
    const srv = await startServer((req, res) => {
      assert.equal(req.url, '/.well-known/a2a-agent-card');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(card));
    });

    try {
      const result = await fetchRemoteAgentCard(`127.0.0.1:${srv.port}`);
      assert.ok(result, 'should return agent card');
      assert.equal(result.name, 'remote-agent');
      // Should be cached
      const cached = _agentCardCache.get(`127.0.0.1:${srv.port}`);
      assert.ok(cached, 'should be cached');
      assert.ok(cached.card, 'cached card should not be null');
    } finally {
      _agentCardCache.clear();
      await srv.close();
    }
  });

  test('fetchRemoteAgentCard returns null on 404', async () => {
    const { fetchRemoteAgentCard, _agentCardCache } = freshRequire();
    _agentCardCache.clear();

    const srv = await startServer((req, res) => {
      res.writeHead(404);
      res.end('Not Found');
    });

    try {
      const result = await fetchRemoteAgentCard(`127.0.0.1:${srv.port}`);
      assert.equal(result, null);
      // Should be negative-cached
      const cached = _agentCardCache.get(`127.0.0.1:${srv.port}`);
      assert.ok(cached, 'should be negative-cached');
      assert.equal(cached.card, null);
    } finally {
      _agentCardCache.clear();
      await srv.close();
    }
  });

  test('fetchRemoteAgentCard returns null on invalid JSON', async () => {
    const { fetchRemoteAgentCard, _agentCardCache } = freshRequire();
    _agentCardCache.clear();

    const srv = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('not json at all');
    });

    try {
      const result = await fetchRemoteAgentCard(`127.0.0.1:${srv.port}`);
      assert.equal(result, null);
    } finally {
      _agentCardCache.clear();
      await srv.close();
    }
  });

  test('fetchRemoteAgentCard returns null when card has no REST interface', async () => {
    const { fetchRemoteAgentCard, _agentCardCache } = freshRequire();
    _agentCardCache.clear();

    const card = { interfaces: [{ type: 'grpc' }] };
    const srv = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(card));
    });

    try {
      const result = await fetchRemoteAgentCard(`127.0.0.1:${srv.port}`);
      assert.equal(result, null);
    } finally {
      _agentCardCache.clear();
      await srv.close();
    }
  });

  test('fetchRemoteAgentCard returns cached result on second call', async () => {
    const { fetchRemoteAgentCard, _agentCardCache } = freshRequire();
    _agentCardCache.clear();

    let requestCount = 0;
    const card = {
      name: 'cached-agent',
      interfaces: [{ type: 'rest', url: 'http://localhost/' }]
    };
    const srv = await startServer((req, res) => {
      requestCount++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(card));
    });

    try {
      await fetchRemoteAgentCard(`127.0.0.1:${srv.port}`);
      await fetchRemoteAgentCard(`127.0.0.1:${srv.port}`);
      assert.equal(requestCount, 1, 'should only fetch once due to cache');
    } finally {
      _agentCardCache.clear();
      await srv.close();
    }
  });

  test('fetchRemoteAgentCard returns null on connection error (negative cache)', async () => {
    const { fetchRemoteAgentCard, _agentCardCache } = freshRequire();
    _agentCardCache.clear();

    const net = require('net');
    const unusedPort = await new Promise((resolve) => {
      const s = net.createServer();
      s.listen(0, '127.0.0.1', () => {
        const port = s.address().port;
        s.close(() => resolve(port));
      });
    });

    try {
      const result = await fetchRemoteAgentCard(`127.0.0.1:${unusedPort}`);
      assert.equal(result, null);
      // Negative cache entry
      const cached = _agentCardCache.get(`127.0.0.1:${unusedPort}`);
      assert.ok(cached, 'should be negative-cached');
      assert.equal(cached.card, null);
    } finally {
      _agentCardCache.clear();
    }
  });

  // ── call() auto-detection ─────────────────────────────────────

  test('call() uses Google A2A format when Agent Card is present', async () => {
    const { A2AClient, _agentCardCache } = freshRequire();
    _agentCardCache.clear();

    let agentCardRequested = false;
    let messageRequest = null;

    const googleResponse = {
      task: {
        id: 'task_auto',
        context_id: 'conv_auto',
        status: {
          state: 'input-required',
          message: {
            role: 'agent',
            parts: [{ content: { text: 'Google A2A response' } }]
          }
        }
      }
    };

    const srv = await startServer((req, res) => {
      if (req.url === '/.well-known/a2a-agent-card') {
        agentCardRequested = true;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          name: 'remote',
          interfaces: [{ type: 'rest', url: `http://127.0.0.1:${srv.port}/api/a2a/` }]
        }));
        return;
      }
      // Capture the message:send request
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        messageRequest = { url: req.url, body: JSON.parse(body), headers: req.headers };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(googleResponse));
      });
    });

    try {
      const client = new A2AClient({ _retryDelays: [0, 0, 0], caller: { name: 'TestBot' } });
      const result = await client.call(
        { host: `127.0.0.1:${srv.port}`, token: 'fed_google' },
        'Hello Google A2A!'
      );

      assert.ok(agentCardRequested, 'should fetch Agent Card');
      assert.ok(messageRequest, 'should send message:send request');
      assert.equal(messageRequest.url, '/api/a2a/message:send');
      assert.equal(messageRequest.body.message.parts[0].content.text, 'Hello Google A2A!');
      assert.equal(messageRequest.headers['authorization'], 'Bearer fed_google');

      // Verify translated response
      assert.equal(result.response, 'Google A2A response');
      assert.equal(result.conversation_id, 'conv_auto');
      assert.equal(result.can_continue, true);
    } finally {
      _agentCardCache.clear();
      await srv.close();
    }
  });

  test('call() falls back to proprietary when no Agent Card', async () => {
    const { A2AClient, _agentCardCache } = freshRequire();
    _agentCardCache.clear();

    let requestUrl = null;

    const srv = await startServer((req, res) => {
      if (req.url === '/.well-known/a2a-agent-card') {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }
      requestUrl = req.url;
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ response: 'proprietary response', conversation_id: 'conv_prop' }));
      });
    });

    try {
      const client = new A2AClient({ _retryDelays: [0, 0, 0] });
      const result = await client.call(
        { host: `127.0.0.1:${srv.port}`, token: 'fed_prop' },
        'Hello proprietary!'
      );

      assert.equal(requestUrl, '/api/a2a/invoke', 'should use proprietary invoke path');
      assert.equal(result.response, 'proprietary response');
      assert.equal(result.conversation_id, 'conv_prop');
    } finally {
      _agentCardCache.clear();
      await srv.close();
    }
  });

  // ── call() multi-turn context_id threading ────────────────────

  test('call() threads context_id through Google A2A multi-turn', async () => {
    const { A2AClient, _agentCardCache } = freshRequire();
    _agentCardCache.clear();

    let capturedContextId = null;

    const srv = await startServer((req, res) => {
      if (req.url === '/.well-known/a2a-agent-card') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          interfaces: [{ type: 'rest', url: `http://127.0.0.1:${srv.port}/api/a2a/` }]
        }));
        return;
      }
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        const parsed = JSON.parse(body);
        capturedContextId = parsed.message.context_id;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          task: {
            id: 'task_mt',
            context_id: 'conv_multi_turn',
            status: {
              state: 'input-required',
              message: { role: 'agent', parts: [{ content: { text: 'Turn response' } }] }
            }
          }
        }));
      });
    });

    try {
      const client = new A2AClient({ _retryDelays: [0, 0, 0] });
      await client.call(
        { host: `127.0.0.1:${srv.port}`, token: 'fed_mt' },
        'Turn 2',
        { conversationId: 'conv_existing' }
      );
      assert.equal(capturedContextId, 'conv_existing', 'should thread context_id');
    } finally {
      _agentCardCache.clear();
      await srv.close();
    }
  });

  // ── end() no-op for Google A2A ────────────────────────────────

  test('end() returns synthetic response for Google A2A remote', async () => {
    const { A2AClient, _agentCardCache } = freshRequire();
    _agentCardCache.clear();

    let endRequested = false;
    const srv = await startServer((req, res) => {
      if (req.url === '/.well-known/a2a-agent-card') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          interfaces: [{ type: 'rest', url: `http://127.0.0.1:${srv.port}/` }]
        }));
        return;
      }
      endRequested = true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ended: true, summary: 'should not reach' }));
    });

    try {
      const client = new A2AClient({ _retryDelays: [0, 0, 0] });
      const result = await client.end(
        { host: `127.0.0.1:${srv.port}`, token: 'fed_end_google' },
        'conv_end_google'
      );
      assert.equal(endRequested, false, 'should NOT send end request to Google A2A remote');
      assert.equal(result.ended, true);
      assert.equal(result.summary, null);
    } finally {
      _agentCardCache.clear();
      await srv.close();
    }
  });

  test('end() uses proprietary path when no Agent Card', async () => {
    const { A2AClient, _agentCardCache } = freshRequire();
    _agentCardCache.clear();

    let endUrl = null;
    const srv = await startServer((req, res) => {
      if (req.url === '/.well-known/a2a-agent-card') {
        res.writeHead(404);
        res.end();
        return;
      }
      endUrl = req.url;
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ended: true, summary: 'Prop summary' }));
      });
    });

    try {
      const client = new A2AClient({ _retryDelays: [0, 0, 0] });
      const result = await client.end(
        { host: `127.0.0.1:${srv.port}`, token: 'fed_end_prop' },
        'conv_end_prop'
      );
      assert.equal(endUrl, '/api/a2a/end', 'should use proprietary end path');
      assert.equal(result.ended, true);
      assert.equal(result.summary, 'Prop summary');
    } finally {
      _agentCardCache.clear();
      await srv.close();
    }
  });

  // ── Google A2A error handling ─────────────────────────────────

  test('call() maps Google A2A error response to A2AError', async () => {
    const { A2AClient, _agentCardCache } = freshRequire();
    _agentCardCache.clear();

    const srv = await startServer((req, res) => {
      if (req.url === '/.well-known/a2a-agent-card') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          interfaces: [{ type: 'rest', url: `http://127.0.0.1:${srv.port}/api/a2a/` }]
        }));
        return;
      }
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: { code: 'invalid_request', message: 'Bad message format' }
        }));
      });
    });

    try {
      const client = new A2AClient({ _retryDelays: [0, 0, 0] });
      let threw = false;
      try {
        await client.call(
          { host: `127.0.0.1:${srv.port}`, token: 'fed_err' },
          'Error test'
        );
      } catch (err) {
        threw = true;
        assert.equal(err.code, 'invalid_request');
        assert.includes(err.message, 'Bad message format');
        assert.equal(err.statusCode, 400);
      }
      assert.ok(threw, 'Expected A2AError from Google A2A error');
    } finally {
      _agentCardCache.clear();
      await srv.close();
    }
  });

};
