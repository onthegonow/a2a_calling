/**
 * Token Cleanup Tests (A2A-65)
 *
 * Covers: cleanupExpired() removing expired tokens, preserving grace period,
 * removing old revoked tokens, preserving valid tokens, custom grace days,
 * empty store, non-expiring tokens, atomic save, and mixed scenarios.
 */

module.exports = function (test, assert, helpers) {
  let tmp;

  function freshStore() {
    if (tmp) tmp.cleanup();
    tmp = helpers.tmpConfigDir('tokens-cleanup');
    delete require.cache[require.resolve('../../src/lib/tokens')];
    const { TokenStore } = require('../../src/lib/tokens');
    return new TokenStore(tmp.dir);
  }

  /**
   * Helper: create a token and backdate its expires_at by manipulating
   * the JSON store directly via _load/_save.
   */
  function createAndBackdateExpiry(store, name, hoursAgo) {
    const { record } = store.create({ name, expires: '1d' });
    const db = store._load();
    const tok = db.tokens.find(t => t.id === record.id);
    tok.expires_at = new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
    store._save(db);
    return record.id;
  }

  /**
   * Helper: create a token, revoke it, then backdate revoked_at.
   */
  function createAndBackdateRevocation(store, name, daysAgo) {
    const { record } = store.create({ name, expires: 'never' });
    store.revoke(record.id);
    const db = store._load();
    const tok = db.tokens.find(t => t.id === record.id);
    tok.revoked_at = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
    store._save(db);
    return record.id;
  }

  // ── 1. Removes tokens expired >1 hour ago ─────────────────────

  test('cleanupExpired removes tokens expired more than 1 hour ago', () => {
    const store = freshStore();
    // A2A-65: Token expired 2 hours ago should be removed
    const id = createAndBackdateExpiry(store, 'old-expired', 2);

    const result = store.cleanupExpired();
    assert.equal(result.removed_expired, 1);
    assert.equal(store.findById(id), undefined);
  });

  // ── 2. Preserves tokens expired <1 hour ago (grace period) ────

  test('cleanupExpired preserves tokens expired less than 1 hour ago', () => {
    const store = freshStore();
    // A2A-65: Token expired 30 minutes ago should be kept (in-flight grace)
    const id = createAndBackdateExpiry(store, 'recent-expired', 0.5);

    const result = store.cleanupExpired();
    assert.equal(result.removed_expired, 0);
    assert.ok(store.findById(id), 'Recently expired token should be preserved');
  });

  // ── 3. Removes tokens revoked >30 days ago (default grace) ────

  test('cleanupExpired removes tokens revoked more than 30 days ago', () => {
    const store = freshStore();
    // A2A-65: Token revoked 35 days ago with default 30-day grace should be removed
    const id = createAndBackdateRevocation(store, 'old-revoked', 35);

    const result = store.cleanupExpired();
    assert.equal(result.removed_revoked, 1);
    assert.equal(store.findById(id), undefined);
  });

  // ── 4. Preserves tokens revoked <30 days ago ──────────────────

  test('cleanupExpired preserves tokens revoked less than 30 days ago', () => {
    const store = freshStore();
    // A2A-65: Token revoked 10 days ago should be preserved under default grace
    const id = createAndBackdateRevocation(store, 'recent-revoked', 10);

    const result = store.cleanupExpired();
    assert.equal(result.removed_revoked, 0);
    assert.ok(store.findById(id), 'Recently revoked token should be preserved');
  });

  // ── 5. Preserves valid (non-expired, non-revoked) tokens ──────

  test('cleanupExpired preserves valid tokens', () => {
    const store = freshStore();
    const { record } = store.create({ name: 'active-token', expires: '7d' });

    const result = store.cleanupExpired();
    assert.equal(result.removed_expired, 0);
    assert.equal(result.removed_revoked, 0);
    assert.ok(store.findById(record.id), 'Valid token should be preserved');
  });

  // ── 6. Respects custom token_expiry_grace_days ────────────────

  test('cleanupExpired respects custom token_expiry_grace_days', () => {
    const store = freshStore();
    // A2A-65: Revoked 5 days ago, with 3-day grace — should be removed
    const id = createAndBackdateRevocation(store, 'custom-grace', 5);

    const result = store.cleanupExpired({ token_expiry_grace_days: 3 });
    assert.equal(result.removed_revoked, 1);
    assert.equal(store.findById(id), undefined);
  });

  // ── 7. Empty token store returns zeroes ────────────────────────

  test('cleanupExpired on empty token store returns zeroes', () => {
    const store = freshStore();

    const result = store.cleanupExpired();
    assert.equal(result.removed_expired, 0);
    assert.equal(result.removed_revoked, 0);
  });

  // ── 8. Preserves non-expiring tokens (expires_at=null) ────────

  test('cleanupExpired preserves non-expiring tokens', () => {
    const store = freshStore();
    // A2A-65: Token with never-expiring lifetime should always be preserved
    const { record } = store.create({ name: 'never-expires', expires: 'never' });

    const result = store.cleanupExpired();
    assert.equal(result.removed_expired, 0);
    assert.equal(result.removed_revoked, 0);
    assert.ok(store.findById(record.id), 'Non-expiring token should be preserved');
  });

  // ── 9. Uses atomic _save() (verify file exists after cleanup) ─

  test('cleanupExpired uses atomic _save (file exists after cleanup)', () => {
    const fs = require('fs');
    const path = require('path');
    const store = freshStore();
    // A2A-65: Create token, backdate, cleanup, verify DB file is intact
    createAndBackdateExpiry(store, 'atomic-test', 3);

    store.cleanupExpired();

    const dbPath = path.join(store.configDir, 'a2a.json');
    assert.ok(fs.existsSync(dbPath), 'Database file should exist after cleanup');
    // Verify the file is valid JSON
    const content = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    assert.ok(Array.isArray(content.tokens), 'Tokens array should be valid after cleanup');
  });

  // ── 10. Mixed scenario: some expired, valid, and revoked ──────

  test('cleanupExpired handles mixed scenario correctly', () => {
    const store = freshStore();

    // A2A-65: Create a diverse set of tokens to test all paths
    // 1. Valid token
    const { record: valid } = store.create({ name: 'valid', expires: '7d' });
    // 2. Token expired >1 hour ago (should be removed)
    const expiredId = createAndBackdateExpiry(store, 'expired-old', 5);
    // 3. Token expired <1 hour ago (should be kept)
    const recentExpiredId = createAndBackdateExpiry(store, 'expired-recent', 0.25);
    // 4. Token revoked >30 days ago (should be removed)
    const oldRevokedId = createAndBackdateRevocation(store, 'revoked-old', 45);
    // 5. Token revoked <30 days ago (should be kept)
    const recentRevokedId = createAndBackdateRevocation(store, 'revoked-recent', 5);
    // 6. Non-expiring token (should be kept)
    const { record: neverExpires } = store.create({ name: 'never', expires: 'never' });

    const result = store.cleanupExpired();

    assert.equal(result.removed_expired, 1, 'Should remove 1 expired token');
    assert.equal(result.removed_revoked, 1, 'Should remove 1 old revoked token');

    // Verify preserved tokens
    assert.ok(store.findById(valid.id), 'Valid token should be preserved');
    assert.ok(store.findById(recentExpiredId), 'Recently expired token should be preserved');
    assert.ok(store.findById(recentRevokedId), 'Recently revoked token should be preserved');
    assert.ok(store.findById(neverExpires.id), 'Non-expiring token should be preserved');

    // Verify removed tokens
    assert.equal(store.findById(expiredId), undefined, 'Old expired token should be removed');
    assert.equal(store.findById(oldRevokedId), undefined, 'Old revoked token should be removed');

    // Verify total count: 4 remain (valid, recentExpired, recentRevoked, neverExpires)
    const remaining = store.list(true); // include revoked
    assert.equal(remaining.length, 4, 'Should have 4 remaining tokens');
  });
};
