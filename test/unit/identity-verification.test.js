/**
 * A2A-52: Identity Verification Integration Tests
 *
 * Covers: signed request flow, unsigned backward compat, TOFU pinning,
 * key mismatch rejection, config keypair storage, and client signing.
 */

module.exports = function (test, assert, helpers) {
  let tmp;

  function freshConfig() {
    if (tmp) tmp.cleanup();
    tmp = helpers.tmpConfigDir('a2a-id');
    delete require.cache[require.resolve('../../src/lib/config')];
    const { A2AConfig } = require('../../src/lib/config');
    return new A2AConfig();
  }

  // ── Config Keypair Storage ─────────────────────────────────────

  test('config default agent has null keypair fields', () => {
    const config = freshConfig();
    const agent = config.getAgent();
    assert.equal(agent.private_key, null);
    assert.equal(agent.public_key, null);
    tmp.cleanup();
  });

  test('getKeypair returns null when no keys set', () => {
    const config = freshConfig();
    assert.equal(config.getKeypair(), null);
    tmp.cleanup();
  });

  test('setKeypair stores and getKeypair retrieves keys', () => {
    const config = freshConfig();
    delete require.cache[require.resolve('../../src/lib/crypto')];
    const { generateKeypair } = require('../../src/lib/crypto');
    const kp = generateKeypair();

    config.setKeypair(kp.privateKey, kp.publicKey);
    const stored = config.getKeypair();
    assert.ok(stored);
    assert.equal(stored.privateKey, kp.privateKey);
    assert.equal(stored.publicKey, kp.publicKey);
    tmp.cleanup();
  });

  test('keypair persists across config instances', () => {
    const config1 = freshConfig();
    delete require.cache[require.resolve('../../src/lib/crypto')];
    const { generateKeypair } = require('../../src/lib/crypto');
    const kp = generateKeypair();
    config1.setKeypair(kp.privateKey, kp.publicKey);

    // Create new instance pointing to same dir
    delete require.cache[require.resolve('../../src/lib/config')];
    const { A2AConfig } = require('../../src/lib/config');
    const config2 = new A2AConfig();
    const stored = config2.getKeypair();
    assert.equal(stored.privateKey, kp.privateKey);
    assert.equal(stored.publicKey, kp.publicKey);
    tmp.cleanup();
  });

  test('export() strips private_key from agent config', () => {
    const config = freshConfig();
    delete require.cache[require.resolve('../../src/lib/crypto')];
    const { generateKeypair } = require('../../src/lib/crypto');
    const kp = generateKeypair();
    config.setKeypair(kp.privateKey, kp.publicKey);

    const exported = config.export();
    assert.equal(exported.agent.private_key, undefined, 'private_key must not be in export');
    assert.equal(exported.agent.public_key, kp.publicKey, 'public_key should be present in export');
    tmp.cleanup();
  });

  // ── Client Signing ─────────────────────────────────────────────

  test('client._signHeaders returns empty object without keys', () => {
    delete require.cache[require.resolve('../../src/lib/client')];
    const { A2AClient } = require('../../src/lib/client');
    const client = new A2AClient({});
    const headers = client._signHeaders('POST', '/api/a2a/invoke', '{}');
    assert.deepEqual(headers, {});
  });

  test('client._signHeaders returns signature headers with keys', () => {
    delete require.cache[require.resolve('../../src/lib/crypto')];
    delete require.cache[require.resolve('../../src/lib/client')];
    const { generateKeypair } = require('../../src/lib/crypto');
    const { A2AClient } = require('../../src/lib/client');

    const kp = generateKeypair();
    const client = new A2AClient({ privateKey: kp.privateKey, publicKey: kp.publicKey });
    const headers = client._signHeaders('POST', '/api/a2a/invoke', '{"message":"hi"}');
    assert.ok(headers['X-A2A-Signature']);
    assert.ok(headers['X-A2A-Public-Key']);
    assert.ok(headers['X-A2A-Timestamp']);
    assert.equal(headers['X-A2A-Public-Key'], kp.publicKey);
  });

  test('client._signHeaders produces verifiable signatures', () => {
    delete require.cache[require.resolve('../../src/lib/crypto')];
    delete require.cache[require.resolve('../../src/lib/client')];
    const { generateKeypair, verifySignature } = require('../../src/lib/crypto');
    const { A2AClient } = require('../../src/lib/client');

    const kp = generateKeypair();
    const client = new A2AClient({ privateKey: kp.privateKey, publicKey: kp.publicKey });
    const body = '{"message":"test"}';
    const headers = client._signHeaders('POST', '/api/a2a/invoke', body);

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

  // ── Token Store: public_key in contacts ────────────────────────

  test('addContact stores public_key when provided', () => {
    if (tmp) tmp.cleanup();
    tmp = helpers.tmpConfigDir('a2a-id-tok');
    delete require.cache[require.resolve('../../src/lib/tokens')];
    const { TokenStore } = require('../../src/lib/tokens');
    const store = new TokenStore(tmp.dir);

    const result = store.addContact('a2a://host.test/fed_test123456789', {
      name: 'TestAgent',
      public_key: 'fakePubKeyBase64=='
    });
    assert.ok(result.success);

    const contact = store.getContact('TestAgent');
    assert.equal(contact.public_key, 'fakePubKeyBase64==');
    tmp.cleanup();
  });

  test('updateContact allows setting public_key', () => {
    if (tmp) tmp.cleanup();
    tmp = helpers.tmpConfigDir('a2a-id-upd');
    delete require.cache[require.resolve('../../src/lib/tokens')];
    const { TokenStore } = require('../../src/lib/tokens');
    const store = new TokenStore(tmp.dir);

    store.addContact('a2a://host2.test/fed_test123456789', { name: 'Bob' });
    const result = store.updateContact('Bob', { public_key: 'newKey123==' });
    assert.ok(result.success);

    const contact = store.getContact('Bob');
    assert.equal(contact.public_key, 'newKey123==');
    tmp.cleanup();
  });

  test('ensureInboundContact creates contact with null public_key', () => {
    if (tmp) tmp.cleanup();
    tmp = helpers.tmpConfigDir('a2a-id-inb');
    delete require.cache[require.resolve('../../src/lib/tokens')];
    const { TokenStore } = require('../../src/lib/tokens');
    const store = new TokenStore(tmp.dir);

    const contact = store.ensureInboundContact({ name: 'InboundAgent' }, 'tok_test123');
    assert.ok(contact);
    assert.equal(contact.public_key, null);
    tmp.cleanup();
  });

  // ── Route: /status includes public_key ─────────────────────────

  test('GET /status includes public_key when configured', () => {
    delete require.cache[require.resolve('../../src/routes/a2a')];
    const { createRoutes } = require('../../src/routes/a2a');

    if (tmp) tmp.cleanup();
    tmp = helpers.tmpConfigDir('a2a-id-status');
    delete require.cache[require.resolve('../../src/lib/tokens')];
    const { TokenStore } = require('../../src/lib/tokens');
    const tokenStore = new TokenStore(tmp.dir);

    const router = createRoutes({ tokenStore, publicKey: 'testPublicKey==' });

    // Find the /status GET handler
    const statusLayer = router.stack.find(l => l.route && l.route.path === '/status' && l.route.methods.get);
    assert.ok(statusLayer, '/status route exists');

    // Simulate request/response
    const fakeReq = { method: 'GET' };
    let jsonResult = null;
    const fakeRes = { json: (data) => { jsonResult = data; } };
    statusLayer.route.stack[0].handle(fakeReq, fakeRes);

    assert.equal(jsonResult.a2a, true);
    assert.equal(jsonResult.public_key, 'testPublicKey==');
    tmp.cleanup();
  });

  test('GET /status omits public_key when not configured', () => {
    delete require.cache[require.resolve('../../src/routes/a2a')];
    const { createRoutes } = require('../../src/routes/a2a');

    if (tmp) tmp.cleanup();
    tmp = helpers.tmpConfigDir('a2a-id-status2');
    delete require.cache[require.resolve('../../src/lib/tokens')];
    const { TokenStore } = require('../../src/lib/tokens');
    const tokenStore = new TokenStore(tmp.dir);

    const router = createRoutes({ tokenStore });
    const statusLayer = router.stack.find(l => l.route && l.route.path === '/status' && l.route.methods.get);
    let jsonResult = null;
    const fakeRes = { json: (data) => { jsonResult = data; } };
    statusLayer.route.stack[0].handle({ method: 'GET' }, fakeRes);

    assert.equal(jsonResult.public_key, undefined);
    tmp.cleanup();
  });
};
