#!/usr/bin/env node
/**
 * E2E Test Orchestrator
 *
 * Runs the full E2E sequence: create env, start servers, onboard,
 * create tokens, exchange invites, cross-server calls, verify, teardown.
 *
 * Usage:
 *   node test/e2e/orchestrate.js                # markdown report to stderr
 *   node test/e2e/orchestrate.js --json          # JSON report to stdout
 *   node test/e2e/orchestrate.js --persist        # save results to disk
 *   node test/e2e/orchestrate.js --json --persist  # both
 *   node test/e2e/orchestrate.js --verbose        # verbose output
 */

const http = require('http');

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const jsonOutput = args.includes('--json');
const persistResults = args.includes('--persist');

// In JSON mode, redirect console.log/error/warn to stderr so only
// the final JSON report goes to stdout (the A2A logger uses console.log
// for INFO-level messages which would corrupt JSON output).
if (jsonOutput) {
  const _origLog = console.log;
  const _origError = console.error;
  const _origWarn = console.warn;
  console.log = (...a) => process.stderr.write(a.join(' ') + '\n');
  console.error = (...a) => process.stderr.write(a.join(' ') + '\n');
  console.warn = (...a) => process.stderr.write(a.join(' ') + '\n');
}

function log(msg) {
  if (!jsonOutput) {
    process.stderr.write(msg + '\n');
  }
}

