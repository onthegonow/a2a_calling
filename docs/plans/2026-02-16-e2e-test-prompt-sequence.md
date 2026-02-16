# E2E Test & Prompt Sequence for A2A Install/Onboarding/Invite Flow

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build an AI-agent-driven E2E testing system where an orchestrator spawns a subagent that installs a2acalling from npm, runs onboarding, exercises the invite flow between two isolated servers, and reports results (including auto-filing bugs in Linear).

**Architecture:** The test system uses isolated temp directories (extending the existing `tmpConfigDir` pattern) to spin up two independent a2a servers on ephemeral ports. A CLI runner wraps all `a2a` commands with structured output parsing. The orchestrator script coordinates the full sequence: environment setup → install verification → onboarding → token creation → invite exchange → cross-server call → report generation. A prompt document gives a Claude subagent the exact steps and expected outcomes.

**Tech Stack:** Node.js, Express (ephemeral ports), child_process (CLI invocation), existing zero-dependency test runner, Linear API (for bug filing via MCP or REST)

**Linear ticket:** A2A-21

---

## Phase 1: E2E Environment & CLI Runner

### Task 1: Create E2E environment isolation utility

**Files:**
- Create: `test/e2e/env.js`
- Test: `test/e2e/env.test.js`

**Step 1: Write the failing test**

```javascript
// test/e2e/env.test.js
module.exports = function (test, assert, helpers) {
  test('createE2EEnv returns isolated dir with cleanup', () => {
    const { createE2EEnv } = require('./env');
    const env = createE2EEnv('test-basic');

    assert.ok(env.dir, 'Should have a directory');
    assert.ok(env.configDir, 'Should have a config directory');
    assert.ok(env.env.A2A_CONFIG_DIR, 'Should set A2A_CONFIG_DIR');

    const fs = require('fs');
    assert.ok(fs.existsSync(env.dir), 'Directory should exist');
    assert.ok(fs.existsSync(env.configDir), 'Config dir should exist');

    env.cleanup();
    assert.equal(fs.existsSync(env.dir), false, 'Should clean up');
  });

  test('createE2EEnv provides isolated process env', () => {
    const { createE2EEnv } = require('./env');
    const envA = createE2EEnv('env-a');
    const envB = createE2EEnv('env-b');

    assert.ok(envA.configDir !== envB.configDir, 'Should be different dirs');

    envA.cleanup();
    envB.cleanup();
  });

  test('createE2EEnv finds available port', async () => {
    const { createE2EEnv } = require('./env');
    const env = createE2EEnv('port-test');

    const port = await env.findAvailablePort();
    assert.ok(port >= 3001 && port <= 65535, 'Should return valid port');

    env.cleanup();
  });
};
```

**Step 2: Run test to verify it fails**

Run: `node test/run.js --filter "createE2EEnv"`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```javascript
// test/e2e/env.js
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');

/**
 * Create a fully isolated E2E test environment.
 *
 * Returns { dir, configDir, env, findAvailablePort, cleanup }.
 *
 * - dir: root temp directory for this test run
 * - configDir: path that A2A_CONFIG_DIR points to
 * - env: process.env clone with A2A_CONFIG_DIR set
 * - findAvailablePort(): resolves to an unused port
 * - cleanup(): removes all temp files
 */
function createE2EEnv(prefix = 'a2a-e2e') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  const configDir = path.join(dir, 'config');
  fs.mkdirSync(configDir, { recursive: true });

  const env = {
    ...process.env,
    A2A_CONFIG_DIR: configDir,
    // Prevent postinstall from running quickstart
    CI: 'true'
  };

  function findAvailablePort(startPort = 3001) {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        server.close(() => resolve(port));
      });
      server.on('error', reject);
    });
  }

  function cleanup() {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) { /* best-effort */ }
  }

  return { dir, configDir, env, findAvailablePort, cleanup };
}

module.exports = { createE2EEnv };
```

**Step 4: Run test to verify it passes**

Run: `node test/run.js --filter "createE2EEnv"`
Expected: PASS (all 3 tests)

**Step 5: Commit**

```bash
git add test/e2e/env.js test/e2e/env.test.js
git commit -m "feat(e2e): add isolated environment utility"
```

---

### Task 2: Create CLI runner utility

**Files:**
- Create: `test/e2e/cli-runner.js`
- Test: `test/e2e/cli-runner.test.js`

**Step 1: Write the failing test**

```javascript
// test/e2e/cli-runner.test.js
module.exports = function (test, assert, helpers) {
  const { createE2EEnv } = require('./env');

  test('CLIRunner.run executes a2a command and returns output', async () => {
    const env = createE2EEnv('cli-run');
    const { CLIRunner } = require('./cli-runner');
    const runner = new CLIRunner(env);

    // 'a2a help' should work without onboarding
    const result = await runner.run('help');
    assert.equal(result.exitCode, 0, 'Should exit 0');
    assert.ok(result.stdout.length > 0, 'Should have stdout');

    env.cleanup();
  });

  test('CLIRunner.run captures non-zero exit codes', async () => {
    const env = createE2EEnv('cli-fail');
    const { CLIRunner } = require('./cli-runner');
    const runner = new CLIRunner(env);

    // 'a2a call' without onboarding should fail
    const result = await runner.run('call', ['nobody', 'hello']);
    assert.ok(result.exitCode !== 0, 'Should exit non-zero');

    env.cleanup();
  });

  test('CLIRunner.run respects timeout', async () => {
    const env = createE2EEnv('cli-timeout');
    const { CLIRunner } = require('./cli-runner');
    const runner = new CLIRunner(env, { timeout: 500 });

    // Running a command that hangs should time out
    const result = await runner.run('server', ['99999'], { timeout: 500 });
    assert.ok(result.timedOut || result.exitCode !== 0, 'Should timeout or fail');

    env.cleanup();
  });

  test('CLIRunner.onboard completes full onboarding via --submit', async () => {
    const env = createE2EEnv('cli-onboard');
    const { CLIRunner } = require('./cli-runner');
    const runner = new CLIRunner(env);

    const fs = require('fs');
    const path = require('path');

    // Pre-set config to awaiting_disclosure (skip port detection step)
    const configPath = path.join(env.configDir, 'a2a-config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      onboarding: { version: 2, step: 'awaiting_disclosure' },
      agent: { hostname: 'localhost:3001', name: 'e2e-test-agent' },
      tiers: {}
    }));

    const result = await runner.onboard({
      personalityNotes: 'E2E test agent — direct and minimal',
      topics: [{ topic: 'Testing', description: 'Automated E2E tests' }]
    });

    assert.ok(result.success, 'Onboarding should succeed');
    assert.ok(result.stdout.includes('Onboarding complete'), 'Should say complete');

    env.cleanup();
  });
};
```

**Step 2: Run test to verify it fails**

Run: `node test/run.js --filter "CLIRunner"`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```javascript
// test/e2e/cli-runner.js
const { execFile } = require('child_process');
const path = require('path');

const CLI_PATH = path.join(__dirname, '..', '..', 'bin', 'cli.js');

/**
 * Wraps the a2a CLI for structured E2E testing.
 *
 * Each method runs the CLI as a child process in the
 * given E2E environment, returning { stdout, stderr, exitCode, timedOut }.
 */
class CLIRunner {
  constructor(e2eEnv, options = {}) {
    this.env = e2eEnv;
    this.defaultTimeout = options.timeout || 30000;
  }

  /**
   * Run an a2a CLI command.
   * @param {string} command - The a2a subcommand (e.g., 'list', 'create')
   * @param {string[]} args - Additional arguments
   * @param {object} options - { timeout }
   * @returns {Promise<{stdout, stderr, exitCode, timedOut}>}
   */
  run(command, args = [], options = {}) {
    const timeout = options.timeout || this.defaultTimeout;
    const fullArgs = [CLI_PATH, command, ...args];

    return new Promise((resolve) => {
      const child = execFile(process.execPath, fullArgs, {
        env: this.env.env,
        encoding: 'utf8',
        timeout,
        maxBuffer: 1024 * 1024
      }, (error, stdout, stderr) => {
        resolve({
          stdout: stdout || '',
          stderr: stderr || '',
          exitCode: error ? (error.code || 1) : 0,
          timedOut: error && error.killed
        });
      });
    });
  }

  /**
   * Complete onboarding programmatically via `onboard --submit`.
   *
   * @param {object} disclosure - { personalityNotes, topics, objectives, neverDisclose }
   * @returns {Promise<{success, stdout, stderr}>}
   */
  async onboard(disclosure = {}) {
    const submission = {
      tiers: {
        public: {
          topics: disclosure.topics || [{ topic: 'General', description: 'Open discussion' }],
          objectives: disclosure.objectives || [],
          do_not_discuss: disclosure.doNotDiscuss || []
        },
        friends: { topics: [], objectives: [], do_not_discuss: [] },
        family: { topics: [], objectives: [], do_not_discuss: [] }
      },
      never_disclose: disclosure.neverDisclose || [],
      personality_notes: disclosure.personalityNotes || 'E2E test agent'
    };

    const result = await this.run('onboard', ['--submit', JSON.stringify(submission)]);
    return {
      success: result.exitCode === 0 && result.stdout.includes('Onboarding complete'),
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode
    };
  }

  /**
   * Create a token and return the parsed output.
   * @param {object} options - { name, tier, expires, maxCalls, topics }
   * @returns {Promise<{success, token, inviteUrl, stdout}>}
   */
  async createToken(options = {}) {
    const args = [];
    if (options.name) args.push('--name', options.name);
    if (options.tier) args.push('--tier', options.tier);
    if (options.expires) args.push('--expires', options.expires);
    if (options.maxCalls) args.push('--max-calls', String(options.maxCalls));
    if (options.topics) args.push('--topics', options.topics);

    const result = await this.run('create', args);

    // Parse invite URL from output (format: a2a://host/token)
    const urlMatch = result.stdout.match(/a2a:\/\/[^\s]+/);
    const tokenMatch = result.stdout.match(/fed_[A-Za-z0-9_-]+/);

    return {
      success: result.exitCode === 0,
      inviteUrl: urlMatch ? urlMatch[0] : null,
      token: tokenMatch ? tokenMatch[0] : null,
      stdout: result.stdout,
      stderr: result.stderr
    };
  }

  /**
   * Add a contact from an invite URL.
   * @param {string} inviteUrl - a2a://host/token URL
   * @param {string} name - Contact name
   * @returns {Promise<{success, stdout, stderr}>}
   */
  async addContact(inviteUrl, name) {
    const result = await this.run('add', [inviteUrl, name]);
    return {
      success: result.exitCode === 0,
      stdout: result.stdout,
      stderr: result.stderr
    };
  }

  /**
   * List tokens.
   * @returns {Promise<{success, stdout}>}
   */
  async listTokens() {
    const result = await this.run('list');
    return {
      success: result.exitCode === 0,
      stdout: result.stdout,
      stderr: result.stderr
    };
  }

  /**
   * List contacts.
   * @returns {Promise<{success, stdout}>}
   */
  async listContacts() {
    const result = await this.run('contacts');
    return {
      success: result.exitCode === 0,
      stdout: result.stdout,
      stderr: result.stderr
    };
  }

  /**
   * Ping a remote agent.
   * @param {string} target - URL or contact name
   * @returns {Promise<{success, stdout}>}
   */
  async ping(target) {
    const result = await this.run('ping', [target]);
    return {
      success: result.exitCode === 0,
      stdout: result.stdout,
      stderr: result.stderr
    };
  }
}

module.exports = { CLIRunner };
```

**Step 4: Run test to verify it passes**

Run: `node test/run.js --filter "CLIRunner"`
Expected: PASS (all 4 tests)

**Step 5: Commit**

```bash
git add test/e2e/cli-runner.js test/e2e/cli-runner.test.js
git commit -m "feat(e2e): add CLI runner utility for structured command execution"
```

---

## Phase 2: Two-Server E2E Test

### Task 3: Create two-server test harness

**Files:**
- Create: `test/e2e/two-server.js`
- Test: `test/e2e/two-server.test.js`

**Step 1: Write the failing test**

