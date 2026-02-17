module.exports = function (test, assert, helpers) {
  const { TestReport } = require('./report');

  test('TestReport tracks pass/fail/skip counts', () => {
    const report = new TestReport('Counting Test');

    report.pass('step-1', 'all good');
    report.pass('step-2');
    report.fail('step-3', 'something broke', 'check logs');
    report.skip('step-4', 'not ready');

    assert.equal(report.passed, 2, 'Should have 2 passed');
    assert.equal(report.failed, 1, 'Should have 1 failed');
    assert.equal(report.skipped, 1, 'Should have 1 skipped');
    assert.equal(report.allPassed, false, 'Should not be allPassed with failures');
    assert.equal(report.steps.length, 4, 'Should have 4 total steps');
  });

  test('TestReport.allPassed is true when no failures', () => {
    const report = new TestReport('All Pass');

    report.pass('step-1');
    report.pass('step-2');
    report.skip('step-3', 'optional');

    assert.equal(report.allPassed, true, 'Should be allPassed (skips do not count as failures)');
  });

  test('TestReport stores step details and errors', () => {
    const report = new TestReport('Details Test');

    report.pass('good-step', 'ran in 10ms');
    report.fail('bad-step', new Error('boom'), 'during setup');
    report.skip('skip-step', 'dependency missing');

    const passStep = report.steps[0];
    assert.equal(passStep.name, 'good-step');
    assert.equal(passStep.status, 'pass');
    assert.equal(passStep.details, 'ran in 10ms');

    const failStep = report.steps[1];
    assert.equal(failStep.name, 'bad-step');
    assert.equal(failStep.status, 'fail');
    assert.includes(failStep.error, 'boom');
    assert.equal(failStep.details, 'during setup');

    const skipStep = report.steps[2];
    assert.equal(skipStep.name, 'skip-step');
    assert.equal(skipStep.status, 'skip');
    assert.equal(skipStep.reason, 'dependency missing');
  });

  test('TestReport.toMarkdown generates valid markdown', () => {
    const report = new TestReport('Markdown Report');
    report.pass('create-env', 'env ready');
    report.fail('invoke-call', 'timeout after 5s', 'network issue');
    report.skip('cleanup', 'skipped due to failure');
    report.finish();

    const md = report.toMarkdown();

    assert.includes(md, '# Markdown Report - FAILED', 'Should have title with FAILED status');
    assert.includes(md, '**Passed:** 1', 'Should show pass count');
    assert.includes(md, '**Failed:** 1', 'Should show fail count');
    assert.includes(md, '**Skipped:** 1', 'Should show skip count');
    assert.includes(md, '[PASS] create-env', 'Should mark passing step');
    assert.includes(md, '[FAIL] invoke-call', 'Should mark failing step');
    assert.includes(md, '[SKIP] cleanup', 'Should mark skipped step');
    assert.includes(md, 'Error: timeout after 5s', 'Should include error');
    assert.includes(md, 'Reason: skipped due to failure', 'Should include skip reason');
  });

  test('TestReport.toMarkdown shows PASSED when all pass', () => {
    const report = new TestReport('All Good');
    report.pass('step-1');
    report.finish();

    const md = report.toMarkdown();
    assert.includes(md, '# All Good - PASSED', 'Should show PASSED status');
  });

  test('TestReport.toJSON returns structured data', () => {
    const report = new TestReport('JSON Report');
    report.pass('step-1');
    report.fail('step-2', 'err');
    report.finish();

    const json = report.toJSON();

    assert.equal(json.name, 'JSON Report');
    assert.equal(json.status, 'failed');
    assert.ok(json.startedAt > 0, 'Should have startedAt');
    assert.ok(json.finishedAt > 0, 'Should have finishedAt');
    assert.ok(json.duration >= 0, 'Should have non-negative duration');
    assert.equal(json.summary.passed, 1);
    assert.equal(json.summary.failed, 1);
    assert.equal(json.summary.skipped, 0);
    assert.equal(json.summary.total, 2);
    assert.equal(json.steps.length, 2);
    assert.equal(json.steps[0].name, 'step-1');
    assert.equal(json.steps[0].status, 'pass');
    assert.equal(json.steps[1].name, 'step-2');
    assert.equal(json.steps[1].status, 'fail');
  });

  test('TestReport.toJSON returns passed status when allPassed', () => {
    const report = new TestReport('Pass Report');
    report.pass('step-1');
    report.finish();

    const json = report.toJSON();
    assert.equal(json.status, 'passed');
  });

  test('TestReport.toLinearIssues creates issues for failures only', () => {
    const report = new TestReport('Linear Test');
    report.pass('good-step');
    report.fail('bad-step-1', 'Error A', 'during invoke');
    report.fail('bad-step-2', 'Error B');
    report.skip('skip-step', 'optional');

    const issues = report.toLinearIssues();

    assert.equal(issues.length, 2, 'Should create issues for failures only');

    assert.includes(issues[0].title, 'bad-step-1 failed');
    assert.includes(issues[0].title, '[E2E]');
    assert.includes(issues[0].description, 'Error A');
    assert.includes(issues[0].description, 'during invoke');
    assert.equal(issues[0].priority, 2);
    assert.ok(Array.isArray(issues[0].labels));
    assert.includes(issues[0].labels, 'bug');
    assert.includes(issues[0].labels, 'e2e');

    assert.includes(issues[1].title, 'bad-step-2 failed');
    assert.includes(issues[1].description, 'Error B');
  });

  test('TestReport.toLinearIssues returns empty array when all pass', () => {
    const report = new TestReport('No Failures');
    report.pass('step-1');
    report.pass('step-2');

    const issues = report.toLinearIssues();
    assert.equal(issues.length, 0, 'Should have no issues when all pass');
  });

  test('TestReport.duration tracks elapsed time', async () => {
    const report = new TestReport('Duration Test');
    const before = Date.now();

    // Small delay to ensure measurable duration
    await new Promise(r => setTimeout(r, 20));
    report.pass('step');
    report.finish();

    assert.ok(report.duration >= 10, 'Duration should be at least 10ms');
    assert.ok(report.finishedAt >= before, 'finishedAt should be after start');
  });
};
