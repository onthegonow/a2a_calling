/**
 * E2E Test Result Persistence
 *
 * Stores test results as timestamped JSON in ~/.config/openclaw/test-results/.
 * Provides history retrieval and regression detection.
 *
 * A2A-42: Local-first result storage — no external dependencies.
 */

const fs = require('fs');
const path = require('path');

// A2A-42: Default config dir matches src/lib/config.js resolution.
// Accept configDir parameter for testability (reviewer feedback: module-level
// constants prevent testing the null-path without subprocess gymnastics).
const DEFAULT_CONFIG_DIR = process.env.A2A_CONFIG_DIR ||
  process.env.OPENCLAW_CONFIG_DIR ||
  path.join(process.env.HOME || '/tmp', '.config', 'openclaw');

const MAX_HISTORY = 20;

// A2A-42: Monotonic counter to disambiguate files written within the same
// millisecond (reviewer flagged tight-loop timestamp collisions in tests).
let seqCounter = 0;

function resolveDir(configDir) {
  const base = configDir || DEFAULT_CONFIG_DIR;
  return {
    resultsDir: path.join(base, 'test-results'),
    latestFile: path.join(base, 'test-results', 'latest.json')
  };
}

// Module-level defaults for callers that don't pass configDir
const RESULTS_DIR = resolveDir().resultsDir;
const LATEST_FILE = resolveDir().latestFile;

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Save a test report result to disk.
 * Writes a timestamped file and updates latest.json.
 * Prunes history beyond MAX_HISTORY entries.
 *
 * @param {object} report - Output from TestReport.toJSON()
 * @returns {{ file: string, latest: string, regression: object }}
 */
function saveResult(report, options = {}) {
  const { resultsDir, latestFile } = resolveDir(options.configDir);
  ensureDir(resultsDir);

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  // A2A-42: Append monotonic counter to prevent filename collisions in tight loops
  const seq = String(seqCounter++).padStart(4, '0');
  const filename = `result-${ts}-${seq}.json`;
  const filepath = path.join(resultsDir, filename);

  // A2A-42: Detect regression before writing, so we can include it in the saved result
  const previous = getLatest(options);
  const regression = previous ? detectRegression(report, previous) : {
    detected: false,
    newFailures: [],
    fixedTests: []
  };

  const enriched = { ...report, regression };
  const json = JSON.stringify(enriched, null, 2);

  // A2A-42: Atomic write via tmp+rename — matches pattern from src/lib/config.js:290
  // Prevents truncated reads if the server reads latest.json mid-write.
  const tmpTimestamped = filepath + '.tmp';
  fs.writeFileSync(tmpTimestamped, json);
  fs.renameSync(tmpTimestamped, filepath);

  const tmpLatest = latestFile + '.tmp';
  fs.writeFileSync(tmpLatest, json);
  fs.renameSync(tmpLatest, latestFile);

  pruneHistory(options);

  return { file: filepath, latest: latestFile, regression };
}

/**
 * Read the most recent test result.
 * @returns {object|null}
 */
function getLatest(options = {}) {
  const { latestFile } = resolveDir(options.configDir);
  if (!fs.existsSync(latestFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(latestFile, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Read the last N results, newest first.
 * @param {number} [limit=20]
 * @returns {object[]}
 */
function getHistory(limit = MAX_HISTORY, options = {}) {
  const { resultsDir } = resolveDir(options.configDir);
  if (!fs.existsSync(resultsDir)) return [];

  const files = fs.readdirSync(resultsDir)
    .filter(f => f.startsWith('result-') && f.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, Math.max(1, limit));

  return files.map(f => {
    try {
      return JSON.parse(fs.readFileSync(path.join(resultsDir, f), 'utf8'));
    } catch {
      return null;
    }
  }).filter(Boolean);
}

/**
 * Compare current vs previous result for regressions.
 * A regression is a step that passed before but fails now.
 * A fix is a step that failed before but passes now.
 *
 * @param {object} current - Current report JSON
 * @param {object} previous - Previous report JSON
 * @returns {{ detected: boolean, newFailures: string[], fixedTests: string[] }}
 */
function detectRegression(current, previous) {
  const prevSteps = new Map();
  for (const step of (previous.steps || [])) {
    prevSteps.set(step.name, step.status);
  }

  const newFailures = [];
  const fixedTests = [];

  for (const step of (current.steps || [])) {
    const prevStatus = prevSteps.get(step.name);
    if (!prevStatus) continue; // new step, not a regression
    if (step.status === 'fail' && prevStatus === 'pass') {
      newFailures.push(step.name);
    }
    if (step.status === 'pass' && prevStatus === 'fail') {
      fixedTests.push(step.name);
    }
  }

  return {
    detected: newFailures.length > 0,
    newFailures,
    fixedTests
  };
}

/**
 * Remove old result files beyond MAX_HISTORY.
 */
function pruneHistory(options = {}) {
  const { resultsDir } = resolveDir(options.configDir);
  if (!fs.existsSync(resultsDir)) return;

  const files = fs.readdirSync(resultsDir)
    .filter(f => f.startsWith('result-') && f.endsWith('.json'))
    .sort();

  while (files.length > MAX_HISTORY) {
    const oldest = files.shift();
    try {
      fs.unlinkSync(path.join(resultsDir, oldest));
    } catch {
      // best effort
    }
  }
}

module.exports = {
  saveResult,
  getLatest,
  getHistory,
  detectRegression,
  RESULTS_DIR,
  LATEST_FILE,
  MAX_HISTORY,
  resolveDir
};
