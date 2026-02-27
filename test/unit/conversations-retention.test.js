/**
 * Conversation Retention & Pruning Tests (A2A-63)
 *
 * Covers: pruneOld() happy path, empty database, active conversation
 * preservation, VACUUM threshold, getDatabaseStats accuracy,
 * config defaults fallback, and configurable retention periods.
 */

module.exports = function (test, assert, helpers) {
  let tmp;

  function freshStore() {
    if (tmp) tmp.cleanup();
    tmp = helpers.tmpConfigDir('conv-retention');
    delete require.cache[require.resolve('../../src/lib/conversations')];
    const { ConversationStore } = require('../../src/lib/conversations');
    const store = new ConversationStore(tmp.dir);
    return store;
  }

  /**
   * Helper: create a concluded conversation with messages, then backdate
   * ended_at to simulate aging.
   */
  function createAgedConversation(store, id, daysOld, messageCount = 2) {
    store.startConversation({ id, direction: 'inbound', contactName: 'Test' });
    for (let i = 0; i < messageCount; i++) {
      store.addMessage(id, {
        direction: i % 2 === 0 ? 'inbound' : 'outbound',
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${i} for ${id}`
      });
    }
    // Conclude the conversation
    const now = new Date().toISOString();
    store.db.prepare(`
      UPDATE conversations SET status = 'concluded', ended_at = ? WHERE id = ?
    `).run(now, id);

    // Backdate ended_at
    store.db.prepare(`
      UPDATE conversations
      SET ended_at = datetime('now', '-${daysOld} days')
      WHERE id = ?
    `).run(id);

    // Also backdate message timestamps so compression can find them
    store.db.prepare(`
      UPDATE messages
      SET timestamp = datetime('now', '-${daysOld} days')
      WHERE conversation_id = ?
    `).run(id);
  }

  // ── pruneOld: happy path ────────────────────────────────────────

  test('pruneOld deletes old concluded conversations and their messages', () => {
    const store = freshStore();

    // Create a conversation that ended 100 days ago (older than default 90)
    createAgedConversation(store, 'conv_old_concluded', 100, 3);

    // Verify it exists before pruning
    const before = store.getDatabaseStats();
    assert.equal(before.conversations, 1);
    assert.equal(before.messages, 3);

    const result = store.pruneOld({ conversations_days: 90, compress_after_days: 7 });

    assert.equal(result.deletedConversations, 1);
    assert.equal(result.deletedMessages, 3);

    // Verify they are gone
    const after = store.getDatabaseStats();
    assert.equal(after.conversations, 0);
    assert.equal(after.messages, 0);

    store.close();
    tmp.cleanup();
  });

  test('pruneOld deletes old timeout conversations', () => {
    const store = freshStore();

    store.startConversation({ id: 'conv_timed_out', direction: 'inbound' });
    store.addMessage('conv_timed_out', {
      direction: 'inbound', role: 'user', content: 'Hello'
    });
    store.timeoutConversation('conv_timed_out');

    // Backdate ended_at to 100 days ago
    store.db.prepare(`
      UPDATE conversations
      SET ended_at = datetime('now', '-100 days')
      WHERE id = ?
    `).run('conv_timed_out');

    const result = store.pruneOld({ conversations_days: 90 });

    assert.equal(result.deletedConversations, 1);
    assert.equal(result.deletedMessages, 1);

    store.close();
    tmp.cleanup();
  });

  // ── pruneOld: active conversations preserved ──────────────────

  test('pruneOld never deletes active conversations regardless of age', () => {
    const store = freshStore();

    // Create an active conversation and manually backdate it
    store.startConversation({ id: 'conv_active_old', direction: 'inbound' });
    store.addMessage('conv_active_old', {
      direction: 'inbound', role: 'user', content: 'Still active'
    });

    // Backdate started_at and last_message_at, but leave status = 'active'
    store.db.prepare(`
      UPDATE conversations
      SET started_at = datetime('now', '-200 days'),
          last_message_at = datetime('now', '-200 days')
      WHERE id = ?
    `).run('conv_active_old');

    const result = store.pruneOld({ conversations_days: 90 });

    assert.equal(result.deletedConversations, 0);
    assert.equal(result.deletedMessages, 0);

    // Verify the active conversation is still there
    const stats = store.getDatabaseStats();
    assert.equal(stats.conversations, 1);
    assert.equal(stats.messages, 1);

    store.close();
    tmp.cleanup();
  });

  test('pruneOld preserves recent concluded conversations', () => {
    const store = freshStore();

    // Create a conversation concluded 30 days ago (within 90-day retention)
    createAgedConversation(store, 'conv_recent_concluded', 30, 2);

    const result = store.pruneOld({ conversations_days: 90 });

    assert.equal(result.deletedConversations, 0);
    assert.equal(result.deletedMessages, 0);

    const stats = store.getDatabaseStats();
    assert.equal(stats.conversations, 1);
    assert.equal(stats.messages, 2);

    store.close();
    tmp.cleanup();
  });

  // ── pruneOld: mixed scenarios ─────────────────────────────────

  test('pruneOld only deletes expired conversations in a mixed set', () => {
    const store = freshStore();

    // Old concluded (should be pruned)
    createAgedConversation(store, 'conv_expired', 120, 2);

    // Recent concluded (should be kept)
    createAgedConversation(store, 'conv_recent', 30, 2);

    // Active (should be kept)
    store.startConversation({ id: 'conv_active_mix', direction: 'inbound' });
    store.addMessage('conv_active_mix', {
      direction: 'inbound', role: 'user', content: 'Active!'
    });

    const result = store.pruneOld({ conversations_days: 90 });

    assert.equal(result.deletedConversations, 1);
    assert.equal(result.deletedMessages, 2);

    const stats = store.getDatabaseStats();
    assert.equal(stats.conversations, 2); // recent + active
    assert.equal(stats.messages, 3); // 2 from recent + 1 from active

    store.close();
    tmp.cleanup();
  });

  // ── pruneOld: empty database ─────────────────────────────────

  test('pruneOld on empty database returns zero counts', () => {
    const store = freshStore();

    const result = store.pruneOld();

    assert.equal(result.compressed, 0);
    assert.equal(result.deletedMessages, 0);
    assert.equal(result.deletedConversations, 0);
    assert.equal(result.vacuumed, false);

    store.close();
    tmp.cleanup();
  });

  // ── pruneOld: compression pipeline ──────────────────────────

  test('pruneOld compresses messages via compressOldMessages before deletion', () => {
    const store = freshStore();

    // Create a conversation concluded 10 days ago — messages should be compressed
    // (compress_after_days=7) but the conversation itself should NOT be deleted
    // (conversations_days=90)
    createAgedConversation(store, 'conv_compress_only', 10, 2);

    const result = store.pruneOld({ conversations_days: 90, compress_after_days: 7 });

    assert.equal(result.compressed, 2); // both messages compressed
    assert.equal(result.deletedConversations, 0); // too recent to delete
    assert.equal(result.deletedMessages, 0);

    // Verify messages are marked as compressed
    const msgs = store.db.prepare(
      'SELECT compressed FROM messages WHERE conversation_id = ?'
    ).all('conv_compress_only');
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].compressed, 1);
    assert.equal(msgs[1].compressed, 1);

    store.close();
    tmp.cleanup();
  });

  // ── pruneOld: VACUUM threshold ────────────────────────────────

  test('pruneOld does NOT vacuum when <= 100 rows deleted', () => {
    const store = freshStore();

    // Create 10 old conversations with 5 messages each = 60 rows total
    for (let i = 0; i < 10; i++) {
      createAgedConversation(store, `conv_small_${i}`, 100, 5);
    }

    const result = store.pruneOld({ conversations_days: 90 });

    assert.equal(result.deletedConversations, 10);
    assert.equal(result.deletedMessages, 50);
    // Total deleted = 60, which is <= 100
    assert.equal(result.vacuumed, false);

    store.close();
    tmp.cleanup();
  });

  test('pruneOld runs VACUUM when > 100 rows deleted', () => {
    const store = freshStore();

    // Create 20 old conversations with 5 messages each = 120 rows total (>100)
    for (let i = 0; i < 20; i++) {
      createAgedConversation(store, `conv_bulk_${i}`, 100, 5);
    }

    const result = store.pruneOld({ conversations_days: 90 });

    assert.equal(result.deletedConversations, 20);
    assert.equal(result.deletedMessages, 100);
    // Total deleted = 120, which is > 100
    assert.equal(result.vacuumed, true);

    store.close();
    tmp.cleanup();
  });

  // ── pruneOld: configurable retention ──────────────────────────

  test('pruneOld respects custom retention period', () => {
    const store = freshStore();

    // Create a conversation concluded 15 days ago
    createAgedConversation(store, 'conv_custom_ret', 15, 2);

    // With default 90 days, it should NOT be pruned
    const result1 = store.pruneOld({ conversations_days: 90 });
    assert.equal(result1.deletedConversations, 0);

    // With 10-day retention, it SHOULD be pruned
    const result2 = store.pruneOld({ conversations_days: 10 });
    assert.equal(result2.deletedConversations, 1);
    assert.equal(result2.deletedMessages, 2);

    store.close();
    tmp.cleanup();
  });

  test('pruneOld uses defaults when no options provided', () => {
    const store = freshStore();

    // Create a conversation 100 days old (older than default 90)
    createAgedConversation(store, 'conv_default_ret', 100, 1);

    const result = store.pruneOld();

    assert.equal(result.deletedConversations, 1);
    assert.equal(result.deletedMessages, 1);

    store.close();
    tmp.cleanup();
  });

  // ── getDatabaseStats ─────────────────────────────────────────

  test('getDatabaseStats returns accurate row counts', () => {
    const store = freshStore();

    // Empty database
    const empty = store.getDatabaseStats();
    assert.equal(empty.conversations, 0);
    assert.equal(empty.messages, 0);

    // Add some data
    store.startConversation({ id: 'conv_stats_1', direction: 'inbound' });
    store.startConversation({ id: 'conv_stats_2', direction: 'outbound' });
    store.addMessage('conv_stats_1', {
      direction: 'inbound', role: 'user', content: 'Msg 1'
    });
    store.addMessage('conv_stats_1', {
      direction: 'outbound', role: 'assistant', content: 'Msg 2'
    });
    store.addMessage('conv_stats_2', {
      direction: 'inbound', role: 'user', content: 'Msg 3'
    });

    const stats = store.getDatabaseStats();
    assert.equal(stats.conversations, 2);
    assert.equal(stats.messages, 3);

    store.close();
    tmp.cleanup();
  });

  test('getDatabaseStats reflects changes after pruning', () => {
    const store = freshStore();

    createAgedConversation(store, 'conv_stats_old', 100, 4);
    store.startConversation({ id: 'conv_stats_keep', direction: 'inbound' });
    store.addMessage('conv_stats_keep', {
      direction: 'inbound', role: 'user', content: 'Keep me'
    });

    const before = store.getDatabaseStats();
    assert.equal(before.conversations, 2);
    assert.equal(before.messages, 5);

    store.pruneOld({ conversations_days: 90 });

    const after = store.getDatabaseStats();
    assert.equal(after.conversations, 1);
    assert.equal(after.messages, 1);

    store.close();
    tmp.cleanup();
  });

  // ── Config defaults fallback ─────────────────────────────────

  test('A2AConfig.getRetention returns defaults when retention section missing', () => {
    const cfgTmp = helpers.tmpConfigDir('cfg-retention');
    delete require.cache[require.resolve('../../src/lib/config')];
    const { A2AConfig } = require('../../src/lib/config');
    const config = new A2AConfig();

    const retention = config.getRetention();

    assert.equal(retention.conversations_days, 90);
    assert.equal(retention.logs_days, 30);
    assert.equal(retention.compress_after_days, 7);
    assert.equal(retention.token_expiry_grace_days, 30);

    cfgTmp.cleanup();
  });

  test('A2AConfig.getRetention merges partial config with defaults', () => {
    const cfgTmp = helpers.tmpConfigDir('cfg-retention-partial');

    // Write a config file with a partial retention section
    helpers.writeA2AConfig(cfgTmp.dir, {
      retention: {
        conversations_days: 60
        // other fields intentionally missing
      }
    });

    delete require.cache[require.resolve('../../src/lib/config')];
    const { A2AConfig } = require('../../src/lib/config');
    const config = new A2AConfig();

    const retention = config.getRetention();

    assert.equal(retention.conversations_days, 60); // custom value
    assert.equal(retention.logs_days, 30); // default
    assert.equal(retention.compress_after_days, 7); // default
    assert.equal(retention.token_expiry_grace_days, 30); // default

    cfgTmp.cleanup();
  });

  test('A2AConfig.getRetention handles invalid retention values gracefully', () => {
    const cfgTmp = helpers.tmpConfigDir('cfg-retention-invalid');

    helpers.writeA2AConfig(cfgTmp.dir, {
      retention: {
        conversations_days: 'not_a_number',
        logs_days: null,
        compress_after_days: NaN
      }
    });

    delete require.cache[require.resolve('../../src/lib/config')];
    const { A2AConfig } = require('../../src/lib/config');
    const config = new A2AConfig();

    const retention = config.getRetention();

    // All invalid values should fall back to defaults
    assert.equal(retention.conversations_days, 90);
    assert.equal(retention.logs_days, 30);
    assert.equal(retention.compress_after_days, 7);
    assert.equal(retention.token_expiry_grace_days, 30);

    cfgTmp.cleanup();
  });

  test('DEFAULT_CONFIG includes retention section', () => {
    delete require.cache[require.resolve('../../src/lib/config')];
    const { DEFAULT_CONFIG } = require('../../src/lib/config');

    assert.ok(DEFAULT_CONFIG.retention);
    assert.equal(DEFAULT_CONFIG.retention.conversations_days, 90);
    assert.equal(DEFAULT_CONFIG.retention.logs_days, 30);
    assert.equal(DEFAULT_CONFIG.retention.compress_after_days, 7);
    assert.equal(DEFAULT_CONFIG.retention.token_expiry_grace_days, 30);
  });

  // ── pruneOld: conversations with NULL ended_at ────────────────

  test('pruneOld ignores conversations with NULL ended_at', () => {
    const store = freshStore();

    // Create a concluded conversation but manually nullify ended_at
    // (edge case: should not be pruned)
    store.startConversation({ id: 'conv_null_ended', direction: 'inbound' });
    store.addMessage('conv_null_ended', {
      direction: 'inbound', role: 'user', content: 'Edge case'
    });
    store.db.prepare(`
      UPDATE conversations SET status = 'concluded', ended_at = NULL WHERE id = ?
    `).run('conv_null_ended');

    const result = store.pruneOld({ conversations_days: 1 });

    assert.equal(result.deletedConversations, 0);
    assert.equal(result.deletedMessages, 0);

    store.close();
    tmp.cleanup();
  });
};
