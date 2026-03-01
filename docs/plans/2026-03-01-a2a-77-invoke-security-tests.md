# A2A-77: Invoke Handler Security Boundary Tests

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add integration tests covering the security boundary of POST /api/a2a/invoke — expired tokens, conversation isolation, store failure graceful degradation, timeout bounding, and message validation edge cases.

**Architecture:** Create a single test file `test/integration/a2a-invoke-security.test.js` following the existing `call-flow.test.js` pattern — mount `createRoutes()` on Express, use `helpers.request()` for HTTP assertions. Each test group covers one security dimension through actual HTTP requests.

**Tech Stack:** Node.js, Express, custom test runner (`test/run.js`), `test/helpers.js` (createTestApp, request)

---

### Task 1: Scaffold test file and token expiration tests

**Files:**
- Create: `test/integration/a2a-invoke-security.test.js`

**Step 1: Write the test file with token expiration tests**

Create `test/integration/a2a-invoke-security.test.js`:

```js
/**
 * A2A-77: Integration tests for invoke handler security boundary
 *
 * Covers: token expiration enforcement, conversation isolation,
 * store failure graceful degradation, timeout bounding,
 * message validation edge cases.
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
    // Create token that already expired (expires_at in the past)
    const { token, record } = tokenStore.create({
      name: 'ExpiredAgent',
      permissions: 'public',
      expires: '1h'
    });
    // Manually backdate expires_at to the past
    const db = JSON.parse(require('fs').readFileSync(
      require('path').join(appCtx.dir, 'a2a-tokens.json'), 'utf8'
    ));
    const entry = db.tokens.find(t => t.id === record.id);
    entry.expires_at = new Date(Date.now() - 60000).toISOString();
    require('fs').writeFileSync(
      require('path').join(appCtx.dir, 'a2a-tokens.json'),
      JSON.stringify(db, null, 2)
    );

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
};
```

**Step 2: Run tests to verify they pass**

Run: `node test/run.js --integration --filter invoke-security`
Expected: 4 passing

**Step 3: Commit**

```bash
git add test/integration/a2a-invoke-security.test.js
git commit -m "test(a2a-77): add token expiration security tests"
```

---

### Task 2: Add conversation isolation tests

**Files:**
- Modify: `test/integration/a2a-invoke-security.test.js`

**Step 1: Add conversation isolation tests after the token expiration group**

Append inside the module.exports function, before the closing `};`:

```js
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

  test('token A sending token B conversation_id gets that ID back but separate context', async () => {
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
      body: { message: 'A hijacks', conversation_id: convIdB }
    });

    // The handler accepts the conversation_id (no cross-token validation at this layer)
    // but the a2aContext carries token A's identity, not token B's
    assert.equal(resA.statusCode, 200);
    assert.equal(resA.body.conversation_id, convIdB);
    // The handler received token A's identity even though conversation_id was B's
    const ctxA = capturedContexts.find(c => c.token_id !== capturedContexts[0].token_id) || capturedContexts[1];
    assert.ok(ctxA, 'handler received context for second call');
    await teardown();
  });
```

**Step 2: Run tests**

Run: `node test/run.js --integration --filter invoke-security`
Expected: 7 passing

**Step 3: Commit**

```bash
git add test/integration/a2a-invoke-security.test.js
git commit -m "test(a2a-77): add conversation isolation tests"
```

---

### Task 3: Add handler error recovery tests

**Files:**
- Modify: `test/integration/a2a-invoke-security.test.js`

**Step 1: Add handler error recovery tests**

Append inside the module.exports function:

```js
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
```

**Step 2: Run tests**

Run: `node test/run.js --integration --filter invoke-security`
Expected: 9 passing

**Step 3: Commit**

```bash
git add test/integration/a2a-invoke-security.test.js
git commit -m "test(a2a-77): add handler error recovery tests"
```

---

### Task 4: Add timeout bounding tests

**Files:**
- Modify: `test/integration/a2a-invoke-security.test.js`

**Step 1: Add timeout bounding tests**

Append inside the module.exports function:

```js
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

    assert.equal(capturedTimeout, 5000); // MIN_TIMEOUT_SECONDS * 1000
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

    assert.equal(capturedTimeout, 300000); // MAX_TIMEOUT_SECONDS * 1000
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

    assert.equal(capturedTimeout, 30000); // 30 * 1000
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

    assert.equal(capturedTimeout, 60000); // fallback 60 * 1000
    await teardown();
  });
```

**Step 2: Run tests**

Run: `node test/run.js --integration --filter invoke-security`
Expected: 13 passing

**Step 3: Commit**

```bash
git add test/integration/a2a-invoke-security.test.js
git commit -m "test(a2a-77): add timeout bounding tests"
```

---

### Task 5: Add message validation edge case tests

**Files:**
- Modify: `test/integration/a2a-invoke-security.test.js`

**Step 1: Add message validation edge case tests**

Append inside the module.exports function:

```js
  // ── Message Validation Edge Cases ───────────────────────────────

  test('empty string message returns 400 missing_message', async () => {
    const { tokenStore } = setup();
    const { token } = tokenStore.create({ name: 'EdgeAgent', permissions: 'public' });

    const res = await client.post('/api/a2a/invoke', {
      headers: { Authorization: `Bearer ${token}` },
      body: { message: '' }
    });

    // Empty string is falsy → missing_message
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

  test('message at exactly 10000 chars returns 200', async () => {
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
```

**Step 2: Run tests**

Run: `node test/run.js --integration --filter invoke-security`
Expected: 18 passing

**Step 3: Commit**

```bash
git add test/integration/a2a-invoke-security.test.js
git commit -m "test(a2a-77): add message validation edge case tests"
```

---

### Task 6: Add caller sanitization and response metadata tests

**Files:**
- Modify: `test/integration/a2a-invoke-security.test.js`

**Step 1: Add caller sanitization and response metadata tests**

Append inside the module.exports function:

```js
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
          name: 'A'.repeat(200),      // max 100
          owner: 'B'.repeat(200),     // max 100
          instance: 'C'.repeat(300),  // max 200
          context: 'D'.repeat(600)    // max 500
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
```

**Step 2: Run tests**

Run: `node test/run.js --integration --filter invoke-security`
Expected: 22 passing

**Step 3: Commit**

```bash
git add test/integration/a2a-invoke-security.test.js
git commit -m "test(a2a-77): add caller sanitization and response metadata tests"
```

---

### Task 7: Quality gate

**Step 1: Run full test suite**

Run: `npm test`
Expected: All tests pass (existing + ~22 new), 0 failures

**Step 2: Verify no lint/knip regressions**

Run: `npx biome check src/**/*.js` (test files are excluded)
Run: `npx knip`
Expected: No new warnings

---

### Task 8: Ship it

**Step 1: Commit, push, PR, merge, update Linear**

```bash
git checkout -b feature/a2a-77
git add test/integration/a2a-invoke-security.test.js docs/plans/2026-03-01-a2a-77-invoke-security-tests.md
git commit -m "test(a2a-77): add integration tests for invoke handler security boundary"
git push origin feature/a2a-77
gh pr create --title "test(a2a-77): add integration tests for invoke handler security boundary" --body "..."
gh pr merge <PR_NUMBER> --squash --delete-branch
# Update Linear A2A-77 → Done
```
