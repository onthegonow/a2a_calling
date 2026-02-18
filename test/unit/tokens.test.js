/**
 * Token Management Tests
 *
 * Covers: token generation, hashing, creation with all options,
 * validation lifecycle, revocation, duration parsing, tier normalization,
 * and the Golda Deluxe profile specifically.
 */

module.exports = function (test, assert, helpers) {
  let tmp;

  function freshStore() {
    if (tmp) tmp.cleanup();
    tmp = helpers.tmpConfigDir('tok');
    delete require.cache[require.resolve('../../src/lib/tokens')];
    const { TokenStore } = require('../../src/lib/tokens');
    return new TokenStore(tmp.dir);
  }

  // ── Token Generation ───────────────────────────────────────────

  test('generateToken returns fed_ prefixed base64url string', () => {
    delete require.cache[require.resolve('../../src/lib/tokens')];
    const { TokenStore } = require('../../src/lib/tokens');
    const token = TokenStore.generateToken();
    assert.match(token, /^fed_[A-Za-z0-9_-]{32}$/);
  });

  test('generateToken produces unique tokens', () => {
    delete require.cache[require.resolve('../../src/lib/tokens')];
    const { TokenStore } = require('../../src/lib/tokens');
    const tokens = new Set();
    for (let i = 0; i < 100; i++) {
      tokens.add(TokenStore.generateToken());
    }
    assert.equal(tokens.size, 100);
  });

  // ── Token Hashing ─────────────────────────────────────────────

  test('hashToken produces consistent sha256 hex', () => {
    delete require.cache[require.resolve('../../src/lib/tokens')];
    const { TokenStore } = require('../../src/lib/tokens');
    const token = 'fed_test123';
    const hash1 = TokenStore.hashToken(token);
    const hash2 = TokenStore.hashToken(token);
    assert.equal(hash1, hash2);
    assert.equal(hash1.length, 64); // sha256 hex length
  });

  test('hashToken differs for different tokens', () => {
    delete require.cache[require.resolve('../../src/lib/tokens')];
    const { TokenStore } = require('../../src/lib/tokens');
    const h1 = TokenStore.hashToken('fed_aaa');
    const h2 = TokenStore.hashToken('fed_bbb');
    assert.notEqual(h1, h2);
  });

  // ── Duration Parsing ──────────────────────────────────────────

  test('parseDuration handles hours', () => {
    delete require.cache[require.resolve('../../src/lib/tokens')];
    const { TokenStore } = require('../../src/lib/tokens');
    assert.equal(TokenStore.parseDuration('1h'), 3600000);
    assert.equal(TokenStore.parseDuration('24h'), 86400000);
  });

  test('parseDuration handles days', () => {
    delete require.cache[require.resolve('../../src/lib/tokens')];
    const { TokenStore } = require('../../src/lib/tokens');
    assert.equal(TokenStore.parseDuration('1d'), 86400000);
    assert.equal(TokenStore.parseDuration('7d'), 604800000);
    assert.equal(TokenStore.parseDuration('30d'), 2592000000);
  });

  test('parseDuration returns null for never', () => {
    delete require.cache[require.resolve('../../src/lib/tokens')];
    const { TokenStore } = require('../../src/lib/tokens');
    assert.equal(TokenStore.parseDuration('never'), null);
    assert.equal(TokenStore.parseDuration(null), null);
    assert.equal(TokenStore.parseDuration(undefined), null);
  });

  test('parseDuration throws on invalid input', () => {
    delete require.cache[require.resolve('../../src/lib/tokens')];
    const { TokenStore } = require('../../src/lib/tokens');
    assert.throws(() => TokenStore.parseDuration('5m'));
    assert.throws(() => TokenStore.parseDuration('abc'));
  });

  // ── Token Creation ────────────────────────────────────────────

  test('create with defaults produces valid record', () => {
    const store = freshStore();
    const { token, record } = store.create();

    assert.match(token, /^fed_/);
    assert.match(record.id, /^tok_/);
    assert.equal(record.name, 'unnamed');
    assert.equal(record.owner, null);
    assert.equal(record.tier, 'public');
    assert.deepEqual(record.capabilities, ['context-read']);
    assert.deepEqual(record.allowed_topics, ['chat']);
    assert.deepEqual(record.allowed_goals, []);
    // A2A-41: disclosure field removed from tokens
    assert.equal(record.notify, 'all');
    assert.equal(record.max_calls, 100);
    assert.equal(record.calls_made, 0);
    assert.equal(record.revoked, false);
    assert.ok(record.created_at);
    assert.ok(record.expires_at); // default 1d
    tmp.cleanup();
  });

  test('create with Golda Deluxe profile', () => {
    const { store, token, record, cleanup, profile } = helpers.tokenStoreWithGolda();

    assert.match(token, /^fed_/);
    assert.equal(record.name, 'Golda Deluxe');
    assert.equal(record.owner, null); // unnamed owner
    assert.equal(record.tier, 'friends');
    assert.deepEqual(record.capabilities, ['context-read', 'calendar.read', 'email.read', 'search']);
    // A2A-41: disclosure field removed from tokens
    assert.equal(record.max_calls, 50);
    assert.deepEqual(record.allowed_topics, profile.token.allowedTopics);
    assert.includes(record.allowed_topics, 'market-analysis');
    assert.includes(record.allowed_topics, 'luxury-consulting');
    assert.deepEqual(record.allowed_goals, profile.token.allowedGoals);
    assert.includes(record.allowed_goals, 'find-authentication-partners');
    assert.equal(record.tier_settings.responseStyle, 'formal');
    assert.ok(record.expires_at);

    cleanup();
  });

  test('tiers stored as labels with capabilities', () => {
    const store = freshStore();

    const pub = store.create({ permissions: 'public' });
    assert.equal(pub.record.tier, 'public');
    assert.deepEqual(pub.record.capabilities, ['context-read']);

    const friend = store.create({ permissions: 'friends' });
    assert.equal(friend.record.tier, 'friends');
    assert.includes(friend.record.capabilities, 'context-read');
    assert.includes(friend.record.capabilities, 'calendar.read');

    const family = store.create({ permissions: 'family' });
    assert.equal(family.record.tier, 'family');
    assert.includes(family.record.capabilities, 'tools');
    assert.includes(family.record.capabilities, 'memory');

    tmp.cleanup();
  });

  test('create throws on invalid tier', () => {
    const store = freshStore();
    assert.throws(() => store.create({ permissions: 'chat-only' }));
    assert.throws(() => store.create({ permissions: 'tools-read' }));
    assert.throws(() => store.create({ permissions: 'tools-write' }));
    tmp.cleanup();
  });

  test('default topics assigned per tier', () => {
    const store = freshStore();

    const pub = store.create({ permissions: 'public' });
    assert.deepEqual(pub.record.allowed_topics, ['chat']);

    const friend = store.create({ permissions: 'friends' });
    assert.includes(friend.record.allowed_topics, 'calendar.read');
    assert.includes(friend.record.allowed_topics, 'email.read');

    const family = store.create({ permissions: 'family' });
    assert.includes(family.record.allowed_topics, 'tools');
    assert.includes(family.record.allowed_topics, 'calendar');

    tmp.cleanup();
  });

  test('custom allowedTopics override defaults', () => {
    const store = freshStore();
    const custom = store.create({
      permissions: 'public',
      allowedTopics: ['chat', 'weather', 'jokes']
    });
    assert.deepEqual(custom.record.allowed_topics, ['chat', 'weather', 'jokes']);
    tmp.cleanup();
  });

  test('custom allowedGoals override defaults', () => {
    const store = freshStore();
    const custom = store.create({
      permissions: 'friends',
      allowedGoals: ['find-partners', 'grow-network']
    });
    assert.deepEqual(custom.record.allowed_goals, ['find-partners', 'grow-network']);
    tmp.cleanup();
  });

  test('goals default from config tiers when not overridden', () => {
    const store = freshStore();
    const fs = require('fs');
    const path = require('path');
    // Write config with tier goals
    fs.writeFileSync(path.join(tmp.dir, 'a2a-config.json'), JSON.stringify({
      tiers: {
        friends: {
          topics: ['chat', 'calendar.read'],
          goals: ['explore-partnerships', 'find-collaborators']
        }
      }
    }));

    delete require.cache[require.resolve('../../src/lib/tokens')];
    const { TokenStore } = require('../../src/lib/tokens');
    const freshTokenStore = new TokenStore(tmp.dir);

    const { record } = freshTokenStore.create({ permissions: 'friends' });
    assert.deepEqual(record.allowed_goals, ['explore-partnerships', 'find-collaborators']);
    tmp.cleanup();
  });

  // ── Token Validation ──────────────────────────────────────────

  test('validate accepts valid token and increments calls', () => {
    const { store, token, record, cleanup, profile } = helpers.tokenStoreWithGolda();

    const result = store.validate(token);
    assert.ok(result.valid);
    assert.equal(result.name, 'Golda Deluxe');
    assert.equal(result.tier, 'friends');
    assert.ok(result.capabilities);
    assert.includes(result.capabilities, 'context-read');
    // A2A-41: disclosure field removed from validate() return
    assert.includes(result.allowed_topics, 'market-analysis');
    assert.deepEqual(result.allowed_goals, profile.token.allowedGoals);
    assert.equal(result.calls_remaining, 49); // 50 - 1

    cleanup();
  });

  test('validate exposes token timeout_ms when set directly', () => {
    const store = freshStore();
    const { token } = store.create({
      name: 'TimeoutToken',
      timeoutMs: 240000
    });
    const result = store.validate(token);
    assert.equal(result.timeout_ms, 240000);
    tmp.cleanup();
  });

  test('validate derives timeout_ms from tier_settings when top-level is absent', () => {
    const store = freshStore();
    const { token } = store.create({
      name: 'TierTimeoutToken',
      tierSettings: { timeout_ms: 210000 }
    });
    const result = store.validate(token);
    assert.equal(result.timeout_ms, 210000);
    tmp.cleanup();
  });

  test('validate rejects unknown token', () => {
    const { store, cleanup } = helpers.tokenStoreWithGolda();
    const result = store.validate('fed_nonexistent');
    assert.equal(result.valid, false);
    assert.equal(result.error, 'token_not_found');
    cleanup();
  });

  test('validate rejects revoked token', () => {
    const { store, token, record, cleanup } = helpers.tokenStoreWithGolda();
    store.revoke(record.id);
    const result = store.validate(token);
    assert.equal(result.valid, false);
    assert.equal(result.error, 'token_revoked');
    cleanup();
  });

  test('validate rejects expired token', () => {
    const store = freshStore();
    const { token, record } = store.create({ expires: '1h' });

    // Manually expire by manipulating the stored data
    const db = store._load();
    db.tokens[0].expires_at = new Date(Date.now() - 1000).toISOString();
    store._save(db);

    const result = store.validate(token);
    assert.equal(result.valid, false);
    assert.equal(result.error, 'token_expired');
    tmp.cleanup();
  });

  test('validate rejects when max calls exceeded', () => {
    const store = freshStore();
    const { token } = store.create({ maxCalls: 2 });

    assert.ok(store.validate(token).valid); // call 1
    assert.ok(store.validate(token).valid); // call 2
    const third = store.validate(token);    // call 3
    assert.equal(third.valid, false);
    assert.equal(third.error, 'max_calls_exceeded');
    tmp.cleanup();
  });

  // ── Token Listing ─────────────────────────────────────────────

  test('list returns active tokens only by default', () => {
    const store = freshStore();
    store.create({ name: 'Active' });
    const { record } = store.create({ name: 'ToRevoke' });
    store.revoke(record.id);

    const active = store.list();
    assert.equal(active.length, 1);
    assert.equal(active[0].name, 'Active');

    const all = store.list(true);
    assert.equal(all.length, 2);
    tmp.cleanup();
  });

  test('findById supports prefix matching', () => {
    const store = freshStore();
    const { record } = store.create({ name: 'Findable' });
    const prefix = record.id.slice(0, 8);

    const found = store.findById(prefix);
    assert.ok(found);
    assert.equal(found.name, 'Findable');
    tmp.cleanup();
  });

  // ── Revocation ────────────────────────────────────────────────

  test('revoke sets revoked flag and timestamp', () => {
    const store = freshStore();
    const { record } = store.create({ name: 'ToRevoke' });

    const result = store.revoke(record.id);
    assert.ok(result.success);
    assert.ok(result.record.revoked);
    assert.ok(result.record.revoked_at);
    tmp.cleanup();
  });

  test('revoke returns error for unknown id', () => {
    const store = freshStore();
    const result = store.revoke('tok_nonexistent');
    assert.equal(result.success, false);
    assert.equal(result.error, 'not_found');
    tmp.cleanup();
  });

  // ── Contact Management ────────────────────────────────────────

  test('addContact parses a2a:// URL', () => {
    const store = freshStore();
    const result = store.addContact('a2a://remote.example.com/fed_abc123', {
      name: 'Remote Agent',
      owner: 'Alice',
      tags: ['collaborator']
    });

    assert.ok(result.success);
    assert.equal(result.contact.name, 'Remote Agent');
    tmp.cleanup();
  });

  test('addContact rejects invalid URL', () => {
    const store = freshStore();
    assert.throws(() => store.addContact('https://bad.com/nope'));
    tmp.cleanup();
  });

  test('addContact detects duplicates', () => {
    const store = freshStore();
    store.addContact('a2a://host.com/fed_token1', { name: 'First' });
    const dup = store.addContact('a2a://host.com/fed_token1', { name: 'Second' });
    assert.equal(dup.success, false);
    assert.equal(dup.error, 'duplicate');
    tmp.cleanup();
  });

  test('getContact decrypts token', () => {
    const store = freshStore();
    store.addContact('a2a://remote.test/fed_secrettoken123', { name: 'Encrypted' });

    const remote = store.getContact('Encrypted');
    assert.ok(remote);
    assert.equal(remote.token, 'fed_secrettoken123');
    assert.equal(remote.token_enc, undefined); // should be stripped
    tmp.cleanup();
  });

  test('linkTokenToContact binds token to remote', () => {
    const store = freshStore();
    const { record } = store.create({ name: 'SharedToken' });
    store.addContact('a2a://friend.com/fed_xxx', { name: 'Friend' });

    const result = store.linkTokenToContact('Friend', record.id);
    assert.ok(result.success);

    const contacts = store.listContacts();
    const linked = contacts.find(r => r.name === 'Friend');
    assert.ok(linked.linked_token);
    assert.equal(linked.linked_token.name, 'SharedToken');
    tmp.cleanup();
  });

  test('updateContact changes metadata', () => {
    const store = freshStore();
    store.addContact('a2a://host.com/fed_x', { name: 'ToUpdate' });

    const result = store.updateContact('ToUpdate', {
      notes: 'Updated notes',
      tags: ['updated']
    });

    assert.ok(result.success);
    const remote = store.getContact('ToUpdate');
    assert.equal(remote.notes, 'Updated notes');
    assert.deepEqual(remote.tags, ['updated']);
    tmp.cleanup();
  });

  test('removeContact deletes contact', () => {
    const store = freshStore();
    store.addContact('a2a://host.com/fed_x', { name: 'ToRemove' });
    const result = store.removeContact('ToRemove');
    assert.ok(result.success);
    assert.equal(store.getContact('ToRemove'), null);
    tmp.cleanup();
  });

  // ── Corrupted DB Recovery ─────────────────────────────────────

  test('corrupted DB is backed up and reset', () => {
    const store = freshStore();
    const fs = require('fs');

    // Write garbage to the DB file
    fs.writeFileSync(store.dbPath, 'not json!!!');
    const db = store._load();

    assert.deepEqual(db.tokens, []);
    assert.deepEqual(db.contacts, []);

    // A backup should exist
    const backups = fs.readdirSync(tmp.dir).filter(f => f.includes('.corrupt.'));
    assert.greaterThan(backups.length, 0);
    tmp.cleanup();
  });
};