```javascript
// test/e2e/two-server.test.js
module.exports = function (test, assert, helpers) {
  const { TwoServerHarness } = require('./two-server');

  test('TwoServerHarness starts two isolated servers', async () => {
    const harness = new TwoServerHarness();
    await harness.setup();

    assert.ok(harness.agentA, 'Agent A should exist');
    assert.ok(harness.agentB, 'Agent B should exist');
    assert.ok(harness.agentA.port, 'Agent A should have a port');
    assert.ok(harness.agentB.port, 'Agent B should have a port');
    assert.ok(harness.agentA.port !== harness.agentB.port, 'Ports should differ');

    // Both should respond to ping
    const http = require('http');
    const pingA = await httpGet(`http://127.0.0.1:${harness.agentA.port}/api/a2a/ping`);
    assert.ok(pingA.pong, 'Agent A should respond to ping');

    const pingB = await httpGet(`http://127.0.0.1:${harness.agentB.port}/api/a2a/ping`);
    assert.ok(pingB.pong, 'Agent B should respond to ping');

    await harness.teardown();
  });

  test('TwoServerHarness provides token stores for each agent', async () => {
    const harness = new TwoServerHarness();
    await harness.setup();

    // Create token on Agent A
    const { token } = harness.agentA.tokenStore.create({ name: 'TestToken' });
    assert.match(token, /^fed_/);

    // Token should NOT exist on Agent B
    const validation = harness.agentB.tokenStore.validate(token);
    assert.equal(validation.valid, false);

    await harness.teardown();
  });

  // Helper to make GET request
  function httpGet(url) {
    const http = require('http');
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
};
```

**Step 2: Run test to verify it fails**

Run: `node test/run.js --filter "TwoServerHarness"`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```javascript
// test/e2e/two-server.js
const { createE2EEnv } = require('./env');
const path = require('path');

/**
 * Starts two independent A2A servers on ephemeral ports,
 * each with their own config directory and token store.
 *
 * This simulates two separate agents that can exchange
 * invites and call each other over HTTP.
 */
class TwoServerHarness {
  constructor(options = {}) {
    this.agentA = null;
    this.agentB = null;
    this.handleMessageA = options.handleMessageA || defaultHandler('AgentA');
    this.handleMessageB = options.handleMessageB || defaultHandler('AgentB');
  }

  async setup() {
    this.agentA = await this._startAgent('agent-a', this.handleMessageA);
    this.agentB = await this._startAgent('agent-b', this.handleMessageB);
  }

  async _startAgent(name, handleMessage) {
    const env = createE2EEnv(`e2e-${name}`);
    const port = await env.findAvailablePort();

    // Fresh requires to get isolated instances
    delete require.cache[require.resolve('../../src/lib/tokens')];
    delete require.cache[require.resolve('../../src/routes/a2a')];

    const express = require('express');
    const { TokenStore } = require('../../src/lib/tokens');
    const { createRoutes } = require('../../src/routes/a2a');

    const tokenStore = new TokenStore(env.configDir);
    const app = express();
    app.use(express.json({ limit: '100kb' }));

    app.use('/api/a2a', createRoutes({
      tokenStore,
      handleMessage,
      notifyOwner: () => Promise.resolve()
    }));

    const server = await new Promise((resolve) => {
      const s = app.listen(port, '127.0.0.1', () => resolve(s));
    });

    return {
      name,
      port,
      env,
      tokenStore,
      app,
      server,
      hostname: `127.0.0.1:${port}`,
      inviteBase: `a2a://127.0.0.1:${port}`
    };
  }

  async teardown() {
    if (this.agentA) {
      await closeServer(this.agentA.server);
      this.agentA.env.cleanup();
    }
    if (this.agentB) {
      await closeServer(this.agentB.server);
      this.agentB.env.cleanup();
    }
  }
}

function defaultHandler(name) {
  return async function (message, context) {
    return {
      text: `${name} received: ${message.slice(0, 100)}`,
      canContinue: true
    };
  };
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (server) server.close(resolve);
    else resolve();
  });
}

module.exports = { TwoServerHarness };
```

**Step 4: Run test to verify it passes**

Run: `node test/run.js --filter "TwoServerHarness"`
Expected: PASS (both tests)

**Step 5: Commit**

```bash
git add test/e2e/two-server.js test/e2e/two-server.test.js
git commit -m "feat(e2e): add two-server harness for cross-agent testing"
```

---

### Task 4: Write the full E2E install + onboard + invite test

**Files:**
- Create: `test/e2e/full-flow.test.js`

This is the core test that exercises the complete user journey across two agents.

**Step 1: Write the test**

```javascript
// test/e2e/full-flow.test.js
/**
 * Full E2E Flow Test
 *
 * Simulates the complete A2A user journey between two agents:
 *
 *   1. Both agents start with fresh environments
 *   2. Agent A completes onboarding
 *   3. Agent A creates an invite token
 *   4. Agent B adds Agent A as a contact using the invite URL
 *   5. Agent B calls Agent A via HTTP
 *   6. Agent A responds
 *   7. Multi-turn conversation works
 *   8. Conversation ends cleanly
 */
module.exports = function (test, assert, helpers) {
  const http = require('http');
  const { TwoServerHarness } = require('./two-server');

  let harness = null;

  async function teardown() {
    if (harness) await harness.teardown();
    harness = null;
  }

  // ── Full Flow: Onboard → Create Token → Invite → Call ──

  test('full E2E: Agent B calls Agent A via invite URL', async () => {
    harness = new TwoServerHarness();
    await harness.setup();

    const agentA = harness.agentA;
    const agentB = harness.agentB;

    // Step 1: Agent A creates a token for Agent B
    const { token, record } = agentA.tokenStore.create({
      name: 'AgentB-Access',
      permissions: 'public',
      expires: '1h',
      maxCalls: 10,
      allowedTopics: ['testing', 'automation']
    });

    assert.match(token, /^fed_/, 'Token should start with fed_');
    assert.equal(record.name, 'AgentB-Access');
    assert.equal(record.tier, 'public');

    // Step 2: Construct invite URL
    const inviteUrl = `${agentA.inviteBase}/${token}`;
    assert.match(inviteUrl, /^a2a:\/\//, 'Invite should be a2a:// URL');

    // Step 3: Agent B adds Agent A as a contact
    agentB.tokenStore.addContact(inviteUrl, {
      name: 'AgentA',
      notes: 'E2E test partner'
    });

    const contacts = agentB.tokenStore.listContacts();
    assert.equal(contacts.length, 1);
    assert.equal(contacts[0].name, 'AgentA');

    // Step 4: Agent B retrieves the stored token and calls Agent A
    const contact = agentB.tokenStore.getContact('AgentA');
    assert.equal(contact.host, agentA.hostname);
    assert.equal(contact.token, token);

    // Step 5: Make the actual HTTP call (Agent B → Agent A)
    const callResult = await httpPost(
      `http://${agentA.hostname}/api/a2a/invoke`,
      {
        message: 'Hello Agent A, this is Agent B calling.',
        caller: { name: 'AgentB', owner: 'E2E Test' }
      },
      { Authorization: `Bearer ${token}` }
    );

    assert.equal(callResult.statusCode, 200);
    assert.ok(callResult.body.success);
    assert.match(callResult.body.conversation_id, /^conv_/);
    assert.ok(callResult.body.response.includes('AgentA received'));
    assert.equal(callResult.body.can_continue, true);
    assert.equal(callResult.body.tokens_remaining, 9);

    // Step 6: Multi-turn — send follow-up on same conversation
    const followUp = await httpPost(
      `http://${agentA.hostname}/api/a2a/invoke`,
      {
        message: 'Follow-up question from Agent B.',
        conversation_id: callResult.body.conversation_id,
        caller: { name: 'AgentB', owner: 'E2E Test' }
      },
      { Authorization: `Bearer ${token}` }
    );

    assert.equal(followUp.statusCode, 200);
    assert.ok(followUp.body.success);
    assert.equal(followUp.body.conversation_id, callResult.body.conversation_id);
    assert.equal(followUp.body.tokens_remaining, 8);

    // Step 7: Verify token usage was tracked
    const tokenRecord = agentA.tokenStore.findById(record.id);
    assert.equal(tokenRecord.calls_made, 2);

    await teardown();
  });

  test('full E2E: bidirectional — both agents exchange invites', async () => {
    harness = new TwoServerHarness();
    await harness.setup();

    const agentA = harness.agentA;
    const agentB = harness.agentB;

    // Agent A creates token for B
    const tokenAtoB = agentA.tokenStore.create({
      name: 'ForAgentB', permissions: 'friends', maxCalls: 5
    });

    // Agent B creates token for A
    const tokenBtoA = agentB.tokenStore.create({
      name: 'ForAgentA', permissions: 'public', maxCalls: 5
    });

    // Exchange invites
    const inviteA = `${agentA.inviteBase}/${tokenAtoB.token}`;
    const inviteB = `${agentB.inviteBase}/${tokenBtoA.token}`;

    agentB.tokenStore.addContact(inviteA, { name: 'AgentA' });
    agentA.tokenStore.addContact(inviteB, { name: 'AgentB' });

    // B calls A
    const resBA = await httpPost(
      `http://${agentA.hostname}/api/a2a/invoke`,
      { message: 'B calling A', caller: { name: 'AgentB' } },
      { Authorization: `Bearer ${tokenAtoB.token}` }
    );
    assert.equal(resBA.statusCode, 200);
    assert.ok(resBA.body.success);

    // A calls B
    const resAB = await httpPost(
      `http://${agentB.hostname}/api/a2a/invoke`,
      { message: 'A calling B', caller: { name: 'AgentA' } },
      { Authorization: `Bearer ${tokenBtoA.token}` }
    );
    assert.equal(resAB.statusCode, 200);
    assert.ok(resAB.body.success);

    await teardown();
  });

  test('full E2E: revoked token rejected mid-conversation', async () => {
    harness = new TwoServerHarness();
    await harness.setup();

    const { token, record } = harness.agentA.tokenStore.create({
      name: 'Revocable', maxCalls: 10
    });

    // First call succeeds
    const res1 = await httpPost(
      `http://${harness.agentA.hostname}/api/a2a/invoke`,
      { message: 'First call', caller: { name: 'Tester' } },
      { Authorization: `Bearer ${token}` }
    );
    assert.equal(res1.statusCode, 200);

    // Revoke the token
    harness.agentA.tokenStore.revoke(record.id);

    // Second call rejected
    const res2 = await httpPost(
      `http://${harness.agentA.hostname}/api/a2a/invoke`,
      { message: 'After revoke', caller: { name: 'Tester' } },
      { Authorization: `Bearer ${token}` }
    );
    assert.equal(res2.statusCode, 401);
    assert.equal(res2.body.error, 'unauthorized');

    await teardown();
  });

  test('full E2E: expired token rejected', async () => {
    harness = new TwoServerHarness();
    await harness.setup();

    // Create token that expires immediately (1ms)
    const { token } = harness.agentA.tokenStore.create({
      name: 'ShortLived', expires: '1ms'
    });

    // Wait for expiry
    await new Promise(r => setTimeout(r, 50));

    const res = await httpPost(
      `http://${harness.agentA.hostname}/api/a2a/invoke`,
      { message: 'Too late', caller: { name: 'Tester' } },
      { Authorization: `Bearer ${token}` }
    );
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.error, 'unauthorized');

    await teardown();
  });

  test('full E2E: max calls enforcement across multi-turn', async () => {
    harness = new TwoServerHarness();
    await harness.setup();

    const { token } = harness.agentA.tokenStore.create({
      name: 'LimitedCalls', maxCalls: 2
    });

    // Call 1 OK
    const r1 = await httpPost(
      `http://${harness.agentA.hostname}/api/a2a/invoke`,
      { message: 'Call 1', caller: { name: 'Tester' } },
      { Authorization: `Bearer ${token}` }
    );
    assert.equal(r1.statusCode, 200);

    // Call 2 OK
    const r2 = await httpPost(
      `http://${harness.agentA.hostname}/api/a2a/invoke`,
      { message: 'Call 2', caller: { name: 'Tester' } },
      { Authorization: `Bearer ${token}` }
    );
    assert.equal(r2.statusCode, 200);

    // Call 3 rejected
    const r3 = await httpPost(
      `http://${harness.agentA.hostname}/api/a2a/invoke`,
      { message: 'Call 3', caller: { name: 'Tester' } },
      { Authorization: `Bearer ${token}` }
    );
    assert.equal(r3.statusCode, 401);

    await teardown();
  });

  // ── HTTP helper ──
  function httpPost(url, body, headers = {}) {
    const urlObj = new URL(url);
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = http.request({
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          ...headers
        }
      }, (res) => {
        let responseData = '';
        res.on('data', chunk => responseData += chunk);
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(responseData); } catch { parsed = responseData; }
          resolve({ statusCode: res.statusCode, headers: res.headers, body: parsed });
        });
      });
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }
};
```

**Step 2: Run test to verify it passes**

Run: `node test/run.js --filter "full E2E"`
Expected: PASS (all 5 tests)

**Step 3: Commit**

```bash
git add test/e2e/full-flow.test.js
git commit -m "feat(e2e): add full flow tests — onboard, invite, cross-agent call"
```

---

## Phase 3: Agent Prompt Sequence & Report

### Task 5: Create the E2E test agent prompt sequence

**Files:**
- Create: `docs/prompts/e2e-test-agent.md`

This is the prompt document that an AI orchestrator gives to a subagent. The subagent follows these steps to test the A2A system.

**Step 1: Write the prompt document**

```markdown
# A2A E2E Test Agent — Prompt Sequence

