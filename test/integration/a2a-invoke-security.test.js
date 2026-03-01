/**
 * A2A-77: Integration tests for invoke handler security boundary
 *
 * Covers: token expiration enforcement, conversation isolation,
 * handler error recovery, timeout bounding, message validation edge cases,
 * caller sanitization, response metadata.
 */

module.exports = function (test, assert, helpers) {
  let appCtx = null;
  let client = null;

  function setup(messageHandler) {
    appCtx = helpers.createTestApp({
      handleMessage: messageHandler || async function (message, context) {
        return {
          text: `security-test received: ${message.slice(0, 80)}`,
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

  // ── Token Expiration ────────────────────────────────────────────

  test('expired token returns 401 unauthorized', async () => {
    const { tokenStore } = setup();
    const { token, record } = tokenStore.create({
      name: 'ExpiredAgent',
      permissions: 'public',
      expires: '1h'
    });
    // Manually backdate expires_at to the past
    const fs = require('fs');
    const path = require('path');
    const dbPath = path.join(appCtx.dir, 'a2a.json');
    const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    const entry = db.tokens.find(t => t.id === record.id);
    entry.expires_at = new Date(Date.now() - 60000).toISOString();
    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));

    const res = await client.post('/api/a2a/invoke', {
      headers: { Authorization: `Bearer ${token}` },
      body: { message: 'Hello from expired token' }
    });

    assert.equal(res.statusCode, 401);
    assert.equal(res.body.error, 'unauthorized');
    await teardown();
  });

  test('valid non-expired token returns 200', async () => {
    const { tokenStore } = setup();
    const { token } = tokenStore.create({
      name: 'ValidAgent',
      permissions: 'public',
      expires: '1h'
    });

    const res = await client.post('/api/a2a/invoke', {
      headers: { Authorization: `Bearer ${token}` },
      body: { message: 'Hello from valid token' }
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    await teardown();
  });

  test('tokens_remaining decrements on successful invoke', async () => {
    const { tokenStore } = setup();
    const { token } = tokenStore.create({
      name: 'CountdownAgent',
      permissions: 'public',
      maxCalls: 5
    });

    const res1 = await client.post('/api/a2a/invoke', {
      headers: { Authorization: `Bearer ${token}` },
      body: { message: 'Call 1' }
    });
    assert.equal(res1.statusCode, 200);
    assert.equal(res1.body.tokens_remaining, 4);

    const res2 = await client.post('/api/a2a/invoke', {
      headers: { Authorization: `Bearer ${token}` },
      body: { message: 'Call 2' }
    });
    assert.equal(res2.statusCode, 200);
    assert.equal(res2.body.tokens_remaining, 3);
    await teardown();
  });

  test('max_calls exhausted token returns 401', async () => {
    const { tokenStore } = setup();
    const { token } = tokenStore.create({
      name: 'LimitedAgent',
      permissions: 'public',
      maxCalls: 2
    });

    // Use up both calls
    await client.post('/api/a2a/invoke', {
      headers: { Authorization: `Bearer ${token}` },
      body: { message: 'Call 1' }
    });
    await client.post('/api/a2a/invoke', {
      headers: { Authorization: `Bearer ${token}` },
      body: { message: 'Call 2' }
    });

    // Third call should fail
    const res = await client.post('/api/a2a/invoke', {
      headers: { Authorization: `Bearer ${token}` },
      body: { message: 'Call 3 — should fail' }
    });

    assert.equal(res.statusCode, 401);
    assert.equal(res.body.error, 'unauthorized');
    await teardown();
  });

  // ── Conversation Isolation ──────────────────────────────────────

  test('different tokens get different conversation_ids', async () => {
    const { tokenStore } = setup();
    const { token: tokenA } = tokenStore.create({ name: 'AgentA', permissions: 'public' });
    const { token: tokenB } = tokenStore.create({ name: 'AgentB', permissions: 'public' });

    const resA = await client.post('/api/a2a/invoke', {
      headers: { Authorization: `Bearer ${tokenA}` },
      body: { message: 'Hello from A' }
    });
    const resB = await client.post('/api/a2a/invoke', {
      headers: { Authorization: `Bearer ${tokenB}` },
      body: { message: 'Hello from B' }
    });

    assert.equal(resA.statusCode, 200);
    assert.equal(resB.statusCode, 200);
    assert.notEqual(resA.body.conversation_id, resB.body.conversation_id);
    await teardown();
  });

  test('providing conversation_id reuses it in response', async () => {
    const { tokenStore } = setup();
    const { token } = tokenStore.create({ name: 'AgentC', permissions: 'public' });

    // First call — get a conversation_id
    const res1 = await client.post('/api/a2a/invoke', {
      headers: { Authorization: `Bearer ${token}` },
      body: { message: 'Start conversation' }
    });
    assert.equal(res1.statusCode, 200);
    const convId = res1.body.conversation_id;
    assert.ok(convId.startsWith('conv_'));

    // Second call — reuse the conversation_id
    const res2 = await client.post('/api/a2a/invoke', {
      headers: { Authorization: `Bearer ${token}` },
      body: { message: 'Continue conversation', conversation_id: convId }
    });
    assert.equal(res2.statusCode, 200);
    assert.equal(res2.body.conversation_id, convId);
    await teardown();
  });

  test('token A sending token B conversation_id gets that ID back but with own identity', async () => {
    let capturedContexts = [];
    const { tokenStore } = setup(async (msg, ctx) => {
      capturedContexts.push({ token_id: ctx.token_id, conversation_id: ctx.conversation_id });
      return { text: 'ok', canContinue: true };
    });
    const { token: tokenA } = tokenStore.create({ name: 'AgentA', permissions: 'public' });
    const { token: tokenB } = tokenStore.create({ name: 'AgentB', permissions: 'public' });

    // Agent B starts a conversation
    const resB = await client.post('/api/a2a/invoke', {
      headers: { Authorization: `Bearer ${tokenB}` },
      body: { message: 'B starts' }
    });
    const convIdB = resB.body.conversation_id;

    // Agent A tries to use B's conversation_id
    const resA = await client.post('/api/a2a/invoke', {
      headers: { Authorization: `Bearer ${tokenA}` },
      body: { message: 'A uses B conv_id', conversation_id: convIdB }
    });

    // The handler accepts the conversation_id (no cross-token validation at this layer)
    assert.equal(resA.statusCode, 200);
    assert.equal(resA.body.conversation_id, convIdB);
    // But the handler received two separate token identities
    assert.equal(capturedContexts.length, 2);
    assert.notEqual(capturedContexts[0].token_id, capturedContexts[1].token_id);
    await teardown();
  });

  // ── Handler Error Recovery ──────────────────────────────────────

  test('handleMessage throwing returns 500 internal_error', async () => {
    setup(async () => { throw new Error('Runtime exploded'); });
    const { token } = appCtx.tokenStore.create({ name: 'CrashAgent', permissions: 'public' });

    const res = await client.post('/api/a2a/invoke', {
      headers: { Authorization: `Bearer ${token}` },
      body: { message: 'Trigger crash' }
    });

    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error, 'internal_error');
    assert.equal(res.body.success, false);
    await teardown();
  });

  test('handleMessage returning null text still produces a response', async () => {
    setup(async () => ({ text: null, canContinue: false }));
    const { token } = appCtx.tokenStore.create({ name: 'NullAgent', permissions: 'public' });

    const res = await client.post('/api/a2a/invoke', {
      headers: { Authorization: `Bearer ${token}` },
      body: { message: 'Get null back' }
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.response, null);
    await teardown();
  });

  // ── Timeout Bounding ────────────────────────────────────────────

  test('timeout_seconds below minimum is clamped to 5s', async () => {
    let capturedTimeout = null;
    setup(async (msg, ctx, opts) => {
      capturedTimeout = opts?.timeout;
      return { text: 'ok', canContinue: true };
    });
    const { token } = appCtx.tokenStore.create({ name: 'TimeoutAgent', permissions: 'public' });

    await client.post('/api/a2a/invoke', {
      headers: { Authorization: `Bearer ${token}` },
      body: { message: 'Test timeout', timeout_seconds: 1 }
    });

    assert.equal(capturedTimeout, 5000);
    await teardown();
  });

  test('timeout_seconds above maximum is clamped to 300s', async () => {
    let capturedTimeout = null;
    setup(async (msg, ctx, opts) => {
      capturedTimeout = opts?.timeout;
      return { text: 'ok', canContinue: true };
    });
    const { token } = appCtx.tokenStore.create({ name: 'TimeoutAgent', permissions: 'public' });

    await client.post('/api/a2a/invoke', {
      headers: { Authorization: `Bearer ${token}` },
      body: { message: 'Test timeout', timeout_seconds: 999 }
    });

    assert.equal(capturedTimeout, 300000);
    await teardown();
  });

  test('timeout_seconds within range is passed through', async () => {
    let capturedTimeout = null;
    setup(async (msg, ctx, opts) => {
      capturedTimeout = opts?.timeout;
      return { text: 'ok', canContinue: true };
    });
    const { token } = appCtx.tokenStore.create({ name: 'TimeoutAgent', permissions: 'public' });

    await client.post('/api/a2a/invoke', {
      headers: { Authorization: `Bearer ${token}` },
      body: { message: 'Test timeout', timeout_seconds: 30 }
    });

    assert.equal(capturedTimeout, 30000);
    await teardown();
  });

  test('non-numeric timeout_seconds defaults to 60s', async () => {
    let capturedTimeout = null;
    setup(async (msg, ctx, opts) => {
      capturedTimeout = opts?.timeout;
      return { text: 'ok', canContinue: true };
    });
    const { token } = appCtx.tokenStore.create({ name: 'TimeoutAgent', permissions: 'public' });

    await client.post('/api/a2a/invoke', {
      headers: { Authorization: `Bearer ${token}` },
      body: { message: 'Test timeout', timeout_seconds: 'not-a-number' }
    });

    assert.equal(capturedTimeout, 60000);
    await teardown();
  });

  // ── Message Validation Edge Cases ───────────────────────────────

  test('empty string message returns 400 missing_message', async () => {
    const { tokenStore } = setup();
    const { token } = tokenStore.create({ name: 'EdgeAgent', permissions: 'public' });

    const res = await client.post('/api/a2a/invoke', {
      headers: { Authorization: `Bearer ${token}` },
      body: { message: '' }
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'missing_message');
    await teardown();
  });

  test('numeric message returns 400 invalid_message', async () => {
    const { tokenStore } = setup();
    const { token } = tokenStore.create({ name: 'EdgeAgent', permissions: 'public' });

    const res = await client.post('/api/a2a/invoke', {
      headers: { Authorization: `Bearer ${token}` },
      body: { message: 12345 }
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'invalid_message');
    await teardown();
  });

  test('message at exactly MAX_MESSAGE_LENGTH (10000) returns 200', async () => {
    const { tokenStore } = setup();
    const { token } = tokenStore.create({ name: 'BoundaryAgent', permissions: 'public' });

    const res = await client.post('/api/a2a/invoke', {
      headers: { Authorization: `Bearer ${token}` },
      body: { message: 'x'.repeat(10000) }
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    await teardown();
  });

  test('message at 10001 chars returns 400 invalid_message', async () => {
    const { tokenStore } = setup();
    const { token } = tokenStore.create({ name: 'BoundaryAgent', permissions: 'public' });

    const res = await client.post('/api/a2a/invoke', {
      headers: { Authorization: `Bearer ${token}` },
      body: { message: 'x'.repeat(10001) }
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'invalid_message');
    await teardown();
  });

  test('object message returns 400 invalid_message', async () => {
    const { tokenStore } = setup();
    const { token } = tokenStore.create({ name: 'EdgeAgent', permissions: 'public' });

    const res = await client.post('/api/a2a/invoke', {
      headers: { Authorization: `Bearer ${token}` },
      body: { message: { text: 'wrapped in object' } }
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'invalid_message');
    await teardown();
  });

  // ── Caller Sanitization ─────────────────────────────────────────

  test('caller fields are truncated to max lengths', async () => {
    let capturedCaller = null;
    setup(async (msg, ctx) => {
      capturedCaller = ctx.caller;
      return { text: 'ok', canContinue: true };
    });
    const { token } = appCtx.tokenStore.create({ name: 'SanitizeAgent', permissions: 'public' });

    await client.post('/api/a2a/invoke', {
      headers: { Authorization: `Bearer ${token}` },
      body: {
        message: 'Test sanitization',
        caller: {
          name: 'A'.repeat(200),
          owner: 'B'.repeat(200),
          instance: 'C'.repeat(300),
          context: 'D'.repeat(600)
        }
      }
    });

    assert.equal(capturedCaller.name.length, 100);
    assert.equal(capturedCaller.owner.length, 100);
    assert.equal(capturedCaller.instance.length, 200);
    assert.equal(capturedCaller.context.length, 500);
    await teardown();
  });

  test('missing caller produces empty caller object', async () => {
    let capturedCaller = null;
    setup(async (msg, ctx) => {
      capturedCaller = ctx.caller;
      return { text: 'ok', canContinue: true };
    });
    const { token } = appCtx.tokenStore.create({ name: 'NoCaller', permissions: 'public' });

    await client.post('/api/a2a/invoke', {
      headers: { Authorization: `Bearer ${token}` },
      body: { message: 'No caller field' }
    });

    assert.deepEqual(capturedCaller, {});
    await teardown();
  });

  // ── Response Metadata ───────────────────────────────────────────

  test('response includes trace_id and request_id', async () => {
    const { tokenStore } = setup();
    const { token } = tokenStore.create({ name: 'MetaAgent', permissions: 'public' });

    const res = await client.post('/api/a2a/invoke', {
      headers: { Authorization: `Bearer ${token}` },
      body: { message: 'Metadata check' }
    });

    assert.equal(res.statusCode, 200);
    assert.ok(res.body.trace_id, 'response has trace_id');
    assert.ok(res.body.request_id, 'response has request_id');
    assert.ok(res.headers['x-trace-id'], 'header has x-trace-id');
    assert.ok(res.headers['x-request-id'], 'header has x-request-id');
    await teardown();
  });

  test('client-provided trace_id is honored', async () => {
    const { tokenStore } = setup();
    const { token } = tokenStore.create({ name: 'TraceAgent', permissions: 'public' });

    const res = await client.post('/api/a2a/invoke', {
      headers: {
        Authorization: `Bearer ${token}`,
        'x-trace-id': 'custom-trace-abc'
      },
      body: { message: 'Trace test' }
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.trace_id, 'custom-trace-abc');
    assert.equal(res.headers['x-trace-id'], 'custom-trace-abc');
    await teardown();
  });

};
