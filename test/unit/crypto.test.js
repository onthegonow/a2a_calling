/**
 * A2A-52: Ed25519 Crypto Module Tests
 *
 * Covers: keypair generation, signing, verification, fingerprinting,
 * timestamp validation, and replay protection.
 */

module.exports = function (test, assert, helpers) {

  function loadCrypto() {
    delete require.cache[require.resolve('../../src/lib/crypto')];
    return require('../../src/lib/crypto');
  }

  // ── Keypair Generation ─────────────────────────────────────────

  test('generateKeypair returns base64 privateKey and publicKey', () => {
    const { generateKeypair } = loadCrypto();
    const kp = generateKeypair();
    assert.ok(kp.privateKey, 'privateKey is present');
    assert.ok(kp.publicKey, 'publicKey is present');
    assert.ok(typeof kp.privateKey === 'string');
    assert.ok(typeof kp.publicKey === 'string');
    // Verify base64 decodes without error
    assert.ok(Buffer.from(kp.privateKey, 'base64').length > 0);
    assert.ok(Buffer.from(kp.publicKey, 'base64').length > 0);
  });

  test('generateKeypair produces unique keypairs', () => {
    const { generateKeypair } = loadCrypto();
    const kp1 = generateKeypair();
    const kp2 = generateKeypair();
    assert.notEqual(kp1.privateKey, kp2.privateKey);
    assert.notEqual(kp1.publicKey, kp2.publicKey);
  });

  // ── Fingerprinting ─────────────────────────────────────────────

  test('fingerprint returns colon-separated hex string', () => {
    const { generateKeypair, fingerprint } = loadCrypto();
    const kp = generateKeypair();
    const fp = fingerprint(kp.publicKey);
    assert.ok(typeof fp === 'string');
    // SHA-256 = 32 bytes = 64 hex chars = 32 pairs with 31 colons
    assert.equal(fp.split(':').length, 32);
    // Each pair is 2 hex chars
    for (const pair of fp.split(':')) {
      assert.equal(pair.length, 2);
      assert.ok(/^[0-9a-f]{2}$/.test(pair));
    }
  });

  test('fingerprint is deterministic for same key', () => {
    const { generateKeypair, fingerprint } = loadCrypto();
    const kp = generateKeypair();
    assert.equal(fingerprint(kp.publicKey), fingerprint(kp.publicKey));
  });

  test('fingerprint differs for different keys', () => {
    const { generateKeypair, fingerprint } = loadCrypto();
    const kp1 = generateKeypair();
    const kp2 = generateKeypair();
    assert.notEqual(fingerprint(kp1.publicKey), fingerprint(kp2.publicKey));
  });

  // ── Signing & Verification ─────────────────────────────────────

  test('signRequest produces expected header keys', () => {
    const { generateKeypair, signRequest } = loadCrypto();
    const kp = generateKeypair();
    const headers = signRequest({
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
      method: 'POST',
      endpoint: '/api/a2a/invoke',
      body: '{"message":"hello"}'
    });
    assert.ok(headers['X-A2A-Signature']);
    assert.ok(headers['X-A2A-Public-Key']);
    assert.ok(headers['X-A2A-Timestamp']);
    assert.equal(headers['X-A2A-Public-Key'], kp.publicKey);
  });

  test('verifySignature returns true for valid signature', () => {
    const { generateKeypair, signRequest, verifySignature } = loadCrypto();
    const kp = generateKeypair();
    const body = '{"message":"test"}';
    const headers = signRequest({
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
      method: 'POST',
      endpoint: '/api/a2a/invoke',
      body
    });
    const valid = verifySignature({
      signature: headers['X-A2A-Signature'],
      publicKey: headers['X-A2A-Public-Key'],
      timestamp: headers['X-A2A-Timestamp'],
      method: 'POST',
      endpoint: '/api/a2a/invoke',
      body
    });
    assert.equal(valid, true);
  });

  test('verifySignature returns false for tampered body', () => {
    const { generateKeypair, signRequest, verifySignature } = loadCrypto();
    const kp = generateKeypair();
    const headers = signRequest({
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
      method: 'POST',
      endpoint: '/api/a2a/invoke',
      body: '{"message":"original"}'
    });
    const valid = verifySignature({
      signature: headers['X-A2A-Signature'],
      publicKey: headers['X-A2A-Public-Key'],
      timestamp: headers['X-A2A-Timestamp'],
      method: 'POST',
      endpoint: '/api/a2a/invoke',
      body: '{"message":"tampered"}'
    });
    assert.equal(valid, false);
  });

  test('verifySignature returns false for wrong public key', () => {
    const { generateKeypair, signRequest, verifySignature } = loadCrypto();
    const kp1 = generateKeypair();
    const kp2 = generateKeypair();
    const body = '{"message":"test"}';
    const headers = signRequest({
      privateKey: kp1.privateKey,
      publicKey: kp1.publicKey,
      method: 'POST',
      endpoint: '/api/a2a/invoke',
      body
    });
    const valid = verifySignature({
      signature: headers['X-A2A-Signature'],
      publicKey: kp2.publicKey,
      timestamp: headers['X-A2A-Timestamp'],
      method: 'POST',
      endpoint: '/api/a2a/invoke',
      body
    });
    assert.equal(valid, false);
  });

  test('verifySignature returns false for wrong endpoint', () => {
    const { generateKeypair, signRequest, verifySignature } = loadCrypto();
    const kp = generateKeypair();
    const body = '{"message":"test"}';
    const headers = signRequest({
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
      method: 'POST',
      endpoint: '/api/a2a/invoke',
      body
    });
    const valid = verifySignature({
      signature: headers['X-A2A-Signature'],
      publicKey: headers['X-A2A-Public-Key'],
      timestamp: headers['X-A2A-Timestamp'],
      method: 'POST',
      endpoint: '/api/a2a/end',
      body
    });
    assert.equal(valid, false);
  });

  // ── Timestamp Validation ───────────────────────────────────────

  test('isTimestampValid accepts current time', () => {
    const { isTimestampValid } = loadCrypto();
    assert.equal(isTimestampValid(new Date().toISOString()), true);
  });

  test('isTimestampValid accepts timestamp 2 minutes ago', () => {
    const { isTimestampValid } = loadCrypto();
    const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    assert.equal(isTimestampValid(twoMinAgo), true);
  });

  test('isTimestampValid rejects timestamp 10 minutes ago', () => {
    const { isTimestampValid } = loadCrypto();
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    assert.equal(isTimestampValid(tenMinAgo), false);
  });

  test('isTimestampValid rejects garbage input', () => {
    const { isTimestampValid } = loadCrypto();
    assert.equal(isTimestampValid('not-a-date'), false);
    assert.equal(isTimestampValid(''), false);
  });

  test('isTimestampValid accepts timestamp 2 minutes in future', () => {
    const { isTimestampValid } = loadCrypto();
    const twoMinFuture = new Date(Date.now() + 2 * 60 * 1000).toISOString();
    assert.equal(isTimestampValid(twoMinFuture), true);
  });

  test('isTimestampValid rejects timestamp 10 minutes in future', () => {
    const { isTimestampValid } = loadCrypto();
    const tenMinFuture = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    assert.equal(isTimestampValid(tenMinFuture), false);
  });
};