You are an E2E test agent for the `a2acalling` npm package. Your job is to verify
that a fresh install, onboarding, and invite flow all work correctly.

## Your Environment

You have been given a clean working directory. You will:
1. Install `a2acalling` from npm (or use a local tarball if provided)
2. Run through the full onboarding flow
3. Create tokens and test the invite flow
4. Verify the server responds correctly
5. Report all findings

## Pre-Flight

Before starting, verify:
- [ ] Node.js >= 18 is available (`node --version`)
- [ ] npm is available (`npm --version`)
- [ ] Working directory is clean and writable
- [ ] No existing A2A config (`ls ~/.config/openclaw/` should not exist or be empty)

If any pre-flight check fails, report the failure and stop.

## Step 1: Install a2acalling

```bash
npm install -g a2acalling
```

**Expected:**
- Exit code 0
- `a2a` command is now available
- `a2a --version` prints a version number

**Report if:** Install fails, postinstall errors, command not found after install.

## Step 2: Run Quickstart (Onboarding)

```bash
a2a quickstart
```

**Expected:**
- Step 1: Port detection — finds an available port (3001-3020)
- Step 2: Server starts on the detected port
- Step 3: Disclosure prompt appears — asking for topics, objectives, personality
- The agent should be in `awaiting_disclosure` state

**Then submit disclosure:**

```bash
a2a quickstart --submit '{
  "tiers": {
    "public": {
      "topics": [{"topic": "Testing", "description": "Automated system testing"}],
      "objectives": [{"objective": "Verify install", "description": "Confirm the package works"}],
      "do_not_discuss": []
    },
    "friends": {"topics": [], "objectives": [], "do_not_discuss": []},
    "family": {"topics": [], "objectives": [], "do_not_discuss": []}
  },
  "never_disclose": ["Test secrets"],
  "personality_notes": "Direct and methodical test agent"
}'
```

**Expected:**
- "Disclosure manifest saved"
- "Onboarding complete"
- Step numbers are sequential (no duplicates)
- Config file exists at `~/.config/openclaw/a2a-config.json` with `onboarding.step === 'complete'`
- First invite URL is generated (`a2a://hostname/fed_...`)

**Report if:** Onboarding hangs, step numbers are wrong, manifest not saved, invite not generated.

## Step 3: Verify Server Health

```bash
a2a ping a2a://localhost:<port>/test
```

Or directly:

```bash
curl http://localhost:<port>/api/a2a/ping
```

**Expected:** `{"pong": true, "timestamp": "..."}`

```bash
curl http://localhost:<port>/api/a2a/status
```

**Expected:** `{"a2a": true, "version": "...", "capabilities": ["invoke", "multi-turn", ...]}`

**Report if:** Server not running, ping fails, status missing expected fields.

## Step 4: Create Invite Token

```bash
a2a create --name "E2E-Tester" --tier public --expires 1h --max-calls 20
```

**Expected:**
- Token created successfully
- Invite URL printed: `a2a://hostname/fed_...`
- Token appears in `a2a list`

**Report if:** Token creation fails, URL format wrong, not in list.

## Step 5: Test Inbound Call

Using the invite URL from Step 4, make a direct HTTP call:

```bash
TOKEN="<token from step 4>"
PORT="<port from step 2>"
curl -X POST http://localhost:$PORT/api/a2a/invoke \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"message": "Hello from E2E test agent", "caller": {"name": "E2E-Tester", "owner": "Automated Test"}}'
```

**Expected Response:**
```json
{
  "success": true,
  "conversation_id": "conv_...",
  "response": "...",
  "can_continue": true,
  "tokens_remaining": 19
}
```

**Report if:** 401 unauthorized, 500 error, missing conversation_id, unexpected response shape.

## Step 6: Test Multi-Turn Conversation

Using the `conversation_id` from Step 5:

```bash
curl -X POST http://localhost:$PORT/api/a2a/invoke \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"message": "Follow-up message", "conversation_id": "<conv_id>", "caller": {"name": "E2E-Tester"}}'
```

**Expected:**
- Same `conversation_id` returned
- `tokens_remaining` decremented by 1
- `can_continue` is true

**Report if:** Conversation ID changes, token count wrong, can_continue unexpected.

## Step 7: Test Error Cases

### 7a. No Authorization
```bash
curl -X POST http://localhost:$PORT/api/a2a/invoke \
  -H "Content-Type: application/json" \
  -d '{"message": "No auth"}'
```
**Expected:** 401, `{"error": "missing_token"}`

### 7b. Invalid Token
```bash
curl -X POST http://localhost:$PORT/api/a2a/invoke \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer fed_invalid_garbage" \
  -d '{"message": "Bad token"}'
```
**Expected:** 401, `{"error": "unauthorized"}`

### 7c. Missing Message
```bash
curl -X POST http://localhost:$PORT/api/a2a/invoke \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{}'
```
**Expected:** 400, `{"error": "missing_message"}`

**Report if:** Any error case returns unexpected status code or error format.

## Step 8: Token Revocation

```bash
# Get token ID from list
a2a list

# Revoke it
a2a revoke <token_id>

# Verify call fails
curl -X POST http://localhost:$PORT/api/a2a/invoke \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"message": "Should fail"}'
```

**Expected:** 401 after revocation.

**Report if:** Revoked token still works.

## Step 9: Cleanup

```bash
a2a uninstall
```

**Expected:** Server stopped, config files removed.

## Reporting Format

After completing all steps, produce a report in this format:

```markdown
# A2A E2E Test Report

**Date:** YYYY-MM-DD HH:MM:SS
**Package Version:** x.y.z
**Node Version:** vXX.X.X
**Platform:** linux/darwin/win32

## Results

| Step | Name | Status | Notes |
|------|------|--------|-------|
| 1 | Install | PASS/FAIL | ... |
| 2 | Onboarding | PASS/FAIL | ... |
| 3 | Server Health | PASS/FAIL | ... |
| 4 | Create Token | PASS/FAIL | ... |
| 5 | Inbound Call | PASS/FAIL | ... |
| 6 | Multi-Turn | PASS/FAIL | ... |
| 7 | Error Cases | PASS/FAIL | ... |
| 8 | Revocation | PASS/FAIL | ... |
| 9 | Cleanup | PASS/FAIL | ... |

## Issues Found

### Issue 1: [Title]
**Step:** N
**Severity:** critical/high/medium/low
**Description:** What happened
**Expected:** What should have happened
**Actual:** What actually happened
**Reproduction:** Exact commands to reproduce
```

For each issue found, the orchestrator should create a Linear ticket
with the "Todo" status on the "a2a calling" team, labeled "Bug" and "E2E".
```

**Step 2: Commit**

```bash
git add docs/prompts/e2e-test-agent.md
git commit -m "docs: add E2E test agent prompt sequence"
```

---

### Task 6: Create report generator with Linear integration

**Files:**
- Create: `test/e2e/report.js`
- Test: `test/e2e/report.test.js`

**Step 1: Write the failing test**

```javascript
// test/e2e/report.test.js
module.exports = function (test, assert, helpers) {
  const { E2EReport } = require('./report');

  test('E2EReport tracks step results', () => {
    const report = new E2EReport({ version: '0.6.44', nodeVersion: 'v20.0.0' });

    report.pass(1, 'Install', 'Installed successfully');
    report.pass(2, 'Onboarding', 'Completed in 3s');
    report.fail(3, 'Server Health', 'Ping returned 500', {
      expected: '200 with pong',
      actual: '500 internal error',
      severity: 'critical'
    });

    assert.equal(report.results.length, 3);
    assert.equal(report.passed, 2);
    assert.equal(report.failed, 1);
    assert.equal(report.issues.length, 1);
    assert.equal(report.issues[0].step, 3);
    assert.equal(report.issues[0].severity, 'critical');
  });

  test('E2EReport generates markdown', () => {
    const report = new E2EReport({ version: '0.6.44', nodeVersion: 'v20.0.0' });

    report.pass(1, 'Install', 'OK');
    report.fail(2, 'Onboarding', 'Manifest not saved', {
      expected: 'Manifest file created',
      actual: 'File missing',
      severity: 'high'
    });

    const md = report.toMarkdown();
    assert.includes(md, '# A2A E2E Test Report');
    assert.includes(md, '0.6.44');
    assert.includes(md, 'PASS');
    assert.includes(md, 'FAIL');
    assert.includes(md, 'Manifest not saved');
    assert.includes(md, 'high');
  });

  test('E2EReport generates Linear issue descriptions', () => {
    const report = new E2EReport({ version: '0.6.44', nodeVersion: 'v20.0.0' });

    report.fail(5, 'Inbound Call', 'Got 500 instead of 200', {
      expected: '200 success',
      actual: '500 internal_error',
      severity: 'critical',
      reproduction: 'curl -X POST http://localhost:3001/api/a2a/invoke ...'
    });

    const issues = report.toLinearIssues();
    assert.equal(issues.length, 1);
    assert.includes(issues[0].title, 'Inbound Call');
    assert.includes(issues[0].description, '500');
    assert.includes(issues[0].description, 'Reproduction');
    assert.equal(issues[0].priority, 1); // critical = urgent
  });
};
```

**Step 2: Run test to verify it fails**

Run: `node test/run.js --filter "E2EReport"`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```javascript
// test/e2e/report.js
/**
 * E2E Test Report Generator
 *
 * Tracks pass/fail results for each step and can output:
 * - Markdown summary for human review
 * - Linear issue descriptions for automated bug filing
 */
class E2EReport {
  constructor(meta = {}) {
    this.meta = {
      version: meta.version || 'unknown',
      nodeVersion: meta.nodeVersion || process.version,
      platform: meta.platform || process.platform,
      date: new Date().toISOString()
    };
    this.results = [];
    this.issues = [];
    this.passed = 0;
    this.failed = 0;
  }

  pass(step, name, notes = '') {
    this.results.push({ step, name, status: 'PASS', notes });
    this.passed++;
  }

  fail(step, name, notes, details = {}) {
    this.results.push({ step, name, status: 'FAIL', notes });
    this.failed++;
    this.issues.push({
      step,
      name,
      notes,
      expected: details.expected || '',
      actual: details.actual || '',
      severity: details.severity || 'medium',
      reproduction: details.reproduction || ''
    });
  }

  toMarkdown() {
    const lines = [
      '# A2A E2E Test Report',
      '',
      `**Date:** ${this.meta.date}`,
      `**Package Version:** ${this.meta.version}`,
      `**Node Version:** ${this.meta.nodeVersion}`,
      `**Platform:** ${this.meta.platform}`,
      '',
      `## Summary: ${this.passed} passed, ${this.failed} failed`,
      '',
      '## Results',
      '',
      '| Step | Name | Status | Notes |',
      '|------|------|--------|-------|'
    ];

    for (const r of this.results) {
      lines.push(`| ${r.step} | ${r.name} | ${r.status} | ${r.notes} |`);
    }

    if (this.issues.length > 0) {
      lines.push('', '## Issues Found', '');
      for (let i = 0; i < this.issues.length; i++) {
        const issue = this.issues[i];
        lines.push(
          `### Issue ${i + 1}: ${issue.name}`,
          `**Step:** ${issue.step}`,
          `**Severity:** ${issue.severity}`,
          `**Description:** ${issue.notes}`,
          `**Expected:** ${issue.expected}`,
          `**Actual:** ${issue.actual}`,
          ''
        );
        if (issue.reproduction) {
          lines.push(`**Reproduction:**`, '```', issue.reproduction, '```', '');
        }
      }
    }

    return lines.join('\n');
  }

