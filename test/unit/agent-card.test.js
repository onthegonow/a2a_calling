/**
 * A2A-76: Google A2A Agent Card Builder Tests
 *
 * Covers: valid card structure, skills mapping from topics, security scheme
 * declaration, extension inclusion, missing config graceful defaults, empty
 * manifest handling, signature inclusion/omission.
 */

module.exports = function (test, assert, helpers) {

  function loadModule() {
    delete require.cache[require.resolve('../../src/lib/agent-card')];
    return require('../../src/lib/agent-card');
  }

  function loadCrypto() {
    delete require.cache[require.resolve('../../src/lib/crypto')];
    return require('../../src/lib/crypto');
  }

  // ── Valid Card Structure ──────────────────────────────────────

  test('buildAgentCard returns all required Agent Card fields', () => {
    const { buildAgentCard } = loadModule();
    const card = buildAgentCard({
      config: { name: 'TestAgent', description: 'A test agent', hostname: 'test.example.com', owner: 'Alice' },
      manifest: { topics: [{ topic: 'Weather', description: 'Current conditions' }] },
      publicKey: null,
      serverUrl: 'https://test.example.com',
      version: '1.2.3'
    });

    assert.ok(card.id, 'id is present');
    assert.equal(card.name, 'TestAgent');
    assert.equal(card.version, '1.2.3');
    assert.ok(card.provider, 'provider is present');
    assert.equal(card.provider.name, 'Alice');
    assert.ok(card.capabilities, 'capabilities is present');
    assert.ok(Array.isArray(card.skills), 'skills is an array');
    assert.ok(Array.isArray(card.interfaces), 'interfaces is an array');
    assert.ok(card.securitySchemes, 'securitySchemes is present');
    assert.ok(Array.isArray(card.security), 'security is an array');
  });

  // ── Skills Mapping ────────────────────────────────────────────

  test('skills array maps from public-tier disclosure topics', () => {
    const { buildAgentCard } = loadModule();
    const card = buildAgentCard({
      config: { name: 'Agent' },
      manifest: {
        topics: [
          { topic: 'Weather Forecasting', description: 'Daily and weekly forecasts' },
          { topic: 'News Headlines', description: 'Latest breaking news' }
        ]
      },
      publicKey: null,
      serverUrl: 'https://host.com',
      version: '1.0.0'
    });

    assert.equal(card.skills.length, 2);
    assert.equal(card.skills[0].id, 'weather-forecasting');
    assert.equal(card.skills[0].name, 'Weather Forecasting');
    assert.equal(card.skills[0].description, 'Daily and weekly forecasts');
    assert.equal(card.skills[1].id, 'news-headlines');
    assert.equal(card.skills[1].name, 'News Headlines');
  });

  test('skills id strips special characters and lowercases', () => {
    const { buildAgentCard } = loadModule();
    const card = buildAgentCard({
      config: { name: 'Agent' },
      manifest: { topics: [{ topic: 'C++ / Rust Programming!', description: '' }] },
      publicKey: null,
      serverUrl: 'https://host.com',
      version: '1.0.0'
    });

    assert.equal(card.skills[0].id, 'c--rust-programming');
    assert.equal(card.skills[0].name, 'C++ / Rust Programming!');
  });

  // ── Empty Manifest ────────────────────────────────────────────

  test('empty manifest produces empty skills array', () => {
    const { buildAgentCard } = loadModule();
    const card = buildAgentCard({
      config: { name: 'Agent' },
      manifest: {},
      publicKey: null,
      serverUrl: 'https://host.com',
      version: '1.0.0'
    });

    assert.ok(Array.isArray(card.skills));
    assert.equal(card.skills.length, 0);
  });

  test('null manifest produces empty skills array', () => {
    const { buildAgentCard } = loadModule();
    const card = buildAgentCard({
      config: { name: 'Agent' },
      manifest: null,
      publicKey: null,
      serverUrl: 'https://host.com',
      version: '1.0.0'
    });

    assert.ok(Array.isArray(card.skills));
    assert.equal(card.skills.length, 0);
  });

  // ── Missing Config Fields ─────────────────────────────────────

  test('missing config name defaults to a2a-agent', () => {
    const { buildAgentCard } = loadModule();
    const card = buildAgentCard({
      config: {},
      manifest: { topics: [] },
      publicKey: null,
      serverUrl: 'https://host.com',
      version: '1.0.0'
    });

    assert.equal(card.name, 'a2a-agent');
  });

  test('null config defaults gracefully', () => {
    const { buildAgentCard } = loadModule();
    const card = buildAgentCard({
      config: null,
      manifest: null,
      publicKey: null,
      serverUrl: '',
      version: ''
    });

    assert.equal(card.name, 'a2a-agent');
    assert.equal(card.version, '0.0.0');
    assert.ok(card.id, 'id is still generated');
  });

  test('provider is omitted when no owner name', () => {
    const { buildAgentCard } = loadModule();
    const card = buildAgentCard({
      config: { name: 'Agent' },
      manifest: { topics: [] },
      publicKey: null,
      serverUrl: 'https://host.com',
      version: '1.0.0'
    });

    assert.equal(card.provider, undefined);
  });

  // ── Security Scheme ───────────────────────────────────────────

  test('securitySchemes declares HTTPAuth bearer scheme', () => {
    const { buildAgentCard } = loadModule();
    const card = buildAgentCard({
      config: { name: 'Agent' },
      manifest: { topics: [] },
      publicKey: null,
      serverUrl: 'https://host.com',
      version: '1.0.0'
    });

    assert.ok(card.securitySchemes.bearerAuth, 'bearerAuth scheme exists');
    assert.equal(card.securitySchemes.bearerAuth.type, 'http');
    assert.equal(card.securitySchemes.bearerAuth.scheme, 'bearer');
    assert.ok(Array.isArray(card.security));
    assert.ok(card.security[0].bearerAuth, 'security references bearerAuth');
  });

  // ── REST Interface ────────────────────────────────────────────

  test('interfaces declares REST with correct server URL', () => {
    const { buildAgentCard } = loadModule();
    const card = buildAgentCard({
      config: { name: 'Agent' },
      manifest: { topics: [] },
      publicKey: null,
      serverUrl: 'https://myhost.example.com',
      version: '1.0.0'
    });

    assert.equal(card.interfaces.length, 1);
    assert.equal(card.interfaces[0].type, 'rest');
    assert.equal(card.interfaces[0].url, 'https://myhost.example.com/api/a2a/');
    assert.equal(card.interfaces[0].version, '0.3');
  });

  test('trailing slash on serverUrl is normalized', () => {
    const { buildAgentCard } = loadModule();
    const card = buildAgentCard({
      config: { name: 'Agent' },
      manifest: { topics: [] },
      publicKey: null,
      serverUrl: 'https://host.com/',
      version: '1.0.0'
    });

    assert.equal(card.interfaces[0].url, 'https://host.com/api/a2a/');
  });

  // ── Extension Format ──────────────────────────────────────────

  test('extensions includes OpenClaw Trust Tiers with correct URI', () => {
    const { buildAgentCard } = loadModule();
    const card = buildAgentCard({
      config: { name: 'Agent' },
      manifest: { topics: [] },
      publicKey: null,
      serverUrl: 'https://host.com',
      version: '1.0.0'
    });

    assert.ok(Array.isArray(card.extensions));
    assert.equal(card.extensions.length, 1);
    const ext = card.extensions[0];
    assert.equal(ext.uri, 'https://openclaw.dev/a2a/extensions/trust-tiers');
    assert.equal(ext.version, '1.0.0');
    assert.equal(ext.required, false);
    assert.ok(ext.data, 'extension data is present');
    assert.deepEqual(ext.data.tiers, ['public', 'friends', 'family']);
    assert.deepEqual(ext.data.disclosure_levels, ['public', 'minimal', 'none']);
    assert.equal(ext.data.default_tier, 'public');
    assert.equal(ext.data.default_disclosure, 'minimal');
  });

  // ── Capabilities ──────────────────────────────────────────────

  test('capabilities declares streaming and pushNotifications as false', () => {
    const { buildAgentCard } = loadModule();
    const card = buildAgentCard({
      config: { name: 'Agent' },
      manifest: { topics: [] },
      publicKey: null,
      serverUrl: 'https://host.com',
      version: '1.0.0'
    });

    assert.equal(card.capabilities.streaming, false);
    assert.equal(card.capabilities.pushNotifications, false);
    assert.equal(card.capabilities.extendedAgentCard, false);
  });

  // ── Signature / Identity ──────────────────────────────────────

  test('signature included when publicKey is provided', () => {
    const { generateKeypair } = loadCrypto();
    const { fingerprint } = loadCrypto();
    const { buildAgentCard } = loadModule();
    const kp = generateKeypair();

    const card = buildAgentCard({
      config: { name: 'Agent' },
      manifest: { topics: [] },
      publicKey: kp.publicKey,
      serverUrl: 'https://host.com',
      version: '1.0.0'
    });

    assert.ok(card.signature, 'signature is present');
    assert.equal(card.signature.algorithm, 'ed25519');
    assert.equal(card.signature.publicKey, kp.publicKey);
    assert.equal(card.signature.fingerprint, fingerprint(kp.publicKey));
  });

  test('signature omitted when no publicKey', () => {
    const { buildAgentCard } = loadModule();
    const card = buildAgentCard({
      config: { name: 'Agent' },
      manifest: { topics: [] },
      publicKey: null,
      serverUrl: 'https://host.com',
      version: '1.0.0'
    });

    assert.equal(card.signature, undefined);
  });

  // ── Agent ID ──────────────────────────────────────────────────

  test('id uses Ed25519 fingerprint when publicKey is provided', () => {
    const { generateKeypair } = loadCrypto();
    const { fingerprint } = loadCrypto();
    const { buildAgentCard } = loadModule();
    const kp = generateKeypair();

    const card = buildAgentCard({
      config: { name: 'Agent' },
      manifest: { topics: [] },
      publicKey: kp.publicKey,
      serverUrl: 'https://host.com',
      version: '1.0.0'
    });

    assert.equal(card.id, fingerprint(kp.publicKey));
  });

  test('id falls back to deterministic hash when no publicKey', () => {
    const { buildAgentCard } = loadModule();
    const card1 = buildAgentCard({
      config: { name: 'Agent', hostname: 'host1.com' },
      manifest: { topics: [] },
      publicKey: null,
      serverUrl: 'https://host1.com',
      version: '1.0.0'
    });
    const card2 = buildAgentCard({
      config: { name: 'Agent', hostname: 'host1.com' },
      manifest: { topics: [] },
      publicKey: null,
      serverUrl: 'https://host1.com',
      version: '1.0.0'
    });
    const card3 = buildAgentCard({
      config: { name: 'Other', hostname: 'host2.com' },
      manifest: { topics: [] },
      publicKey: null,
      serverUrl: 'https://host2.com',
      version: '1.0.0'
    });

    // Same inputs → same id
    assert.equal(card1.id, card2.id);
    // Different inputs → different id
    assert.notEqual(card1.id, card3.id);
    // Colon-separated hex format
    assert.ok(card1.id.includes(':'), 'fallback id uses colon-separated format');
  });

  // ── Filters invalid topics ────────────────────────────────────

  test('topics with missing topic field are filtered out', () => {
    const { buildAgentCard } = loadModule();
    const card = buildAgentCard({
      config: { name: 'Agent' },
      manifest: { topics: [
        { topic: 'Valid', description: 'ok' },
        { description: 'missing topic field' },
        null,
        { topic: '', description: 'empty topic' }
      ]},
      publicKey: null,
      serverUrl: 'https://host.com',
      version: '1.0.0'
    });

    assert.equal(card.skills.length, 1);
    assert.equal(card.skills[0].name, 'Valid');
  });

};
