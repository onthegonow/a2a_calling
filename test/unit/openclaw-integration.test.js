/**
 * A2A-68: Unit tests for openclaw-integration.js
 *
 * Covers: loadOwnerContext, buildSummaryPrompt, createExecSummarizer,
 * createHttpSummarizer, createSessionSummarizer, createAutoSummarizer.
 */

module.exports = function (test, assert, helpers) {

  // ── Shared utilities ──────────────────────────────────────────

  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const http = require('http');

  function freshModule() {
    delete require.cache[require.resolve('../../src/lib/openclaw-integration')];
    delete require.cache[require.resolve('../../src/lib/summary-prompt')];
    return require('../../src/lib/openclaw-integration');
  }

  function makeTmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-oc-'));
  }

  function rmTmpDir(dir) {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  function mockExecSync(mockFn) {
    const cp = require('child_process');
    const original = cp.execSync;
    cp.execSync = mockFn;
    return () => { cp.execSync = original; };
  }

  function startMockServer(handler) {
    return new Promise((resolve) => {
      const server = http.createServer(handler);
      server.listen(0, '127.0.0.1', () => {
        resolve({
          port: server.address().port,
          close() { return new Promise((r) => server.close(r)); }
        });
      });
    });
  }

  // ── loadOwnerContext ──────────────────────────────────────────

  test('loadOwnerContext returns empty context when workspace has no USER.md or memory/', () => {
    const dir = makeTmpDir();
    try {
      const { loadOwnerContext } = freshModule();
      const ctx = loadOwnerContext(dir);
      assert.deepEqual(ctx.goals, []);
      assert.deepEqual(ctx.interests, []);
      assert.equal(ctx.user, null);
      assert.equal(ctx.memory, null);
      assert.equal(ctx.context, '');
    } finally {
      rmTmpDir(dir);
    }
  });

  test('loadOwnerContext extracts goals from ## Goals section in USER.md', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'USER.md'),
      '# About Me\n\n## Goals\n- Learn Rust\n- Ship v2\n\n## Other\nstuff');
    try {
      const { loadOwnerContext } = freshModule();
      const ctx = loadOwnerContext(dir);
      assert.deepEqual(ctx.goals, ['Learn Rust', 'Ship v2']);
    } finally {
      rmTmpDir(dir);
    }
  });

  test('loadOwnerContext extracts interests from ## Interests section', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'USER.md'),
      '# Me\n\n## Interests\n- Photography\n* Cooking\n\n## Next\nblah');
    try {
      const { loadOwnerContext } = freshModule();
      const ctx = loadOwnerContext(dir);
      assert.deepEqual(ctx.interests, ['Photography', 'Cooking']);
    } finally {
      rmTmpDir(dir);
    }
  });

  test('loadOwnerContext tierGoals option takes priority over USER.md goals', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'USER.md'), '## Goals\n- From USER.md');
    try {
      const { loadOwnerContext } = freshModule();
      const ctx = loadOwnerContext(dir, { tierGoals: ['Tier goal A', 'Tier goal B'] });
      assert.deepEqual(ctx.goals, ['Tier goal A', 'Tier goal B']);
    } finally {
      rmTmpDir(dir);
    }
  });

  test('loadOwnerContext loads MEMORY.md and up to 3 memory files', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'MEMORY.md'), 'Main memory content');
    const memDir = path.join(dir, 'memory');
    fs.mkdirSync(memDir);
    fs.writeFileSync(path.join(memDir, 'a.md'), 'Memory A');
    fs.writeFileSync(path.join(memDir, 'b.md'), 'Memory B');
    fs.writeFileSync(path.join(memDir, 'c.md'), 'Memory C');
    fs.writeFileSync(path.join(memDir, 'd.md'), 'Memory D');
    try {
      const { loadOwnerContext } = freshModule();
      const ctx = loadOwnerContext(dir);
      assert.ok(ctx.memory.includes('Main memory content'), 'includes MEMORY.md');
      // sorted reverse alpha: d, c, b picked (3 cap); a excluded
      assert.ok(ctx.memory.includes('Memory D'), 'includes d.md');
      assert.ok(ctx.memory.includes('Memory C'), 'includes c.md');
      assert.ok(ctx.memory.includes('Memory B'), 'includes b.md');
      assert.ok(!ctx.memory.includes('Memory A'), 'a.md is capped out');
    } finally {
      rmTmpDir(dir);
    }
  });

  test('loadOwnerContext handles empty USER.md gracefully', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'USER.md'), '');
    try {
      const { loadOwnerContext } = freshModule();
      const ctx = loadOwnerContext(dir);
      assert.equal(ctx.user, '');
      assert.deepEqual(ctx.goals, []);
      assert.deepEqual(ctx.interests, []);
    } finally {
      rmTmpDir(dir);
    }
  });

  // ── buildSummaryPrompt ────────────────────────────────────────

  test('buildSummaryPrompt maps messages and ownerContext to unified prompt', () => {
    const { buildSummaryPrompt } = freshModule();
    const messages = [
      { direction: 'inbound', content: 'Hello from Alice' },
      { direction: 'outbound', content: 'Hi Alice, welcome' }
    ];
    const ownerContext = { goals: ['Ship v2', 'Learn Rust'] };
    const callerInfo = { name: 'Alice', owner: 'Alice Corp', context: 'Partnership chat' };

    const prompt = buildSummaryPrompt(messages, ownerContext, callerInfo);
    assert.type(prompt, 'string');
    assert.ok(prompt.includes('[Alice]'), 'includes caller label');
    assert.ok(prompt.includes('Hello from Alice'), 'includes inbound message');
    assert.ok(prompt.includes('Hi Alice, welcome'), 'includes outbound message');
    assert.ok(prompt.includes('Ship v2'), 'includes owner goals');
  });

  test('buildSummaryPrompt handles missing callerInfo fields', () => {
    const { buildSummaryPrompt } = freshModule();
    const messages = [{ direction: 'inbound', content: 'Test message' }];
    const ownerContext = { goals: [] };

    const prompt = buildSummaryPrompt(messages, ownerContext);
    assert.type(prompt, 'string');
    assert.ok(prompt.includes('[Caller]'), 'falls back to default caller label');
  });

  test('buildSummaryPrompt handles null ownerContext', () => {
    const { buildSummaryPrompt } = freshModule();
    const messages = [{ direction: 'inbound', content: 'Test' }];

    const prompt = buildSummaryPrompt(messages, null, { name: 'Bob' });
    assert.type(prompt, 'string');
    assert.ok(prompt.includes('[Bob]'), 'includes caller name');
  });

  // ── createExecSummarizer ──────────────────────────────────────

  test('createExecSummarizer parses JSON response from CLI', async () => {
    const dir = makeTmpDir();
    const restore = mockExecSync(() => JSON.stringify({
      summary: 'Call went well',
      relevance: 'high'
    }));

    try {
      const { createExecSummarizer } = freshModule();
      const summarize = createExecSummarizer(dir);
      const result = await summarize(
        [{ direction: 'inbound', content: 'Hello' }],
        { name: 'Alice' }
      );
      assert.equal(result.summary, 'Call went well');
      assert.equal(result.relevance, 'high');
    } finally {
      restore();
      rmTmpDir(dir);
    }
  });

  test('createExecSummarizer falls back to raw text when no JSON in output', async () => {
    const dir = makeTmpDir();
    const restore = mockExecSync(() => 'Just plain text summary output');

    try {
      const { createExecSummarizer } = freshModule();
      const summarize = createExecSummarizer(dir);
      const result = await summarize([{ direction: 'inbound', content: 'Hello' }]);
      assert.equal(result.summary, 'Just plain text summary output');
      assert.equal(result.relevance, 'unknown');
    } finally {
      restore();
      rmTmpDir(dir);
    }
  });

  test('createExecSummarizer returns { summary: null } on exec error', async () => {
    const dir = makeTmpDir();
    const restore = mockExecSync(() => { throw new Error('Command timed out'); });

    try {
      const { createExecSummarizer } = freshModule();
      const summarize = createExecSummarizer(dir);
      const result = await summarize([{ direction: 'inbound', content: 'Hello' }]);
      assert.equal(result.summary, null);
    } finally {
      restore();
      rmTmpDir(dir);
    }
  });

  test('createExecSummarizer cleans up temp file after execution', async () => {
    const dir = makeTmpDir();
    let capturedCmd = null;
    const restore = mockExecSync((cmd) => {
      capturedCmd = cmd;
      return '{}';
    });

    try {
      const { createExecSummarizer } = freshModule();
      const summarize = createExecSummarizer(dir);
      await summarize([{ direction: 'inbound', content: 'Hello' }]);

      const tmpFileMatch = capturedCmd.match(/\/tmp\/a2a-summary-\d+\.txt/);
      assert.ok(tmpFileMatch, 'command references tmp file');
      assert.ok(!fs.existsSync(tmpFileMatch[0]), 'tmp file is cleaned up after call');
    } finally {
      restore();
      rmTmpDir(dir);
    }
  });

  // ── createHttpSummarizer ──────────────────────────────────────

  test('createHttpSummarizer sends POST and resolves with parsed JSON', async () => {
    let receivedBody = null;
    const srv = await startMockServer((req, res) => {
      let data = '';
      req.on('data', c => data += c);
      req.on('end', () => {
        receivedBody = JSON.parse(data);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ summary: 'HTTP summary result' }));
      });
    });

    try {
      const { createHttpSummarizer } = freshModule();
      const summarize = createHttpSummarizer(`http://127.0.0.1:${srv.port}/api/summarize`);
      const result = await summarize(
        [{ direction: 'inbound', content: 'Hello' }],
        { name: 'Alice' }
      );
      assert.equal(result.summary, 'HTTP summary result');
      assert.ok(receivedBody.prompt, 'sent prompt in body');
      assert.ok(receivedBody.messages, 'sent messages in body');
      assert.ok(receivedBody.callerInfo, 'sent callerInfo in body');
    } finally {
      await srv.close();
    }
  });

  test('createHttpSummarizer resolves { summary: null } on connection error', async () => {
    const { createHttpSummarizer } = freshModule();
    const summarize = createHttpSummarizer('http://127.0.0.1:1/api/summarize');
    const result = await summarize([{ direction: 'inbound', content: 'Hello' }]);
    assert.equal(result.summary, null);
  });

  // ── createSessionSummarizer ───────────────────────────────────

  test('createSessionSummarizer sends POST with auth header to gateway', async () => {
    let receivedHeaders = null;
    let receivedPath = null;
    const srv = await startMockServer((req, res) => {
      receivedHeaders = req.headers;
      receivedPath = req.url;
      let data = '';
      req.on('data', c => data += c);
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ summary: { headline: 'Session summary' } }));
      });
    });

    try {
      const { createSessionSummarizer } = freshModule();
      const summarize = createSessionSummarizer(
        `http://127.0.0.1:${srv.port}`,
        'test-gateway-token'
      );
      const result = await summarize(
        [{ direction: 'inbound', content: 'Hello' }],
        { name: 'Bob' }
      );
      assert.equal(receivedPath, '/api/internal/summarize');
      assert.equal(receivedHeaders.authorization, 'Bearer test-gateway-token');
      assert.equal(result.headline, 'Session summary');
    } finally {
      await srv.close();
    }
  });

  test('createSessionSummarizer resolves { summary: null } on connection error', async () => {
    const { createSessionSummarizer } = freshModule();
    const summarize = createSessionSummarizer('http://127.0.0.1:1', 'token');
    const result = await summarize([{ direction: 'inbound', content: 'Hello' }]);
    assert.equal(result.summary, null);
  });

  // ── createAutoSummarizer ──────────────────────────────────────

  test('createAutoSummarizer selects session summarizer when gatewayUrl is set', async () => {
    let requestPath = null;
    const srv = await startMockServer((req, res) => {
      requestPath = req.url;
      let data = '';
      req.on('data', c => data += c);
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ summary: 'ok' }));
      });
    });

    try {
      const { createAutoSummarizer } = freshModule();
      const summarize = createAutoSummarizer({
        gatewayUrl: `http://127.0.0.1:${srv.port}`
      });
      await summarize([{ direction: 'inbound', content: 'Hello' }]);
      assert.equal(requestPath, '/api/internal/summarize');
    } finally {
      await srv.close();
    }
  });

  test('createAutoSummarizer selects HTTP summarizer when summaryEndpoint is provided', async () => {
    let requestPath = null;
    const srv = await startMockServer((req, res) => {
      requestPath = req.url;
      let data = '';
      req.on('data', c => data += c);
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ summary: 'ok' }));
      });
    });

    try {
      const { createAutoSummarizer } = freshModule();
      const summarize = createAutoSummarizer({
        summaryEndpoint: `http://127.0.0.1:${srv.port}/custom/summarize`
      });
      await summarize([{ direction: 'inbound', content: 'Hello' }]);
      assert.equal(requestPath, '/custom/summarize');
    } finally {
      await srv.close();
    }
  });

  test('createAutoSummarizer falls back to exec summarizer when no gateway or endpoint', async () => {
    const dir = makeTmpDir();
    let execCalled = false;
    const restore = mockExecSync(() => {
      execCalled = true;
      return JSON.stringify({ summary: 'exec result' });
    });
    const savedGateway = process.env.OPENCLAW_GATEWAY_URL;
    delete process.env.OPENCLAW_GATEWAY_URL;

    try {
      const { createAutoSummarizer } = freshModule();
      const summarize = createAutoSummarizer({ workspaceDir: dir });
      const result = await summarize([{ direction: 'inbound', content: 'Hello' }]);
      assert.ok(execCalled, 'execSync was called');
      assert.equal(result.summary, 'exec result');
    } finally {
      restore();
      if (savedGateway) process.env.OPENCLAW_GATEWAY_URL = savedGateway;
      else delete process.env.OPENCLAW_GATEWAY_URL;
      rmTmpDir(dir);
    }
  });

};