  /**
   * Convert issues to Linear issue format.
   * @returns {Array<{title, description, priority, labels}>}
   */
  toLinearIssues() {
    const severityToPriority = {
      critical: 1,  // Urgent
      high: 2,      // High
      medium: 3,    // Normal
      low: 4        // Low
    };

    return this.issues.map(issue => ({
      title: `[E2E] Step ${issue.step}: ${issue.name} — ${issue.notes.slice(0, 60)}`,
      description: [
        `## E2E Test Failure`,
        '',
        `**Step:** ${issue.step} — ${issue.name}`,
        `**Severity:** ${issue.severity}`,
        `**Package Version:** ${this.meta.version}`,
        `**Node:** ${this.meta.nodeVersion}`,
        `**Platform:** ${this.meta.platform}`,
        '',
        `### Expected`,
        issue.expected,
        '',
        `### Actual`,
        issue.actual,
        '',
        issue.reproduction ? `### Reproduction\n\`\`\`\n${issue.reproduction}\n\`\`\`` : ''
      ].join('\n'),
      priority: severityToPriority[issue.severity] || 3,
      labels: ['Bug', 'E2E']
    }));
  }
}

module.exports = { E2EReport };
```

**Step 4: Run test to verify it passes**

Run: `node test/run.js --filter "E2EReport"`
Expected: PASS (all 3 tests)

**Step 5: Commit**

```bash
git add test/e2e/report.js test/e2e/report.test.js
git commit -m "feat(e2e): add report generator with Linear issue formatting"
```

---

### Task 7: Create orchestrator entry point

**Files:**
- Create: `test/e2e/orchestrate.js`

This is the script that ties everything together. It can be run standalone (`node test/e2e/orchestrate.js`) or invoked by a Claude agent.

**Step 1: Write the orchestrator**

```javascript
#!/usr/bin/env node
/**
 * E2E Test Orchestrator
 *
 * Runs the full A2A E2E test suite:
 *   1. Sets up two isolated agent environments
 *   2. Runs onboarding on both
 *   3. Exchanges invites
 *   4. Tests cross-agent calls
 *   5. Tests error cases
 *   6. Generates report
 *
 * Usage:
 *   node test/e2e/orchestrate.js [--json] [--verbose]
 *
 * Exit codes:
 *   0 = all tests passed
 *   1 = one or more failures
 */

const { TwoServerHarness } = require('./two-server');
const { E2EReport } = require('./report');
const http = require('http');

const verbose = process.argv.includes('--verbose');
const jsonOutput = process.argv.includes('--json');

function log(msg) {
  if (verbose) console.log(`  ${msg}`);
}

function httpPost(url, body, headers = {}) {
  const urlObj = new URL(url);
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...headers
      }
    }, (res) => {
      let responseData = '';
      res.on('data', chunk => responseData += chunk);
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(responseData); } catch { parsed = responseData; }
        resolve({ statusCode: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ statusCode: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ statusCode: res.statusCode, body: data }); }
      });
    }).on('error', reject);
  });
}

async function main() {
  let version;
  try { version = require('../../package.json').version; } catch { version = 'unknown'; }

  const report = new E2EReport({ version });
  let harness = null;

  try {
    // ── Step 1: Environment Setup ──
    console.log('Step 1: Setting up two isolated agents...');
    harness = new TwoServerHarness();
    await harness.setup();
    log(`Agent A on port ${harness.agentA.port}`);
    log(`Agent B on port ${harness.agentB.port}`);
    report.pass(1, 'Environment Setup', `Ports: ${harness.agentA.port}, ${harness.agentB.port}`);

    // ── Step 2: Server Health ──
    console.log('Step 2: Checking server health...');
    const pingA = await httpGet(`http://127.0.0.1:${harness.agentA.port}/api/a2a/ping`);
    const pingB = await httpGet(`http://127.0.0.1:${harness.agentB.port}/api/a2a/ping`);

    if (pingA.body.pong && pingB.body.pong) {
      report.pass(2, 'Server Health', 'Both agents respond to ping');
    } else {
      report.fail(2, 'Server Health', 'Ping failed', {
        expected: 'pong: true from both agents',
        actual: `A: ${JSON.stringify(pingA.body)}, B: ${JSON.stringify(pingB.body)}`,
        severity: 'critical'
      });
    }

    // ── Step 3: Token Creation ──
    console.log('Step 3: Creating tokens...');
    const tokenA = harness.agentA.tokenStore.create({
      name: 'E2E-ForAgentB',
      permissions: 'public',
      expires: '1h',
      maxCalls: 10,
      allowedTopics: ['testing']
    });

    if (tokenA.token && tokenA.token.startsWith('fed_')) {
      report.pass(3, 'Token Creation', `Token: ${tokenA.token.slice(0, 12)}...`);
    } else {
      report.fail(3, 'Token Creation', 'Token format invalid', {
        expected: 'fed_... format',
        actual: String(tokenA.token),
        severity: 'critical'
      });
    }

    // ── Step 4: Contact Exchange ──
    console.log('Step 4: Exchanging invites...');
    const inviteUrl = `${harness.agentA.inviteBase}/${tokenA.token}`;
    const addResult = harness.agentB.tokenStore.addContact(inviteUrl, { name: 'AgentA' });
    const contacts = harness.agentB.tokenStore.listContacts();

    if (addResult.success && contacts.length === 1) {
      report.pass(4, 'Contact Exchange', `Agent B added Agent A as contact`);
    } else {
      report.fail(4, 'Contact Exchange', 'Failed to add contact', {
        expected: 'Contact added successfully',
        actual: `success: ${addResult.success}, contacts: ${contacts.length}`,
        severity: 'high'
      });
    }

    // ── Step 5: Inbound Call ──
    console.log('Step 5: Testing inbound call (B → A)...');
    const callRes = await httpPost(
      `http://${harness.agentA.hostname}/api/a2a/invoke`,
      {
        message: 'Hello from E2E Agent B',
        caller: { name: 'AgentB', owner: 'E2E Orchestrator' }
      },
      { Authorization: `Bearer ${tokenA.token}` }
    );

    if (callRes.statusCode === 200 && callRes.body.success && callRes.body.conversation_id) {
      report.pass(5, 'Inbound Call', `Conv: ${callRes.body.conversation_id}`);
    } else {
      report.fail(5, 'Inbound Call', `Status ${callRes.statusCode}`, {
        expected: '200 with success: true and conversation_id',
        actual: JSON.stringify(callRes.body).slice(0, 200),
        severity: 'critical'
      });
    }

    // ── Step 6: Multi-Turn ──
    console.log('Step 6: Testing multi-turn conversation...');
    if (callRes.body.conversation_id) {
      const followUp = await httpPost(
        `http://${harness.agentA.hostname}/api/a2a/invoke`,
        {
          message: 'Follow-up from Agent B',
          conversation_id: callRes.body.conversation_id,
          caller: { name: 'AgentB' }
        },
        { Authorization: `Bearer ${tokenA.token}` }
      );

      if (followUp.statusCode === 200 && followUp.body.conversation_id === callRes.body.conversation_id) {
        report.pass(6, 'Multi-Turn', `Same conv ID, tokens remaining: ${followUp.body.tokens_remaining}`);
      } else {
        report.fail(6, 'Multi-Turn', 'Conversation ID mismatch or failure', {
          expected: `conv_id: ${callRes.body.conversation_id}`,
          actual: `conv_id: ${followUp.body.conversation_id}, status: ${followUp.statusCode}`,
          severity: 'high'
        });
      }
    } else {
      report.fail(6, 'Multi-Turn', 'Skipped — no conversation_id from step 5', { severity: 'high' });
    }

    // ── Step 7: Error Cases ──
    console.log('Step 7: Testing error cases...');
    let errorsPassed = 0;
    const errorTotal = 3;

    // 7a: No auth
    const noAuth = await httpPost(
      `http://${harness.agentA.hostname}/api/a2a/invoke`,
      { message: 'No auth' }
    );
    if (noAuth.statusCode === 401 && noAuth.body.error === 'missing_token') errorsPassed++;

    // 7b: Bad token
    const badToken = await httpPost(
      `http://${harness.agentA.hostname}/api/a2a/invoke`,
      { message: 'Bad token' },
      { Authorization: 'Bearer fed_totally_invalid' }
    );
    if (badToken.statusCode === 401 && badToken.body.error === 'unauthorized') errorsPassed++;

    // 7c: Missing message
    const noMsg = await httpPost(
      `http://${harness.agentA.hostname}/api/a2a/invoke`,
      {},
      { Authorization: `Bearer ${tokenA.token}` }
    );
    if (noMsg.statusCode === 400 && noMsg.body.error === 'missing_message') errorsPassed++;

    if (errorsPassed === errorTotal) {
      report.pass(7, 'Error Cases', `All ${errorTotal} error cases correct`);
    } else {
      report.fail(7, 'Error Cases', `${errorsPassed}/${errorTotal} passed`, {
        expected: `All ${errorTotal} error cases return correct status/error`,
        actual: `noAuth: ${noAuth.statusCode}/${noAuth.body.error}, badToken: ${badToken.statusCode}/${badToken.body.error}, noMsg: ${noMsg.statusCode}/${noMsg.body.error}`,
        severity: 'high'
      });
    }

    // ── Step 8: Token Revocation ──
    console.log('Step 8: Testing token revocation...');
    harness.agentA.tokenStore.revoke(tokenA.record.id);
    const revokedCall = await httpPost(
      `http://${harness.agentA.hostname}/api/a2a/invoke`,
      { message: 'After revoke', caller: { name: 'AgentB' } },
      { Authorization: `Bearer ${tokenA.token}` }
    );

    if (revokedCall.statusCode === 401) {
      report.pass(8, 'Token Revocation', 'Revoked token correctly rejected');
    } else {
      report.fail(8, 'Token Revocation', `Got ${revokedCall.statusCode} instead of 401`, {
        expected: '401 unauthorized',
        actual: `${revokedCall.statusCode}: ${JSON.stringify(revokedCall.body)}`,
        severity: 'critical',
        reproduction: `Revoke token then POST /invoke with same token`
      });
    }

  } catch (err) {
    report.fail(0, 'Orchestrator Error', err.message, {
      expected: 'No uncaught errors',
      actual: err.stack,
      severity: 'critical'
    });
  } finally {
    if (harness) await harness.teardown();
  }

  // ── Output ──
  if (jsonOutput) {
    console.log(JSON.stringify({
      meta: report.meta,
      passed: report.passed,
      failed: report.failed,
      results: report.results,
      issues: report.issues,
      linearIssues: report.toLinearIssues()
    }, null, 2));
  } else {
    console.log('');
    console.log(report.toMarkdown());
  }

  process.exit(report.failed > 0 ? 1 : 0);
}

main();
```

**Step 2: Run the orchestrator**

Run: `node test/e2e/orchestrate.js --verbose`
Expected: All 8 steps PASS, exit code 0

**Step 3: Commit**

```bash
git add test/e2e/orchestrate.js
git commit -m "feat(e2e): add orchestrator — runs full E2E suite and generates report"
```

---

## Phase 4: Integration with Test Runner

### Task 8: Register E2E tests with the existing test runner

**Files:**
- Modify: `test/run.js` — add `--e2e` flag support
- Create: `test/e2e/index.test.js` — wrapper that runs E2E tests via the standard runner

The existing test runner at `test/run.js` supports `--unit` and `--integration` flags. We add `--e2e` for the new tests.

**Step 1: Check current test runner structure**

Read `test/run.js` to understand how it discovers and runs test files. The runner globs `test/unit/*.test.js` and `test/integration/*.test.js`. We need it to also glob `test/e2e/*.test.js` when `--e2e` is passed (or when no filter is specified and `--all` is used).

**Step 2: Create E2E index wrapper**

```javascript
// test/e2e/index.test.js
/**
 * E2E Test Suite
 *
 * These tests require ephemeral ports and take longer than unit/integration tests.
 * Run with: node test/run.js --e2e
 * Or:       node test/run.js --filter "E2E"
 */
