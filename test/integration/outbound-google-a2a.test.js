/**
 * A2A-80: Google A2A Outbound Protocol — Integration Tests
 *
 * Full round-trip tests with a mock Google A2A server:
 * - Complete call flow (Agent Card discovery → message:send → response translation)
 * - Multi-turn conversation with context_id threading
 * - Fallback when no Agent Card available
 * - Error handling from Google A2A remote
 * - end() no-op for Google A2A remotes
 */

const http = require('http');

module.exports = function (test, assert, helpers) {

  function freshRequire() {
    delete require.cache[require.resolve('../../src/lib/client')];
    return require('../../src/lib/client');
  }

  /**
   * Start a mock Google A2A server that serves Agent Card and handles message:send.
   * Options:
   *   agentCard: object|null - Agent Card to serve (null = 404)
   *   onMessage: fn(body, req) -> response - handler for message:send
   */
  function startGoogleA2AServer(options = {}) {
    return new Promise((resolve) => {
      const requests = [];
      const server = http.createServer((req, res) => {
        if (req.url === '/.well-known/a2a-agent-card') {
          if (options.agentCard) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(options.agentCard));
          } else {
            res.writeHead(404);
            res.end('Not Found');
          }
          return;
        }

        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
          const parsed = JSON.parse(body);
          requests.push({ url: req.url, body: parsed, headers: req.headers });

          if (options.onMessage) {
            const response = options.onMessage(parsed, req);
            if (response.statusCode) {
              res.writeHead(response.statusCode, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(response.body));
            } else {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(response));
            }
          } else {
            // Default: echo back with input-required
            const contextId = parsed.message?.context_id || `conv_${Date.now()}`;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              task: {
                id: `task_${Date.now()}`,
                context_id: contextId,
                status: {
                  state: 'input-required',
                  message: {
                    role: 'agent',
                    parts: [{ content: { text: `echo: ${parsed.message?.parts?.[0]?.content?.text || ''}` } }]
                  }
                }
              }
            }));
          }
        });
      });

      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        resolve({
          port,
          requests,
          close() { return new Promise(r => server.close(r)); }
        });
      });
    });
  }

  // ── Full Google A2A call flow ─────────────────────────────────

  test('full Google A2A outbound call: Agent Card discovery → message:send → translated response', async () => {
    const { A2AClient, _agentCardCache } = freshRequire();
    _agentCardCache.clear();

    const srv = await startGoogleA2AServer({
      agentCard: null, // will be set per-port below
      onMessage(body) {
        return {
          task: {
            id: 'task_full',
            context_id: 'conv_full',
            status: {
              state: 'input-required',
              message: {
                role: 'agent',
                parts: [
                  { content: { text: 'Hello from Google A2A!' } },
                  { content: { text: 'How can I help?' } }
                ]
              }
            }
          }
        };
      }
    });

    // Pre-seed Agent Card in cache since we can't have a dynamic server URL in the card before creation
    _agentCardCache.set(`127.0.0.1:${srv.port}`, {
      card: {
        name: 'full-test-agent',
        interfaces: [{ type: 'rest', url: `http://127.0.0.1:${srv.port}/api/a2a/` }]
      },
      cachedAt: Date.now()
    });

    try {
      const client = new A2AClient({
        _retryDelays: [0, 0, 0],
        caller: { name: 'IntegrationBot', owner: 'Test Owner' }
      });

      const result = await client.call(
        { host: `127.0.0.1:${srv.port}`, token: 'fed_full_flow' },
        'Hello integration test!'
      );

      // Verify response shape
      assert.equal(result.response, 'Hello from Google A2A!\nHow can I help?');
      assert.equal(result.conversation_id, 'conv_full');
      assert.equal(result.can_continue, true);

      // Verify request was sent correctly
      assert.equal(srv.requests.length, 1);
      const req = srv.requests[0];
      assert.equal(req.url, '/api/a2a/message:send');
      assert.equal(req.body.message.role, 'user');
      assert.equal(req.body.message.parts[0].content.text, 'Hello integration test!');
      assert.equal(req.body.metadata.caller_name, 'IntegrationBot');
      assert.equal(req.body.metadata.caller_owner, 'Test Owner');
      assert.equal(req.body.configuration.blocking, true);
      assert.equal(req.headers['authorization'], 'Bearer fed_full_flow');
    } finally {
      _agentCardCache.clear();
      await srv.close();
    }
  });

  // ── Multi-turn conversation ───────────────────────────────────

  test('multi-turn Google A2A conversation threads context_id', async () => {
    const { A2AClient, _agentCardCache } = freshRequire();
    _agentCardCache.clear();

    let turnCount = 0;
    const srv = await startGoogleA2AServer({
      onMessage(body) {
        turnCount++;
        const contextId = body.message?.context_id || `conv_new_${Date.now()}`;
        return {
          task: {
            id: `task_turn_${turnCount}`,
            context_id: contextId,
            status: {
              state: turnCount < 3 ? 'input-required' : 'completed',
              message: {
                role: 'agent',
                parts: [{ content: { text: `Turn ${turnCount} response` } }]
              }
            }
          }
        };
      }
    });

    _agentCardCache.set(`127.0.0.1:${srv.port}`, {
      card: { interfaces: [{ type: 'rest', url: `http://127.0.0.1:${srv.port}/api/a2a/` }] },
      cachedAt: Date.now()
    });

    try {
      const client = new A2AClient({ _retryDelays: [0, 0, 0] });
      const endpoint = { host: `127.0.0.1:${srv.port}`, token: 'fed_mt' };

      // Turn 1: no conversation ID
      const r1 = await client.call(endpoint, 'First message');
      assert.equal(r1.can_continue, true);
      assert.ok(r1.conversation_id, 'should have conversation_id');

      // Turn 2: thread the conversation ID from turn 1
      const r2 = await client.call(endpoint, 'Second message', {
        conversationId: r1.conversation_id
      });
      assert.equal(r2.can_continue, true);

      // Verify context_id was threaded in turn 2
      assert.equal(srv.requests[1].body.message.context_id, r1.conversation_id);

      // Turn 3: completed
      const r3 = await client.call(endpoint, 'Third message', {
        conversationId: r2.conversation_id
      });
      assert.equal(r3.can_continue, false);
    } finally {
      _agentCardCache.clear();
      await srv.close();
    }
  });

  // ── Fallback to proprietary ───────────────────────────────────

  test('falls back to proprietary when Agent Card returns 404', async () => {
    const { A2AClient, _agentCardCache } = freshRequire();
    _agentCardCache.clear();

    const srv = await startGoogleA2AServer({
      agentCard: null, // 404 for Agent Card
      onMessage() {
        // This should not be reached via message:send
        return { task: { id: 'wrong', status: { state: 'completed', message: { parts: [] } } } };
      }
    });

    // We need a server that handles BOTH agent card (404) and /api/a2a/invoke
    await srv.close();

    const propSrv = await new Promise((resolve) => {
      let requestUrl = null;
      const server = http.createServer((req, res) => {
        if (req.url === '/.well-known/a2a-agent-card') {
          res.writeHead(404);
          res.end();
          return;
        }
        requestUrl = req.url;
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ response: 'proprietary!', conversation_id: 'conv_prop' }));
        });
      });
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        resolve({
          port,
          getUrl() { return requestUrl; },
          close() { return new Promise(r => server.close(r)); }
        });
      });
    });

    try {
      const client = new A2AClient({ _retryDelays: [0, 0, 0] });
      const result = await client.call(
        { host: `127.0.0.1:${propSrv.port}`, token: 'fed_fallback' },
        'Proprietary test'
      );
      assert.equal(propSrv.getUrl(), '/api/a2a/invoke');
      assert.equal(result.response, 'proprietary!');
    } finally {
      _agentCardCache.clear();
      await propSrv.close();
    }
  });

  // ── Error handling ────────────────────────────────────────────

  test('Google A2A error response is mapped to A2AError', async () => {
    const { A2AClient, _agentCardCache } = freshRequire();
    _agentCardCache.clear();

    const srv = await startGoogleA2AServer({
      onMessage() {
        return {
          statusCode: 403,
          body: { error: { code: 'forbidden', message: 'Token expired' } }
        };
      }
    });

    _agentCardCache.set(`127.0.0.1:${srv.port}`, {
      card: { interfaces: [{ type: 'rest', url: `http://127.0.0.1:${srv.port}/api/a2a/` }] },
      cachedAt: Date.now()
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
        assert.equal(err.code, 'forbidden');
        assert.includes(err.message, 'Token expired');
        assert.equal(err.statusCode, 403);
      }
      assert.ok(threw, 'Expected A2AError from Google A2A 403');
    } finally {
      _agentCardCache.clear();
      await srv.close();
    }
  });

  // ── end() no-op for Google A2A ────────────────────────────────

  test('end() is no-op for Google A2A remotes and returns synthetic response', async () => {
    const { A2AClient, _agentCardCache } = freshRequire();
    _agentCardCache.clear();

    let endRequestReceived = false;
    const srv = await new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        if (req.url === '/.well-known/a2a-agent-card') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            interfaces: [{ type: 'rest', url: `http://127.0.0.1:${server.address().port}/` }]
          }));
          return;
        }
        endRequestReceived = true;
        res.writeHead(200);
        res.end('{}');
      });
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        resolve({ port, server, close() { return new Promise(r => server.close(r)); } });
      });
    });

    try {
      const client = new A2AClient({ _retryDelays: [0, 0, 0] });
      const result = await client.end(
        { host: `127.0.0.1:${srv.port}`, token: 'fed_end_noop' },
        'conv_end_noop'
      );
      assert.equal(endRequestReceived, false, 'should NOT hit end endpoint');
      assert.equal(result.ended, true);
      assert.equal(result.summary, null);
    } finally {
      _agentCardCache.clear();
      await srv.close();
    }
  });

};
