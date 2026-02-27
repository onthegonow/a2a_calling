'use strict';

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { setTimeout: delay } = require('timers/promises');
const Database = require('better-sqlite3');
const { A2AClient, TokenStore } = require('a2acalling');

const repoDir = process.argv[2] || '/workspace/a2acalling';
const serverScript = require.resolve('a2acalling/src/server.js');
const children = [];

function log(message, data) {
  if (data) {
    console.log(`[smoke] ${message}`, data);
    return;
  }
  console.log(`[smoke] ${message}`);
}

function attachOutput(prefix, stream) {
  stream.on('data', (chunk) => {
    const text = String(chunk || '');
    for (const line of text.split('\n')) {
      if (line.trim()) {
        console.log(`[${prefix}] ${line}`);
      }
    }
  });
}

function startServer(options) {
  const env = {
    ...process.env,
    A2A_RUNTIME: 'test',
    A2A_CONFIG_DIR: options.configDir,
    A2A_HOSTNAME: `127.0.0.1:${options.port}`,
    A2A_PORT: String(options.port),
    A2A_AGENT_NAME: options.agentName,
    A2A_OWNER_NAME: options.ownerName,
    A2A_LOG_LEVEL: 'debug',
    NODE_ENV: 'test'
    ,
    ...(options.extraEnv || {})
  };

  const child = spawn(process.execPath, [serverScript, String(options.port)], {
    env,
    cwd: repoDir,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  attachOutput(options.name, child.stdout);
  attachOutput(options.name, child.stderr);

  child.on('exit', (code, signal) => {
    log(`${options.name} exited`, { code, signal });
  });

  children.push(child);
  return child;
}

function stopServer(child, timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (!child || child.killed || child.exitCode !== null) {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch (err) {
        // best effort
      }
    }, timeoutMs);

    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });

    try {
      child.kill('SIGTERM');
    } catch (err) {
      clearTimeout(timer);
      resolve();
    }
  });
}

async function stopAllServers() {
  for (const child of children.splice(0, children.length)) {
    await stopServer(child);
  }
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      server.close((err) => {
        if (err) return reject(err);
        resolve(port);
      });
    });
  });
}

