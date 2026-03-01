/**
 * A2A-78: Google A2A Protocol Inbound — POST /message:send
 *
 * Integration tests covering: valid Google A2A format request/response,
 * text part extraction, context_id → conversation_id mapping, auth reuse,
 * rate limiting, invalid/missing parts rejected, multiple text parts
 * concatenated, non-text parts skipped, TaskState mapping.
 */

module.exports = function (test, assert, helpers) {
  let appCtx = null;
  let client = null;

  function setup(messageHandler) {
    appCtx = helpers.createTestApp({
      handleMessage: messageHandler || async function (message, context) {
        return {
          text: `agent received: ${message.slice(0, 80)}`,
          canContinue: true
        };
      }
    });
    client = helpers.request(appCtx.app);
    return appCtx;
  }

  async function teardown() {
    if (client) await client.close();
    if (appCtx) appCtx.cleanup();
    appCtx = null;
    client = null;
  }

  function makeGoogleBody(textParts, opts = {}) {
    const parts = (textParts || []).map(t => {
      if (typeof t === 'string') return { content: { text: t } };
      return t;
    });
    return {
      message: {
        message_id: opts.message_id || `msg_${Date.now()}`,
        role: 'user',
        parts,
        ...(opts.context_id ? { context_id: opts.context_id } : {})
      },
      configuration: {
        acceptedOutputModes: ['text'],
        blocking: opts.blocking !== undefined ? opts.blocking : true,
        ...(opts.timeout_seconds ? { timeout_seconds: opts.timeout_seconds } : {})
      },
      metadata: opts.metadata || {}
    };
  }

  // ── Happy Path ─────────────────────────────────────────────────

  test('POST /message:send with valid Google A2A format returns Task object', async () => {
    const { tokenStore } = setup();
    const { token } = tokenStore.create({ name: 'RemoteAgent', permissions: 'friends' });

    const res = await client.post('/api/a2a/message%3Asend', {
      headers: { Authorization: `Bearer ${token}` },
      body: makeGoogleBody(['Hello from Google A2A!'])
    });

    assert.equal(res.statusCode, 200);
    assert.ok(res.body.task, 'response has task object');
    assert.ok(res.body.task.id, 'task has id');
    assert.ok(res.body.task.id.startsWith('task_'), 'task id starts with task_');
    assert.ok(res.body.task.context_id, 'task has context_id');
    assert.ok(res.body.task.context_id.startsWith('conv_'), 'context_id maps to conv_ id');
    assert.ok(res.body.task.status, 'task has status');
    assert.equal(res.body.task.status.state, 'input-required');
    assert.ok(res.body.task.status.message, 'status has message');
    assert.equal(res.body.task.status.message.role, 'agent');
    assert.ok(Array.isArray(res.body.task.status.message.parts), 'message has parts array');
    assert.equal(res.body.task.status.message.parts.length, 1);
    assert.ok(res.body.task.status.message.parts[0].content.text.includes('agent received:'));
    assert.ok(res.body.task.status.timestamp, 'status has timestamp');
    await teardown();
  });

  // ── TaskState Mapping ──────────────────────────────────────────

  test('can_continue:true maps to input-required state', async () => {
    setup(async () => ({ text: 'More input needed', canContinue: true }));
    const { token } = appCtx.tokenStore.create({ name: 'Agent', permissions: 'public' });

    const res = await client.post('/api/a2a/message%3Asend', {
      headers: { Authorization: `Bearer ${token}` },
      body: makeGoogleBody(['Test'])
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.task.status.state, 'input-required');
    await teardown();
  });

  test('can_continue:false maps to completed state', async () => {
    setup(async () => ({ text: 'Done', canContinue: false }));
    const { token } = appCtx.tokenStore.create({ name: 'Agent', permissions: 'public' });

    const res = await client.post('/api/a2a/message%3Asend', {
      headers: { Authorization: `Bearer ${token}` },
      body: makeGoogleBody(['Test'])
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.task.status.state, 'completed');
    await teardown();
  });

  // ── Response Metadata ──────────────────────────────────────────

  test('response includes openclaw metadata in task.metadata', async () => {
    const { tokenStore } = setup();
    const { token } = tokenStore.create({ name: 'Agent', permissions: 'friends' });

    const res = await client.post('/api/a2a/message%3Asend', {
      headers: { Authorization: `Bearer ${token}` },
      body: makeGoogleBody(['Hello'])
    });

    assert.equal(res.statusCode, 200);
    const meta = res.body.task.metadata;
    assert.ok(meta, 'task has metadata');
    assert.equal(meta['openclaw:tier'], 'friends');
    assert.ok(meta['openclaw:disclosure'], 'disclosure is present');
    assert.ok(typeof meta['openclaw:calls_remaining'] === 'number' || meta['openclaw:calls_remaining'] === undefined,
      'calls_remaining is number or undefined');
    await teardown();
  });

  // ── Text Part Extraction ───────────────────────────────────────

  test('multiple text parts are concatenated', async () => {
    let receivedMessage = null;
    setup(async (msg) => {
      receivedMessage = msg;
      return { text: 'ok', canContinue: true };
    });
    const { token } = appCtx.tokenStore.create({ name: 'Agent', permissions: 'public' });

    await client.post('/api/a2a/message%3Asend', {
      headers: { Authorization: `Bearer ${token}` },
      body: makeGoogleBody(['First part.', 'Second part.', 'Third part.'])
    });

    assert.equal(receivedMessage, 'First part.\nSecond part.\nThird part.');
    await teardown();
  });

  test('non-text parts are skipped gracefully', async () => {
    let receivedMessage = null;
    setup(async (msg) => {
      receivedMessage = msg;
      return { text: 'ok', canContinue: true };
    });
    const { token } = appCtx.tokenStore.create({ name: 'Agent', permissions: 'public' });

    const res = await client.post('/api/a2a/message%3Asend', {
      headers: { Authorization: `Bearer ${token}` },
      body: makeGoogleBody([
        'Hello text',
        { content: { url: 'https://example.com/file.pdf' } },
        { content: { data: { key: 'value' } } }
      ])
    });

    assert.equal(res.statusCode, 200);
    assert.equal(receivedMessage, 'Hello text');
    await teardown();
  });

  // ── context_id → conversation_id Mapping ───────────────────────

  test('context_id maps to conversation_id for conversation continuity', async () => {
    const { tokenStore } = setup();
    const { token } = tokenStore.create({ name: 'Agent', permissions: 'public' });

    // First call — no context_id, gets a new conversation
    const res1 = await client.post('/api/a2a/message%3Asend', {
      headers: { Authorization: `Bearer ${token}` },
      body: makeGoogleBody(['First message'])
    });
    assert.equal(res1.statusCode, 200);
    const contextId = res1.body.task.context_id;
    assert.ok(contextId.startsWith('conv_'));

    // Second call — pass context_id from first response
    const res2 = await client.post('/api/a2a/message%3Asend', {
      headers: { Authorization: `Bearer ${token}` },
      body: makeGoogleBody(['Follow-up'], { context_id: contextId })
    });
    assert.equal(res2.statusCode, 200);
    assert.equal(res2.body.task.context_id, contextId);
    await teardown();
  });

  // ── Auth Enforcement ───────────────────────────────────────────

  test('missing bearer token returns 401', async () => {
    setup();
    const res = await client.post('/api/a2a/message%3Asend', {
      body: makeGoogleBody(['Hello'])
    });

    assert.equal(res.statusCode, 401);
    assert.equal(res.body.error, 'missing_token');
    await teardown();
  });

  test('invalid bearer token returns 401', async () => {
    setup();
    const res = await client.post('/api/a2a/message%3Asend', {
      headers: { Authorization: 'Bearer fed_invalid_token_12345' },
      body: makeGoogleBody(['Hello'])
    });

    assert.equal(res.statusCode, 401);
    assert.equal(res.body.error, 'unauthorized');
    await teardown();
  });

  // ── Rate Limiting ──────────────────────────────────────────────

  test('rate limiting is shared with /invoke (same token, same limits)', async () => {
    const { tokenStore } = setup();
    const { token } = tokenStore.create({ name: 'Agent', permissions: 'public' });

    // Exhaust the rate limit via /invoke first (default: 10/min)
    for (let i = 0; i < 10; i++) {
      await client.post('/api/a2a/invoke', {
        headers: { Authorization: `Bearer ${token}` },
        body: { message: `Call ${i}` }
      });
    }

    // Now /message:send should be rate limited
    const res = await client.post('/api/a2a/message%3Asend', {
      headers: { Authorization: `Bearer ${token}` },
      body: makeGoogleBody(['Should be rate limited'])
    });

    assert.equal(res.statusCode, 429);
    assert.equal(res.body.error, 'rate_limited');
    await teardown();
  });

  // ── Format Validation ──────────────────────────────────────────

  test('missing message object returns 400', async () => {
    const { tokenStore } = setup();
    const { token } = tokenStore.create({ name: 'Agent', permissions: 'public' });

    const res = await client.post('/api/a2a/message%3Asend', {
      headers: { Authorization: `Bearer ${token}` },
      body: { configuration: { blocking: true } }
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'invalid_message');
    await teardown();
  });

  test('empty parts array returns 400', async () => {
    const { tokenStore } = setup();
    const { token } = tokenStore.create({ name: 'Agent', permissions: 'public' });

    const res = await client.post('/api/a2a/message%3Asend', {
      headers: { Authorization: `Bearer ${token}` },
      body: {
        message: { message_id: 'msg_1', role: 'user', parts: [] }
      }
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'invalid_message');
    await teardown();
  });

  test('only non-text parts returns 400 (no text content)', async () => {
    const { tokenStore } = setup();
    const { token } = tokenStore.create({ name: 'Agent', permissions: 'public' });

    const res = await client.post('/api/a2a/message%3Asend', {
      headers: { Authorization: `Bearer ${token}` },
      body: makeGoogleBody([
        { content: { url: 'https://example.com/file.pdf' } },
        { content: { data: { key: 'value' } } }
      ])
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'no_text_content');
    await teardown();
  });

  // ── Existing /invoke Unchanged ─────────────────────────────────

  test('existing /invoke endpoint still works with same response format', async () => {
    const { tokenStore } = setup();
    const { token } = tokenStore.create({ name: 'Agent', permissions: 'public' });

    const res = await client.post('/api/a2a/invoke', {
      headers: { Authorization: `Bearer ${token}` },
      body: { message: 'Hello from native format' }
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.ok(res.body.trace_id, 'has trace_id');
    assert.ok(res.body.request_id, 'has request_id');
    assert.ok(res.body.conversation_id, 'has conversation_id');
    assert.ok(typeof res.body.response === 'string', 'response is a string');
    assert.equal(res.body.can_continue, true);
    // Verify it does NOT have Google A2A task format
    assert.equal(res.body.task, undefined);
    await teardown();
  });

  // ── Caller Metadata ────────────────────────────────────────────

  test('metadata.caller_name is passed through to handler context', async () => {
    let capturedContext = null;
    setup(async (msg, ctx) => {
      capturedContext = ctx;
      return { text: 'ok', canContinue: true };
    });
    const { token } = appCtx.tokenStore.create({ name: 'Agent', permissions: 'public' });

    await client.post('/api/a2a/message%3Asend', {
      headers: { Authorization: `Bearer ${token}` },
      body: makeGoogleBody(['Hello'], {
        metadata: { caller_name: 'Alice', caller_instance: 'alice.example.com' }
      })
    });

    assert.ok(capturedContext, 'handler context was captured');
    assert.equal(capturedContext.caller.name, 'Alice');
    assert.equal(capturedContext.caller.instance, 'alice.example.com');
    assert.equal(capturedContext.mode, 'a2a');
    await teardown();
  });

  // ── URL Encoding ───────────────────────────────────────────────

  test('percent-encoded path /message%3Asend works', async () => {
    const { tokenStore } = setup();
    const { token } = tokenStore.create({ name: 'Agent', permissions: 'public' });

    const res = await client.post('/api/a2a/message%3Asend', {
      headers: { Authorization: `Bearer ${token}` },
      body: makeGoogleBody(['Hello via percent encoding'])
    });

    assert.equal(res.statusCode, 200);
    assert.ok(res.body.task);
    await teardown();
  });

};
