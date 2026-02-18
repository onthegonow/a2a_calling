/**
 * Call Flow Integration Test — Golda Deluxe → claudebot
 *
 * Simulates a complete inbound A2A call lifecycle:
 *
 *   1. Set up server with Golda's token
 *   2. POST /invoke as Golda Deluxe calling claudebot
 *   3. Verify response structure
 *   4. Continue conversation (multi-turn)
 *   5. End conversation via POST /end
 *   6. Verify conversation is stored and summarized
 *
 * Also tests error cases: missing auth, bad tokens,
 * rate limiting, oversized messages, missing message body.
 */

module.exports = function (test, assert, helpers) {
  let appCtx = null;
  let client = null;

  // ── Setup / Teardown ──────────────────────────────────────────

  function setup(messageHandler) {
    appCtx = helpers.createTestApp({
      handleMessage: messageHandler || async function (message, context) {
        return {
          text: `claudebot received: ${message.slice(0, 50)}`,
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

  // ── Health / Status ───────────────────────────────────────────

  test('GET /ping returns pong', async () => {
    setup();
    const res = await client.get('/api/a2a/ping');
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.pong);
    assert.ok(res.body.timestamp);
    await teardown();
  });

  test('GET /status returns capabilities', async () => {
    setup();
    const res = await client.get('/api/a2a/status');
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.a2a);
    assert.includes(res.body.capabilities, 'invoke');
    assert.includes(res.body.capabilities, 'multi-turn');
    await teardown();
  });

  // ── Golda Calls claudebot (Happy Path) ────────────────────────

  test('Golda Deluxe calls claudebot — full invoke flow', async () => {
    const { tokenStore } = setup();
    const profile = helpers.goldaDeluxeProfile();

    // Create token for Golda
    const { token } = tokenStore.create({
      name: profile.agent.name,
      owner: profile.agent.owner,
      permissions: profile.token.tier,
      maxCalls: profile.token.maxCalls,
      allowedTopics: profile.token.allowedTopics,
      tierSettings: profile.token.tierSettings
    });

    const scenario = profile.callScenarios.claudebotCall;

    const res = await client.post('/api/a2a/invoke', {
      headers: { Authorization: `Bearer ${token}` },
      body: {
        message: scenario.message,
        caller: scenario.caller,
        timeout_seconds: 30
      }
    });

    assert.equal(res.statusCode, 200);
    assert.ok(res.body.success);
    assert.ok(res.body.conversation_id);
    assert.match(res.body.conversation_id, /^conv_/);
    assert.ok(res.body.response);
    assert.includes(res.body.response, 'claudebot received');
    assert.equal(res.body.can_continue, true);
    assert.equal(res.body.tokens_remaining, 49);

    await teardown();
  });

  test('multi-turn conversation with Golda', async () => {
    const { tokenStore } = setup();
    const profile = helpers.goldaDeluxeProfile();

    const { token } = tokenStore.create({
      name: profile.agent.name,
      permissions: profile.token.tier,
      maxCalls: 50
    });

    // Turn 1: introduction
    const res1 = await client.post('/api/a2a/invoke', {
      headers: { Authorization: `Bearer ${token}` },
      body: {
        message: profile.callScenarios.claudebotCall.message,
        caller: profile.callScenarios.claudebotCall.caller
      }
    });
    assert.ok(res1.body.success);
    const convId = res1.body.conversation_id;

    // Turn 2: follow-up using same conversation_id
    const res2 = await client.post('/api/a2a/invoke', {
      headers: { Authorization: `Bearer ${token}` },
      body: {
        message: profile.callScenarios.followUp.message,
        caller: profile.callScenarios.followUp.caller,
        conversation_id: convId
      }
    });
    assert.ok(res2.body.success);
    assert.equal(res2.body.conversation_id, convId); // same conversation
    assert.equal(res2.body.tokens_remaining, 48);

    await teardown();
  });

  // ── Error Cases ───────────────────────────────────────────────

  test('invoke without auth returns 401', async () => {
    setup();
    const res = await client.post('/api/a2a/invoke', {
      body: { message: 'No auth' }
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.error, 'missing_token');
    await teardown();
  });

  test('invoke with invalid token returns 401', async () => {
    setup();
    const res = await client.post('/api/a2a/invoke', {
      headers: { Authorization: 'Bearer fed_invalid_token' },
      body: { message: 'Bad token' }
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.error, 'unauthorized');
    await teardown();
  });

  test('invoke with revoked token returns 401', async () => {
    const { tokenStore } = setup();
    const { token, record } = tokenStore.create({ name: 'Revoked' });
    tokenStore.revoke(record.id);

    const res = await client.post('/api/a2a/invoke', {
      headers: { Authorization: `Bearer ${token}` },
      body: { message: 'Revoked token' }
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.error, 'unauthorized');
    await teardown();
  });

  test('invoke without message returns 400', async () => {
    const { tokenStore } = setup();
    const { token } = tokenStore.create({ name: 'Test' });

    const res = await client.post('/api/a2a/invoke', {
      headers: { Authorization: `Bearer ${token}` },
      body: {}
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'missing_message');
    await teardown();
  });

  test('invoke with oversized message returns 400', async () => {
    const { tokenStore } = setup();
    const { token } = tokenStore.create({ name: 'Test' });

    const res = await client.post('/api/a2a/invoke', {
      headers: { Authorization: `Bearer ${token}` },
      body: { message: 'x'.repeat(15000) }
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'invalid_message');
    await teardown();
  });

  test('invoke sanitizes caller data', async () => {
    let captured = null;
    const { tokenStore } = setup(async (message, context) => {
      captured = context.caller;
      return { text: 'ok', canContinue: true };
    });

    const { token } = tokenStore.create({ name: 'Test' });

    await client.post('/api/a2a/invoke', {
      headers: { Authorization: `Bearer ${token}` },
      body: {
        message: 'Test',
        caller: {
          name: 'x'.repeat(200), // over 100 limit
          instance: 'normal',
          extra_field: 'should be dropped'
        }
      }
    });

    assert.equal(captured.name.length, 100); // truncated
    assert.equal(captured.extra_field, undefined); // dropped
    await teardown();
  });

  test('invoke bounds timeout to valid range', async () => {
    let capturedTimeout = null;
    const { tokenStore } = setup(async (message, context, options) => {
      capturedTimeout = options.timeout;
      return { text: 'ok', canContinue: true };
    });

    const { token } = tokenStore.create({ name: 'Test' });

    // Under minimum (5s)
    await client.post('/api/a2a/invoke', {
      headers: { Authorization: `Bearer ${token}` },
      body: { message: 'Test', timeout_seconds: 1 }
    });
    assert.equal(capturedTimeout, 5000); // bounded to 5s * 1000

    // Over maximum (300s)
    await client.post('/api/a2a/invoke', {
      headers: { Authorization: `Bearer ${token}` },
      body: { message: 'Test', timeout_seconds: 999 }
    });
    assert.equal(capturedTimeout, 300000); // bounded to 300s * 1000

    await teardown();
  });

  test('max calls enforcement through HTTP', async () => {
    const { tokenStore } = setup();
    const { token } = tokenStore.create({ name: 'Limited', maxCalls: 2 });

    // Call 1 OK
    const r1 = await client.post('/api/a2a/invoke', {
      headers: { Authorization: `Bearer ${token}` },
      body: { message: 'Call 1' }
    });
    assert.ok(r1.body.success);

    // Call 2 OK
    const r2 = await client.post('/api/a2a/invoke', {
      headers: { Authorization: `Bearer ${token}` },
      body: { message: 'Call 2' }
    });
    assert.ok(r2.body.success);

    // Call 3 rejected
    const r3 = await client.post('/api/a2a/invoke', {
      headers: { Authorization: `Bearer ${token}` },
      body: { message: 'Call 3' }
    });
    assert.equal(r3.statusCode, 401);
    assert.equal(r3.body.error, 'unauthorized');

    await teardown();
  });

  // ── End Conversation ──────────────────────────────────────────

  test('POST /end without auth returns 401', async () => {
    setup();
    const res = await client.post('/api/a2a/end', {
      body: { conversation_id: 'conv_123' }
    });
    assert.equal(res.statusCode, 401);
    await teardown();
  });

  test('POST /end without conversation_id returns 400', async () => {
    const { tokenStore } = setup();
    const { token } = tokenStore.create({ name: 'Test' });

    const res = await client.post('/api/a2a/end', {
      headers: { Authorization: `Bearer ${token}` },
      body: {}
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'missing_conversation_id');
    await teardown();
  });

  // ── Collaboration Field in Response ──────────────────────────

  test('invoke returns collaboration field when handleMessage provides it', async () => {
    const { tokenStore } = setup(async (message, context) => {
      return {
        text: `Response to: ${message}`,
        canContinue: true,
        collaboration: {
          phase: 'explore',
          turnCount: 3,
          overlapScore: 0.45,
          activeThreads: ['market analysis'],
          candidateCollaborations: [],
          closeSignal: false
        }
      };
    });

    const { token } = tokenStore.create({ name: 'CollabTest' });

    const res = await client.post('/api/a2a/invoke', {
      headers: { Authorization: `Bearer ${token}` },
      body: { message: 'Test collaboration field' }
    });

    assert.equal(res.statusCode, 200);
    assert.ok(res.body.success);
    assert.ok(res.body.collaboration, 'Response should include collaboration field');
    assert.equal(res.body.collaboration.phase, 'explore');
    assert.equal(res.body.collaboration.turnCount, 3);
    assert.equal(res.body.collaboration.overlapScore, 0.45);
    assert.equal(res.body.can_continue, true);
    await teardown();
  });

  test('invoke omits collaboration field when not provided', async () => {
    const { tokenStore } = setup(async (message, context) => {
      return { text: 'No collab', canContinue: true };
    });

    const { token } = tokenStore.create({ name: 'NoCollabTest' });

    const res = await client.post('/api/a2a/invoke', {
      headers: { Authorization: `Bearer ${token}` },
      body: { message: 'Test no collaboration' }
    });

    assert.equal(res.statusCode, 200);
    assert.ok(res.body.success);
    assert.equal(res.body.collaboration, undefined);
    await teardown();
  });

  test('invoke returns can_continue false when handler signals close', async () => {
    const { tokenStore } = setup(async (message, context) => {
      return {
        text: 'Wrapping up',
        canContinue: false,
        collaboration: {
          phase: 'close',
          turnCount: 10,
          overlapScore: 0.8,
          activeThreads: [],
          candidateCollaborations: ['joint project'],
          closeSignal: true
        }
      };
    });

    const { token } = tokenStore.create({ name: 'CloseTest' });

    const res = await client.post('/api/a2a/invoke', {
      headers: { Authorization: `Bearer ${token}` },
      body: { message: 'Final message' }
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.can_continue, false);
    assert.ok(res.body.collaboration);
    assert.equal(res.body.collaboration.closeSignal, true);
    await teardown();
  });

  // ── Handler Error ─────────────────────────────────────────────

  test('invoke returns 500 when handler throws', async () => {
    const { tokenStore } = setup(async () => {
      throw new Error('Handler exploded');
    });

    const { token } = tokenStore.create({ name: 'Test' });

    const res = await client.post('/api/a2a/invoke', {
      headers: { Authorization: `Bearer ${token}` },
      body: { message: 'Crash test' }
    });
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error, 'internal_error');
    await teardown();
  });

  // ── Context Passed to Handler ─────────────────────────────────

  test('handler receives full a2a context with Golda profile', async () => {
    let capturedContext = null;
    const { tokenStore } = setup(async (message, context) => {
      capturedContext = context;
      return { text: 'ok', canContinue: true };
    });

    const profile = helpers.goldaDeluxeProfile();
    const { token } = tokenStore.create({
      name: profile.agent.name,
      owner: profile.agent.owner,
      permissions: profile.token.tier,
      allowedTopics: profile.token.allowedTopics,
      tierSettings: profile.token.tierSettings
    });

    await client.post('/api/a2a/invoke', {
      headers: { Authorization: `Bearer ${token}` },
      body: {
        message: profile.callScenarios.claudebotCall.message,
        caller: profile.callScenarios.claudebotCall.caller
      }
    });

    assert.equal(capturedContext.mode, 'a2a');
    assert.equal(capturedContext.token_name, 'Golda Deluxe');
    assert.equal(capturedContext.tier, 'friends');
    assert.ok(capturedContext.capabilities);
    assert.includes(capturedContext.capabilities, 'context-read');
    // A2A-41: disclosure field removed from a2a context
    assert.includes(capturedContext.allowed_topics, 'market-analysis');
    assert.equal(capturedContext.caller.name, 'Golda Deluxe');
    assert.match(capturedContext.conversation_id, /^conv_/);

    await teardown();
  });
};