async function waitForEndpoint(url, timeoutMs = 30000) {
  const start = Date.now();
  let lastError = null;

  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        return;
      }
      lastError = new Error(`status=${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await delay(250);
  }

  throw new Error(`Timed out waiting for ${url}: ${lastError ? lastError.message : 'unknown error'}`);
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const bodyText = await res.text();
  let json = null;

  try {
    json = bodyText ? JSON.parse(bodyText) : null;
  } catch (err) {
    throw new Error(`Invalid JSON from ${url}: ${bodyText}`);
  }

  return { res, json };
}

function writeSubagentBridgeScript(scriptPath) {
  const source = `'use strict';

const fs = require('fs');

function parseInvite(inviteUrl) {
  const match = String(inviteUrl || '').match(/^a2a:\\/\\/([^/]+)\\/(.+)$/);
  if (!match) {
    throw new Error('Invalid A2A_SUBAGENT_INVITE');
  }
  return { host: match[1], token: match[2] };
}

function resolveHttpParts(host) {
  const isLocalhost = host === 'localhost' || host.startsWith('localhost:') || host.startsWith('127.');
  const hasExplicitPort = host.includes(':');
  const port = hasExplicitPort ? Number.parseInt(host.split(':')[1], 10) : 80;
  const protocol = isLocalhost || port === 80 || (hasExplicitPort && port !== 443) ? 'http' : 'https';
  const hostname = host.split(':')[0];
  return { protocol, hostname, port };
}

async function invokeSubagent(inviteUrl, payload) {
  const { host, token } = parseInvite(inviteUrl);
  const { protocol, hostname, port } = resolveHttpParts(host);
  const traceId = payload?.context?.traceId || payload?.context?.trace_id || '';
  const url = \`\${protocol}://\${hostname}:\${port}/api/a2a/invoke\`;
  const body = {
    message: payload?.message || 'No message provided',
    caller: {
      name: 'smoke-agent-b',
      owner: 'Smoke Owner B',
      instance: 'smoke-subagent-bridge'
    }
  };

  const headers = {
    Authorization: \`Bearer \${token}\`,
    'Content-Type': 'application/json'
  };
  if (traceId) {
    headers['x-trace-id'] = traceId;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : {};
  } catch (err) {
    throw new Error(\`Subagent returned non-JSON response: \${text}\`);
  }

  if (!res.ok || !json.success) {
    throw new Error(\`Subagent invoke failed status=\${res.status} body=\${text}\`);
  }

  const snippet = String(json.response || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
  return {
    subConversationId: json.conversation_id || null,
    snippet
  };
}

async function main() {
  const invite = process.env.A2A_SUBAGENT_INVITE || '';
  if (!invite) {
    throw new Error('A2A_SUBAGENT_INVITE env not set');
  }

  const raw = fs.readFileSync(0, 'utf8');
  const payload = raw ? JSON.parse(raw) : {};
  const result = await invokeSubagent(invite, payload);

  process.stdout.write(
    \`SUBAGENT_OK sub_conv=\${result.subConversationId || 'none'} text=\${result.snippet || 'none'}\`
  );
}

main().catch((err) => {
  const message = err && err.message ? err.message : String(err);
  process.stderr.write(\`subagent bridge failed: \${message}\\n\`);
  process.exit(1);
});
`;

  fs.writeFileSync(scriptPath, source, { mode: 0o755 });
}

async function main() {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-smoke-lane-'));
  const agentAConfig = path.join(runDir, 'agent-a-config');
  const agentBConfig = path.join(runDir, 'agent-b-config');
  const agentCConfig = path.join(runDir, 'agent-c-config');

  fs.mkdirSync(agentAConfig, { recursive: true });
  fs.mkdirSync(agentBConfig, { recursive: true });
  fs.mkdirSync(agentCConfig, { recursive: true });

  const portA = await getFreePort();
  const portB = await getFreePort();
  const portC = await getFreePort();

  const tokenStoreB = new TokenStore(agentBConfig);
  const { token: tokenForAtoB } = tokenStoreB.create({
    name: 'smoke-agent-a-access',
    permissions: 'friends',
    expires: '1d',
    disclosure: 'minimal'
  });

  const tokenStoreC = new TokenStore(agentCConfig);
  const { token: tokenForBtoC } = tokenStoreC.create({
    name: 'smoke-agent-b-access',
    permissions: 'friends',
    expires: '1d',
    disclosure: 'minimal'
  });

  const inviteToB = `a2a://127.0.0.1:${portB}/${tokenForAtoB}`;
  const inviteToC = `a2a://127.0.0.1:${portC}/${tokenForBtoC}`;
  const subagentBridgeScript = path.join(runDir, 'subagent-bridge.js');
  writeSubagentBridgeScript(subagentBridgeScript);

  log('Starting agent servers', { portA, portB, portC, runDir });

  startServer({
    name: 'agent-a',
    port: portA,
    configDir: agentAConfig,
    agentName: 'smoke-agent-a',
    ownerName: 'Smoke Owner A'
  });

  startServer({
    name: 'agent-b',
    port: portB,
    configDir: agentBConfig,
    agentName: 'smoke-agent-b',
    ownerName: 'Smoke Owner B',
    extraEnv: {
      A2A_AGENT_COMMAND: `node ${subagentBridgeScript}`,
      A2A_SUBAGENT_INVITE: inviteToC
    }
  });

  startServer({
    name: 'agent-c',
    port: portC,
    configDir: agentCConfig,
    agentName: 'smoke-agent-c',
    ownerName: 'Smoke Owner C'
  });

  await waitForEndpoint(`http://127.0.0.1:${portA}/api/a2a/ping`);
  await waitForEndpoint(`http://127.0.0.1:${portB}/api/a2a/ping`);
  await waitForEndpoint(`http://127.0.0.1:${portC}/api/a2a/ping`);

  const clientA = new A2AClient({
    timeout: 15000,
    caller: {
      name: 'smoke-agent-a',
      owner: 'Smoke Owner A',
      instance: 'smoke-lane'
    }
  });

  log('Running invoke -> continue -> end flow (with subagent hop)');
  const first = await clientA.call(inviteToB, 'Hello from smoke lane. Please respond with one collaboration idea.');
  assert.strictEqual(first.success, true, 'first call should succeed');
  assert.ok(first.conversation_id, 'first call should return conversation_id');
  assert.ok(
    typeof first.response === 'string' && first.response.includes('SUBAGENT_OK'),
    'first response should come from subagent bridge'
  );

  const conversationId = first.conversation_id;

  const second = await clientA.call(
    inviteToB,
    'Follow-up: summarize in one line what we agreed to do next.',
    { conversationId }
  );
  assert.strictEqual(second.success, true, 'second call should succeed');
  assert.strictEqual(second.conversation_id, conversationId, 'conversation_id should stay stable');
  assert.ok(
    typeof second.response === 'string' && second.response.includes('SUBAGENT_OK'),
    'second response should come from subagent bridge'
  );

  const ended = await clientA.end(inviteToB, conversationId);
  assert.strictEqual(ended.success, true, 'end should succeed');

  log('Injecting invalid-token failure path');
  const invalidInvoke = await fetch(`http://127.0.0.1:${portB}/api/a2a/invoke`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer fed_invalid_smoke_token',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ message: 'this should fail' })
  });
  assert.strictEqual(invalidInvoke.status, 401, 'invalid token invoke should return 401');

  log('Asserting dashboard log APIs');
  const logsByConv = await fetchJson(
    `http://127.0.0.1:${portB}/api/a2a/dashboard/logs?conversation_id=${encodeURIComponent(conversationId)}&limit=250`
  );
  assert.strictEqual(logsByConv.res.status, 200, 'logs by conversation should return 200');
  assert.ok(logsByConv.json && logsByConv.json.success, 'logs by conversation should return success=true');
  assert.ok(Array.isArray(logsByConv.json.logs), 'logs payload should contain logs array');
  assert.ok(logsByConv.json.logs.length > 0, 'logs array should not be empty');

  const traceLog = logsByConv.json.logs.find((entry) => entry.trace_id);
  assert.ok(traceLog, 'at least one log entry should include trace_id');
  const traceId = traceLog.trace_id;

  const logsByTrace = await fetchJson(
    `http://127.0.0.1:${portB}/api/a2a/dashboard/logs/trace/${encodeURIComponent(traceId)}?limit=250`
  );
  assert.strictEqual(logsByTrace.res.status, 200, 'logs by trace should return 200');
  assert.ok(logsByTrace.json && logsByTrace.json.success, 'logs by trace should return success=true');
  assert.ok(logsByTrace.json.logs.length > 0, 'trace logs should not be empty');
  assert.ok(logsByTrace.json.logs.every((entry) => entry.trace_id === traceId), 'trace filter should be strict');

  const logsByError = await fetchJson(
    `http://127.0.0.1:${portB}/api/a2a/dashboard/logs?error_code=TOKEN_INVALID_OR_EXPIRED&limit=50`
  );
  assert.strictEqual(logsByError.res.status, 200, 'logs by error should return 200');
  assert.ok(logsByError.json.logs.length > 0, 'error_code filter should return entries');
  assert.ok(
    logsByError.json.logs.some((entry) => typeof entry.hint === 'string' && entry.hint.toLowerCase().includes('fresh invite token')),
    'error_code logs should include actionable hint'
  );

  const logStats = await fetchJson(`http://127.0.0.1:${portB}/api/a2a/dashboard/logs/stats`);
  assert.strictEqual(logStats.res.status, 200, 'log stats should return 200');
  assert.ok(logStats.json && logStats.json.success, 'log stats should return success=true');
  assert.ok(logStats.json.stats.total > 0, 'stats total should be > 0');

  log('Asserting DB persistence');
  const logDbPath = path.join(agentBConfig, 'a2a-logs.db');
  const convDbPath = path.join(agentBConfig, 'a2a-conversations.db');
  const subagentConvDbPath = path.join(agentCConfig, 'a2a-conversations.db');

  assert.ok(fs.existsSync(logDbPath), 'log db file should exist');
  assert.ok(fs.existsSync(convDbPath), 'conversation db file should exist');
  assert.ok(fs.existsSync(subagentConvDbPath), 'subagent conversation db file should exist');

  const logDb = new Database(logDbPath, { readonly: true });
  const conversationLogs = logDb.prepare('SELECT COUNT(*) AS count FROM logs WHERE conversation_id = ?').get(conversationId);
  assert.ok(conversationLogs.count >= 2, 'conversation should have persisted logs');

  const invalidTokenLog = logDb
    .prepare('SELECT error_code, hint FROM logs WHERE error_code = ? ORDER BY id DESC LIMIT 1')
    .get('TOKEN_INVALID_OR_EXPIRED');
  assert.ok(invalidTokenLog, 'TOKEN_INVALID_OR_EXPIRED should be persisted');
  assert.ok(invalidTokenLog.hint && invalidTokenLog.hint.length > 0, 'error log should include hint');
  logDb.close();

  const convDb = new Database(convDbPath, { readonly: true });
  const conversationRow = convDb
    .prepare('SELECT id, status, message_count FROM conversations WHERE id = ?')
    .get(conversationId);
  assert.ok(conversationRow, 'conversation row should exist');
  assert.strictEqual(conversationRow.status, 'concluded', 'conversation should be concluded');
  assert.ok(conversationRow.message_count >= 4, 'conversation should persist both inbound/outbound messages');

  const messageCountRow = convDb
    .prepare('SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?')
    .get(conversationId);
  assert.ok(messageCountRow.count >= 4, 'messages table should include conversation messages');
  convDb.close();

  const subagentConvDb = new Database(subagentConvDbPath, { readonly: true });
  const subagentConversationCount = subagentConvDb
    .prepare('SELECT COUNT(*) AS count FROM conversations')
    .get()
    .count;
  const subagentMessageCount = subagentConvDb
    .prepare('SELECT COUNT(*) AS count FROM messages')
    .get()
    .count;
  subagentConvDb.close();

  assert.ok(subagentConversationCount >= 1, 'subagent should receive at least one routed conversation');
  assert.ok(subagentMessageCount >= 2, 'subagent should persist routed conversation messages');

  const result = {
    lane: 'smoke',
    ports: { a: portA, b: portB, c: portC },
    conversation_id: conversationId,
    trace_id: traceId,
    logs_found: logsByConv.json.logs.length,
    invalid_token_logs_found: logsByError.json.logs.length,
    stats_total: logStats.json.stats.total,
    subagent_conversations: subagentConversationCount,
    subagent_messages: subagentMessageCount
  };

  fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify(result, null, 2));
  log('PASS', result);
}

main()
  .catch(async (err) => {
    console.error('[smoke] FAIL', err && err.stack ? err.stack : err);
    process.exitCode = 1;
    await stopAllServers();
  })
  .then(async () => {
    await stopAllServers();
  });
