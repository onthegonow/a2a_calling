/**
 * E2E Test Report Generator
 *
 * Tracks test steps (pass/fail/skip) and generates
 * Markdown, JSON, or Linear issue output.
 */

class TestReport {
  constructor(name) {
    this.name = name;
    this.steps = [];
    this.startedAt = Date.now();
    this.finishedAt = null;
  }

  pass(stepName, details) {
    this.steps.push({
      name: stepName,
      status: 'pass',
      details: details || null,
      timestamp: Date.now()
    });
  }

  fail(stepName, error, details) {
    this.steps.push({
      name: stepName,
      status: 'fail',
      error: String(error),
      details: details || null,
      timestamp: Date.now()
    });
  }

  skip(stepName, reason) {
    this.steps.push({
      name: stepName,
      status: 'skip',
      reason: reason || null,
      timestamp: Date.now()
    });
  }

  get passed() {
    return this.steps.filter(s => s.status === 'pass').length;
  }

  get failed() {
    return this.steps.filter(s => s.status === 'fail').length;
  }

  get skipped() {
    return this.steps.filter(s => s.status === 'skip').length;
  }

  get allPassed() {
    return this.failed === 0;
  }

  get duration() {
    const end = this.finishedAt || Date.now();
    return end - this.startedAt;
  }

  finish() {
    this.finishedAt = Date.now();
  }

  toMarkdown() {
    const lines = [];
    const status = this.allPassed ? 'PASSED' : 'FAILED';
    lines.push(`# ${this.name} - ${status}`);
    lines.push('');
    lines.push(`**Duration:** ${this.duration}ms`);
    lines.push(`**Passed:** ${this.passed} | **Failed:** ${this.failed} | **Skipped:** ${this.skipped}`);
    lines.push('');
    lines.push('## Steps');
    lines.push('');

    for (const step of this.steps) {
      const icon = step.status === 'pass' ? '[PASS]'
        : step.status === 'fail' ? '[FAIL]'
        : '[SKIP]';

      lines.push(`- ${icon} ${step.name}`);

      if (step.details) {
        lines.push(`  - Details: ${step.details}`);
      }
      if (step.error) {
        lines.push(`  - Error: ${step.error}`);
      }
      if (step.reason) {
        lines.push(`  - Reason: ${step.reason}`);
      }
    }

    lines.push('');
    return lines.join('\n');
  }

  toJSON() {
    return {
      name: this.name,
      status: this.allPassed ? 'passed' : 'failed',
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      duration: this.duration,
      summary: {
        passed: this.passed,
        failed: this.failed,
        skipped: this.skipped,
        total: this.steps.length
      },
      steps: this.steps.map(s => ({ ...s }))
    };
  }

  toLinearIssues() {
    const failures = this.steps.filter(s => s.status === 'fail');
    return failures.map(step => ({
      title: `[E2E] ${this.name}: ${step.name} failed`,
      description: [
        `## E2E Test Failure`,
        '',
        `**Report:** ${this.name}`,
        `**Step:** ${step.name}`,
        `**Error:** ${step.error}`,
        step.details ? `**Details:** ${step.details}` : '',
        '',
        `**Timestamp:** ${new Date(step.timestamp).toISOString()}`
      ].filter(Boolean).join('\n'),
      priority: 2,
      labels: ['bug', 'e2e']
    }));
  }
}

module.exports = { TestReport };
