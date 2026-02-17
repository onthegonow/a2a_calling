const http = require('http');

/**
 * Full E2E flow tests
 *
 * Tests the complete lifecycle of agent-to-agent communication
 * using TwoServerHarness with real HTTP calls.
 */

function postInvoke(hostname, port, token, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname, port, path: '/api/a2a/invoke',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Content-Length': Buffer.byteLength(data)
      }
    }, (res) => {
      let chunks = '';
      res.on('data', c => chunks += c);
      res.on('end', () => {
        try { resolve({ statusCode: res.statusCode, body: JSON.parse(chunks) }); }
        catch { resolve({ statusCode: res.statusCode, body: chunks }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

module.exports = function (test, assert, helpers, ctx) {
  const { TwoServerHarness } = require('./two-server');
  let harness;

  ctx.afterEach(async () => {
    if (harness) {
      await harness.teardown();
      harness = null;
    }
  });

  test('Agent B calls Agent A via invite URL (full lifecycle)', async () => {
    harness = new TwoServerHarness({
      handleMessageA: async (message, context) => {
        return { text: `Hello from Agent A! You said: ${message}`, canContinue: true };
      },
      handleMessageB: async (message, context) => {
        return { text: `Hello from Agent B! You said: ${message}`, canContinue: true };
      }
    });
    await harness.setup();

    // Agent A creates a token for Agent B
    const { token, record } = harness.agentA.tokenStore.create({
      name: 'AgentB-Access',
      permissions: 'friends',
      expires: '1h',
      maxCalls: 10
    });

    assert.match(token, /^fed_/, 'Token should have fed_ prefix');
    assert.ok(record.id, 'Record should have an ID');

    // Agent B calls Agent A using the token
    const result = await postInvoke('127.0.0.1', harness.agentA.port, token, {
      message: 'Hey Agent A, this is Agent B!',
      caller: { name: 'AgentB', owner: 'TestOwner' }
    });

    assert.equal(result.statusCode, 200, 'Should return 200');
    assert.equal(result.body.success, true, 'Should be successful');
    assert.ok(result.body.response, 'Should have a response');
    assert.includes(result.body.response, 'Hello from Agent A', 'Response should come from Agent A handler');
    assert.ok(result.body.conversation_id, 'Should have conversation_id');
    assert.equal(result.body.can_continue, true, 'Should allow continuation');
  });

  test('Bidirectional invite exchange', async () => {
    harness = new TwoServerHarness({
      handleMessageA: async (message, context) => {
        return { text: `A replies: got "${message}"`, canContinue: true };
      },
      handleMessageB: async (message, context) => {
        return { text: `B replies: got "${message}"`, canContinue: true };
      }
    });
    await harness.setup();

    // Agent A creates token for Agent B
    const tokenForB = harness.agentA.tokenStore.create({
      name: 'ForAgentB',
      permissions: 'friends',
      expires: '1h'
    });

    // Agent B creates token for Agent A
    const tokenForA = harness.agentB.tokenStore.create({
      name: 'ForAgentA',
      permissions: 'friends',
      expires: '1h'
    });

    // Agent B calls Agent A
    const resultBA = await postInvoke('127.0.0.1', harness.agentA.port, tokenForB.token, {
      message: 'Hello A, from B',
      caller: { name: 'AgentB' }
    });
    assert.equal(resultBA.statusCode, 200, 'B->A should return 200');
    assert.includes(resultBA.body.response, 'A replies', 'Should get Agent A response');

    // Agent A calls Agent B
    const resultAB = await postInvoke('127.0.0.1', harness.agentB.port, tokenForA.token, {
      message: 'Hello B, from A',
      caller: { name: 'AgentA' }
    });
    assert.equal(resultAB.statusCode, 200, 'A->B should return 200');
    assert.includes(resultAB.body.response, 'B replies', 'Should get Agent B response');
  });

  test('Revoked token rejected mid-conversation', async () => {
    harness = new TwoServerHarness({
      handleMessageA: async (message) => {
        return { text: `Got it: ${message}`, canContinue: true };
      }
    });
    await harness.setup();

    // Create token on Agent A
    const { token, record } = harness.agentA.tokenStore.create({
      name: 'RevocableToken',
      permissions: 'public',
      expires: '1h',
      maxCalls: 10
    });

    // First call succeeds
    const firstCall = await postInvoke('127.0.0.1', harness.agentA.port, token, {
      message: 'First message',
      caller: { name: 'Caller' }
    });
    assert.equal(firstCall.statusCode, 200, 'First call should succeed');
    assert.equal(firstCall.body.success, true, 'First call body should be successful');

    // Revoke the token
    const revokeResult = harness.agentA.tokenStore.revoke(record.id);
    assert.equal(revokeResult.success, true, 'Revoke should succeed');

    // Second call should fail with 401
    const secondCall = await postInvoke('127.0.0.1', harness.agentA.port, token, {
      message: 'Second message after revocation',
      caller: { name: 'Caller' }
    });
    assert.equal(secondCall.statusCode, 401, 'Revoked token should return 401');
    assert.equal(secondCall.body.success, false, 'Revoked token should fail');
  });

  test('Expired token rejected', async () => {
    harness = new TwoServerHarness({
      handleMessageA: async (message) => {
        return { text: `Response: ${message}`, canContinue: true };
      }
    });
    await harness.setup();

    // Create a token and manually set it as already expired
    const { token, record } = harness.agentA.tokenStore.create({
      name: 'ExpiredToken',
      permissions: 'public',
      expires: '1h'
    });

    // Manually expire it by editing the store
    const fs = require('fs');
    const path = require('path');
    const dbPath = path.join(harness.agentA.env.configDir, 'a2a.json');
    const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    const tokenRecord = db.tokens.find(t => t.id === record.id);
    tokenRecord.expires_at = new Date(Date.now() - 1000).toISOString(); // 1 second in the past
    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));

    // Call should fail
    const result = await postInvoke('127.0.0.1', harness.agentA.port, token, {
      message: 'Should not work',
      caller: { name: 'Caller' }
    });
    assert.equal(result.statusCode, 401, 'Expired token should return 401');
    assert.equal(result.body.success, false, 'Expired token should fail');
  });

  test('Max calls enforcement', async () => {
    harness = new TwoServerHarness({
      handleMessageA: async (message) => {
        return { text: `Echo: ${message}`, canContinue: true };
      }
    });
    await harness.setup();

    // Create token with maxCalls: 2
    const { token } = harness.agentA.tokenStore.create({
      name: 'LimitedToken',
      permissions: 'public',
      expires: '1h',
      maxCalls: 2
    });

    // First call should succeed
    const call1 = await postInvoke('127.0.0.1', harness.agentA.port, token, {
      message: 'Call 1',
      caller: { name: 'Caller' }
    });
    assert.equal(call1.statusCode, 200, 'Call 1 should succeed');
    assert.equal(call1.body.success, true, 'Call 1 should be successful');

    // Second call should succeed
    const call2 = await postInvoke('127.0.0.1', harness.agentA.port, token, {
      message: 'Call 2',
      caller: { name: 'Caller' }
    });
    assert.equal(call2.statusCode, 200, 'Call 2 should succeed');
    assert.equal(call2.body.success, true, 'Call 2 should be successful');

    // Third call should fail (max_calls exceeded)
    const call3 = await postInvoke('127.0.0.1', harness.agentA.port, token, {
      message: 'Call 3',
      caller: { name: 'Caller' }
    });
    assert.equal(call3.statusCode, 401, 'Call 3 should return 401 (max calls exceeded)');
    assert.equal(call3.body.success, false, 'Call 3 should fail');
  });
};