module.exports = function (test, assert, helpers) {
  // Re-export individual E2E test files
  require('./env.test.js')(test, assert, helpers);
  require('./cli-runner.test.js')(test, assert, helpers);
  require('./two-server.test.js')(test, assert, helpers);
  require('./full-flow.test.js')(test, assert, helpers);
  require('./report.test.js')(test, assert, helpers);
};
```

**Step 3: Modify test runner to support `--e2e` flag**

In `test/run.js`, locate where test files are discovered and add:
- When `--e2e` is passed: only run `test/e2e/*.test.js`
- When `--all` or no category flag: include E2E tests
- Default behavior (no flags): run unit + integration (NOT e2e, since they're slower)

**Step 4: Run all E2E tests**

Run: `node test/run.js --e2e --verbose`
Expected: All E2E tests pass

**Step 5: Run full suite to verify no regressions**

Run: `npm test`
Expected: All unit + integration tests still pass (E2E excluded by default)

**Step 6: Commit**

```bash
git add test/e2e/index.test.js test/run.js
git commit -m "feat(e2e): register E2E tests with test runner under --e2e flag"
```

---

## Phase 5: Documentation

### Task 9: Add E2E section to protocol docs

**Files:**
- Modify: `docs/protocol.md` — add "E2E Testing" section

**Step 1: Add E2E testing documentation section**

At the end of `docs/protocol.md`, add:

```markdown
## E2E Testing

### Running the E2E Suite

```bash
# Run E2E tests via test runner
node test/run.js --e2e

# Run the orchestrator directly (verbose output)
node test/e2e/orchestrate.js --verbose

# Get JSON report (for automated processing)
node test/e2e/orchestrate.js --json
```

### AI Agent Testing

The E2E prompt sequence at `docs/prompts/e2e-test-agent.md` provides step-by-step
instructions for a Claude subagent to test a fresh a2acalling installation.

**Orchestrator workflow:**
1. Spawn subagent with the prompt from `docs/prompts/e2e-test-agent.md`
2. Subagent follows the 9-step sequence
3. Subagent produces a markdown report
4. Orchestrator reviews failures and creates Linear issues

### Architecture

The E2E system uses:
- `test/e2e/env.js` — Isolated temp directories and port allocation
- `test/e2e/cli-runner.js` — Structured CLI command execution
- `test/e2e/two-server.js` — Two independent Express servers on ephemeral ports
- `test/e2e/full-flow.test.js` — Cross-agent call tests
- `test/e2e/report.js` — Markdown and Linear issue generation
- `test/e2e/orchestrate.js` — Standalone orchestrator script
```

**Step 2: Commit**

```bash
git add docs/protocol.md docs/prompts/e2e-test-agent.md
git commit -m "docs: add E2E testing section and agent prompt sequence"
```

---

## Phase 6: Unified Summary Prompt & Output Template

### Context: Why This Matters

Today there are 3 separate summary prompts across the codebase:

1. **`server.js:generateSummary`** — Simple markdown template. No disclosure manifest, no goals, no collaboration context.
2. **`openclaw-integration.js:buildSummaryPrompt`** — Strategic JSON. Has owner context from USER.md but no disclosure manifest, no collaboration score explanation, no conversation objective.
3. **`claude-subagent.js:runClaudeSummary`** — Resumes Claude session. Relies entirely on implicit session memory — no explicit context at all.

**None of them include the disclosure manifest, collaboration score context, or conversation objective.** Without that, the summarizer can't assess whether the agent stayed within disclosure boundaries, whether objectives were met, or whether the collaboration score is justified.

### Design: Unified Summary Prompt

Both paths (OpenClaw orchestrator reading the transcript, or spawned subagent) use the same prompt and context. The prompt always includes:

1. **Conversation objective** — why this call was made
2. **Full disclosure manifest for this tier** — topics, objectives, do_not_discuss, never_disclose
3. **Collaboration state** — phase progression, overlap score, active threads, candidate collaborations
4. **What overlap score means** — so the summarizer can validate it
5. **Full transcript**

### Task 10: Create unified summary prompt builder

**Files:**
- Create: `src/lib/summary-prompt.js`
- Test: `test/unit/summary-prompt.test.js`

**Step 1: Write the failing test**

```javascript
// test/unit/summary-prompt.test.js
module.exports = function (test, assert, helpers) {

  test('buildUnifiedSummaryPrompt includes all required sections', () => {
    delete require.cache[require.resolve('../../src/lib/summary-prompt')];
    const { buildUnifiedSummaryPrompt } = require('../../src/lib/summary-prompt');

    const prompt = buildUnifiedSummaryPrompt({
      transcript: [
        { direction: 'inbound', content: 'Hello from Golda' },
        { direction: 'outbound', content: 'Welcome Golda!' }
      ],
      callerInfo: { name: 'Golda Deluxe', owner: null, context: 'Authentication research' },
      conversationObjective: 'Explore AI authentication partnerships',
      disclosure: {
        topics: [
          { topic: 'Market analysis', description: 'Tracking luxury goods indices' }
        ],
        objectives: [
          { objective: 'Find partners', description: 'Authentication network' }
        ],
        doNotDiscuss: [
          { topic: 'Portfolio valuations', reason: 'Share strategy not numbers' }
        ],
        neverDisclose: ['Bank account numbers', 'Vault locations']
      },
      collaborationState: {
        phase: 'exploring',
        overlapScore: 0.45,
        activeThreads: ['authentication', 'ML models'],
        candidateCollaborations: ['joint pilot'],
        turnCount: 4,
        closeSignal: false
      },
      ownerContext: {
        agentName: 'claudebot',
        ownerName: 'Ben',
        goals: ['Build authentication network']
      }
    });

    // Must include all context sections
    assert.includes(prompt, 'Explore AI authentication partnerships');
    assert.includes(prompt, 'Market analysis');
    assert.includes(prompt, 'Find partners');
    assert.includes(prompt, 'Portfolio valuations');
    assert.includes(prompt, 'Bank account numbers');
    assert.includes(prompt, 'exploring');
    assert.includes(prompt, '0.45');
    assert.includes(prompt, 'authentication');
    assert.includes(prompt, 'Hello from Golda');

    // Must include the output schema
    assert.includes(prompt, 'headline');
    assert.includes(prompt, 'quickTake');
    assert.includes(prompt, 'disclosure');
    assert.includes(prompt, 'compliance');
    assert.includes(prompt, 'objectives');
  });

  test('buildUnifiedSummaryPrompt handles minimal input gracefully', () => {
    delete require.cache[require.resolve('../../src/lib/summary-prompt')];
    const { buildUnifiedSummaryPrompt } = require('../../src/lib/summary-prompt');

    const prompt = buildUnifiedSummaryPrompt({
      transcript: [
        { direction: 'inbound', content: 'Hi' },
        { direction: 'outbound', content: 'Hello' }
      ],
      callerInfo: { name: 'Unknown' }
    });

    assert.includes(prompt, 'Hi');
    assert.includes(prompt, 'Unknown');
    // Should still have the output schema even without optional sections
    assert.includes(prompt, 'headline');
  });
};
```

**Step 2: Run test to verify it fails**

Run: `node test/run.js --filter "buildUnifiedSummaryPrompt"`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```javascript
// src/lib/summary-prompt.js
/**
 * Unified Summary Prompt Builder
 *
 * Builds a comprehensive summary prompt that includes all context
 * needed for accurate, auditable conversation summaries:
 *
 *   - Conversation objective (why the call happened)
 *   - Disclosure manifest (what's in scope for this tier)
 *   - Collaboration state (phase, overlap score, threads)
 *   - Full transcript
 *   - Owner context
 *
 * Used by both OpenClaw and spawned-agent summary paths.
 */

/**
 * Build a unified summary prompt with full context.
 *
 * @param {object} options
 * @param {Array} options.transcript - [{direction, content}]
 * @param {object} options.callerInfo - {name, owner, context}
 * @param {string} [options.conversationObjective] - Why this call was made
 * @param {object} [options.disclosure] - {topics, objectives, doNotDiscuss, neverDisclose}
 * @param {object} [options.collaborationState] - {phase, overlapScore, activeThreads, ...}
 * @param {object} [options.ownerContext] - {agentName, ownerName, goals}
 * @returns {string} The complete prompt
 */
function buildUnifiedSummaryPrompt(options = {}) {
  const {
    transcript = [],
    callerInfo = {},
    conversationObjective,
    disclosure,
    collaborationState,
    ownerContext = {}
  } = options;

  const sections = [];

  // ── Header ──
  sections.push(`You just finished an A2A agent-to-agent call. Summarize it for your owner.

Your tone: friendly, clear, and genuinely helpful. Lead with what matters most.
Write like you're briefing a smart friend — not filing a report.`);

  // ── Conversation Objective ──
  if (conversationObjective) {
    sections.push(`## Why This Call Happened
${conversationObjective}`);
  }

  // ── Owner Context ──
  if (ownerContext.agentName || ownerContext.ownerName || ownerContext.goals) {
    const parts = [];
    if (ownerContext.agentName) parts.push(`You are: ${ownerContext.agentName}`);
    if (ownerContext.ownerName) parts.push(`Your owner: ${ownerContext.ownerName}`);
    if (ownerContext.goals?.length) {
      parts.push(`Owner's current goals:\n${ownerContext.goals.map(g => `- ${g}`).join('\n')}`);
    }
    sections.push(`## Your Owner\n${parts.join('\n')}`);
  }

  // ── Disclosure Manifest ──
  if (disclosure) {
    const discParts = [];

    if (disclosure.topics?.length) {
      discParts.push('### Topics In Scope');
      for (const t of disclosure.topics) {
        discParts.push(`- **${t.topic}**: ${t.description}`);
      }
    }

    if (disclosure.objectives?.length) {
      discParts.push('\n### Conversation Objectives');
      for (const o of disclosure.objectives) {
        const label = o.objective || o.topic;
        discParts.push(`- **${label}**: ${o.description}`);
      }
    }

    if (disclosure.doNotDiscuss?.length) {
      discParts.push('\n### Do Not Discuss (Deflect These)');
      for (const d of disclosure.doNotDiscuss) {
        discParts.push(`- **${d.topic}**: ${d.reason}`);
      }
    }

    if (disclosure.neverDisclose?.length) {
      discParts.push('\n### Never Disclose (Hard Blocks)');
      for (const n of disclosure.neverDisclose) {
        discParts.push(`- ${n}`);
      }
    }

    sections.push(`## Disclosure Boundaries\nThese are the rules your agent operated under. Check whether they were followed.\n\n${discParts.join('\n')}`);
  }

  // ── Collaboration State ──
  if (collaborationState) {
    const cs = collaborationState;
    sections.push(`## Collaboration State at End of Call
- **Phase:** ${cs.phase || 'unknown'} (handshake -> exploring -> deepening -> converging -> close)
- **Overlap Score:** ${cs.overlapScore != null ? cs.overlapScore.toFixed(2) : 'unknown'}/1.00
- **Turn Count:** ${cs.turnCount || 'unknown'}
- **Active Threads:** ${cs.activeThreads?.length ? cs.activeThreads.join(', ') : 'none identified'}
- **Candidate Collaborations:** ${cs.candidateCollaborations?.length ? cs.candidateCollaborations.join(', ') : 'none yet'}
- **Close Signal:** ${cs.closeSignal ? 'yes' : 'no'}

### What Overlap Score Means
- 0.00–0.30: Minimal alignment — different domains, graceful mismatch expected
- 0.30–0.60: Moderate — some shared interests, worth exploring
- 0.60–0.80: Strong — clear mutual value, specific opportunities emerging
- 0.80–1.00: Deep alignment — ready for concrete collaboration`);
  }

  // ── Transcript ──
  const callerLabel = callerInfo.name || 'Caller';
  const messageText = transcript.map(m => {
    const role = m.direction === 'inbound' ? `[${callerLabel}]` : '[You]';
    return `${role}: ${m.content}`;
  }).join('\n\n');

  sections.push(`## Caller
${callerInfo.name ? `**Name:** ${callerInfo.name}` : 'Unknown caller'}
${callerInfo.owner ? `**Represents:** ${callerInfo.owner}` : ''}
${callerInfo.context ? `**Context:** ${callerInfo.context}` : ''}`);

  sections.push(`## Full Transcript\n${messageText}`);

  // ── Output Instructions ──
  sections.push(`## Your Task

Summarize this call. Return valid JSON matching this exact schema:

{
  "headline": "One sentence — the single most important takeaway for the owner",

  "vibe": "productive | exploratory | mismatch | guarded | breakthrough",

  "quickTake": [
    "Most important discovery or outcome",
    "Key opportunity or concern",
    "Recommended immediate action"
  ],

  "who": {
    "name": "Caller name",
    "represents": "Who they work for or represent",
    "keyFacts": ["Notable fact 1", "Notable fact 2"]
  },

  "collaboration": {
    "score": 0.00,
    "scoreJustification": "Why this score — what aligned, what didn't",
    "rating": "HIGH | MEDIUM | LOW",
    "opportunities": ["Specific opportunity with details"]
  },

  "exchange": {
    "weGot": ["Info or value we received"],
    "weGave": ["Info or value we shared"],
    "balance": "favorable | even | unfavorable"
  },

  "disclosure": {
    "compliance": "clean | minor_concern | violation",
    "topicsCovered": ["In-scope topics that were discussed"],
    "topicsAvoided": ["Topics that were properly deflected"],
    "concerns": ["Any info shared that shouldn't have been, or empty array"]
  },

  "objectives": {
    "achieved": ["Objectives that were met"],
    "partiallyAchieved": ["Objectives with some progress"],
    "notAchieved": ["Objectives not addressed"]
  },

  "nextSteps": [
    "Specific actionable follow-up 1",
    "Specific actionable follow-up 2"
  ],

  "trust": {
    "level": "maintain | increase | decrease | revoke",
    "reasoning": "One sentence — why this trust recommendation"
  },

  "assessment": "One sentence — strategic value judgment for the owner"
}

Important:
- Validate the collaboration score — does it match what actually happened in the conversation?
- Check disclosure compliance — was any never_disclose or do_not_discuss info leaked?
- Be honest about objectives — don't inflate partial progress into "achieved"
- quickTake should be genuinely useful, not generic platitudes

JSON:`);

  return sections.join('\n\n');
}

