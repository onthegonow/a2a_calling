#!/usr/bin/env node
/**
 * A2A Test Runner
 *
 * Minimal, zero-dependency test runner.
 * Discovers and runs all *.test.js files under test/.
 *
 * Usage:
 *   node test/run.js                  # run all tests (excludes e2e)
 *   node test/run.js --unit           # unit tests only
 *   node test/run.js --integration    # integration tests only
 *   node test/run.js --e2e            # e2e tests only
 *   node test/run.js --filter tokens  # tests matching "tokens"
 *   node test/run.js --verbose        # show passing test names too
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const flags = {
  unit: args.includes('--unit'),
  integration: args.includes('--integration'),
  e2e: args.includes('--e2e'),
  verbose: args.includes('--verbose') || args.includes('-v'),
  filter: args.find((a, i) => args[i - 1] === '--filter') || null
};

// Discover test files
function findTests(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findTests(full));
    } else if (entry.name.endsWith('.test.js')) {
      results.push(full);
    }
  }
  return results.sort();
}

const testDir = path.dirname(__filename);
let testFiles = findTests(testDir);

// Apply filters
if (flags.unit) {
  testFiles = testFiles.filter(f => f.includes('/unit/'));
}
if (flags.integration) {
  testFiles = testFiles.filter(f => f.includes('/integration/'));
}
if (flags.e2e) {
  testFiles = testFiles.filter(f => f.includes('/e2e/'));
}
if (flags.filter) {
  testFiles = testFiles.filter(f => f.includes(flags.filter));
}

// Default: exclude e2e tests unless explicitly requested (they're slower)
if (!flags.unit && !flags.integration && !flags.e2e && !flags.filter) {
  testFiles = testFiles.filter(f => !f.includes('/e2e/'));
}

// Test context — each file gets its own
class TestContext {
  constructor(fileName) {
    this.fileName = fileName;
    this.tests = [];
    this.beforeEachFn = null;
    this.afterEachFn = null;
    this.passed = 0;
    this.failed = 0;
    this.errors = [];
  }

  test(name, fn) {
    this.tests.push({ name, fn });
  }

  beforeEach(fn) {
    this.beforeEachFn = fn;
  }

  afterEach(fn) {
    this.afterEachFn = fn;
  }

  async run() {
    const label = path.relative(testDir, this.fileName);
    process.stdout.write(`\n  ${label}\n`);

    for (const { name, fn } of this.tests) {
      try {
        if (this.beforeEachFn) await this.beforeEachFn();
        await fn();
        if (this.afterEachFn) await this.afterEachFn();
        this.passed++;
        if (flags.verbose) {
          process.stdout.write(`    \x1b[32m✓\x1b[0m ${name}\n`);
        }
      } catch (err) {
        this.failed++;
        this.errors.push({ name, err });
        process.stdout.write(`    \x1b[31m✗\x1b[0m ${name}\n`);
        process.stdout.write(`      \x1b[31m${err.message}\x1b[0m\n`);
        if (err.stack) {
          const stackLine = err.stack.split('\n').find(l => l.includes('.test.js'));
          if (stackLine) process.stdout.write(`      ${stackLine.trim()}\n`);
        }
      }
    }
  }
}

// Minimal assertion library
const assert = {
  ok(value, msg) {
    if (!value) throw new Error(msg || `Expected truthy, got ${JSON.stringify(value)}`);
  },
  equal(actual, expected, msg) {
    if (actual !== expected) {
      throw new Error(msg || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  },
  deepEqual(actual, expected, msg) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) {
      throw new Error(msg || `Deep equal failed:\n  actual:   ${a}\n  expected: ${b}`);
    }
  },
  throws(fn, msg) {
    let threw = false;
    try { fn(); } catch (e) { threw = true; }
    if (!threw) throw new Error(msg || 'Expected function to throw');
  },
  async rejects(fn, msg) {
    let threw = false;
    try { await fn(); } catch (e) { threw = true; }
    if (!threw) throw new Error(msg || 'Expected promise to reject');
  },
  match(str, pattern, msg) {
    if (!pattern.test(str)) {
      throw new Error(msg || `Expected "${str}" to match ${pattern}`);
    }
  },
  includes(haystack, needle, msg) {
    if (typeof haystack === 'string') {
      if (!haystack.includes(needle)) {
        throw new Error(msg || `Expected string to include "${needle}"`);
      }
    } else if (Array.isArray(haystack)) {
      if (!haystack.includes(needle)) {
        throw new Error(msg || `Expected array to include ${JSON.stringify(needle)}`);
      }
    } else {
      throw new Error('assert.includes requires string or array');
    }
  },
  notEqual(actual, expected, msg) {
    if (actual === expected) {
      throw new Error(msg || `Expected values to differ, both are ${JSON.stringify(actual)}`);
    }
  },
  type(value, expectedType, msg) {
    const actual = typeof value;
    if (actual !== expectedType) {
      throw new Error(msg || `Expected type ${expectedType}, got ${actual}`);
    }
  },
  greaterThan(a, b, msg) {
    if (!(a > b)) throw new Error(msg || `Expected ${a} > ${b}`);
  },
  lessThan(a, b, msg) {
    if (!(a < b)) throw new Error(msg || `Expected ${a} < ${b}`);
  }
};

// Run everything
async function main() {
  console.log(`\n\x1b[1mA2A Test Suite\x1b[0m`);
  console.log(`Found ${testFiles.length} test file(s)\n`);

  let totalPassed = 0;
  let totalFailed = 0;
  const allErrors = [];

  for (const file of testFiles) {
    const ctx = new TestContext(file);

    // Load the test module — it receives (test, assert, helpers)
    const helpers = require('./helpers');
    const testModule = require(file);
    testModule(ctx.test.bind(ctx), assert, helpers, ctx);

    await ctx.run();
    totalPassed += ctx.passed;
    totalFailed += ctx.failed;
    allErrors.push(...ctx.errors.map(e => ({ file, ...e })));
  }

  // Summary
  console.log('\n' + '─'.repeat(50));
  console.log(
    `  \x1b[32m${totalPassed} passing\x1b[0m` +
    (totalFailed ? `  \x1b[31m${totalFailed} failing\x1b[0m` : '')
  );

  if (allErrors.length > 0) {
    console.log('\n\x1b[31mFailures:\x1b[0m\n');
    allErrors.forEach(({ file, name, err }, i) => {
      const rel = path.relative(testDir, file);
      console.log(`  ${i + 1}) ${rel} > ${name}`);
      console.log(`     ${err.message}\n`);
    });
    process.exit(1);
  }

  console.log('');
  process.exit(0);
}

main().catch(err => {
  console.error('Runner crashed:', err);
  process.exit(2);
});
