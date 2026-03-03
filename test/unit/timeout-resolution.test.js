/**
 * Timeout Resolution Tests
 *
 * Covers gaps identified in A2A-90 audit:
 * - parsePositiveInt edge cases (NaN, negative, zero, float strings, null, undefined)
 * - resolveTokenTimeoutMs: camelCase aliases (timeoutMs, tierSettings)
 * - resolveTokenTimeoutMs: non-object input, null token
 * - resolveTurnTimeoutMs: custom hardFallbackMs, envTimeoutMs from env var
 * - CallMonitor idle timeout trigger via _checkIdleConversations()
 * - CallMonitor max duration trigger via _checkIdleConversations()
 * - CallMonitor endConversation error paths (store throws)
 */

module.exports = function (test, assert, helpers) {

  // ── parsePositiveInt edge cases ─────────────────────────────────

  test('parsePositiveInt returns null for NaN', () => {
    const { parsePositiveInt } = require('../../src/lib/turn-timeout');
    assert.equal(parsePositiveInt('not-a-number'), null);
  });

  test('parsePositiveInt returns null for zero', () => {
    const { parsePositiveInt } = require('../../src/lib/turn-timeout');
    assert.equal(parsePositiveInt(0), null);
  });

  test('parsePositiveInt returns null for negative numbers', () => {
    const { parsePositiveInt } = require('../../src/lib/turn-timeout');
    assert.equal(parsePositiveInt(-100), null);
    assert.equal(parsePositiveInt('-5'), null);
  });

  test('parsePositiveInt returns null for null and undefined', () => {
    const { parsePositiveInt } = require('../../src/lib/turn-timeout');
    assert.equal(parsePositiveInt(null), null);
    assert.equal(parsePositiveInt(undefined), null);
  });

  test('parsePositiveInt returns null for empty string', () => {
    const { parsePositiveInt } = require('../../src/lib/turn-timeout');
    assert.equal(parsePositiveInt(''), null);
  });

  test('parsePositiveInt parses valid positive integers', () => {
    const { parsePositiveInt } = require('../../src/lib/turn-timeout');
    assert.equal(parsePositiveInt(42), 42);
    assert.equal(parsePositiveInt('300000'), 300000);
    assert.equal(parsePositiveInt(1), 1);
  });

  test('parsePositiveInt truncates float strings to int', () => {
    const { parsePositiveInt } = require('../../src/lib/turn-timeout');
    assert.equal(parsePositiveInt('3.7'), 3);
    assert.equal(parsePositiveInt('99.99'), 99);
  });

  // ── resolveTokenTimeoutMs edge cases ────────────────────────────

  test('resolveTokenTimeoutMs returns null for null token', () => {
    const { resolveTokenTimeoutMs } = require('../../src/lib/turn-timeout');
    assert.equal(resolveTokenTimeoutMs(null), null);
  });

  test('resolveTokenTimeoutMs returns null for non-object token', () => {
    const { resolveTokenTimeoutMs } = require('../../src/lib/turn-timeout');
    assert.equal(resolveTokenTimeoutMs('string'), null);
    assert.equal(resolveTokenTimeoutMs(42), null);
  });

  test('resolveTokenTimeoutMs supports camelCase timeoutMs', () => {
    const { resolveTokenTimeoutMs } = require('../../src/lib/turn-timeout');
    const value = resolveTokenTimeoutMs({ timeoutMs: 180000 });
    assert.equal(value, 180000);
  });

  test('resolveTokenTimeoutMs prefers timeout_ms over timeoutMs', () => {
    const { resolveTokenTimeoutMs } = require('../../src/lib/turn-timeout');
    const value = resolveTokenTimeoutMs({ timeout_ms: 240000, timeoutMs: 180000 });
    assert.equal(value, 240000);
  });

  test('resolveTokenTimeoutMs supports camelCase tierSettings', () => {
    const { resolveTokenTimeoutMs } = require('../../src/lib/turn-timeout');
    const value = resolveTokenTimeoutMs({
      tierSettings: { timeoutMs: 150000 }
    });
    assert.equal(value, 150000);
  });

  test('resolveTokenTimeoutMs returns null for empty token object', () => {
    const { resolveTokenTimeoutMs } = require('../../src/lib/turn-timeout');
    assert.equal(resolveTokenTimeoutMs({}), null);
  });

  test('resolveTokenTimeoutMs returns null when tier_settings is not an object', () => {
    const { resolveTokenTimeoutMs } = require('../../src/lib/turn-timeout');
    assert.equal(resolveTokenTimeoutMs({ tier_settings: 'bad' }), null);
  });

  test('resolveTokenTimeoutMs ignores invalid timeout_ms values', () => {
    const { resolveTokenTimeoutMs } = require('../../src/lib/turn-timeout');
    assert.equal(resolveTokenTimeoutMs({ timeout_ms: -1 }), null);
    assert.equal(resolveTokenTimeoutMs({ timeout_ms: 0 }), null);
    assert.equal(resolveTokenTimeoutMs({ timeout_ms: 'garbage' }), null);
  });

  // ── resolveTurnTimeoutMs edge cases ─────────────────────────────

  test('resolveTurnTimeoutMs uses custom hardFallbackMs when provided', () => {
    const { resolveTurnTimeoutMs } = require('../../src/lib/turn-timeout');
    const value = resolveTurnTimeoutMs({ hardFallbackMs: 120000 });
    assert.equal(value, 120000);
  });

  test('resolveTurnTimeoutMs uses HARD_FALLBACK when all sources empty', () => {
    const {
      resolveTurnTimeoutMs,
      HARD_FALLBACK_TURN_TIMEOUT_MS
    } = require('../../src/lib/turn-timeout');
    const value = resolveTurnTimeoutMs({});
    assert.equal(value, HARD_FALLBACK_TURN_TIMEOUT_MS);
    assert.equal(value, 300000);
  });

  test('resolveTurnTimeoutMs skips invalid tokenTimeoutMs', () => {
    const { resolveTurnTimeoutMs } = require('../../src/lib/turn-timeout');
    const value = resolveTurnTimeoutMs({
      tokenTimeoutMs: -1,
      configTimeoutMs: 200000
    });
    assert.equal(value, 200000);
  });

  test('resolveTurnTimeoutMs skips zero envTimeoutMs', () => {
    const { resolveTurnTimeoutMs } = require('../../src/lib/turn-timeout');
    const value = resolveTurnTimeoutMs({
      envTimeoutMs: 0,
      configTimeoutMs: 200000
    });
    assert.equal(value, 200000);
  });

  // ── CallMonitor: idle timeout trigger ───────────────────────────

  test('_checkIdleConversations concludes idle conversation', async () => {
    delete require.cache[require.resolve('../../src/lib/call-monitor')];
    const { CallMonitor } = require('../../src/lib/call-monitor');

    let concludedId = null;
    let concludeReason = null;
    const monitor = new CallMonitor({
      idleTimeoutMs: 50,       // 50ms idle timeout for fast test
      maxDurationMs: 300000,   // high max duration (not under test here)
      checkIntervalMs: 100000, // manual trigger, no auto-run
      convStore: {
        concludeConversation: async (id, opts) => {
          concludedId = id;
          return { success: true };
        },
        getConversationContext: () => ({})
      },
      notifyOwner: async (notification) => {
        concludeReason = notification.reason;
      }
    });

    // Track a conversation, then wait for it to become idle
    monitor.trackActivity('conv_idle_test', { name: 'TestAgent' });

    // Wait longer than idle timeout
    await new Promise(r => setTimeout(r, 80));

    // Manually trigger the check
    await monitor._checkIdleConversations();

    assert.equal(concludedId, 'conv_idle_test');
    assert.equal(monitor.getActiveCount(), 0);
    // Wait a tick for notifyOwner to fire
    await new Promise(r => setTimeout(r, 20));
    assert.equal(concludeReason, 'idle_timeout');
    monitor.stop();
  });

  // ── CallMonitor: max duration trigger ───────────────────────────

  test('_checkIdleConversations concludes conversation exceeding max duration', async () => {
    delete require.cache[require.resolve('../../src/lib/call-monitor')];
    const { CallMonitor } = require('../../src/lib/call-monitor');

    let concludedId = null;
    let concludeReason = null;
    const monitor = new CallMonitor({
      idleTimeoutMs: 300000,   // high idle timeout (not under test)
      maxDurationMs: 50,       // 50ms max duration for fast test
      checkIntervalMs: 100000,
      convStore: {
        concludeConversation: async (id) => {
          concludedId = id;
          return { success: true };
        },
        getConversationContext: () => ({})
      },
      notifyOwner: async (notification) => {
        concludeReason = notification.reason;
      }
    });

    monitor.trackActivity('conv_maxdur_test', { name: 'TestAgent' });

    // Keep activity fresh (not idle) but wait past max duration
    await new Promise(r => setTimeout(r, 30));
    monitor.trackActivity('conv_maxdur_test'); // refresh lastActivity
    await new Promise(r => setTimeout(r, 40));

    await monitor._checkIdleConversations();

    assert.equal(concludedId, 'conv_maxdur_test');
    assert.equal(monitor.getActiveCount(), 0);
    await new Promise(r => setTimeout(r, 20));
    assert.equal(concludeReason, 'max_duration');
    monitor.stop();
  });

  // ── CallMonitor: _checkIdleConversations leaves active conversations ─

  test('_checkIdleConversations does not conclude active conversations', async () => {
    delete require.cache[require.resolve('../../src/lib/call-monitor')];
    const { CallMonitor } = require('../../src/lib/call-monitor');

    let concludedCount = 0;
    const monitor = new CallMonitor({
      idleTimeoutMs: 60000,
      maxDurationMs: 300000,
      checkIntervalMs: 100000,
      convStore: {
        concludeConversation: async () => {
          concludedCount++;
          return { success: true };
        },
        getConversationContext: () => ({})
      },
      notifyOwner: async () => {}
    });

    monitor.trackActivity('conv_active', { name: 'TestAgent' });

    // Immediately check — should NOT conclude (just tracked, not idle)
    await monitor._checkIdleConversations();

    assert.equal(concludedCount, 0, 'Should not conclude active conversation');
    assert.equal(monitor.getActiveCount(), 1);
    monitor.stop();
  });

  // ── CallMonitor: endConversation error path (store throws) ──────

  test('endConversation returns error when convStore.concludeConversation throws', async () => {
    delete require.cache[require.resolve('../../src/lib/call-monitor')];
    const { CallMonitor } = require('../../src/lib/call-monitor');

    const monitor = new CallMonitor({
      idleTimeoutMs: 60000,
      maxDurationMs: 300000,
      checkIntervalMs: 100000,
      convStore: {
        concludeConversation: async () => {
          throw new Error('DB write failed');
        }
      },
      notifyOwner: async () => {}
    });

    monitor.trackActivity('conv_err', { name: 'TestAgent' });
    const result = await monitor.endConversation('conv_err', 'explicit');

    assert.equal(result.success, false);
    assert.equal(result.error, 'DB write failed');
    assert.equal(monitor.getActiveCount(), 0, 'Conversation removed from tracking even on error');
    monitor.stop();
  });

  // ── CallMonitor: multiple idle conversations concluded together ──

  test('_checkIdleConversations concludes all idle conversations', async () => {
    delete require.cache[require.resolve('../../src/lib/call-monitor')];
    const { CallMonitor } = require('../../src/lib/call-monitor');

    const concluded = [];
    const monitor = new CallMonitor({
      idleTimeoutMs: 50,
      maxDurationMs: 300000,
      checkIntervalMs: 100000,
      convStore: {
        concludeConversation: async (id) => {
          concluded.push(id);
          return { success: true };
        },
        getConversationContext: () => ({})
      },
      notifyOwner: async () => {}
    });

    monitor.trackActivity('conv_a', { name: 'Agent A' });
    monitor.trackActivity('conv_b', { name: 'Agent B' });

    await new Promise(r => setTimeout(r, 80));
    await monitor._checkIdleConversations();

    assert.equal(concluded.length, 2, 'Both idle conversations concluded');
    assert.includes(concluded, 'conv_a');
    assert.includes(concluded, 'conv_b');
    assert.equal(monitor.getActiveCount(), 0);
    monitor.stop();
  });
};