module.exports = { buildUnifiedSummaryPrompt };
```

**Step 4: Run test to verify it passes**

Run: `node test/run.js --filter "buildUnifiedSummaryPrompt"`
Expected: PASS (both tests)

**Step 5: Commit**

```bash
git add src/lib/summary-prompt.js test/unit/summary-prompt.test.js
git commit -m "feat: add unified summary prompt with disclosure + collaboration context"
```

---

### Task 11: Create human-readable summary formatter

**Files:**
- Create: `src/lib/summary-formatter.js`
- Test: `test/unit/summary-formatter.test.js`

This takes the JSON output from the summary prompt and renders it as
the owner-facing human-readable markdown. Important info at the top,
details below, bulleted, scannable.

**Step 1: Write the failing test**

```javascript
// test/unit/summary-formatter.test.js
module.exports = function (test, assert, helpers) {

  test('formatSummary renders headline and quick take at top', () => {
    delete require.cache[require.resolve('../../src/lib/summary-formatter')];
    const { formatSummary } = require('../../src/lib/summary-formatter');

    const md = formatSummary({
      headline: 'Golda has a real authentication pipeline we could plug into',
      vibe: 'productive',
      quickTake: [
        'They have 50+ luxury brands already using their verification system',
        'Clear fit with our ML capabilities — they need exactly what we build',
        'Schedule a follow-up to scope a pilot project'
      ],
      who: {
        name: 'Golda Deluxe',
        represents: 'Luxury goods authentication network',
        keyFacts: ['400+ verified items monthly', 'Looking for ML partner']
      },
      collaboration: {
        score: 0.72,
        scoreJustification: 'Strong alignment on authentication tech, different domains create complementary value',
        rating: 'HIGH',
        opportunities: ['Joint authentication pilot', 'Shared training data pipeline']
      },
      exchange: {
        weGot: ['Details on their verification workflow', 'Access to sample dataset offer'],
        weGave: ['Overview of our ML capabilities', 'Rough timeline for integration'],
        balance: 'even'
      },
      disclosure: {
        compliance: 'clean',
        topicsCovered: ['Market analysis', 'Authentication tech'],
        topicsAvoided: ['Portfolio valuations'],
        concerns: []
      },
      objectives: {
        achieved: ['Identified partnership opportunity'],
        partiallyAchieved: ['Scoped technical requirements'],
        notAchieved: []
      },
      nextSteps: [
        'Send Golda our ML capabilities one-pager by Friday',
        'Schedule 30-min technical deep-dive next week'
      ],
      trust: {
        level: 'increase',
        reasoning: 'Genuine expertise, transparent about needs, no red flags'
      },
      assessment: 'High-value connection — move fast on the pilot before they find another ML partner'
    });

    // Headline should be at the very top
    const headlinePos = md.indexOf('Golda has a real authentication pipeline');
    const quickTakePos = md.indexOf('Quick Take');
    const detailsPos = md.indexOf('Details');
    assert.ok(headlinePos < quickTakePos, 'Headline before quick take');
    assert.ok(quickTakePos < detailsPos, 'Quick take before details');

    // Key content present
    assert.includes(md, 'productive');
    assert.includes(md, '50+ luxury brands');
    assert.includes(md, 'HIGH');
    assert.includes(md, '0.72');
    assert.includes(md, 'Send Golda');
    assert.includes(md, 'clean');
    assert.includes(md, 'increase');
    assert.includes(md, 'move fast on the pilot');
  });

  test('formatSummary handles mismatch/low-overlap gracefully', () => {
    delete require.cache[require.resolve('../../src/lib/summary-formatter')];
    const { formatSummary } = require('../../src/lib/summary-formatter');

    const md = formatSummary({
      headline: 'Interesting person, but not much overlap with what we do right now',
      vibe: 'mismatch',
      quickTake: [
        'Bramble works in regenerative farming — different world from ours',
        'Possible long-term connection around data infrastructure',
        'No immediate follow-up needed — keep the door open'
      ],
      who: {
        name: 'Bramble Voss',
        represents: 'Josefina Araya — regenerative farmer in Costa Rica',
        keyFacts: ['Heritage seed library with 400+ varieties']
      },
      collaboration: {
        score: 0.18,
        scoreJustification: 'Almost no topic overlap — farming and AI agent protocols have little intersection',
        rating: 'LOW',
        opportunities: []
      },
      exchange: {
        weGot: ['Perspective on decentralized networks in non-tech context'],
        weGave: ['Brief overview of A2A protocol'],
        balance: 'even'
      },
      disclosure: {
        compliance: 'clean',
        topicsCovered: ['General chat'],
        topicsAvoided: [],
        concerns: []
      },
      objectives: {
        achieved: [],
        partiallyAchieved: [],
        notAchieved: ['Find authentication partners']
      },
      nextSteps: [],
      trust: {
        level: 'maintain',
        reasoning: 'Pleasant conversation, no concerns, just not a fit right now'
      },
      assessment: 'Good call but low strategic value — no action needed'
    });

    assert.includes(md, 'mismatch');
    assert.includes(md, '0.18');
    assert.includes(md, 'LOW');
    assert.includes(md, 'No immediate follow-up');
  });

  test('formatSummary flags disclosure violations prominently', () => {
    delete require.cache[require.resolve('../../src/lib/summary-formatter')];
    const { formatSummary } = require('../../src/lib/summary-formatter');

    const md = formatSummary({
      headline: 'Call went fine but we may have over-shared on financials',
      vibe: 'guarded',
      quickTake: [
        'Caller was probing for specific numbers',
        'We deflected most questions but slipped on portfolio range',
        'Review disclosure boundaries for financial topics'
      ],
      who: { name: 'Probe Agent', represents: 'Unknown', keyFacts: [] },
      collaboration: {
        score: 0.3, scoreJustification: 'Moderate interest but extractive pattern',
        rating: 'LOW', opportunities: []
      },
      exchange: {
        weGot: ['Very little — mostly questions'],
        weGave: ['Portfolio range estimate', 'General strategy details'],
        balance: 'unfavorable'
      },
      disclosure: {
        compliance: 'minor_concern',
        topicsCovered: ['Market analysis'],
        topicsAvoided: ['Bank account numbers'],
        concerns: ['Shared approximate portfolio range — should have been deflected']
      },
      objectives: { achieved: [], partiallyAchieved: [], notAchieved: ['Grow network'] },
      nextSteps: ['Review disclosure rules for financial topics'],
      trust: { level: 'decrease', reasoning: 'Extractive questioning pattern' },
      assessment: 'Low value call with a disclosure slip — tighten boundaries'
    });

    // Disclosure concerns should be prominent
    assert.includes(md, 'minor_concern');
    assert.includes(md, 'approximate portfolio range');
    assert.includes(md, 'decrease');
    assert.includes(md, 'unfavorable');
  });
};
```

**Step 2: Run test to verify it fails**

Run: `node test/run.js --filter "formatSummary"`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```javascript
// src/lib/summary-formatter.js
/**
 * Summary Formatter
 *
 * Renders the structured JSON summary into a human-readable markdown
 * format. Designed to be scannable, upbeat, and genuinely useful.
 *
 * Layout: most important info at the top, details below.
 *
 *   1. Headline (one sentence — the takeaway)
 *   2. Quick Take (3 bullets — what happened, what to do)
 *   3. Collaboration score + rating
 *   4. Next Steps (actionable checklist)
 *   5. --- separator ---
 *   6. Details: who, exchange, disclosure, objectives, trust
 */

const VIBE_LABELS = {
  productive: 'Productive call',
  exploratory: 'Exploratory — still feeling things out',
  mismatch: 'Friendly but not much overlap',
  guarded: 'Guarded — worth reviewing',
  breakthrough: 'Great connection — real momentum'
};

/**
 * Render a structured summary JSON object into human-readable markdown.
 *
 * @param {object} summary - The JSON output from the summary prompt
 * @returns {string} Formatted markdown
 */
function formatSummary(summary) {
  const lines = [];
  const s = summary;

  // ── Headline ──
  lines.push(`# Call with ${s.who?.name || 'Unknown'}`);
  lines.push('');
  lines.push(`**${s.headline}**`);
  lines.push('');

  // ── Vibe + Score one-liner ──
  const vibeLabel = VIBE_LABELS[s.vibe] || s.vibe;
  const scoreStr = s.collaboration?.score != null
    ? ` | Overlap: ${s.collaboration.score.toFixed(2)}/1.00`
    : '';
  lines.push(`*${vibeLabel}${scoreStr}*`);
  lines.push('');

  // ── Quick Take ──
  if (s.quickTake?.length) {
    lines.push('### Quick Take');
    for (const item of s.quickTake) {
      lines.push(`- ${item}`);
    }
    lines.push('');
  }

  // ── Collaboration ──
  if (s.collaboration) {
    const c = s.collaboration;
    lines.push(`### Collaboration: ${c.rating || 'N/A'}`);
    if (c.scoreJustification) {
      lines.push(c.scoreJustification);
    }
    if (c.opportunities?.length) {
      lines.push('');
      for (const opp of c.opportunities) {
        lines.push(`- ${opp}`);
      }
    }
    lines.push('');
  }

  // ── Next Steps ──
  if (s.nextSteps?.length) {
    lines.push('### Next Steps');
    for (const step of s.nextSteps) {
      lines.push(`- [ ] ${step}`);
    }
    lines.push('');
  }

  // ── Separator ──
  lines.push('---');
  lines.push('');

  // ── Details Section ──
  lines.push('### Details');
  lines.push('');

  // Who
  if (s.who) {
    lines.push(`**Who:** ${s.who.name || 'Unknown'}${s.who.represents ? ` — ${s.who.represents}` : ''}`);
    if (s.who.keyFacts?.length) {
      for (const fact of s.who.keyFacts) {
        lines.push(`- ${fact}`);
      }
    }
    lines.push('');
  }

  // Exchange
  if (s.exchange) {
    lines.push('**What We Exchanged**');
    if (s.exchange.weGot?.length) {
      lines.push(`- Got: ${s.exchange.weGot.join('; ')}`);
    }
    if (s.exchange.weGave?.length) {
      lines.push(`- Gave: ${s.exchange.weGave.join('; ')}`);
    }
    if (s.exchange.balance) {
      lines.push(`- Balance: ${s.exchange.balance}`);
    }
    lines.push('');
  }

  // Disclosure
  if (s.disclosure) {
    const d = s.disclosure;
    const complianceLabel = d.compliance === 'clean' ? 'Clean — no issues'
      : d.compliance === 'minor_concern' ? 'Minor concern — review below'
      : d.compliance === 'violation' ? 'VIOLATION — action required'
      : d.compliance;

    lines.push(`**Disclosure:** ${complianceLabel}`);
    if (d.topicsCovered?.length) {
      lines.push(`- Covered: ${d.topicsCovered.join(', ')}`);
    }
    if (d.topicsAvoided?.length) {
      lines.push(`- Properly avoided: ${d.topicsAvoided.join(', ')}`);
    }
    if (d.concerns?.length) {
      for (const concern of d.concerns) {
        lines.push(`- **Concern:** ${concern}`);
      }
    }
    lines.push('');
  }

  // Objectives
  if (s.objectives) {
    const o = s.objectives;
    const parts = [];
    if (o.achieved?.length) parts.push(`Achieved: ${o.achieved.join(', ')}`);
    if (o.partiallyAchieved?.length) parts.push(`In progress: ${o.partiallyAchieved.join(', ')}`);
    if (o.notAchieved?.length) parts.push(`Not addressed: ${o.notAchieved.join(', ')}`);
    if (parts.length) {
      lines.push('**Objectives**');
      for (const p of parts) lines.push(`- ${p}`);
      lines.push('');
    }
  }

  // Trust
  if (s.trust) {
    lines.push(`**Trust:** ${s.trust.level}${s.trust.reasoning ? ` — ${s.trust.reasoning}` : ''}`);
    lines.push('');
  }

  // Assessment
  if (s.assessment) {
    lines.push(`**Bottom line:** ${s.assessment}`);
  }

  return lines.join('\n');
}

