/**
 * Update Checker
 *
 * Zero-dependency npm version checks for a2acalling.
 */

const REGISTRY_URL = 'https://registry.npmjs.org/a2acalling/latest';
const FETCH_TIMEOUT_MS = 15000;

function parseVersion(str) {
  if (!str || typeof str !== 'string') return null;
  const match = str.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10)
  };
}

function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return 0;
  if (va.major !== vb.major) return va.major < vb.major ? -1 : 1;
  if (va.minor !== vb.minor) return va.minor < vb.minor ? -1 : 1;
  if (va.patch !== vb.patch) return va.patch < vb.patch ? -1 : 1;
  return 0;
}

function isSameMajor(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return false;
  return va.major === vb.major;
}

async function fetchLatestVersion() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(REGISTRY_URL, {
      signal: controller.signal,
      headers: { Accept: 'application/json' }
    });
    clearTimeout(timeout);
    if (!res.ok) {
      return { error: `Registry returned ${res.status}` };
    }
    const data = await res.json();
    if (!data || typeof data.version !== 'string') {
      return { error: 'No version field in registry response' };
    }
    return { version: data.version };
  } catch (err) {
    if (err && err.name === 'AbortError') {
      return { error: 'Registry request timed out' };
    }
    return { error: err && err.message ? err.message : 'Unknown fetch error' };
  }
}

async function checkForUpdate(currentVersion) {
  const result = await fetchLatestVersion();
  if (result.error) {
    return {
      available: false,
      current: currentVersion,
      latest: null,
      sameMajor: false,
      error: result.error
    };
  }

  const latest = result.version;
  return {
    available: compareVersions(currentVersion, latest) < 0,
    current: currentVersion,
    latest,
    sameMajor: isSameMajor(currentVersion, latest)
  };
}

module.exports = {
  REGISTRY_URL,
  FETCH_TIMEOUT_MS,
  parseVersion,
  compareVersions,
  isSameMajor,
  fetchLatestVersion,
  checkForUpdate
};

