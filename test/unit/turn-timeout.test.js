module.exports = function (test, assert) {
  const {
    HARD_FALLBACK_TURN_TIMEOUT_MS,
    resolveTokenTimeoutMs,
    resolveTurnTimeoutMs
  } = require('../../src/lib/turn-timeout');

  test('resolveTokenTimeoutMs prefers token.timeout_ms', () => {
    const value = resolveTokenTimeoutMs({
      timeout_ms: 240000,
      tier_settings: { timeout_ms: 210000 }
    });
    assert.equal(value, 240000);
  });

  test('resolveTokenTimeoutMs falls back to token tier settings', () => {
    const value = resolveTokenTimeoutMs({
      tier_settings: { timeout_ms: 210000 }
    });
    assert.equal(value, 210000);
  });

  test('resolveTurnTimeoutMs precedence token then env then config then fallback', () => {
    const tokenValue = resolveTurnTimeoutMs({
      tokenTimeoutMs: 240000,
      envTimeoutMs: 220000,
      configTimeoutMs: 200000
    });
    assert.equal(tokenValue, 240000);

    const envValue = resolveTurnTimeoutMs({
      envTimeoutMs: 220000,
      configTimeoutMs: 200000
    });
    assert.equal(envValue, 220000);

    const configValue = resolveTurnTimeoutMs({
      configTimeoutMs: 200000
    });
    assert.equal(configValue, 200000);

    const fallbackValue = resolveTurnTimeoutMs({
      envTimeoutMs: '',
      configTimeoutMs: ''
    });
    assert.equal(fallbackValue, HARD_FALLBACK_TURN_TIMEOUT_MS);
  });
};
