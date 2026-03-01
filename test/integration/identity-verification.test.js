/**
 * Identity Verification Integration Tests — Ed25519 Signature Flow
 *
 * Tests the full HTTP flow through verifySigHeaders() in the route handler:
 *   1. Client generates keypair + signs request
 *   2. Sends POST /invoke (or /end) with X-A2A-* headers
 *   3. Server verifies signature, timestamp, TOFU key pinning
 *   4. Asserts correct HTTP status and context fields
 *
 * A2A-74: Fills the gap between unit-level crypto tests and route integration.
 */

const { generateKeypair, signRequest, fingerprint } = require('../../src/lib/crypto');

module.exports = function (test, assert, helpers) {
  let appCtx = null;
  let client = null;

  function setup(messageHandler) {
    appCtx = helpers.createTestApp({
      handleMessage: messageHandler || async function (message, context) {
        return {
          text: `echo: ${message.slice(0, 50)}`,
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

  /**
   * Helper: create a token and optionally a linked contact.
   * Returns { token, record, contact? }.
   */
  function createTokenWithContact(tokenStore, opts = {}) {
    const { token, record } = tokenStore.create({
      name: opts.name || 'SigTest',
      permissions: opts.permissions || 'public',
      maxCalls: opts.maxCalls || 50
    });

    let contact = null;
    if (opts.createContact) {
      const result = tokenStore.addContact(`a2a://testhost.local/${token}`, {
        name: opts.contactName || 'sig-test-contact',
        linked_token_id: record.id,
        public_key: opts.pinnedKey || null
      });
      contact = result.contact;
    }

    return { token, record, contact };
  }

  /**
   * Helper: sign a request body for /api/a2a/invoke (or custom endpoint).
   */
  function signInvoke(keypair, body, endpoint = '/api/a2a/invoke') {
    return signRequest({
      privateKey: keypair.privateKey,
      publicKey: keypair.publicKey,
      method: 'POST',
      endpoint,
      body: JSON.stringify(body)
    });
  }

  // ── Backward Compatibility ───────────────────────────────────────

  test('unsigned request returns 200 with identity_verified: false', async () => {
    let capturedContext = null;
    const { tokenStore } = setup(async (message, context) => {
      capturedContext = context;
      return { text: 'ok', canContinue: true };
    });

    const { token } = tokenStore.create({ name: 'UnsignedTest' });

    const res = await client.post('/api/a2a/invoke', {
      headers: { Authorization: `Bearer ${token}` },
      body: { message: 'No signature headers' }
    });

    assert.equal(res.statusCode, 200);
    assert.ok(res.body.success);
    assert.equal(capturedContext.identity_verified, false);
    assert.equal(capturedContext.public_key_fingerprint, null);
    await teardown();
  });

  // ── Valid Signature ──────────────────────────────────────────────

  test('correctly signed request returns 200 with identity_verified: true', async () => {
    let capturedContext = null;
    const { tokenStore } = setup(async (message, context) => {
      capturedContext = context;
      return { text: 'ok', canContinue: true };
    });

    const { token } = tokenStore.create({ name: 'SignedTest' });
    const keypair = generateKeypair();
    const body = { message: 'Signed request' };
    const sigHeaders = signInvoke(keypair, body);

    const res = await client.post('/api/a2a/invoke', {
      headers: {
        Authorization: `Bearer ${token}`,
        ...sigHeaders
      },
      body
    });

    assert.equal(res.statusCode, 200);
    assert.ok(res.body.success);
    assert.equal(capturedContext.identity_verified, true);
    await teardown();
  });

  // ── Timestamp Expiry ─────────────────────────────────────────────

  test('expired timestamp returns 403 with error: timestamp_expired', async () => {
    const { tokenStore } = setup();
    const { token } = tokenStore.create({ name: 'ExpiredTsTest' });
    const keypair = generateKeypair();
    const body = { message: 'Expired timestamp' };

    // Manually construct headers with a timestamp >5 minutes old
    const crypto = require('crypto');
    const oldTimestamp = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    const bodyStr = JSON.stringify(body);
    const bodyHash = crypto.createHash('sha256').update(bodyStr).digest('hex');
    const payload = `${oldTimestamp}:POST:/api/a2a/invoke:${bodyHash}`;
    const keyObject = crypto.createPrivateKey({
      key: Buffer.from(keypair.privateKey, 'base64'),
      format: 'der',
      type: 'pkcs8'
    });
    const signature = crypto.sign(null, Buffer.from(payload), keyObject).toString('base64');

    const res = await client.post('/api/a2a/invoke', {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-A2A-Signature': signature,
        'X-A2A-Public-Key': keypair.publicKey,
        'X-A2A-Timestamp': oldTimestamp
      },
      body
    });

    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error, 'timestamp_expired');
    await teardown();
  });

  // ── Malformed Public Key ─────────────────────────────────────────

  test('malformed public key returns 400 with error: malformed_public_key', async () => {
    const { tokenStore } = setup();
    const { token } = tokenStore.create({ name: 'BadKeyTest' });

    const res = await client.post('/api/a2a/invoke', {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-A2A-Signature': 'dGVzdA==',
        'X-A2A-Public-Key': 'not-a-valid-der-key!!!',
        'X-A2A-Timestamp': new Date().toISOString()
      },
      body: { message: 'Malformed key test' }
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'malformed_public_key');
    await teardown();
  });

  // ── Wrong Key (valid format, signature mismatch) ─────────────────

  test('wrong private key returns 403 with error: invalid_signature', async () => {
    const { tokenStore } = setup();
    const { token } = tokenStore.create({ name: 'WrongKeyTest' });

    const signingKeypair = generateKeypair();
    const differentKeypair = generateKeypair();
    const body = { message: 'Wrong key test' };

    // Sign with signingKeypair but send differentKeypair's public key
    const sigHeaders = signRequest({
      privateKey: signingKeypair.privateKey,
      publicKey: differentKeypair.publicKey, // mismatched public key
      method: 'POST',
      endpoint: '/api/a2a/invoke',
      body: JSON.stringify(body)
    });

    const res = await client.post('/api/a2a/invoke', {
      headers: {
        Authorization: `Bearer ${token}`,
        ...sigHeaders
      },
      body
    });

    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error, 'invalid_signature');
    await teardown();
  });

  // ── TOFU: First Use Pins Key ─────────────────────────────────────

  test('first signed request pins public key to contact (TOFU)', async () => {
    const { tokenStore } = setup(async (message, context) => {
      return { text: 'ok', canContinue: true };
    });

    const { token, record } = createTokenWithContact(tokenStore, {
      createContact: true,
      contactName: 'tofu-pin-test'
    });

    // Verify contact has no pinned key yet
    const contactBefore = tokenStore.getContact('tofu-pin-test');
    assert.equal(contactBefore.public_key, null);

    const keypair = generateKeypair();
    const body = { message: 'TOFU pin test' };
    const sigHeaders = signInvoke(keypair, body);

    const res = await client.post('/api/a2a/invoke', {
      headers: {
        Authorization: `Bearer ${token}`,
        ...sigHeaders
      },
      body
    });

    assert.equal(res.statusCode, 200);
    assert.ok(res.body.success);

    // Verify the key was pinned
    const contactAfter = tokenStore.getContact('tofu-pin-test');
    assert.equal(contactAfter.public_key, keypair.publicKey);
    await teardown();
  });

  // ── TOFU: Repeat with Same Key Succeeds ──────────────────────────

  test('subsequent request with same key succeeds (TOFU repeat)', async () => {
    let capturedContext = null;
    const { tokenStore } = setup(async (message, context) => {
      capturedContext = context;
      return { text: 'ok', canContinue: true };
    });

    const keypair = generateKeypair();
    const { token } = createTokenWithContact(tokenStore, {
      createContact: true,
      contactName: 'tofu-repeat-test',
      pinnedKey: keypair.publicKey // pre-pin the key
    });

    const body = { message: 'TOFU repeat test' };
    const sigHeaders = signInvoke(keypair, body);

    const res = await client.post('/api/a2a/invoke', {
      headers: {
        Authorization: `Bearer ${token}`,
        ...sigHeaders
      },
      body
    });

    assert.equal(res.statusCode, 200);
    assert.ok(res.body.success);
    assert.equal(capturedContext.identity_verified, true);
    await teardown();
  });

  // ── TOFU: Different Key Rejected ─────────────────────────────────

  test('different key returns 403 with error: public_key_mismatch (TOFU violation)', async () => {
    const { tokenStore } = setup();

    const originalKeypair = generateKeypair();
    const attackerKeypair = generateKeypair();
    const { token } = createTokenWithContact(tokenStore, {
      createContact: true,
      contactName: 'tofu-mismatch-test',
      pinnedKey: originalKeypair.publicKey // pre-pin original key
    });

    const body = { message: 'TOFU mismatch test' };
    // Sign with attacker keypair (different from pinned)
    const sigHeaders = signInvoke(attackerKeypair, body);

    const res = await client.post('/api/a2a/invoke', {
      headers: {
        Authorization: `Bearer ${token}`,
        ...sigHeaders
      },
      body
    });

    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error, 'public_key_mismatch');
    await teardown();
  });

  // ── Tampered Body ────────────────────────────────────────────────

  test('tampered body returns 403 with error: invalid_signature', async () => {
    const { tokenStore } = setup();
    const { token } = tokenStore.create({ name: 'TamperedTest' });
    const keypair = generateKeypair();

    // Sign with the original body
    const originalBody = { message: 'Original message' };
    const sigHeaders = signInvoke(keypair, originalBody);

    // Send a different body (tampered)
    const tamperedBody = { message: 'Tampered message' };

    const res = await client.post('/api/a2a/invoke', {
      headers: {
        Authorization: `Bearer ${token}`,
        ...sigHeaders
      },
      body: tamperedBody
    });

    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error, 'invalid_signature');
    await teardown();
  });

  // ── /end Endpoint Signature Verification ─────────────────────────

  test('/end endpoint verifies signatures (rejects expired timestamp)', async () => {
    const { tokenStore } = setup();
    const { token } = tokenStore.create({ name: 'EndSigTest' });

    // First make a valid invoke to get a conversation_id
    const res1 = await client.post('/api/a2a/invoke', {
      headers: { Authorization: `Bearer ${token}` },
      body: { message: 'Start conversation' }
    });
    assert.equal(res1.statusCode, 200);
    const convId = res1.body.conversation_id;

    // Now try to /end with an expired timestamp signature
    const keypair = generateKeypair();
    const crypto = require('crypto');
    const oldTimestamp = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    const endBody = { conversation_id: convId };
    const bodyStr = JSON.stringify(endBody);
    const bodyHash = crypto.createHash('sha256').update(bodyStr).digest('hex');
    const payload = `${oldTimestamp}:POST:/api/a2a/end:${bodyHash}`;
    const keyObject = crypto.createPrivateKey({
      key: Buffer.from(keypair.privateKey, 'base64'),
      format: 'der',
      type: 'pkcs8'
    });
    const signature = crypto.sign(null, Buffer.from(payload), keyObject).toString('base64');

    const res2 = await client.post('/api/a2a/end', {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-A2A-Signature': signature,
        'X-A2A-Public-Key': keypair.publicKey,
        'X-A2A-Timestamp': oldTimestamp
      },
      body: endBody
    });

    assert.equal(res2.statusCode, 403);
    assert.equal(res2.body.error, 'timestamp_expired');
    await teardown();
  });

  // ── Fingerprint Inclusion ────────────────────────────────────────

  test('response context includes public_key_fingerprint when identity verified', async () => {
    let capturedContext = null;
    const { tokenStore } = setup(async (message, context) => {
      capturedContext = context;
      return { text: 'ok', canContinue: true };
    });

    const { token } = tokenStore.create({ name: 'FingerprintTest' });
    const keypair = generateKeypair();
    const body = { message: 'Fingerprint test' };
    const sigHeaders = signInvoke(keypair, body);

    const res = await client.post('/api/a2a/invoke', {
      headers: {
        Authorization: `Bearer ${token}`,
        ...sigHeaders
      },
      body
    });

    assert.equal(res.statusCode, 200);
    assert.ok(res.body.success);
    assert.equal(capturedContext.identity_verified, true);

    // Fingerprint should be a colon-separated hex string
    const expectedFingerprint = fingerprint(keypair.publicKey);
    assert.equal(capturedContext.public_key_fingerprint, expectedFingerprint);
    assert.ok(capturedContext.public_key_fingerprint.includes(':'));
    await teardown();
  });
};
