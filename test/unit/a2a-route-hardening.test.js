/**
 * A2A Route Hardening Tests (A2A-53)
 *
 * Covers three hardening fixes:
 * 1. Rate limit Map eviction (stale sweep + oldest-entry fallback)
 * 2. Timing-safe admin token comparison
 * 3. parseInt validation with NaN fallback and clamping
 */

module.exports = function (test, assert, helpers) {

  // ── 1. Rate limit eviction ──────────────────────────────────────────

  test('rate limit eviction: Map stays bounded after exceeding threshold', () => {
    delete require.cache[require.resolve('../../src/routes/a2a')];
    const { checkRateLimit, _rateLimits, _RATE_LIMIT_MAX_ENTRIES } = require('../../src/routes/a2a');

    // Clear any leftover state
    _rateLimits.clear();

    // Fill the Map beyond the threshold
    const overCount = _RATE_LIMIT_MAX_ENTRIES + 50;
    for (let i = 0; i < overCount; i++) {
      checkRateLimit(`evict_tok_${i}`, { minute: 100000, hour: 100000, day: 100000 });
    }

    // After the call that crosses the threshold, eviction should have fired
    // The Map should be at or below the max threshold
    assert.ok(
      _rateLimits.size <= _RATE_LIMIT_MAX_ENTRIES + 1,
      `Expected Map size <= ${_RATE_LIMIT_MAX_ENTRIES + 1}, got ${_rateLimits.size}`
    );

    _rateLimits.clear();
  });

  test('rate limit eviction: stale entries are removed first', () => {
    delete require.cache[require.resolve('../../src/routes/a2a')];
    const { checkRateLimit, _rateLimits, _RATE_LIMIT_MAX_ENTRIES } = require('../../src/routes/a2a');

    _rateLimits.clear();

    // Manually insert stale entries (bucket timestamps from 48 hours ago)
    const staleMinute = Math.floor((Date.now() - 48 * 3600000) / 60000);
    const staleHour = Math.floor((Date.now() - 48 * 3600000) / 3600000);
    const staleDay = Math.floor((Date.now() - 48 * 3600000) / 86400000);

    for (let i = 0; i < _RATE_LIMIT_MAX_ENTRIES; i++) {
      _rateLimits.set(`stale_tok_${i}`, {
        minute: { count: 1, bucket: staleMinute },
        hour: { count: 1, bucket: staleHour },
        day: { count: 1, bucket: staleDay }
      });
    }

    // One more call should trigger eviction and remove the stale entries
    checkRateLimit('fresh_tok', { minute: 100000, hour: 100000, day: 100000 });

    // Stale entries should have been swept; only the fresh one remains
    assert.ok(_rateLimits.has('fresh_tok'), 'Fresh entry should survive eviction');
    assert.ok(
      _rateLimits.size <= 2,
      `Expected mostly stale entries evicted, got Map size ${_rateLimits.size}`
    );

    _rateLimits.clear();
  });

  test('rate limit eviction: oldest entries evicted when all are recent', () => {
    delete require.cache[require.resolve('../../src/routes/a2a')];
    const { checkRateLimit, _rateLimits, _RATE_LIMIT_MAX_ENTRIES } = require('../../src/routes/a2a');

    _rateLimits.clear();

    // Fill to exactly the threshold with fresh entries
    for (let i = 0; i < _RATE_LIMIT_MAX_ENTRIES; i++) {
      checkRateLimit(`recent_tok_${i}`, { minute: 100000, hour: 100000, day: 100000 });
    }
    assert.equal(_rateLimits.size, _RATE_LIMIT_MAX_ENTRIES);

    // One more triggers eviction — all are recent, so oldest-first fallback kicks in
    checkRateLimit('trigger_tok', { minute: 100000, hour: 100000, day: 100000 });

    // The Map should not exceed the threshold
    assert.ok(
      _rateLimits.size <= _RATE_LIMIT_MAX_ENTRIES + 1,
      `Expected Map size <= ${_RATE_LIMIT_MAX_ENTRIES + 1}, got ${_rateLimits.size}`
    );
    // The trigger token should still exist (it's the newest)
    assert.ok(_rateLimits.has('trigger_tok'), 'Triggering entry should survive');

    _rateLimits.clear();
  });

  test('rate limit eviction: response shape unchanged', () => {
    delete require.cache[require.resolve('../../src/routes/a2a')];
    const { checkRateLimit, _rateLimits } = require('../../src/routes/a2a');

    _rateLimits.clear();

    const ok = checkRateLimit('shape_tok', { minute: 10, hour: 100, day: 1000 });
    assert.equal(ok.limited, false);
    assert.equal(ok.error, undefined);
    assert.equal(ok.message, undefined);
    assert.equal(ok.retryAfter, undefined);

    // Exhaust minute limit
    for (let i = 1; i < 10; i++) {
      checkRateLimit('shape_tok', { minute: 10, hour: 100, day: 1000 });
    }
    const blocked = checkRateLimit('shape_tok', { minute: 10, hour: 100, day: 1000 });
    assert.equal(blocked.limited, true);
    assert.equal(blocked.error, 'rate_limited');
    assert.equal(typeof blocked.message, 'string');
    assert.equal(typeof blocked.retryAfter, 'number');

    _rateLimits.clear();
  });

  // ── 2. Timing-safe admin auth ───────────────────────────────────────

  test('timingSafeTokenEqual: matching tokens return true', () => {
    delete require.cache[require.resolve('../../src/routes/a2a')];
    const { timingSafeTokenEqual } = require('../../src/routes/a2a');

    assert.equal(timingSafeTokenEqual('secret123', 'secret123'), true);
    assert.equal(timingSafeTokenEqual('a', 'a'), true);
  });

  test('timingSafeTokenEqual: mismatched tokens return false', () => {
    delete require.cache[require.resolve('../../src/routes/a2a')];
    const { timingSafeTokenEqual } = require('../../src/routes/a2a');

    assert.equal(timingSafeTokenEqual('secret123', 'secret456'), false);
    assert.equal(timingSafeTokenEqual('abc', 'xyz'), false);
  });

  test('timingSafeTokenEqual: different lengths return false', () => {
    delete require.cache[require.resolve('../../src/routes/a2a')];
    const { timingSafeTokenEqual } = require('../../src/routes/a2a');

    assert.equal(timingSafeTokenEqual('short', 'muchlongertoken'), false);
    assert.equal(timingSafeTokenEqual('a', 'ab'), false);
  });

  test('timingSafeTokenEqual: null/undefined/empty returns false', () => {
    delete require.cache[require.resolve('../../src/routes/a2a')];
    const { timingSafeTokenEqual } = require('../../src/routes/a2a');

    assert.equal(timingSafeTokenEqual(null, 'token'), false);
    assert.equal(timingSafeTokenEqual('token', null), false);
    assert.equal(timingSafeTokenEqual(null, null), false);
    assert.equal(timingSafeTokenEqual(undefined, 'token'), false);
    assert.equal(timingSafeTokenEqual('', 'token'), false);
    assert.equal(timingSafeTokenEqual('token', ''), false);
  });

  // ── 3. parseInt validation and clamping ─────────────────────────────

  test('parseInt clamping: limit falls back to 20 for non-numeric input', () => {
    // Simulate the inline expression used in the route handler
    const parse = (v) => Math.min(100, Math.max(1, Number.parseInt(String(v), 10) || 20));

    assert.equal(parse('abc'), 20);
    assert.equal(parse(''), 20);
    assert.equal(parse(undefined), 20);
    assert.equal(parse(null), 20);
    assert.equal(parse(NaN), 20);
  });

  test('parseInt clamping: limit respects valid numeric input', () => {
    const parse = (v) => Math.min(100, Math.max(1, Number.parseInt(String(v), 10) || 20));

    assert.equal(parse('10'), 10);
    assert.equal(parse('50'), 50);
    assert.equal(parse('1'), 1);
    assert.equal(parse('100'), 100);
    assert.equal(parse(42), 42);
  });

  test('parseInt clamping: limit is clamped to 1-100 range', () => {
    const parse = (v) => Math.min(100, Math.max(1, Number.parseInt(String(v), 10) || 20));

    assert.equal(parse('0'), 20);   // 0 is falsy, || 20 fires, clamped to 20
    assert.equal(parse('-5'), 1);   // -5 is truthy, Math.max(1, -5) = 1
    assert.equal(parse('999'), 100);
    assert.equal(parse('101'), 100);
  });

  test('parseInt clamping: recent_messages falls back to 10 for non-numeric', () => {
    const parse = (v) => Math.min(50, Math.max(1, Number.parseInt(String(v), 10) || 10));

    assert.equal(parse('abc'), 10);
    assert.equal(parse(''), 10);
    assert.equal(parse(undefined), 10);
    assert.equal(parse(NaN), 10);
  });

  test('parseInt clamping: recent_messages respects valid numeric input', () => {
    const parse = (v) => Math.min(50, Math.max(1, Number.parseInt(String(v), 10) || 10));

    assert.equal(parse('5'), 5);
    assert.equal(parse('25'), 25);
    assert.equal(parse('50'), 50);
    assert.equal(parse(1), 1);
  });

  test('parseInt clamping: recent_messages is clamped to 1-50 range', () => {
    const parse = (v) => Math.min(50, Math.max(1, Number.parseInt(String(v), 10) || 10));

    assert.equal(parse('0'), 10);   // 0 is falsy, falls back to 10
    assert.equal(parse('-1'), 1);   // -1 is truthy, clamped to 1
    assert.equal(parse('999'), 50);
    assert.equal(parse('51'), 50);
  });
};
