/**
 * Unit tests for test/e2e/persist.js
 *
 * Uses configDir parameter for isolation — no env var hacks.
 * Each test gets a fresh temp directory.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const { saveResult, getLatest, getHistory, detectRegression, resolveDir } = require('../e2e/persist');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'persist-test-'));
}

function makeReport(overrides = {}) {
  return {
    name: 'E2E Orchestrator',
    status: overrides.status || 'passed',
    startedAt: Date.now() - 500,
    finishedAt: Date.now(),
    duration: 500,
    summary: { passed: 8, failed: 0, skipped: 0, total: 8 },
    steps: overrides.steps || [
      { name: 'Create harness', status: 'pass', timestamp: Date.now() },
      { name: 'Start servers', status: 'pass', timestamp: Date.now() },
      { name: 'Ping both agents', status: 'pass', timestamp: Date.now() },
      { name: 'Create tokens', status: 'pass', timestamp: Date.now() },
      { name: 'Exchange invites', status: 'pass', timestamp: Date.now() },
      { name: 'B calls A', status: 'pass', timestamp: Date.now() },
      { name: 'A calls B', status: 'pass', timestamp: Date.now() },
      { name: 'Verify response integrity', status: 'pass', timestamp: Date.now() }
    ],
    ...overrides
  };
}

module.exports = function (test, assert) {
  test('saveResult creates results directory and files', () => {
    const configDir = makeTmpDir();
    const report = makeReport();
    const result = saveResult(report, { configDir });

    assert.ok(fs.existsSync(result.file), 'Should create timestamped file');
    assert.ok(fs.existsSync(result.latest), 'Should create latest.json');

    const saved = JSON.parse(fs.readFileSync(result.file, 'utf8'));
    assert.equal(saved.status, 'passed');
    assert.equal(saved.summary.passed, 8);
    assert.ok(saved.regression, 'Should include regression field');
    assert.equal(saved.regression.detected, false);
  });

  test('getLatest returns the most recent result', () => {
    const configDir = makeTmpDir();
    const report = makeReport({ duration: 999 });
    saveResult(report, { configDir });
    const latest = getLatest({ configDir });
    assert.ok(latest, 'Should return a result');
    assert.equal(latest.duration, 999);
  });

  test('getLatest returns null when no results exist', () => {
    const configDir = makeTmpDir();
    const latest = getLatest({ configDir });
    assert.equal(latest, null, 'Should return null for empty directory');
  });

  test('getHistory returns results newest first', () => {
    const configDir = makeTmpDir();
    for (let i = 0; i < 3; i++) {
      saveResult(makeReport({ duration: 100 + i }), { configDir });
    }
    const history = getHistory(10, { configDir });
    assert.ok(history.length >= 3, 'Should have at least 3 results');
    assert.ok(history[0].duration >= history[history.length - 1].duration,
      'Should be sorted newest first');
  });

  test('getHistory returns empty array for missing directory', () => {
    const configDir = makeTmpDir();
    const history = getHistory(10, { configDir });
    assert.equal(history.length, 0, 'Should return empty array');
  });

  test('detectRegression identifies new failures', () => {
    const previous = makeReport();
    const current = makeReport({
      status: 'failed',
      steps: [
        { name: 'Create harness', status: 'pass', timestamp: Date.now() },
        { name: 'Start servers', status: 'fail', timestamp: Date.now() },
        { name: 'Ping both agents', status: 'pass', timestamp: Date.now() }
      ]
    });

    const result = detectRegression(current, previous);
    assert.equal(result.detected, true);
    assert.ok(result.newFailures.includes('Start servers'));
    assert.equal(result.fixedTests.length, 0);
  });

  test('detectRegression identifies fixed tests', () => {
    const previous = makeReport({
      steps: [
        { name: 'Create harness', status: 'pass', timestamp: Date.now() },
        { name: 'Start servers', status: 'fail', timestamp: Date.now() }
      ]
    });
    const current = makeReport({
      steps: [
        { name: 'Create harness', status: 'pass', timestamp: Date.now() },
        { name: 'Start servers', status: 'pass', timestamp: Date.now() }
      ]
    });

    const result = detectRegression(current, previous);
    assert.equal(result.detected, false);
    assert.ok(result.fixedTests.includes('Start servers'));
  });

  test('pruneHistory keeps only MAX_HISTORY files', () => {
    const configDir = makeTmpDir();
    // A2A-42: Use counter suffix in filenames to avoid timestamp collision
    // when writing 25 files in a tight loop (reviewer note on flakiness risk).
    for (let i = 0; i < 25; i++) {
      saveResult(makeReport({ duration: i }), { configDir });
    }

    const { resultsDir } = resolveDir(configDir);
    const files = fs.readdirSync(resultsDir)
      .filter(f => f.startsWith('result-') && f.endsWith('.json'));

    assert.ok(files.length <= 20, `Should have at most 20 files, got ${files.length}`);
  });

  test('saveResult uses atomic write (tmp+rename)', () => {
    const configDir = makeTmpDir();
    const report = makeReport();
    const result = saveResult(report, { configDir });

    // No .tmp files should remain after write
    const { resultsDir } = resolveDir(configDir);
    const tmpFiles = fs.readdirSync(resultsDir).filter(f => f.endsWith('.tmp'));
    assert.equal(tmpFiles.length, 0, 'No .tmp files should remain after atomic write');
  });
};
