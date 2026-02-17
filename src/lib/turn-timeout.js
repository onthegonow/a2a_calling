const HARD_FALLBACK_TURN_TIMEOUT_MS = 300000;

function parsePositiveInt(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function resolveTokenTimeoutMs(token) {
  if (!token || typeof token !== 'object') {
    return null;
  }

  const topLevel = parsePositiveInt(token.timeout_ms ?? token.timeoutMs);
  if (topLevel) {
    return topLevel;
  }

  const tierSettings = token.tier_settings || token.tierSettings;
  if (!tierSettings || typeof tierSettings !== 'object') {
    return null;
  }
  return parsePositiveInt(tierSettings.timeout_ms ?? tierSettings.timeoutMs);
}

function resolveTurnTimeoutMs(options = {}) {
  const tokenTimeoutMs = parsePositiveInt(options.tokenTimeoutMs);
  if (tokenTimeoutMs) {
    return tokenTimeoutMs;
  }

  const envTimeoutMs = parsePositiveInt(
    options.envTimeoutMs !== undefined ? options.envTimeoutMs : process.env.A2A_TURN_TIMEOUT
  );
  if (envTimeoutMs) {
    return envTimeoutMs;
  }

  const configTimeoutMs = parsePositiveInt(options.configTimeoutMs);
  if (configTimeoutMs) {
    return configTimeoutMs;
  }

  const fallbackTimeoutMs = parsePositiveInt(options.hardFallbackMs);
  return fallbackTimeoutMs || HARD_FALLBACK_TURN_TIMEOUT_MS;
}

module.exports = {
  HARD_FALLBACK_TURN_TIMEOUT_MS,
  parsePositiveInt,
  resolveTokenTimeoutMs,
  resolveTurnTimeoutMs
};