function postInvoke(hostname, port, token, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname, port, path: '/api/a2a/invoke',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Content-Length': Buffer.byteLength(data)
      }
    }, (res) => {
      let chunks = '';
      res.on('data', c => chunks += c);
      res.on('end', () => {
        try { resolve({ statusCode: res.statusCode, body: JSON.parse(chunks) }); }
        catch { resolve({ statusCode: res.statusCode, body: chunks }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  const { TestReport } = require('./report');
  const { TwoServerHarness } = require('./two-server');

  const report = new TestReport('E2E Orchestrator');
  let harness = null;

  try {
    // Step 1: Create harness (includes E2E envs)
    log('  [1/8] Creating TwoServerHarness...');
    try {
      harness = new TwoServerHarness({
        handleMessageA: async (message, context) => {
          return { text: `AgentA: received "${message}"`, canContinue: true };
        },
        handleMessageB: async (message, context) => {
          return { text: `AgentB: received "${message}"`, canContinue: true };
        }
      });
      report.pass('Create harness');
      if (verbose) log('    Harness created');
    } catch (err) {
      report.fail('Create harness', err);
      throw err;
    }

    // Step 2: Start two servers
    log('  [2/8] Starting two servers...');
    try {
      await harness.setup();
      report.pass('Start servers', `A=:${harness.agentA.port} B=:${harness.agentB.port}`);
      if (verbose) {
        log(`    Agent A on port ${harness.agentA.port}`);
        log(`    Agent B on port ${harness.agentB.port}`);
      }
    } catch (err) {
      report.fail('Start servers', err);
      throw err;
    }

    // Step 3: Verify both agents respond to ping
    log('  [3/8] Verifying ping on both agents...');
    try {
      const pingA = await httpGet(`http://127.0.0.1:${harness.agentA.port}/api/a2a/ping`);
      const pingB = await httpGet(`http://127.0.0.1:${harness.agentB.port}/api/a2a/ping`);
      if (!pingA.pong || !pingB.pong) {
        throw new Error(`Ping failed: A=${JSON.stringify(pingA)} B=${JSON.stringify(pingB)}`);
      }
      report.pass('Ping both agents');
    } catch (err) {
      report.fail('Ping both agents', err);
      throw err;
    }

    // Step 4: Create tokens (Agent A gives token to B, B gives token to A)
    log('  [4/8] Creating tokens...');
    let tokenForB, tokenForA;
    try {
      tokenForB = harness.agentA.tokenStore.create({
        name: 'ForAgentB',
        permissions: 'friends',
        expires: '1h',
        maxCalls: 50
      });
      tokenForA = harness.agentB.tokenStore.create({
        name: 'ForAgentA',
        permissions: 'friends',
        expires: '1h',
        maxCalls: 50
      });
      if (!tokenForB.token || !tokenForA.token) {
        throw new Error('Token creation returned empty token');
      }
      report.pass('Create tokens', `A-token=${tokenForB.record.id} B-token=${tokenForA.record.id}`);
      if (verbose) {
        log(`    Token for B: ${tokenForB.record.id}`);
        log(`    Token for A: ${tokenForA.record.id}`);
      }
    } catch (err) {
      report.fail('Create tokens', err);
      throw err;
    }

    // Step 5: Exchange invites (add contacts)
    log('  [5/8] Exchanging invites...');
    try {
      const inviteForB = `a2a://127.0.0.1:${harness.agentA.port}/${tokenForB.token}`;
      const inviteForA = `a2a://127.0.0.1:${harness.agentB.port}/${tokenForA.token}`;

      const contactB = harness.agentB.tokenStore.addContact(inviteForB, { name: 'AgentA' });
      const contactA = harness.agentA.tokenStore.addContact(inviteForA, { name: 'AgentB' });

      if (!contactB.success || !contactA.success) {
        throw new Error(`Contact add failed: B=${JSON.stringify(contactB)} A=${JSON.stringify(contactA)}`);
      }
      report.pass('Exchange invites');
    } catch (err) {
      report.fail('Exchange invites', err);
      throw err;
    }

    // Step 6: Cross-server call: B calls A
    log('  [6/8] Agent B calls Agent A...');
    try {
      const result = await postInvoke('127.0.0.1', harness.agentA.port, tokenForB.token, {
        message: 'Hello from Agent B!',
        caller: { name: 'AgentB', owner: 'E2E-Test' }
      });
      if (result.statusCode !== 200 || !result.body.success) {
        throw new Error(`B->A call failed: ${result.statusCode} ${JSON.stringify(result.body)}`);
      }
      if (!result.body.response.includes('AgentA')) {
        throw new Error(`Unexpected response: ${result.body.response}`);
      }
      report.pass('B calls A', `response="${result.body.response.slice(0, 80)}"`);
      if (verbose) log(`    Response: ${result.body.response}`);
    } catch (err) {
      report.fail('B calls A', err);
      throw err;
    }

    // Step 7: Cross-server call: A calls B
    log('  [7/8] Agent A calls Agent B...');
    try {
      const result = await postInvoke('127.0.0.1', harness.agentB.port, tokenForA.token, {
        message: 'Hello from Agent A!',
        caller: { name: 'AgentA', owner: 'E2E-Test' }
      });
      if (result.statusCode !== 200 || !result.body.success) {
        throw new Error(`A->B call failed: ${result.statusCode} ${JSON.stringify(result.body)}`);
      }
      if (!result.body.response.includes('AgentB')) {
        throw new Error(`Unexpected response: ${result.body.response}`);
      }
      report.pass('A calls B', `response="${result.body.response.slice(0, 80)}"`);
      if (verbose) log(`    Response: ${result.body.response}`);
    } catch (err) {
      report.fail('A calls B', err);
      throw err;
    }

    // Step 8: Verify responses
    log('  [8/8] Verifying response integrity...');
    try {
      // Make another round-trip to confirm conversation IDs are returned
      const verifyCall = await postInvoke('127.0.0.1', harness.agentA.port, tokenForB.token, {
        message: 'Verification message',
        caller: { name: 'AgentB' }
      });
      if (!verifyCall.body.conversation_id) {
        throw new Error('Missing conversation_id in response');
      }
      if (verifyCall.body.can_continue !== true) {
        throw new Error('Expected can_continue=true');
      }
      report.pass('Verify response integrity');
    } catch (err) {
      report.fail('Verify response integrity', err);
    }

  } catch (err) {
    // Critical failure - steps after the failed one are skipped
    if (verbose) log(`  CRITICAL: ${err.message}`);
  } finally {
    // Teardown
    if (harness) {
      try {
        await harness.teardown();
        if (verbose) log('  Teardown complete');
      } catch (err) {
        log(`  Teardown error: ${err.message}`);
      }
    }
  }

  report.finish();

  // A2A-42: Persist results to local storage for regression tracking
  if (persistResults) {
    try {
      const { saveResult } = require('./persist');
      const persisted = saveResult(report.toJSON());
      if (!jsonOutput) {
        process.stderr.write(`Results saved to ${persisted.file}\n`);
      }
      if (persisted.regression.detected) {
        process.stderr.write(`\u26A0 REGRESSION DETECTED: ${persisted.regression.newFailures.join(', ')}\n`);
      }
      if (persisted.regression.fixedTests.length > 0) {
        process.stderr.write(`\u2713 Fixed: ${persisted.regression.fixedTests.join(', ')}\n`);
      }
    } catch (err) {
      process.stderr.write(`Warning: Failed to persist results: ${err.message}\n`);
    }
  }

  // Output report
  if (jsonOutput) {
    process.stdout.write(JSON.stringify(report.toJSON(), null, 2) + '\n');
  } else {
    process.stderr.write('\n' + report.toMarkdown());
  }

  // Exit code
  process.exit(report.allPassed ? 0 : 1);
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    }).on('error', reject);
  });
}

main().catch(err => {
  process.stderr.write(`Orchestrator crashed: ${err.message}\n${err.stack}\n`);
  process.exit(2);
});