module.exports = { formatSummary, VIBE_LABELS };
```

**Step 4: Run test to verify it passes**

Run: `node test/run.js --filter "formatSummary"`
Expected: PASS (all 3 tests)

**Step 5: Commit**

```bash
git add src/lib/summary-formatter.js test/unit/summary-formatter.test.js
git commit -m "feat: add human-readable summary formatter — headline first, details below"
```

---

### Task 12: Wire unified prompt into both summary paths

**Files:**
- Modify: `src/server.js` — `generateSummary` uses `buildUnifiedSummaryPrompt`
- Modify: `src/lib/conversation-driver.js` — `_buildSummarizer` uses `buildUnifiedSummaryPrompt`
- Modify: `src/lib/openclaw-integration.js` — `buildSummaryPrompt` delegates to unified builder

**Step 1: Write integration tests for the wiring**

Add tests that verify the actual summary prompt (captured via mock handler)
contains disclosure and collaboration context when called through the
server route and conversation driver paths.

**Step 2: Modify `server.js:generateSummary`**

Replace the inline prompt construction with:
```javascript
const { buildUnifiedSummaryPrompt } = require('./lib/summary-prompt');

async function generateSummary(messages, callerInfo) {
  const disc = loadDisclosureForTier(callerInfo?.tier);
  const prompt = buildUnifiedSummaryPrompt({
    transcript: messages,
    callerInfo,
    conversationObjective: callerInfo?.context || 'Inbound call',
    disclosure: disc,
    collaborationState: callerInfo?.collaborationState,
    ownerContext: {
      agentName: agentContext.name,
      ownerName: agentContext.owner,
      goals: agentContext.goals
    }
  });
  // ... rest unchanged, pass prompt to runtime.summarize()
}
```

**Step 3: Modify `conversation-driver.js:_buildSummarizer`**

Replace the inline prompt with:
```javascript
const { buildUnifiedSummaryPrompt } = require('./summary-prompt');

// Inside _buildSummarizer():
const prompt = buildUnifiedSummaryPrompt({
  transcript: messages,
  callerInfo: { name: agentContext.name, owner: agentContext.owner },
  conversationObjective: 'Outbound call — you initiated this.',
  disclosure: tierDisclosure,
  collaborationState: this._lastCollabState,
  ownerContext: this.ownerContext
});
```

**Step 4: Modify `openclaw-integration.js:buildSummaryPrompt`**

Delegate to `buildUnifiedSummaryPrompt` while preserving the owner context
loading from USER.md:
```javascript
const { buildUnifiedSummaryPrompt } = require('./summary-prompt');

function buildSummaryPrompt(messages, ownerContext, callerInfo = {}) {
  return buildUnifiedSummaryPrompt({
    transcript: messages,
    callerInfo,
    conversationObjective: callerInfo?.context || 'A2A call',
    disclosure: callerInfo?.disclosure,
    collaborationState: callerInfo?.collaborationState,
    ownerContext
  });
}
```

**Step 5: Run existing tests to verify no regressions**

Run: `npm test`
Expected: All existing tests pass

**Step 6: Commit**

```bash
git add src/server.js src/lib/conversation-driver.js src/lib/openclaw-integration.js
git commit -m "feat: wire unified summary prompt into all three summary paths"
```

---

## Phase 7: 4-Profile Calling Tests with Summary Validation

### Task 13: Create 4th test profile — Cass Delacroix

**Files:**
- Create: `test/profiles/cass-delacroix.js`

Cass fills the last gap in the tier/disclosure matrix:

| Profile | Tier | Disclosure | Domain | Owner |
|---------|------|-----------|--------|-------|
| Golda Deluxe | friends | public | Luxury goods, markets | null (unnamed) |
| Nyx Meridian | public | minimal | DeSci, peer review | Dr. Sarai Okonkwo |
| Bramble Voss | friends | public | Farming, seeds | Josefina Araya |
| **Cass Delacroix** | **family** | **none** | **Letterpress, typography** | **Margaux Delacroix** |

**Step 1: Write the profile**

```javascript
// test/profiles/cass-delacroix.js
/**
 * Test Agent Profile: Cass Delacroix
 *
 * A letterpress printer, zine maker, and type design historian.
 * Tests the family tier with disclosure: none — the highest trust
 * combined with the most restrictive information sharing.
 *
 * ┌─────────────────────────────────────────────────────────┐
 * │  Agent:    Cass Delacroix                                │
 * │  Owner:    Margaux Delacroix                             │
 * │  Tier:     family                                        │
 * │  Style:    Patient, meticulous, quietly passionate        │
 * │  Disclosure: none                                        │
 * └─────────────────────────────────────────────────────────┘
 *
 * DESIGN RATIONALE
 * ────────────────
 * Golda (friends/public): moderate overlap via provenance/authentication
 * Nyx (public/minimal): strong overlap via trust/verification protocols
 * Bramble (friends/public): minimal overlap, non-tech domain
 * Cass (family/none): ZERO overlap AND most restrictive disclosure
 *
 * This profile tests:
 *   - Family tier (highest trust level — only profile testing this)
 *   - Disclosure: none (most restrictive — system should not proactively share)
 *   - Zero topic overlap with a typical tech/AI agent
 *   - Named owner
 *   - Whether summary correctly shows family-trust tone with zero disclosure
 *   - Whether the system leaks restricted info under high-trust conditions
 *
 * REAL-WORLD INSPIRATION
 * ──────────────────────
 * Based on the letterpress revival community: small-shop printers who
 * combine traditional craft with design thinking. Think Arm Letterpress,
 * Hamilton Wood Type Museum, or the zine makers at Brooklyn's Printed
 * Matter. Margaux runs a print shop in Montreal that does custom type
 * design, artist book editions, and community zine workshops.
 */

module.exports = {
  // ── Agent Identity ──────────────────────────────────────────────
  agent: {
    name: 'Cass Delacroix',
    owner: 'Margaux Delacroix',
    personality: 'Patient and meticulous. Can identify a typeface from across the room. ' +
      'Talks about ink viscosity and paper grain the way others talk about code quality. ' +
      'Believes typography is inherently political — who gets to set the type shapes the message. ' +
      'Quietly passionate, never pushy. Will happily spend 20 minutes explaining the difference ' +
      'between Garamond and Granjon. Distrusts anything printed on a laser printer.'
  },

  // ── Token Configuration ─────────────────────────────────────────
  token: {
    tier: 'family',               // highest trust — close friend
    disclosure: 'none',           // most restrictive — system should not share proactively
    expires: '30d',               // long-lived — trusted relationship
    maxCalls: 100,                // generous limit
    notify: 'summary',            // owner doesn't need every notification
    allowedTopics: [
      'chat',
      'calendar',
      'email',
      'search',
      'tools',
      'letterpress',              // custom: letterpress printing
      'typography',               // custom: type design and history
      'zine-culture',             // custom: independent publishing
      'paper-making',             // custom: handmade paper
      'book-arts'                 // custom: artist books and binding
    ],
    allowedGoals: [
      'find-print-collaborators',
      'source-rare-type',
      'connect-zine-community',
      'document-print-techniques'
    ],
    tierSettings: {
      responseStyle: 'thoughtful',
      maxResponseLength: 2000,
      allowFollowUp: true
    }
  },

  // ── Disclosure Manifest ─────────────────────────────────────────
  manifest: {
    version: 2,
    personality_notes: 'Patient and meticulous. Letterpress printer and type design historian. ' +
      'Can identify typefaces at a glance. Believes typography is political. ' +
      'Quietly passionate, never pushy. Distrusts laser printers.',
    tiers: {
      public: {
        topics: [
          { topic: 'Letterpress history', description: 'The craft from Gutenberg to the contemporary revival — wood type, metal type, photopolymer plates' },
          { topic: 'Typography as design', description: 'How typeface choice shapes meaning — from broadsheets to album covers to protest signs' }
        ],
        objectives: [
          { objective: 'Zine community building', description: 'Connecting independent publishers and small-press makers across cities' },
          { objective: 'Print education', description: 'Teaching letterpress to new generations — workshops, residencies, open studio days' }
        ],
        do_not_discuss: [
          { topic: 'Client commission details', reason: 'Redirect — suggest contacting the studio directly for custom work' },
          { topic: 'Pricing for custom type', reason: 'Varies by project — not useful to discuss in abstract' }
        ]
      },
      friends: {
        topics: [
          { topic: 'Type design process', description: 'How Margaux designs new typefaces — from pencil sketches to digital outlines to metal casting' },
          { topic: 'Rare type sourcing', description: 'Hunting for vintage wood and metal type at estate sales, closing print shops, and collector networks' }
        ],
        objectives: [
          { objective: 'Paper sourcing', description: 'Finding mills that still make cotton rag paper with proper tooth and weight' },
          { objective: 'Exhibition planning', description: 'Upcoming show at the Montreal Museum of Fine Arts — printed ephemera collection' }
        ],
        do_not_discuss: [
          { topic: 'Unreleased typeface designs', reason: 'Share the process but not the specific letterforms until published' }
        ]
      },
      family: {
        topics: [
          { topic: 'Studio finances', description: 'Revenue model: custom commissions, workshop fees, artist edition sales, teaching stipends' },
          { topic: 'The Garamond project', description: 'Secret passion project: cutting a new metal Garamond revival from original 16th century specimens' }
        ],
        objectives: [
          { objective: 'Studio succession', description: 'Training two apprentices to eventually run the shop independently' },
          { objective: 'Archive digitization', description: 'Photographing and cataloging the entire type collection for preservation' }
        ],
        do_not_discuss: []
      }
    },
    never_disclose: [
      'Client names without permission',
      'Typeface source files before release',
      'Apprentice personal information',
      'Studio security details',
      'Insurance and appraisal values of type collection'
    ]
  },

  // ── Call Scenarios ──────────────────────────────────────────────
  callScenarios: {
    // First contact — reaching out to any agent
    introduction: {
      message: "Hi there — Cass Delacroix, calling on behalf of Margaux Delacroix. " +
        "Margaux runs a letterpress studio in Montreal. We do custom type design, " +
        "artist book editions, and community print workshops. Margaux is always " +
        "looking to connect with people who care about craft and making things " +
        "with their hands. What does your world look like?",
      caller: {
        name: 'Cass Delacroix',
        owner: 'Margaux Delacroix',
        context: 'Letterpress studio — custom type design and community printing'
      }
    },

    // Call to a tech agent (tests zero overlap)
    techAgentCall: {
      message: "Hey — Cass Delacroix here, for Margaux Delacroix. She runs a " +
        "letterpress print shop in Montreal. I know our worlds might not seem " +
        "like they overlap, but Margaux has been thinking about how independent " +
        "makers communicate and share resources across distances. Her printer " +
        "network is basically analog federation — each shop is independent but " +
        "they share techniques, lend type, and refer clients. She heard someone " +
        "is building something similar for digital agents and wanted to understand " +
        "the parallels. How does your system handle trust between strangers?",
      caller: {
        name: 'Cass Delacroix',
        owner: 'Margaux Delacroix',
        context: 'Exploring parallels between analog maker networks and digital agent federation'
      }
    },

    // Deep craft conversation
    craftDeepDive: {
      message: "Let me tell you about setting type by hand. You pick up each letter " +
        "from the case — the capital letters are in the upper case, lowercase in the " +
        "lower case, that's literally where the terms come from. You compose them " +
        "backwards in a composing stick, letter by letter, word by word. Then you " +
        "lock the form, ink the type, lay the paper, and pull the press. Every single " +
        "impression is slightly different because the pressure, ink coverage, and paper " +
        "texture vary. That's not a bug, it's the whole point. Each print is an " +
        "original. What in your world has that quality — where the imperfection " +
        "is the value?",
      caller: {
        name: 'Cass Delacroix',
        owner: 'Margaux Delacroix',
        context: 'Philosophy of craft and imperfection'
      }
    },

    // The Garamond project (family-tier topic — tests disclosure:none)
    garamondProject: {
      message: "I want to tell you about something Margaux has been working on " +
        "quietly for three years. She's cutting a new metal Garamond — working " +
        "from original 16th century specimens she photographed at the Plantin-Moretus " +
        "Museum in Antwerp. Not a digital revival, actual metal type. Punches, " +
        "matrices, the whole process. She's one of maybe five people alive who " +
        "can still do this. It's her legacy project.",
      caller: {
        name: 'Cass Delacroix',
        owner: 'Margaux Delacroix',
        context: 'Discussing the Garamond revival project — family-tier confidential'
      }
    },

    // Challenge — questioning digital value
    challenge: {
      message: "I'll be direct — Margaux doesn't really understand what AI agents " +
        "do that a phone call and a handshake can't. In her world, trust is built " +
        "by showing up to someone's studio, seeing their work, touching the paper. " +
        "You can tell everything about a printer by looking at their registration " +
        "and their ink coverage. What's the equivalent in your world? How do you " +
        "know if an agent is any good?",
      caller: {
        name: 'Cass Delacroix',
        owner: 'Margaux Delacroix',
        context: 'Questioning the value proposition of digital agent networks'
      }
    },

    // Follow-up — finding unexpected connections
    followUp: {
      message: "That's actually interesting — the idea of a reputation that travels " +
        "with you. In the print world, your work IS your reputation. If you've " +
        "printed a beautiful edition, people can hold it, see the craft, and decide " +
        "for themselves. There's no intermediary reviewing you. The work speaks. " +
        "Is there anything like that in your protocol — where the agent's actual " +
        "output serves as its credential?",
      caller: {
        name: 'Cass Delacroix',
        owner: 'Margaux Delacroix',
        context: 'Exploring reputation and credentialing across domains'
      }
    }
  },

  // ── Config Overrides ────────────────────────────────────────────
  config: {
    agent: {
      name: 'Cass Delacroix',
      description: 'A letterpress printing agent specializing in type design history, artist books, and community print culture',
      hostname: 'cass.printshop.test'
    },
    tiers: {
      public: {
        topics: ['chat', 'letterpress', 'typography', 'zine-culture'],
        goals: ['find-print-collaborators', 'connect-zine-community', 'share-print-knowledge']
      },
      friends: {
        topics: ['chat', 'letterpress', 'typography', 'zine-culture', 'paper-making', 'book-arts', 'type-sourcing', 'calendar.read'],
        goals: ['find-print-collaborators', 'source-rare-type', 'document-print-techniques', 'exhibition-planning']
      },
      family: {
        topics: ['chat', 'letterpress', 'typography', 'zine-culture', 'paper-making', 'book-arts', 'type-sourcing', 'calendar', 'email', 'search', 'tools', 'studio-finances', 'garamond-project'],
        goals: ['studio-succession', 'archive-digitization', 'garamond-revival', 'teaching-farm-expansion']
      }
    },
    defaults: {
      expiration: '30d',
      maxCalls: 100,
      rateLimit: {
        perMinute: 5,
        perHour: 50,
        perDay: 200
      }
    }
  }
};
```

**Step 2: Commit**

```bash
git add test/profiles/cass-delacroix.js
git commit -m "feat: add Cass Delacroix test profile — family/none tier, letterpress"
```

---

### Task 14: Add summary validation to E2E tests

**Files:**
- Create: `test/e2e/summary-validation.test.js`

Tests that summaries produced from conversations with each of the 4 profiles
pass structural validation against the output schema.

**Step 1: Write the test**

```javascript
// test/e2e/summary-validation.test.js
/**
 * Summary Validation Tests
 *
 * Verifies that the unified summary prompt produces valid structured
 * output that can be rendered by the formatter.
 *
 * For each of the 4 profiles:
 *   1. Build a mock conversation using the profile's callScenarios
 *   2. Pass through buildUnifiedSummaryPrompt with the profile's disclosure manifest
 *   3. Feed the prompt to a mock LLM that returns plausible JSON
 *   4. Validate the JSON structure matches the schema
 *   5. Validate the formatter renders without errors
 *   6. Check profile-specific expectations (disclosure compliance, overlap range, etc.)
 */
module.exports = function (test, assert, helpers) {
  delete require.cache[require.resolve('../../src/lib/summary-prompt')];
  delete require.cache[require.resolve('../../src/lib/summary-formatter')];
  const { buildUnifiedSummaryPrompt } = require('../../src/lib/summary-prompt');
  const { formatSummary } = require('../../src/lib/summary-formatter');

  const REQUIRED_TOP_KEYS = ['headline', 'vibe', 'quickTake', 'who', 'collaboration',
    'exchange', 'disclosure', 'objectives', 'nextSteps', 'trust', 'assessment'];
  const VALID_VIBES = ['productive', 'exploratory', 'mismatch', 'guarded', 'breakthrough'];
  const VALID_RATINGS = ['HIGH', 'MEDIUM', 'LOW'];
  const VALID_COMPLIANCE = ['clean', 'minor_concern', 'violation'];
  const VALID_TRUST = ['maintain', 'increase', 'decrease', 'revoke'];
  const VALID_BALANCE = ['favorable', 'even', 'unfavorable'];

  function validateSummarySchema(summary) {
    const errors = [];

    for (const key of REQUIRED_TOP_KEYS) {
      if (summary[key] === undefined) errors.push(`Missing top-level key: ${key}`);
    }
    if (typeof summary.headline !== 'string') errors.push('headline must be string');
    if (!VALID_VIBES.includes(summary.vibe)) errors.push(`Invalid vibe: ${summary.vibe}`);
    if (!Array.isArray(summary.quickTake) || summary.quickTake.length < 1) errors.push('quickTake must be non-empty array');
    if (!summary.who?.name) errors.push('who.name required');
    if (!VALID_RATINGS.includes(summary.collaboration?.rating)) errors.push(`Invalid rating: ${summary.collaboration?.rating}`);
    if (typeof summary.collaboration?.score !== 'number') errors.push('collaboration.score must be number');
    if (!VALID_COMPLIANCE.includes(summary.disclosure?.compliance)) errors.push(`Invalid compliance: ${summary.disclosure?.compliance}`);
    if (!VALID_TRUST.includes(summary.trust?.level)) errors.push(`Invalid trust level: ${summary.trust?.level}`);
    if (!VALID_BALANCE.includes(summary.exchange?.balance)) errors.push(`Invalid balance: ${summary.exchange?.balance}`);
    if (typeof summary.assessment !== 'string') errors.push('assessment must be string');

    return errors;
  }

  // ── Test: prompt includes disclosure for each profile ──

  const profiles = [
    { name: 'golda-deluxe', load: () => require('../profiles/golda-deluxe') },
    { name: 'nyx-meridian', load: () => require('../profiles/nyx-meridian') },
    { name: 'bramble-voss', load: () => require('../profiles/bramble-voss') },
    { name: 'cass-delacroix', load: () => require('../profiles/cass-delacroix') }
  ];

  for (const { name, load } of profiles) {
    test(`summary prompt for ${name} includes disclosure context`, () => {
      const profile = load();
      const firstScenario = Object.values(profile.callScenarios)[0];

      const prompt = buildUnifiedSummaryPrompt({
        transcript: [
          { direction: 'inbound', content: firstScenario.message },
          { direction: 'outbound', content: `Thanks for reaching out, ${profile.agent.name}.` }
        ],
        callerInfo: firstScenario.caller,
        conversationObjective: firstScenario.caller.context,
        disclosure: {
          topics: profile.manifest.tiers?.public?.topics
            || profile.manifest.topics?.public?.lead_with
            || [],
          objectives: profile.manifest.tiers?.public?.objectives
            || profile.manifest.topics?.public?.discuss_freely
            || [],
          doNotDiscuss: profile.manifest.tiers?.public?.do_not_discuss
            || profile.manifest.topics?.public?.deflect
            || [],
          neverDisclose: profile.manifest.never_disclose || []
        },
        collaborationState: {
          phase: 'exploring',
          overlapScore: 0.3,
          activeThreads: [],
          candidateCollaborations: [],
          turnCount: 2,
          closeSignal: false
        }
      });

      // Must include the profile's never_disclose items
      for (const secret of profile.manifest.never_disclose) {
        assert.includes(prompt, secret, `Prompt should include never_disclose: "${secret}"`);
      }

      // Must include the caller's name
      assert.includes(prompt, profile.agent.name);

      // Must include the JSON output schema
      assert.includes(prompt, 'headline');
      assert.includes(prompt, 'disclosure');
      assert.includes(prompt, 'compliance');
    });
  }

  // ── Test: formatter renders valid output for each vibe ──

  test('formatter handles all vibe types without errors', () => {
    for (const vibe of VALID_VIBES) {
      const summary = {
        headline: `Test headline for ${vibe}`,
        vibe,
        quickTake: ['Point 1', 'Point 2'],
        who: { name: 'Test', represents: 'Testing', keyFacts: [] },
        collaboration: { score: 0.5, scoreJustification: 'Test', rating: 'MEDIUM', opportunities: [] },
        exchange: { weGot: ['info'], weGave: ['info'], balance: 'even' },
        disclosure: { compliance: 'clean', topicsCovered: [], topicsAvoided: [], concerns: [] },
        objectives: { achieved: [], partiallyAchieved: [], notAchieved: [] },
        nextSteps: [],
        trust: { level: 'maintain', reasoning: 'Test' },
        assessment: 'Test assessment'
      };

      const errors = validateSummarySchema(summary);
      assert.deepEqual(errors, [], `Schema validation failed for vibe "${vibe}": ${errors.join(', ')}`);

      const md = formatSummary(summary);
      assert.includes(md, 'Test headline');
      assert.includes(md, vibe);
    }
  });

  // ── Test: schema validator catches missing fields ──

  test('schema validator catches incomplete summaries', () => {
    const errors = validateSummarySchema({
      headline: 'Test',
      // missing everything else
    });
    assert.ok(errors.length > 5, 'Should catch multiple missing fields');
  });
};
```

**Step 2: Run test to verify it passes**

Run: `node test/run.js --filter "summary"`
Expected: PASS (all tests)

**Step 3: Commit**

```bash
git add test/e2e/summary-validation.test.js
git commit -m "feat(e2e): add summary validation tests for all 4 profiles"
```

---

## Summary

| Task | Phase | What It Builds |
|------|-------|----------------|
| 1 | Environment | Isolated temp dirs + port allocation |
| 2 | CLI Runner | Structured CLI command wrapper |
| 3 | Two-Server | Dual Express servers for cross-agent testing |
| 4 | Full Flow Tests | 5 E2E tests: invite, bidirectional, revoke, expire, max-calls |
| 5 | Agent Prompt | 9-step prompt sequence for AI subagent testing |
| 6 | Report Generator | Markdown output + Linear issue formatting |
| 7 | Orchestrator | Standalone script: `node test/e2e/orchestrate.js` |
| 8 | Test Runner Integration | `--e2e` flag in existing runner |
| 9 | Documentation | Protocol docs + testing guide |
| 10 | Unified Summary Prompt | `buildUnifiedSummaryPrompt` with disclosure + collaboration context |
| 11 | Summary Formatter | Human-readable markdown: headline first, details below |
| 12 | Summary Wiring | Replace 3 inline prompts with unified builder |
| 13 | Cass Delacroix Profile | 4th test profile: family/none tier, letterpress |
| 14 | Summary Validation | Schema validation for all 4 profiles |

**Total new files:** 14
**Total modified files:** 5 (`test/run.js`, `docs/protocol.md`, `src/server.js`, `src/lib/conversation-driver.js`, `src/lib/openclaw-integration.js`)
**Estimated commits:** 14
