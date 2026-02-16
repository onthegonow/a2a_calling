#!/usr/bin/env node
/**
 * A2A Calling CLI
 * 
 * Usage:
 *   a2a create [options]     Create an A2A token
 *   a2a list                 List active tokens
 *   a2a revoke <id>          Revoke a token
 *   a2a add <url> [name]     Add a contact (alias of "contacts add")
 *   a2a remotes              List contacts (alias of "contacts")
 *   a2a call <url> <msg>     Call a contact (or invite URL)
 *   a2a ping <url>           Ping an invite URL
 *   a2a gui                  Open the local dashboard GUI in a browser
 *   a2a setup                Auto setup (gateway-aware dashboard install)
 *   a2a uninstall            Stop server and remove local A2A config
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { TokenStore } = require('../src/lib/tokens');
const { A2AClient } = require('../src/lib/client');

const CONFIG_DIR = process.env.A2A_CONFIG_DIR || process.env.OPENCLAW_CONFIG_DIR || path.join(os.homedir(), '.config', 'openclaw');
const CONFIG_PATH = path.join(CONFIG_DIR, 'a2a-config.json');
const ONBOARDING_EXEMPT = new Set([
  'quickstart',
  'help',
  'version',
  'status',
  'update',
  'uninstall',
  'onboard',
  'gui',
  'dashboard',
  'server',
  'setup',
  'install'
]);

function isOnboarded() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return config.onboarding?.version === 2 && config.onboarding?.step === 'complete';
  } catch (err) {
    return false;
  }
}

// Lazy load conversation store (requires better-sqlite3)
let convStore = null;
function getConvStore() {
  if (convStore === false) return null; // Already tried and failed
  if (!convStore) {
    try {
      const { ConversationStore } = require('../src/lib/conversations');
      convStore = new ConversationStore();
      if (!convStore.isAvailable()) {
        console.error(`[a2a] ${convStore.getError()}`);
        convStore = false;
        return null;
      }
    } catch (err) {
      convStore = false;
      return null;
    }
  }
  return convStore;
}

const store = new TokenStore();

// Commands that should hard-fail with a clear error when not onboarded,
// rather than falling through to the interactive quickstart flow.
// These are outbound operations often invoked by agents/automation.
const ONBOARDING_HARD_FAIL = new Set([
  'call', 'ping'
]);

// ── enforceOnboarding ────────────────────────────────────────────────────
// If onboarding is incomplete or the config is missing/invalid, run the
// full quickstart flow inline — verbose, with direct stdio. The agent sees
// the banner, port selection, server start, and disclosure prompt right here.
//
// This is the primary onboarding entry point for agents. npm postinstall
// silently starts the server (npm captures its output), so the first time
// the agent runs ANY `a2a` command, this function fires and gives the agent
// the full verbose walkthrough it needs to complete setup.
//
// Returns a Promise if quickstart needs to run (caller must await), or
// undefined if onboarding is already complete.
function enforceOnboarding(command) {
  if (ONBOARDING_EXEMPT.has(command)) {
    return;
  }

  if (!isOnboarded()) {
    // For outbound commands (call, ping, status), fail immediately with
    // a clear error instead of dumping onboarding prompts. This prevents
    // calling agents from receiving walls of setup instructions.
    if (ONBOARDING_HARD_FAIL.has(command)) {
      console.error('❌ Onboarding not complete. Run `a2a quickstart` first to set up your agent.');
      process.exit(1);
    }

    // Run the full quickstart flow inline — verbose output, direct stdio.
    // This replaces the original command; after onboarding the agent can
    // re-run their intended command.
    return commands.quickstart({ flags: {}, positional: [] });
  }
}

// Format relative time
function formatTimeAgo(date) {
  const seconds = Math.floor((new Date() - date) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
}

function openInBrowser(url) {
  const platform = process.platform;
  let cmd = null;
  let args = [];

  if (platform === 'darwin') {
    cmd = 'open';
    args = [url];
  } else if (platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '', url];
  } else {
    cmd = 'xdg-open';
    args = [url];
  }

  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.unref();
    return { attempted: true, command: [cmd, ...args].join(' ') };
  } catch (err) {
    return { attempted: false, error: err.message };
  }
}

function findNativeApp() {
  if (os.platform() !== 'darwin') return null;

  const candidates = [
    path.join(os.homedir(), 'Applications', 'A2A Callbook.app'),
    '/Applications/A2A Callbook.app',
  ];

  for (const appPath of candidates) {
    try {
      if (fs.existsSync(appPath)) return appPath;
    } catch (_) {}
  }

  return null;
}

async function findLocalServerPort(preferredPorts = []) {
  const http = require('http');

  const candidates = [];
  const seen = new Set();
  for (const port of preferredPorts) {
    const n = Number.parseInt(String(port), 10);
    if (!Number.isFinite(n) || n <= 0 || n > 65535) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    candidates.push(n);
  }

  const defaultPorts = [3001, 80, 8080, 8443, 9001];
  for (const port of defaultPorts) {
    if (seen.has(port)) continue;
    seen.add(port);
    candidates.push(port);
  }

  const probe = (port) => new Promise(resolve => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/a2a/ping',
      method: 'GET',
      timeout: 800
    }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });

  for (const port of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await probe(port);
    if (ok) return port;
  }
  return null;
}

// Parse arguments
function parseArgs(argv) {
  const args = { _: [], flags: {} };
  let i = 2;
  while (i < argv.length) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : true;
      args.flags[key] = val;
    } else if (argv[i].startsWith('-') && argv[i].length === 2) {
      const key = argv[i].slice(1);
      const val = argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : true;
      args.flags[key] = val;
    } else {
      args._.push(argv[i]);
    }
    i++;
  }
  return args;
}

async function promptYesNo(question) {
  const q = String(question || '');
  // Support both bracket and paren styles: [Y/n], (y/N), etc.
  // Convention: uppercase letter is the default when user presses Enter.
  const defaultValue = q.includes('y/N')
    ? false
    : q.includes('Y/n')
      ? true
      : true;

  if (!isInteractiveShell()) {
    return defaultValue;
  }

  return await new Promise(resolve => {
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      const normalized = String(answer || '').trim().toLowerCase();
      if (!normalized) return resolve(defaultValue);
      resolve(normalized === 'y' || normalized === 'yes');
    });
  });
}

function isInteractiveShell() {
  return Boolean(process.stdin && process.stdout && process.stdin.isTTY && process.stdout.isTTY);
}

async function promptText(question, defaultValue = '') {
  if (!isInteractiveShell()) {
    return defaultValue;
  }
  return await new Promise(resolve => {
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      const cleaned = String(answer || '').trim();
      resolve(cleaned || defaultValue);
    });
  });
}

function parsePort(raw, fallback = null) {
  const parsed = Number.parseInt(String(raw || '').trim(), 10);
  if (Number.isFinite(parsed) && parsed > 0 && parsed <= 65535) {
    return parsed;
  }
  return fallback;
}

function printStepHeader(label) {
  const clean = String(label || '').trim();
  const innerWidth = Math.max(62, clean.length + 12);
  const padding = Math.max(0, innerWidth - clean.length);
  const left = Math.floor(padding / 2);
  const right = Math.max(0, padding - left);
  console.log('\n' + '╔' + '═'.repeat(innerWidth) + '╗');
  console.log(`║${' '.repeat(left)}${clean}${' '.repeat(right)}║`);
  console.log('╚' + '═'.repeat(innerWidth) + '╝');
}

function printSection(title) {
  console.log('\n━━━ ' + title + ' ━━━');
}

async function inspectPorts(preferredPort = null) {
  const candidates = [];
  if (preferredPort) {
    candidates.push(preferredPort);
  }
  candidates.push(80);
  for (let p = 3001; p < 3021; p += 1) {
    if (!candidates.includes(p)) candidates.push(p);
  }

  const { tryBindPort } = require('../src/lib/port-scanner');
  const results = [];
  for (const port of candidates) {
    const r = await tryBindPort(port);
    results.push({
      port,
      available: Boolean(r.ok),
      blocked: !r.ok && r.code === 'EACCES',
      code: r.code || null
    });
  }
  return results;
}

function summarizePortResults(portResults) {
  return portResults.map(item => {
    if (item.available) return `Port ${item.port}: available ✓`;
    if (item.blocked) return `Port ${item.port}: requires elevated privileges`;
    return `Port ${item.port}: in use`;
  });
}

/**
 * Identify what process is using a given port.
 * Returns { pid, name } or null if detection fails.
 */
function identifyPortProcess(port) {
  const p = Number(port);
  if (!Number.isFinite(p) || p <= 0) return null;
  const { execSync } = require('child_process');
  // Try lsof first (most common on Linux/macOS)
  try {
    const out = execSync(`lsof -i :${p} -sTCP:LISTEN -t 2>/dev/null`, { encoding: 'utf8', timeout: 5000 }).trim();
    if (out) {
      const pid = out.split('\n')[0].trim();
      let name = 'unknown';
      try {
        name = execSync(`ps -p ${pid} -o comm= 2>/dev/null`, { encoding: 'utf8', timeout: 3000 }).trim();
      } catch (e) { /* best-effort */ }
      return { pid: Number(pid), name };
    }
  } catch (e) { /* lsof not available or failed */ }

  // Fallback: ss (Linux)
  try {
    const out = execSync(`ss -tlnp 'sport = :${p}' 2>/dev/null`, { encoding: 'utf8', timeout: 5000 });
    const pidMatch = out.match(/pid=(\d+)/);
    const nameMatch = out.match(/\("([^"]+)"/);
    if (pidMatch) {
      return { pid: Number(pidMatch[1]), name: nameMatch ? nameMatch[1] : 'unknown' };
    }
  } catch (e) { /* ss not available */ }

  return null;
}

/**
 * When port 80 is unavailable, prompt the user with fallback options.
 * Returns { strategy: 'kill' | 'proxy' | 'continue', port: number }
 *
 * Non-interactive: auto-returns 'continue' with a printed warning.
 */
async function promptPortFallbackStrategy(fallbackPort, interactive) {
  const processInfo = identifyPortProcess(80);

  console.log('\n  ┌─────────────────────────────────────────────────────────────────┐');
  console.log('  │  ⚠  PORT 80 IS UNAVAILABLE                                     │');
  console.log('  └─────────────────────────────────────────────────────────────────┘');
  console.log('');
  if (processInfo) {
    console.log(`  Port 80 is held by: ${processInfo.name} (PID ${processInfo.pid})`);
  } else {
    console.log('  Port 80 is in use by another process (could not identify).');
  }
  console.log('');
  console.log('  Why this matters:');
  console.log('    - Port 80 is the default HTTP port — no firewall config needed');
  console.log(`    - Fallback port ${fallbackPort} may be blocked by the caller's firewall`);
  console.log(`    - If the server restarts on a different port, all invite URLs break`);
  console.log(`    - Invite URLs with non-standard ports look like: a2a://host:${fallbackPort}/token`);
  console.log('');

  if (!interactive) {
    console.log(`  Non-interactive mode: continuing on port ${fallbackPort}.`);
    console.log('  Set up a reverse proxy (port 80 → ' + fallbackPort + ') for production use.\n');
    return { strategy: 'continue', port: fallbackPort };
  }

  console.log('  Options:');
  if (processInfo) {
    console.log(`    1) Kill ${processInfo.name} (PID ${processInfo.pid}) and use port 80`);
  } else {
    console.log('    1) Kill the process on port 80 and retry');
  }
  console.log(`    2) Set up a reverse proxy (port 80 → ${fallbackPort})`);
  console.log(`    3) Continue on port ${fallbackPort} (not recommended for production)`);
  console.log('');

  const choice = await promptText('  Choose [1/2/3]: ', '2');
  const normalized = String(choice).trim();

  if (normalized === '1') {
    return { strategy: 'kill', port: 80, processInfo };
  } else if (normalized === '3') {
    console.log(`\n  ⚠  Continuing on port ${fallbackPort}.`);
    console.log(`     Invite URLs will include :${fallbackPort} and may not be reachable externally.`);
    console.log('     You can set up a reverse proxy later with: a2a config --help\n');
    return { strategy: 'continue', port: fallbackPort };
  } else {
    // Default: reverse proxy (option 2)
    return { strategy: 'proxy', port: fallbackPort };
  }
}

/**
 * Attempt to kill the process on a given port.
 * Returns true if kill succeeded and port is now available.
 */
async function killPortProcess(processInfo) {
  if (!processInfo || !Number.isFinite(processInfo.pid)) return false;
  const { execSync } = require('child_process');
  try {
    console.log(`  Killing ${processInfo.name} (PID ${processInfo.pid})...`);
    execSync(`kill ${processInfo.pid}`, { timeout: 5000 });
    // Wait briefly for the port to free up
    await new Promise(r => setTimeout(r, 1000));
    const { tryBindPort } = require('../src/lib/port-scanner');
    const result = await tryBindPort(80);
    if (result.ok) {
      console.log('  ✅ Port 80 is now available.');
      return true;
    }
    console.log('  Port 80 is still in use after kill. The process may require sudo to stop.');
    return false;
  } catch (e) {
    console.log(`  Could not kill process: ${e.message}`);
    console.log('  You may need to run: sudo kill ' + processInfo.pid);
    return false;
  }
}

/**
 * Detect installed web servers and generate reverse proxy config.
 * Returns { hasNginx, hasCaddy, nginxConfig, caddyConfig }.
 */
function generateProxyConfig(backendPort) {
  const { spawnSync } = require('child_process');
  const hasNginx = spawnSync('which', ['nginx'], { encoding: 'utf8' }).status === 0;
  const hasCaddy = spawnSync('which', ['caddy'], { encoding: 'utf8' }).status === 0;

  const nginxConfig = [
    '# ══════════════════════════════════════════════════════════════',
    '# A2A (Agent-to-Agent) Protocol Proxy',
    '# ══════════════════════════════════════════════════════════════',
    '# Routes federation requests from port 80 to the local',
    `# A2A server on port ${backendPort}.`,
    '#',
    '# Protocol: https://github.com/onthegonow/a2a_calling',
    '# All requests to /api/a2a/* are agent-to-agent API calls.',
    '# ══════════════════════════════════════════════════════════════',
    'location /api/a2a/ {',
    `    proxy_pass http://127.0.0.1:${backendPort}/api/a2a/;`,
    '    proxy_http_version 1.1;',
    '    proxy_set_header Host $host;',
    '    proxy_set_header X-Real-IP $remote_addr;',
    '    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
    '    proxy_set_header X-Forwarded-Proto $scheme;',
    '}'
  ].join('\n');

  const caddyConfig = [
    '# A2A (Agent-to-Agent) Protocol Proxy',
    `# Routes federation requests to local A2A server on port ${backendPort}`,
    '# Protocol: https://github.com/onthegonow/a2a_calling',
    'handle /api/a2a/* {',
    `    reverse_proxy 127.0.0.1:${backendPort}`,
    '}'
  ].join('\n');

  return { hasNginx, hasCaddy, nginxConfig, caddyConfig };
}

function extractNameFromPersonality(notes) {
  if (!notes || typeof notes !== 'string') return null;
  const patterns = [
    /(?:I'm|I am|My name is|Name:|Owner:)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/,
    /^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:is|here|speaking)/
  ];
  for (const p of patterns) {
    const m = notes.match(p);
    if (m && m[1]) return m[1].trim();
  }
  return null;
}

async function handleDisclosureSubmit(args, commandLabel = 'onboard') {
  const submitRaw = args.flags.submit;
  if (!submitRaw) return false;

  const { A2AConfig } = require('../src/lib/config');
  const {
    validateDisclosureSubmission,
    saveManifest,
    MANIFEST_FILE
  } = require('../src/lib/disclosure');

  const config = new A2AConfig();
  const submitCommand = commandLabel === 'quickstart'
    ? 'a2a quickstart --submit'
    : 'a2a onboard --submit';

  let parsed;
  try {
    parsed = JSON.parse(String(submitRaw));
  } catch (e) {
    console.error('\nInvalid JSON in --submit flag.');
    console.error(`  Parse error: ${e.message}\n`);
    process.exit(1);
  }

  const result = validateDisclosureSubmission(parsed);
  if (!result.valid) {
    console.error('\nDisclosure submission validation failed:\n');
    result.errors.forEach(err => console.error(`  - ${err}`));
    console.error(`\nFix the errors above and resubmit with: ${submitCommand} '<json>'\n`);
    process.exit(1);
  }

  saveManifest(result.manifest);
  console.log('\nStep 3 of 4: Disclosure manifest saved.');
  console.log(`  Manifest: ${MANIFEST_FILE}`);

  // Sync tier config from manifest
  const manifest = result.manifest;
  
  // Helper to extract topic names
  function getTierTopics(tierData) {
    if (!tierData || !Array.isArray(tierData.topics)) return [];
    return tierData.topics.map(t => String(t && t.topic || '').trim()).filter(Boolean);
  }

  const tiersData = manifest.tiers || {};

  // Derive goals from disclosure objectives (used in tier config and token creation)
  const disclosureObjectives = (tiersData.public?.objectives || [])
    .map(o => typeof o === 'string' ? o : (o && o.objective || ''))
    .map(s => s.trim().toLowerCase().replace(/\s+/g, '-').slice(0, 60))
    .filter(Boolean);

  const tokenGoals = disclosureObjectives.length > 0
    ? [...new Set(disclosureObjectives)].slice(0, 5)
    : ['grow-network', 'find-collaborators', 'build-in-public'];

  try {
    config.setTier('public', {
      topics: getTierTopics(tiersData.public),
      goals: tokenGoals,
      disclosure: 'minimal'
    });
    config.setTier('friends', {
      topics: [...getTierTopics(tiersData.public), ...getTierTopics(tiersData.friends)],
      disclosure: 'standard'
    });
    config.setTier('family', {
      topics: [...getTierTopics(tiersData.public), ...getTierTopics(tiersData.friends), ...getTierTopics(tiersData.family)],
      disclosure: 'full'
    });
  } catch (err) {
    console.error(`  Warning: could not sync tier config: ${err.message}`);
  }

  // If already onboarded, this is a topic update — no invite generation needed
  if (config.isOnboarded()) {
    console.log('\nDisclosure topics updated. Your agent will use these on the next inbound call.\n');
    return true;
  }

  console.log('\nStep 4 of 4: Generating your first invite...\n');

  // Extract identity from disclosure submission (parsed = raw JSON, result = validated)
  const ownerName = parsed.owner_name
    || extractNameFromPersonality(result.manifest?.personality_notes)
    || process.env.USER
    || 'Agent Owner';

  const agentName = args.flags.name
    || parsed.agent_name
    || config.getAgent().name
    || process.env.A2A_AGENT_NAME
    || `${ownerName}'s Agent`;

  // Save identity to config
  config.setAgent({ name: agentName, owner_name: ownerName });

  const hostname = config.getAgent().hostname || process.env.A2A_HOSTNAME || 'localhost';

  const publicTopics = getTierTopics(tiersData.public);

  const { token } = store.create({
    name: agentName,
    owner: ownerName,
    permissions: 'public',
    disclosure: 'minimal',
    expires: 'never',
    maxCalls: null,
    allowedTopics: publicTopics,
    allowedGoals: tokenGoals,
    notify: 'all'
  });

  const inviteUrl = `a2a://${hostname}/${token}`;
  console.log(`  Invite URL: ${inviteUrl}`);
  console.log('  Share this invite to let other agents call you.\n');

  config.completeOnboarding();
  console.log('Onboarding complete.\n');
  console.log(`  Config: ${CONFIG_PATH}`);
  console.log(`  Disclosure: ${MANIFEST_FILE}`);
  console.log(`  Invite: ${inviteUrl}\n`);

  return true;
}

async function resolveInviteHostname() {
  const { resolveInviteHost } = require('../src/lib/invite-host');

  try {
    const { A2AConfig } = require('../src/lib/config');
    const config = new A2AConfig();
    const agent = config.getAgent() || {};
    const onboarding = config.getAll().onboarding || {};
    
    // If hostname is set without a port (e.g., "149.28.213.47"), assume port 80 
    // (user configured reverse proxy or direct bind to 80)
    // If hostname has a port (e.g., "149.28.213.47:3007"), use that port
    // If no hostname set, use server_port from onboarding
    const hostname = agent.hostname || '';
    const hasExplicitPort = hostname.includes(':') && !hostname.startsWith('[');
    
    let defaultPort;
    if (hasExplicitPort) {
      defaultPort = null; // Will be parsed from hostname
    } else if (hostname && !hostname.includes('localhost')) {
      // External hostname without port = assume port 80 (reverse proxy or direct)
      defaultPort = 80;
    } else {
      // Local or no hostname - use actual server port
      defaultPort = onboarding.server_port || process.env.PORT || process.env.A2A_PORT || 80;
    }
    
    const resolved = await resolveInviteHost({
      config,
      defaultPort
    });
    return resolved;
  } catch (err) {
    return resolveInviteHost({
      fallbackHost: process.env.OPENCLAW_HOSTNAME || process.env.HOSTNAME || 'localhost',
      defaultPort: process.env.PORT || process.env.A2A_PORT || 80
    });
  }
}

// Commands
const commands = {
  create: async (args) => {
    const { A2AConfig } = require('../src/lib/config');
    const { loadManifest, getTopicsForTier } = require('../src/lib/disclosure');
    const config = new A2AConfig();
    
    // Parse max-calls: number, 'unlimited', or default (unlimited)
    let maxCalls = null; // Default: unlimited
    if (args.flags['max-calls']) {
      if (args.flags['max-calls'] === 'unlimited') {
        maxCalls = null;
      } else {
        maxCalls = parseInt(args.flags['max-calls']) || null;
      }
    }

    // Get tier from --tier or --permissions flag
    const tier = args.flags.tier || args.flags.t || args.flags.permissions || args.flags.p || 'public';
    
    // Get owner from flag or config
    const configAgent = config.getAgent() || {};
    const ownerName = args.flags.owner || args.flags.o || configAgent.owner || configAgent.name || null;
    
    // Get topics from disclosure manifest based on tier (with inheritance)
    const tierTopics = getTopicsForTier(tier);
    
    // Parse custom topics if provided, otherwise use tier topics
    let allowedTopics;
    if (args.flags.topics) {
      allowedTopics = args.flags.topics.split(',').map(t => t.trim());
    } else if (tierTopics.topics && tierTopics.topics.length > 0) {
      allowedTopics = tierTopics.topics.map(t => t.topic || t);
    } else {
      allowedTopics = null;
    }
    
    // Get objectives from disclosure
    const objectives = tierTopics.objectives || [];

    const { token, record } = store.create({
      name: args.flags.name || args.flags.n || 'unnamed',
      owner: ownerName,
      expires: args.flags.expires || args.flags.e || 'never',
      permissions: tier,
      disclosure: args.flags.disclosure || args.flags.d || 'minimal',
      notify: args.flags.notify || 'all',
      maxCalls,
      allowedTopics,
      allowedGoals: objectives.map(o => o.objective || o)
    });

    const resolvedHost = await resolveInviteHostname();
    const hostname = resolvedHost.host;
    const inviteUrl = `a2a://${hostname}/${token}`;

    const expiresText = record.expires_at 
      ? new Date(record.expires_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : 'never';

    if (resolvedHost.warnings && resolvedHost.warnings.length) {
      for (const w of resolvedHost.warnings) {
        console.warn(`\n⚠️  ${w}`);
      }
      console.warn('');
    }

    // Auto-link to contact if specified
    const linkContact = args.flags.link || args.flags.l;
    if (linkContact) {
      const linkResult = store.linkTokenToContact(linkContact, record.id);
      if (linkResult.success) {
        console.log(`✅ Token created & linked to ${linkContact}\n`);
      } else {
        console.log(`✅ Token created (link failed: ${linkResult.error})\n`);
      }
    } else {
      console.log(`✅ A2A token created\n`);
    }
    
    console.log(`Name: ${record.name}`);
    if (record.owner) console.log(`Owner: ${record.owner}`);
    console.log(`Expires: ${record.expires_at || 'never'}`);
    console.log(`Tier: ${record.tier}`);
    console.log(`Topics: ${record.allowed_topics.join(', ')}`);
    console.log(`Disclosure: ${record.disclosure}`);
    console.log(`Notify: ${record.notify}`);
    console.log(`Max calls: ${record.max_calls || 'unlimited'}`);
    if (linkContact) console.log(`Linked to: ${linkContact}`);
    console.log(`\nTo revoke: a2a revoke ${record.id}`);
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`📋 SHAREABLE INVITE (copy everything below):`);
    console.log(`${'─'.repeat(50)}\n`);
    
    // Get agent name from config (reuse configAgent from earlier)
    const myAgentName = configAgent.name || 'my agent';
    const ownerText = record.owner;
    
    // Format topics as bullet list
    const topicsArray = record.allowed_topics || [];
    const topicsList = topicsArray.length > 0 
      ? topicsArray.map(t => `  • ${t}`).join('\n')
      : '';
    
    // Format objectives as bullet list
    const goalsArray = record.allowed_goals || [];
    const goalsList = goalsArray.length > 0
      ? goalsArray.map(g => `  • ${g}`).join('\n')
      : '';

    // Build invite header
    const inviteHeader = ownerText 
      ? `**${ownerText}** invites you to connect with their agent **${myAgentName}**`
      : `You're invited to connect with **${myAgentName}**`;

    const invite = `🤝 **Agent-to-Agent Invite**

${inviteHeader}

\`\`\`
${inviteUrl}
\`\`\`
${topicsList ? `\n💬 **Topics:**\n${topicsList}\n` : ''}${goalsList ? `\n🎯 **Goals:**\n${goalsList}\n` : ''}${expiresText !== 'never' ? `⏰ Expires: ${expiresText}\n` : ''}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📦 **Getting Started**

**1️⃣ Install**
\`\`\`
npm install -g a2acalling
\`\`\`

**2️⃣ Quick Setup** _(first time only)_
\`\`\`
a2a quickstart
\`\`\`

**3️⃣ Add Contact**
\`\`\`
a2a add "${inviteUrl}" "${ownerText || 'friend'}"
\`\`\`

**4️⃣ Say Hello!**
\`\`\`
a2a call "${ownerText || 'friend'}" "Hello! My owner asked me to reach out."
\`\`\`

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

⚡ **One-liner** _(already set up?)_
\`\`\`
a2a add "${inviteUrl}" "${ownerText || 'friend'}" && a2a call "${ownerText || 'friend'}" "Hello!"
\`\`\`

🔗 Docs: https://github.com/onthegonow/a2a_calling`;

    console.log(invite);
    console.log(`\n${'─'.repeat(50)}`);
  },

  list: () => {
    const tokens = store.list();
    if (tokens.length === 0) {
      console.log('No active A2A tokens.');
      return;
    }

    console.log('Active A2A tokens:\n');
    for (const t of tokens) {
      const expired = t.expires_at && new Date(t.expires_at) < new Date();
      const status = expired ? '⚠️  EXPIRED' : '✅ Active';
      const tier = t.tier || 'public';
      const topics = t.allowed_topics || ['chat'];
      console.log(`${status}  ${t.id}`);
      console.log(`   Name: ${t.name}`);
      console.log(`   Tier: ${tier} → ${topics.join(', ')}`);
      console.log(`   Expires: ${t.expires_at || 'never'}`);
      console.log(`   Calls: ${t.calls_made}${t.max_calls ? '/' + t.max_calls : ''}`);
      console.log();
    }
  },

  revoke: (args) => {
    const id = args._[1];
    if (!id) {
      console.error('Usage: a2a revoke <token_id>');
      process.exit(1);
    }

    const result = store.revoke(id);
    if (!result.success) {
      console.error(`Token not found: ${id}`);
      process.exit(1);
    }

    console.log(`✅ Token revoked: ${result.record.name} (${result.record.id})`);
  },

  add: (args) => {
    const url = args._[1];
    const name = args._[2] || args.flags.name;
    
    if (!url) {
      console.error('Usage: a2a add <invite_url> [name]');
      process.exit(1);
    }

    try {
      const result = store.addContact(url, { name });
      if (!result.success) {
        console.log(`Contact already registered: ${result.existing.name}`);
        return;
      }
      console.log(`✅ Contact added: ${result.contact.name} (${result.contact.host})`);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  },

  remotes: () => {
    // Alias for contacts
    commands.contacts({ _: ['contacts'], flags: {} });
  },

  contacts: (args) => {
    const subcommand = args._[1];
    
    // Sub-commands
    if (subcommand === 'add') return commands['contacts:add'](args);
    if (subcommand === 'show') return commands['contacts:show'](args);
    if (subcommand === 'edit') return commands['contacts:edit'](args);
    if (subcommand === 'ping') return commands['contacts:ping'](args);
    if (subcommand === 'link') return commands['contacts:link'](args);
    if (subcommand === 'rm' || subcommand === 'remove') return commands['contacts:rm'](args);

    // Default: list contacts
    const contacts = store.listContacts();
    if (contacts.length === 0) {
      console.log('📇 No contacts yet.\n');
      console.log('Add one with: a2a contacts add <invite_url>');
      return;
    }

    console.log(`📇 Agent Contacts (${contacts.length})\n`);
    for (const r of contacts) {
      const statusIcon = r.status === 'online' ? '🟢' : r.status === 'offline' ? '🔴' : '⚪';
      const ownerText = r.owner ? ` — ${r.owner}` : '';
      
      // Permission badge from linked token (what YOU gave THEM)
      let permBadge = '';
      if (r.linked_token) {
        const tier = r.linked_token.tier || 'public';
        permBadge = tier === 'family' ? ' ⚡' : tier === 'friends' ? ' 🔧' : ' 🌐';
      }
      
      console.log(`${statusIcon} ${r.name}${ownerText}${permBadge}`);
      if (r.tags && r.tags.length > 0) {
        console.log(`   🏷️  ${r.tags.join(', ')}`);
      }
      if (r.last_seen) {
        const ago = formatTimeAgo(new Date(r.last_seen));
        console.log(`   📍 Last seen: ${ago}`);
      }
      console.log();
    }
    
    console.log('Legend: 🌐 public  🔧 friends  ⚡ family');
  },

  'contacts:add': (args) => {
    const url = args._[2];
    if (!url) {
      console.error('Usage: a2a contacts add <invite_url> [options]');
      console.error('Options:');
      console.error('  --name, -n     Agent name');
      console.error('  --owner, -o    Owner name');
      console.error('  --server-name  Server label (optional)');
      console.error('  --notes        Notes about this contact');
      console.error('  --tags         Comma-separated tags');
      console.error('  --link         Link to token ID you gave them');
      process.exit(1);
    }

    const options = {
      name: args.flags.name || args.flags.n,
      owner: args.flags.owner || args.flags.o,
      server_name: args.flags['server-name'] || args.flags.server_name || args.flags.serverName || null,
      notes: args.flags.notes,
      tags: args.flags.tags ? args.flags.tags.split(',').map(t => t.trim()) : [],
      linkedTokenId: args.flags.link || null
    };

    try {
      const result = store.addContact(url, options);
      if (!result.success) {
        console.log(`Contact already exists: ${result.existing.name}`);
        return;
      }
      console.log(`✅ Contact added: ${result.contact.name}`);
      if (result.contact.owner) console.log(`   Owner: ${result.contact.owner}`);
      if (result.contact.server_name) console.log(`   Server: ${result.contact.server_name}`);
      console.log(`   Host: ${result.contact.host}`);
      if (options.linkedTokenId) {
        console.log(`   Linked to token: ${options.linkedTokenId}`);
      } else {
        console.log(`\n💡 Link a token: a2a contacts link ${result.contact.name} <token_id>`);
      }
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  },

  'contacts:show': (args) => {
    const name = args._[2];
    if (!name) {
      console.error('Usage: a2a contacts show <name>');
      process.exit(1);
    }

    // Get contact with linked token info
    const contacts = store.listContacts();
    const remote = contacts.find(r => r.name === name || r.id === name);
    if (!remote) {
      console.error(`Contact not found: ${name}`);
      process.exit(1);
    }

    const statusIcon = remote.status === 'online' ? '🟢' : remote.status === 'offline' ? '🔴' : '⚪';

    console.log(`\n${'═'.repeat(50)}`);
    console.log(`${statusIcon} ${remote.name}`);
    console.log(`${'═'.repeat(50)}\n`);
    
    if (remote.owner) console.log(`👤 Owner: ${remote.owner}`);
    console.log(`🌐 Host: ${remote.host}`);
    
    // Show linked token (permissions you gave them)
    if (remote.linked_token) {
      const t = remote.linked_token;
      const tier = t.tier || 'public';
      const topics = t.allowed_topics || ['chat'];
      const tierIcon = tier === 'family' ? '⚡' : tier === 'friends' ? '🔧' : '🌐';
      console.log(`🔐 Your token to them: ${t.id}`);
      console.log(`   Tier: ${tierIcon} ${tier}`);
      console.log(`   Topics: ${topics.join(', ')}`);
      console.log(`   Calls: ${t.calls_made}${t.max_calls ? '/' + t.max_calls : ''}`);
      if (t.revoked) console.log(`   ⚠️  REVOKED`);
    } else {
      console.log(`🔐 No linked token (you haven't given them access yet)`);
    }
    
    if (remote.tags && remote.tags.length > 0) {
      console.log(`🏷️  Tags: ${remote.tags.join(', ')}`);
    }
    if (remote.notes) {
      console.log(`📝 Notes: ${remote.notes}`);
    }
    
    console.log(`\n📅 Added: ${new Date(remote.added_at).toLocaleDateString()}`);
    if (remote.last_seen) {
      console.log(`📍 Last seen: ${formatTimeAgo(new Date(remote.last_seen))}`);
    }
    if (remote.last_check) {
      console.log(`🔄 Last check: ${formatTimeAgo(new Date(remote.last_check))}`);
    }

    console.log(`\n${'─'.repeat(50)}`);
    console.log(`Quick actions:`);
    console.log(`  a2a contacts ping ${name}`);
    console.log(`  a2a call ${name} "Hello!"`);
    if (!remote.linked_token) {
      console.log(`  a2a contacts link ${name} <token_id>`);
    }
    console.log(`${'─'.repeat(50)}\n`);
  },

  'contacts:edit': (args) => {
    const name = args._[2];
    if (!name) {
      console.error('Usage: a2a contacts edit <name> [options]');
      console.error('Options:');
      console.error('  --name         New name');
      console.error('  --owner        Owner name');
      console.error('  --server-name  Server label');
      console.error('  --notes        Notes');
      console.error('  --tags         Comma-separated tags');
      process.exit(1);
    }

    const updates = {};
    if (args.flags.name) updates.name = args.flags.name;
    if (args.flags.owner) updates.owner = args.flags.owner;
    if (args.flags['server-name'] || args.flags.server_name || args.flags.serverName) updates.server_name = args.flags['server-name'] || args.flags.server_name || args.flags.serverName;
    if (args.flags.notes) updates.notes = args.flags.notes;
    if (args.flags.tags) updates.tags = args.flags.tags.split(',').map(t => t.trim());

    if (Object.keys(updates).length === 0) {
      console.error('No updates specified. Use --name, --owner, --notes, or --tags');
      process.exit(1);
    }

    const result = store.updateContact(name, updates);
    if (!result.success) {
      console.error(`Contact not found: ${name}`);
      process.exit(1);
    }

    console.log(`✅ Contact updated: ${(result.contact || result.remote).name}`);
  },

  'contacts:link': (args) => {
    const contactName = args._[2];
    const tokenId = args._[3];
    
    if (!contactName || !tokenId) {
      console.error('Usage: a2a contacts link <contact_name> <token_id>');
      console.error('\nLinks a token you created to a contact, showing what access they have.');
      console.error('\nExample:');
      console.error('  a2a contacts link Alice tok_abc123');
      process.exit(1);
    }

    const result = store.linkTokenToContact(contactName, tokenId);
    if (!result.success) {
      if (result.error === 'contact_not_found') {
        console.error(`Contact not found: ${contactName}`);
      } else if (result.error === 'token_not_found') {
        console.error(`Token not found: ${tokenId}`);
      }
      process.exit(1);
    }

    const permLabel = result.token.tier === 'family' ? '⚡ family' :
                      result.token.tier === 'friends' ? '🔧 friends' : '🌐 public';
    
    console.log(`✅ Linked token to contact`);
    console.log(`   Contact: ${result.contact?.name || result.remote.name}`);
    console.log(`   Token: ${result.token.id} (${result.token.name})`);
    console.log(`   Permissions: ${permLabel}`);
  },

  'contacts:ping': async (args) => {
    const name = args._[2];
    if (!name) {
      console.error('Usage: a2a contacts ping <name>');
      process.exit(1);
    }

    const remote = store.getContact(name);
    if (!remote) {
      console.error(`Contact not found: ${name}`);
      process.exit(1);
    }

    const client = new A2AClient({});
    const url = `a2a://${remote.host}/${remote.token}`;

    console.log(`🔍 Pinging ${remote.name}...`);

    try {
      const result = await client.ping(url);
      store.updateContactStatus(name, 'online');
      console.log(`🟢 ${remote.name} is online`);
      console.log(`   Agent: ${result.name}`);
      console.log(`   Version: ${result.version}`);
    } catch (err) {
      store.updateContactStatus(name, 'offline', err.message);
      console.log(`🔴 ${remote.name} is offline`);
      console.log(`   Error: ${err.message}`);
    }
  },

  'contacts:rm': (args) => {
    const name = args._[2];
    if (!name) {
      console.error('Usage: a2a contacts rm <name>');
      process.exit(1);
    }

    const result = store.removeContact(name);
    if (!result.success) {
      console.error(`Contact not found: ${name}`);
      process.exit(1);
    }

    console.log(`✅ Contact removed: ${(result.contact || result.remote).name}`);
  },

  // ========== CONVERSATIONS ==========

  conversations: (args) => {
    const subcommand = args._[1];
    
    if (subcommand === 'show') return commands['conversations:show'](args);
    if (subcommand === 'end') return commands['conversations:end'](args);

    // Default: list conversations
    const cs = getConvStore();
    if (!cs) {
      console.log('💬 Conversation storage not available.');
      console.log('Install: npm install better-sqlite3');
      return;
    }

    const { contact, status, limit = 20 } = args.flags;
    const conversations = cs.listConversations({
      contactId: contact,
      status,
      limit: parseInt(limit),
      includeMessages: true,
      messageLimit: 1
    });

    if (conversations.length === 0) {
      console.log('💬 No conversations yet.');
      return;
    }

    console.log(`💬 Conversations (${conversations.length})\n`);
    for (const conv of conversations) {
      const statusIcon = conv.status === 'concluded' ? '✅' : conv.status === 'timeout' ? '⏱️' : '💬';
      const timeAgo = formatTimeAgo(new Date(conv.last_message_at));
      const preview = conv.messages?.[0]?.content?.slice(0, 50) || '';
      
      console.log(`${statusIcon} ${conv.id}`);
      console.log(`   Contact: ${conv.contact_name || conv.contact_id || 'unknown'}`);
      console.log(`   Messages: ${conv.message_count} | ${timeAgo}`);
      if (conv.summary) {
        console.log(`   Summary: ${conv.summary.slice(0, 80)}...`);
      } else if (preview) {
        console.log(`   Preview: "${preview}..."`);
      }
      if (conv.owner_relevance) {
        console.log(`   Relevance: ${conv.owner_relevance}`);
      }
      console.log();
    }
  },

  'conversations:show': (args) => {
    const convId = args._[2];
    if (!convId) {
      console.error('Usage: a2a conversations show <conversation_id>');
      process.exit(1);
    }

    const cs = getConvStore();
    if (!cs) {
      console.error('Conversation storage not available. Install: npm install better-sqlite3');
      process.exit(1);
    }

    const context = cs.getConversationContext(convId, args.flags.messages || 20);
    if (!context) {
      console.error(`Conversation not found: ${convId}`);
      process.exit(1);
    }

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`💬 ${context.id}`);
    console.log(`${'═'.repeat(60)}\n`);

    console.log(`👤 Contact: ${context.contact || 'unknown'}`);
    console.log(`📊 Status: ${context.status}`);
    console.log(`📝 Messages: ${context.messageCount}`);
    console.log(`📅 Started: ${new Date(context.startedAt).toLocaleString()}`);
    if (context.endedAt) {
      console.log(`🏁 Ended: ${new Date(context.endedAt).toLocaleString()}`);
    }

    if (context.summary) {
      console.log(`\n${'─'.repeat(60)}`);
      console.log(`📋 Summary:\n${context.summary}`);
    }

    if (context.ownerContext) {
      console.log(`\n${'─'.repeat(60)}`);
      console.log(`🔒 Owner Context (private):`);
      console.log(`   Relevance: ${context.ownerContext.relevance || 'unknown'}`);
      if (context.ownerContext.summary) {
        console.log(`   Summary: ${context.ownerContext.summary}`);
      }
      if (context.ownerContext.goalsTouched?.length) {
        console.log(`   Goals: ${context.ownerContext.goalsTouched.join(', ')}`);
      }
      if (context.ownerContext.actionItems?.length) {
        console.log(`   Actions: ${context.ownerContext.actionItems.join(', ')}`);
      }
      if (context.ownerContext.followUp) {
        console.log(`   Follow-up: ${context.ownerContext.followUp}`);
      }
      if (context.ownerContext.notes) {
        console.log(`   Notes: ${context.ownerContext.notes}`);
      }
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`Recent messages:`);
    console.log(`${'─'.repeat(60)}`);
    for (const msg of context.recentMessages) {
      const role = msg.direction === 'inbound' ? '← In' : '→ Out';
      const time = new Date(msg.timestamp).toLocaleTimeString();
      console.log(`\n[${time}] ${role}:`);
      console.log(msg.content);
    }
    console.log(`\n${'═'.repeat(60)}\n`);
  },

  'conversations:end': async (args) => {
    const convId = args._[2];
    if (!convId) {
      console.error('Usage: a2a conversations end <conversation_id>');
      process.exit(1);
    }

    const cs = getConvStore();
    if (!cs) {
      console.error('Conversation storage not available');
      process.exit(1);
    }

    // For now, conclude without LLM summarizer
    const result = await cs.concludeConversation(convId, {});
    
    if (!result.success) {
      console.error(`Failed to end conversation: ${result.error}`);
      process.exit(1);
    }

    console.log(`✅ Conversation concluded: ${convId}`);
    if (result.summary) {
      console.log(`📋 Summary: ${result.summary}`);
    }
  },

  call: async (args) => {
    let target = args._[1];
    const message = args._.slice(2).join(' ') || args.flags.message || args.flags.m;

    if (!target || !message) {
      console.error('Usage: a2a call <contact_or_url> <message>');
      console.error('  --single        Single-turn call (one message, one response)');
      console.error('  --min-turns N   Minimum turns before close (default: 8)');
      console.error('  --max-turns N   Maximum turns (default: 25)');
      process.exit(1);
    }

    // Check if target is a contact name (not a URL)
    let url = target;
    let contactName = null;
    if (!target.startsWith('a2a://')) {
      const remote = store.getContact(target);
      if (remote) {
        url = `a2a://${remote.host}/${remote.token}`;
        contactName = remote.name;
      }
    }

    const single = Boolean(args.flags.single);
    const callerName = args.flags.name || 'CLI User';

    if (!single) {
      // Multi-turn conversation via ConversationDriver
      const { ConversationDriver } = require('../src/lib/conversation-driver');
      const { createRuntimeAdapter } = require('../src/lib/runtime-adapter');
      const { loadManifest } = require('../src/lib/disclosure');

      const workspaceDir = process.env.A2A_WORKSPACE || process.env.OPENCLAW_WORKSPACE || process.cwd();
      const agentContext = {
        name: process.env.A2A_AGENT_NAME || process.env.AGENT_NAME || 'a2a-agent',
        owner: process.env.A2A_OWNER_NAME || process.env.USER || 'Agent Owner'
      };

      const runtime = createRuntimeAdapter({ workspaceDir, agentContext });
      const cs = getConvStore();
      const disclosure = loadManifest();

      const minTurns = parseInt(args.flags['min-turns']) || 8;
      const maxTurns = parseInt(args.flags['max-turns']) || 25;

      // Build owner context from config for summarizer
      let ownerContext = {};
      try {
        const { A2AConfig } = require('../src/lib/config');
        const config = new A2AConfig();
        const configAll = config.getAll();
        const tierGoals = configAll.tiers?.public?.goals || [];
        ownerContext = {
          goals: tierGoals,
          agentName: agentContext.name,
          ownerName: agentContext.owner
        };
      } catch (err) {
        // Best effort
      }

      const driver = new ConversationDriver({
        runtime,
        agentContext,
        caller: { name: callerName },
        endpoint: url,
        convStore: cs,
        disclosure,
        minTurns,
        maxTurns,
        ownerContext,
        onTurn: (info) => {
          const preview = info.messagePreview.length >= 80
            ? info.messagePreview + '...'
            : info.messagePreview;
          console.log(`  Turn ${info.turn} | ${info.phase} | overlap: ${info.overlapScore.toFixed(2)} | ${preview}`);
        }
      });

      console.log(`📞 Starting multi-turn conversation with ${contactName || url}...`);
      console.log(`  Min turns: ${minTurns} | Max turns: ${maxTurns}\n`);

      try {
        const result = await driver.run(message);

        if (contactName) {
          store.updateContactStatus(contactName, 'online');
        }

        console.log(`\n✅ Conversation complete`);
        console.log(`  Turns: ${result.turnCount}`);
        console.log(`  Phase: ${result.collabState.phase}`);
        console.log(`  Overlap: ${result.collabState.overlapScore.toFixed(2)}`);
        if (result.collabState.candidateCollaborations.length > 0) {
          console.log(`  Collaborations: ${result.collabState.candidateCollaborations.join(', ')}`);
        }
        console.log(`  Conversation ID: ${result.conversationId}`);
        if (result.summary) {
          console.log(`\n📋 Summary:\n${result.summary}`);
        }
      } catch (err) {
        if (contactName) {
          store.updateContactStatus(contactName, 'offline', err.message);
        }
        console.error(`❌ Multi-turn call failed: ${err.message}`);
        process.exit(1);
      }
      return;
    }

    // Single-shot call (existing behavior)
    const client = new A2AClient({
      caller: { name: callerName }
    });

    try {
      console.log(`📞 Calling ${contactName || url}...`);
      const response = await client.call(url, message);

      // Update contact status on success
      if (contactName) {
        store.updateContactStatus(contactName, 'online');
      }

      // Persist conversation locally
      const cs = getConvStore();
      if (cs) {
        try {
          // Use remote conversation ID if provided, otherwise generate a local one
          const convId = response.conversation_id || `conv_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

          const convResult = cs.startConversation({
            id: convId,
            contactId: contactName || null,
            contactName: contactName || null,
            direction: 'outbound'
          });
          if (convResult.success === false) {
            console.error(`⚠️  Failed to save conversation: ${convResult.error}`);
          } else {
            const outMsg = cs.addMessage(convId, {
              direction: 'outbound',
              role: 'user',
              content: message
            });
            if (outMsg.success === false) {
              console.error(`⚠️  Failed to save outbound message: ${outMsg.error}`);
            }
            if (response.response) {
              const inMsg = cs.addMessage(convId, {
                direction: 'inbound',
                role: 'assistant',
                content: response.response
              });
              if (inMsg.success === false) {
                console.error(`⚠️  Failed to save inbound message: ${inMsg.error}`);
              }
            }
            // Update response to include conversation ID for display
            if (!response.conversation_id) {
              response.conversation_id = convId;
            }
          }
        } catch (err) {
          console.error(`⚠️  Error persisting conversation: ${err.message}`);
        }
      }

      console.log(`\n✅ Response:\n`);
      console.log(response.response);
      if (response.conversation_id) {
        console.log(`\n📝 Conversation ID: ${response.conversation_id}`);
      }
    } catch (err) {
      // Update contact status on failure
      if (contactName) {
        store.updateContactStatus(contactName, 'offline', err.message);
      }
      console.error(`❌ Call failed: ${err.message}`);
      process.exit(1);
    }
  },

  ping: async (args) => {
    const url = args._[1];
    if (!url) {
      console.error('Usage: a2a ping <invite_url>');
      process.exit(1);
    }

    const client = new A2AClient();
    const result = await client.ping(url);
    
    if (result.pong) {
      console.log(`✅ Agent reachable at ${url}`);
      if (result.timestamp) {
        console.log(`   Timestamp: ${result.timestamp}`);
      }
    } else {
      console.log(`❌ Agent not reachable at ${url}`);
      process.exit(1);
    }
  },

  gui: async (args) => {
    // GUI is always safe to open even before onboarding.
    const tab = (args.flags.tab || args.flags.t || '').trim().toLowerCase();
    const allowedTabs = new Set(['contacts', 'calls', 'logs', 'settings', 'invites']);
    const hash = allowedTabs.has(tab) ? `#${tab}` : '';

    const urlFlag = args.flags.url;
    if (urlFlag) {
      const url = String(urlFlag);
      console.log(`Dashboard URL: ${url}`);
      const opened = openInBrowser(url);
      if (opened.attempted) {
        console.log(`Opening browser via: ${opened.command}`);
      } else {
        console.log('Could not auto-open browser.');
      }
      return;
    }

    // Prefer native app on macOS (--browser flag forces browser)
    if (!args.flags.browser) {
      const nativeApp = findNativeApp();
      if (nativeApp) {
        console.log('Opening A2A Callbook native app...');
        const result = openInBrowser(nativeApp);
        if (result.attempted) {
          return;
        }
      }
    }

    const preferred = [];
    if (args.flags.port || args.flags.p) preferred.push(args.flags.port || args.flags.p);
    if (process.env.A2A_PORT) preferred.push(process.env.A2A_PORT);
    if (process.env.PORT) preferred.push(process.env.PORT);

    const port = await findLocalServerPort(preferred);
    if (!port) {
      console.log('Dashboard is not reachable on common ports.');
      console.log('Start the server (example):');
      console.log('  A2A_HOSTNAME="localhost:3001" a2a server --port 3001');
      console.log('Then open:');
      console.log('  http://127.0.0.1:3001/dashboard/');
      return;
    }

    const url = `http://127.0.0.1:${port}/dashboard/${hash}`;
    console.log(`Dashboard URL: ${url}`);
    const opened = openInBrowser(url);
    if (opened.attempted) {
      console.log(`Opening browser via: ${opened.command}`);
    } else {
      console.log('Could not auto-open browser; open the URL above manually.');
    }
  },

  dashboard: (args) => {
    // Alias for gui
    return commands.gui(args);
  },

  status: async (args) => {
    const url = args._[1];

    // If a URL is provided, check that remote agent's status
    if (url) {
      const client = new A2AClient();
      try {
        const status = await client.status(url);
        console.log(`A2A status for ${url}:\n`);
        console.log(JSON.stringify(status, null, 2));
      } catch (err) {
        console.error(`❌ Failed to get status: ${err.message}`);
        process.exit(1);
      }
      return;
    }

    // No URL — show local server status
    const { A2AConfig } = require('../src/lib/config');
    const config = new A2AConfig();
    const onboarding = config.getOnboarding();
    const agent = config.getAgent();

    console.log('A2A Local Status\n');

    // Onboarding state
    const onboarded = onboarding.version === 2 && onboarding.step === 'complete';
    console.log(`  Onboarding:  ${onboarded ? '✅ Complete' : `⚠️  ${onboarding.step || 'not started'} (run: a2a quickstart)`}`);
    console.log(`  Agent name:  ${agent.name || '(not set)'}`);
    console.log(`  Hostname:    ${agent.hostname || '(not set)'}`);

    // Check if server is running
    const preferred = [];
    if (onboarding.server_port) preferred.push(onboarding.server_port);
    const port = await findLocalServerPort(preferred);
    if (port) {
      console.log(`  Server:      ✅ Running on port ${port}`);

      // Fetch dashboard status for more detail
      const http = require('http');
      try {
        const statusData = await new Promise((resolve, reject) => {
          const req = http.request({
            hostname: '127.0.0.1', port,
            path: '/api/a2a/dashboard/status',
            method: 'GET', timeout: 2000
          }, (res) => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => {
              try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
            });
          });
          req.on('error', reject);
          req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
          req.end();
        });

        if (statusData.agent) {
          if (statusData.agent.owner_name) console.log(`  Owner:       ${statusData.agent.owner_name}`);
        }
        if (statusData.invite_host) {
          const ih = typeof statusData.invite_host === 'object' ? statusData.invite_host.host : statusData.invite_host;
          if (ih) console.log(`  Invite host: ${ih}`);
        }
        if (statusData.warnings && statusData.warnings.length) {
          console.log('');
          for (const w of statusData.warnings) {
            console.log(`  ⚠️  ${w}`);
          }
        }
      } catch (_) {
        // Dashboard status unavailable — that's fine, we already showed port
      }
    } else {
      console.log('  Server:      ❌ Not running');
      console.log('  Start with:  a2a server --port 3001');
    }

    console.log(`\n  Tip: a2a status <invite_url> to check a remote agent`);
  },

  config: (args) => {
    const { A2AConfig } = require('../src/lib/config');
    const config = new A2AConfig();
    
    const hostname = args.flags.hostname || args.flags.h;
    const port = args.flags.port || args.flags.p;
    const show = args.flags.show || args.flags.s || (!hostname && !port);
    
    if (show) {
      const agent = config.getAgent();
      console.log('A2A Configuration:\n');
      console.log(`  Hostname: ${agent.hostname || '(not set)'}`);
      console.log(`  Name: ${agent.name || '(not set)'}`);
      console.log(`  Description: ${agent.description || '(not set)'}`);
      const onboarding = config.getAll().onboarding || {};
      console.log(`  Server port: ${onboarding.server_port || '(not running)'}`);
      console.log(`  Onboarding step: ${onboarding.step || 'not started'}`);
      return;
    }
    
    const updates = {};
    if (hostname) {
      // Remove port from hostname if it's :80 (default)
      const cleanHostname = hostname.replace(/:80$/, '');
      updates.hostname = cleanHostname;
      console.log(`  Hostname updated to: ${cleanHostname}`);
    }
    
    if (Object.keys(updates).length > 0) {
      config.setAgent(updates);
      console.log('  ✅ Configuration saved.');
    }
  },

  server: (args) => {
    const explicitPort = args.flags.port || args.flags.p || process.env.PORT;
    if (explicitPort) {
      process.env.PORT = explicitPort;
      console.log(`Starting A2A server on port ${explicitPort}...`);
    } else {
      console.log('Starting A2A server (scanning for available port)...');
    }
    require('../src/server.js');
  },

  // ==========================================================================
  // quickstart — full onboarding flow
  //
  // OBJECTIVE: Walk an installing agent (or human) through every step needed
  // to get A2A Calling running, in a single pass. The postinstall hook calls
  // this automatically, so `npm install -g a2acalling` completes the entire
  // setup without any follow-up commands.
  //
  // Every prompt auto-accepts its default when there is no TTY, so the full
  // flow completes unattended in non-interactive environments (agents).
  //
  // STEPS:
  //   Step 1 — Port selection: scan for an available port and bind it.
  //   Step 2 — Hostname detection: look up the external IP so remote agents
  //            know where to reach this instance.
  //   Step 3 — Server start: launch the A2A server as a detached process,
  //            confirm it's listening, save config, and print a verify hint.
  //   Step 4 — Disclosure prompt: output a full agent-readable prompt that
  //            instructs the agent to scan its own workspace files, extract
  //            tiered disclosure topics, and submit them back via
  //            `a2a quickstart --submit '<json>'`.
  //
  // The disclosure prompt does NOT pre-scan files itself — it tells the agent
  // which files to look for (USER.md, SOUL.md, etc.) and lets the agent read
  // them with its own tools. This is intentional: the installer runs in a
  // subprocess where it has no access to the agent's file-reading capabilities.
  // ==========================================================================
  quickstart: async (args) => {
    const { A2AConfig } = require('../src/lib/config');
    const { isPortListening } = require('../src/lib/port-scanner');
    const { buildExtractionPrompt } = require('../src/lib/disclosure');
    const { getExternalIp } = require('../src/lib/external-ip');

    const config = new A2AConfig();
    const interactive = isInteractiveShell();

    // Handle `quickstart --submit '<json>'` — this is the agent calling back
    // after it has scanned its workspace and built the disclosure JSON.
    if (await handleDisclosureSubmit(args, 'quickstart')) {
      return;
    }

    if (args.flags.force) {
      config.resetOnboarding();
    }

    // Already onboarded — skip unless --force
    if (config.isOnboarded() && !args.flags.force) {
      console.log('\nOnboarding already complete. Use --force to re-run.\n');
      return;
    }

    // Resume point: if the server is already running and we're waiting for the
    // agent to submit disclosure topics, skip straight to the disclosure prompt.
    // This happens when the agent re-runs quickstart after a previous partial run.
    let currentStep = 'not_started';
    try {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      currentStep = cfg.onboarding?.step || 'not_started';
    } catch (e) {
      if (e.code !== 'ENOENT' && e.name !== 'SyntaxError') {
        console.error(`  Warning: could not read config: ${e.message}`);
      }
    }
    if (currentStep === 'awaiting_disclosure' && !args.flags.force) {
      console.log('\nStep 1 already complete. Server is running.\n');
      console.log('Step 2 of 4: Configure disclosure topics\n');
      console.log(buildExtractionPrompt());
      console.log('\n  Read your workspace files, extract topics, and present to your owner for review.');
      console.log("  Then submit with: a2a quickstart --submit '<json>'\n");
      return;
    }

    printStepHeader('🤝  A2A Calling — First-Time Setup');

    // Interactive: ask for confirmation. Non-interactive: auto-accepts (Y).
    const continueSetup = await promptYesNo('Continue with setup? [Y/n] ');
    if (!continueSetup) {
      console.log('\nSetup cancelled.\n');
      return;
    }

    // ── Step 1: Port selection ───────────────────────────────────────────
    // Port 80 is strongly preferred (no firewall config needed for external access).
    // If port 80 is available and bindable, use it. Otherwise fall back to 3001-3020.
    printSection('Port Configuration');
    const preferredPort = parsePort(args.flags.port || args.flags.p, null);
    const candidates = await inspectPorts(preferredPort);
    const availableCandidates = candidates.filter(c => c.available);
    
    // Strongly prefer port 80 if available
    const port80Candidate = candidates.find(c => c.port === 80);
    const port80Available = port80Candidate && port80Candidate.available;
    
    let recommendedPort;
    if (port80Available) {
      recommendedPort = 80;
    } else if (availableCandidates.length) {
      recommendedPort = availableCandidates[0].port;
    } else {
      recommendedPort = null;
    }

    if (!recommendedPort) {
      console.error('  Could not find a bindable port in the scan range.');
      console.error('  Re-run with --port <number> after freeing one of these ports.\n');
      if (interactive) {
        console.log('  Ports scanned:');
        summarizePortResults(candidates).forEach(line => console.log(`    ${line}`));
      }
      process.exit(1);
    }

    let serverPort = recommendedPort;
    let proxyStrategy = false; // true if user chose reverse proxy option

    if (port80Available) {
      // Port 80 available — simple confirm
      console.log('  Port 80 is available — using it for easiest external access.');
      const portPrompt = `Use port 80? [Y/n]: `;
      const portChoice = await promptText(portPrompt, 'y');

      if (!interactive) {
        serverPort = 80;
      } else if (!['', 'y', 'Y', 'yes', 'YES', 'ye'].includes(String(portChoice).trim())) {
        if (/^(n|no|custom|c)$/i.test(String(portChoice).trim())) {
          let customPort = null;
          while (customPort === null) {
            const raw = await promptText('Enter a custom port number: ', String(recommendedPort));
            const parsed = parsePort(raw, null);
            if (!parsed) {
              console.log('  Invalid port. Enter a value between 1 and 65535.');
              continue;
            }
            const checked = await (async () => {
              const scan = await inspectPorts(parsed);
              return scan[0];
            })();
            if (!checked.available) {
              console.log(`  Port ${parsed} is unavailable (${checked.code || 'in use'}).`);
              continue;
            }
            customPort = parsed;
          }
          serverPort = customPort;
        } else {
          const parsed = parsePort(portChoice, null);
          if (parsed) {
            const checked = await (async () => {
              const scan = await inspectPorts(parsed);
              return scan[0];
            })();
            if (!checked.available) {
              console.log(`  Port ${parsed} is unavailable (${checked.code || 'in use'}).`);
            } else {
              serverPort = parsed;
            }
          }
        }
      }
    } else {
      // Port 80 NOT available — show the fallback strategy prompt
      const fallback = await promptPortFallbackStrategy(recommendedPort, interactive);

      if (fallback.strategy === 'kill') {
        const confirmKill = await promptYesNo(`  Kill ${(fallback.processInfo && fallback.processInfo.name) || 'process'} (PID ${(fallback.processInfo && fallback.processInfo.pid) || '?'})? (y/N) `);
        if (confirmKill) {
          const killed = await killPortProcess(fallback.processInfo);
          if (killed) {
            serverPort = 80;
          } else {
            console.log(`\n  Falling back to port ${recommendedPort}.`);
            console.log('  You can set up a reverse proxy after setup completes.\n');
            serverPort = recommendedPort;
          }
        } else {
          console.log(`  Skipped. Using port ${recommendedPort}.\n`);
          serverPort = recommendedPort;
        }
      } else if (fallback.strategy === 'proxy') {
        serverPort = fallback.port;
        proxyStrategy = true;
      } else {
        serverPort = fallback.port;
      }
    }

    // ── Step 2: Hostname detection ───────────────────────────────────────
    // Look up the machine's external IP so invite URLs point to a routable
    // address. Non-interactive: auto-uses the detected IP. Interactive: lets
    // the user choose IP, domain, or skip.
    printSection('Hostname Configuration');
    const ipResult = await getExternalIp();
    const externalIp = ipResult.ip || null;
    let publicHost = `localhost:${serverPort}`;

    if (externalIp) {
      const detectedHost = serverPort === 80 ? externalIp : `${externalIp}:${serverPort}`;
      console.log(`  Detected external IP: ${detectedHost}`);
      if (interactive) {
        const hostChoiceRaw = await promptText(
          'How should other agents reach you?\n'
          + '  1. Use IP directly\n'
          + '  2. Enter a domain name\n'
          + '  3. Skip (configure later)\n'
          + 'Choice [1/2/3]: ',
          '1'
        );
        const hostChoice = String(hostChoiceRaw || '').trim();
        if (hostChoice === '2') {
          const manualHost = await promptText('Enter your public hostname: ', '');
          if (manualHost) publicHost = String(manualHost).trim();
        } else if (hostChoice === '3') {
          publicHost = process.env.A2A_HOSTNAME || `localhost:${serverPort}`;
        } else {
          publicHost = detectedHost;
        }
      } else {
        publicHost = detectedHost;
      }
    } else if (interactive) {
      const hostChoiceRaw = await promptText(
        'External IP unavailable.\nHow should other agents reach you?\n'
        + '  1. Enter a domain name\n'
        + '  2. Skip (use localhost)\n'
        + 'Choice [1/2]: ',
        '2'
      );
      const hostChoice = String(hostChoiceRaw || '').trim();
      if (hostChoice === '1') {
        const manualHost = await promptText('Enter your public hostname: ', '');
        if (manualHost) publicHost = String(manualHost).trim();
      }
    } else if (ipResult.error) {
      console.log(`  External IP lookup failed: ${ipResult.error}`);
    }

    // ── Step 3: Server start ─────────────────────────────────────────────
    // Launch the A2A Express server as a detached background process, wait
    // for it to bind, then save the config with the server PID and port.
    // Non-interactive: auto-starts. Interactive: asks for confirmation.
    // Also prints a one-line networking hint (reverse proxy or firewall)
    // and a curl command the agent can use to verify external reachability.
    printSection('Starting Server');
    console.log('  Configuration summary:');
    console.log(`    Port: ${serverPort}`);
    console.log(`    Public host: ${publicHost}`);

    const startServer = await promptYesNo('Start the A2A server now? [Y/n] ');
    if (!startServer) {
      console.log('\nServer not started. Run with:\n  a2a server --port <port> --hostname <host>\n');
      return;
    }

    const isAlreadyListening = await isPortListening(serverPort, '127.0.0.1', { timeoutMs: 250 });
    let serverPid = null;
    if (!isAlreadyListening.listening) {
      const serverScript = path.join(__dirname, '../src/server.js');
      const child = spawn(process.execPath, [serverScript], {
        env: { ...process.env, PORT: String(serverPort) },
        detached: true,
        stdio: 'ignore'
      });
      serverPid = child.pid;
      child.unref();
    } else {
      console.log('  Existing server detected on this port.');
    }

    async function waitForServer(port) {
      for (let i = 0; i < 18; i++) {
        const listening = await isPortListening(port, '127.0.0.1', { timeoutMs: 250 });
        if (listening.listening) return true;
        await new Promise(r => setTimeout(r, 250));
      }
      return false;
    }

    const serverUp = await waitForServer(serverPort);
    if (!serverUp) {
      console.log('  Server failed to start. Check logs and retry:');
      console.log(`    PORT=${serverPort} node ${path.join(__dirname, '../src/server.js')}`);
      process.exit(1);
    }

    if (serverPid) {
      console.log('  Server started.');
      config.setOnboarding({ server_pid: serverPid, server_port: serverPort });
    } else {
      console.log('  Using existing server.');
    }
    console.log('  ✅ A2A server is running');

    if (externalIp) {
      if (serverPort === 80) {
        // Port 80 — optimal setup, no extra config needed
        console.log(`\n  ✅ Running on port 80 — external agents can reach you directly.`);
        console.log(`  Invite hostname: ${externalIp}`);
        publicHost = externalIp;
      } else if (proxyStrategy) {
        // User chose to set up a reverse proxy
        const proxy = generateProxyConfig(serverPort);

        console.log(`\n  ━━━ Reverse Proxy Configuration ━━━`);
        console.log(`\n  A2A server running on port ${serverPort}. Configure your web server`);
        console.log(`  to proxy port 80 → ${serverPort} so invite URLs work without a port number.\n`);

        if (proxy.hasNginx) {
          console.log('  ┌─────────────────────────────────────────────────────────────────┐');
          console.log('  │  nginx — add inside your server {} block                        │');
          console.log('  │  File: /etc/nginx/sites-available/default                       │');
          console.log('  └─────────────────────────────────────────────────────────────────┘');
          console.log('');
          proxy.nginxConfig.split('\n').forEach(line => console.log(`  ${line}`));
          console.log('');
          console.log('  To apply:');
          console.log('    1. sudo nano /etc/nginx/sites-available/default');
          console.log('    2. Add the config above inside your server { } block');
          console.log('    3. sudo nginx -t');
          console.log('    4. sudo systemctl reload nginx');
        }

        if (proxy.hasCaddy) {
          console.log('');
          console.log('  ┌─────────────────────────────────────────────────────────────────┐');
          console.log('  │  Caddy config                                                   │');
          console.log('  └─────────────────────────────────────────────────────────────────┘');
          console.log('');
          proxy.caddyConfig.split('\n').forEach(line => console.log(`  ${line}`));
        }

        if (!proxy.hasNginx && !proxy.hasCaddy) {
          console.log('  No nginx or Caddy detected. Install one:');
          console.log('    sudo apt install nginx   # Debian/Ubuntu');
          console.log('    sudo yum install nginx   # RHEL/CentOS');
          console.log('');
          console.log('  Then add this proxy config:');
          proxy.nginxConfig.split('\n').forEach(line => console.log(`  ${line}`));
        }

        // With reverse proxy, invite URLs use port 80 (no port in URL)
        console.log(`\n  After applying, invite hostname will be: ${externalIp} (no port needed)`);
        publicHost = externalIp;
      } else {
        // User chose 'continue' on non-standard port — brief reminder
        console.log(`\n  ⚠  Running on port ${serverPort} (non-standard).`);
        console.log(`  Invite hostname: ${publicHost}`);
        console.log('');
        console.log('  ⚠️  Remote agents using your invite URL will try port 80 by default.');
        console.log('  Without a reverse proxy, inbound calls on port 80 will fail silently.');
        console.log(`\n  To set up a reverse proxy later:`);
        console.log(`    a2a config --hostname ${externalIp}`);
        console.log(`  Then configure nginx/caddy to proxy port 80 → ${serverPort}.`);
      }

      const verifyUrl = `http://${publicHost}/api/a2a/ping`;
      console.log(`\n  Verify: curl -s ${verifyUrl}`);

      // Fix 6: Actually run the connectivity check
      const http = require('http');
      const verifyOk = await new Promise(resolve => {
        const req = http.request({
          hostname: '127.0.0.1',
          port: serverPort,
          path: '/api/a2a/ping',
          method: 'GET',
          timeout: 2000
        }, (res) => {
          res.resume();
          resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.end();
      });

      if (verifyOk) {
        console.log('  ✅ Local connectivity verified');
      } else {
        console.log('  ⚠️  Local server check failed — server may still be starting');
      }

      // Fix 7: Surface invite-host warnings during quickstart
      try {
        const { resolveInviteHost } = require('../src/lib/invite-host');
        const resolved = await resolveInviteHost({
          hostname: publicHost,
          port: serverPort
        });
        if (resolved.warnings && resolved.warnings.length) {
          console.log('\n  ━━━ Network Warnings ━━━');
          for (const w of resolved.warnings) {
            console.warn(`  ⚠️  ${w}`);
          }
        }
      } catch (_) {}
    }

    // Save server config and advance onboarding state to awaiting_disclosure.
    config.setAgent({ hostname: publicHost });
    config.setOnboarding({ step: 'awaiting_disclosure' });

    // ── Step 4: Disclosure prompt ────────────────────────────────────────
    // Output a full agent-readable prompt that tells the agent to:
    //   1. Scan its own workspace for USER.md, SOUL.md, etc.
    //   2. Extract tiered disclosure topics from those files
    //   3. Build the required JSON structure
    //   4. Submit it back via `a2a quickstart --submit '<json>'`
    //
    // IMPORTANT: We do NOT pre-scan files here. The installer runs in a
    // subprocess and has no access to the agent's file-reading tools. The
    // prompt lists which files to look for and the agent reads them itself.
    printSection('Disclosure Topic Extraction');
    console.log('Step 2 of 4: Configure disclosure topics\n');
    console.log(buildExtractionPrompt());
    console.log('\n  Read your workspace files, extract topics, and present to your owner for review.');
    console.log("  Then submit with: a2a quickstart --submit '<json>'\n");
  },


  install: () => {
    require('../scripts/install-openclaw.js');
  },

  setup: () => {
    require('../scripts/install-openclaw.js');
  },

  uninstall: async (args) => {
    const fs = require('fs');
    const path = require('path');
    const { spawnSync } = require('child_process');

    const keepConfig = Boolean(args.flags['keep-config'] || args.flags.keepConfig);
    const force = Boolean(args.flags.force || args.flags.f);

    const configDir = process.env.A2A_CONFIG_DIR ||
      process.env.OPENCLAW_CONFIG_DIR ||
      path.join(process.env.HOME || '/tmp', '.config', 'openclaw');

    const configFile = path.join(configDir, 'a2a-config.json');
    const disclosureFile = path.join(configDir, 'a2a-disclosure.json');
    const tokensFile = path.join(configDir, 'a2a-tokens.json');
    const tokenStoreFile = path.join(configDir, 'a2a.json');
    const externalIpFile = path.join(configDir, 'a2a-external-ip.json');
    const dbFile = path.join(configDir, 'a2a-conversations.db');
    const logsDbFile = path.join(configDir, 'a2a-logs.db');
    const callbookDbFile = path.join(configDir, 'a2a-callbook.db');

    console.log(`\n🗑️  A2A Uninstall`);
    console.log('─────────────────\n');

    if (!keepConfig && !force) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        console.error('Refusing to prompt without a TTY. Re-run with --force to confirm uninstall.');
        process.exit(1);
      }

      const existing = [configFile, disclosureFile, tokensFile, tokenStoreFile, externalIpFile, dbFile, logsDbFile, callbookDbFile].filter(f => fs.existsSync(f));
      const list = existing.length ? existing.map(f => `  - ${f}`).join('\n') : '  (no local config/database files found)';
      const ok = await promptYesNo(
        `This will stop the pm2 process "a2a" and delete:\n${list}\nProceed? (y/N) `
      );
      if (!ok) {
        console.log('\nCancelled.\n');
        return;
      }
    }

    function pm2Exists() {
      const res = spawnSync('pm2', ['--version'], { stdio: 'ignore', timeout: 4000 });
      if (res.error && res.error.code === 'ENOENT') return false;
      return res.status === 0;
    }

    function pm2HasProcess(name) {
      const res = spawnSync('pm2', ['describe', name], { encoding: 'utf8', timeout: 6000 });
      if (res.error && res.error.code === 'ENOENT') return false;
      return res.status === 0;
    }

    function pm2StopAndDelete(name) {
      if (!pm2Exists()) return { ok: true, skipped: true };
      if (!pm2HasProcess(name)) return { ok: true, skipped: true };

      const stop = spawnSync('pm2', ['stop', name], { encoding: 'utf8', timeout: 8000 });
      if (stop.status !== 0) {
        const msg = (stop.stderr || stop.stdout || '').trim();
        return { ok: false, error: msg || 'pm2 stop failed' };
      }

      const del = spawnSync('pm2', ['delete', name], { encoding: 'utf8', timeout: 8000 });
      if (del.status !== 0) {
        const msg = (del.stderr || del.stdout || '').trim();
        return { ok: false, error: msg || 'pm2 delete failed' };
      }

      return { ok: true };
    }

    function rmFileSafe(filePath) {
      try {
        fs.rmSync(filePath, { force: true });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

    // Check if a TCP port is currently occupied (async, fast)
    function isPortOccupied(port) {
      if (!port) return false;
      const net = require('net');
      return new Promise((resolve) => {
        const socket = net.connect({ host: '127.0.0.1', port });
        let settled = false;
        const finish = (result) => {
          if (settled) return;
          settled = true;
          try { socket.destroy(); } catch (e) {}
          resolve(result);
        };
        socket.setTimeout(500, () => finish(false));
        socket.once('connect', () => finish(true));
        socket.once('error', () => finish(false));
      });
    }

    // Find PID listening on a given port by parsing /proc/net/tcp6 (Linux)
    function findPidOnPort(port) {
      try {
        // Try fuser first (most reliable)
        const fuserResult = spawnSync('fuser', [`${port}/tcp`], {
          encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe']
        });
        if (fuserResult.status === 0 && fuserResult.stdout) {
          const pids = fuserResult.stdout.trim().split(/\s+/).map(Number).filter(p => p > 0);
          if (pids.length > 0) return pids;
        }
      } catch (e) { /* fuser not available, fall through */ }

      try {
        // Fallback: parse /proc/net/tcp and /proc/net/tcp6
        const portHex = port.toString(16).toUpperCase().padStart(4, '0');
        const pids = [];
        for (const proto of ['/proc/net/tcp', '/proc/net/tcp6']) {
          let content;
          try { content = fs.readFileSync(proto, 'utf8'); } catch (e) { continue; }
          const lines = content.split('\n');
          for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            if (parts.length < 10) continue;
            const localAddr = parts[1]; // e.g., 00000000:1F90
            const localPort = localAddr.split(':')[1];
            if (localPort && localPort.toUpperCase() === portHex) {
              const inode = parts[9];
              // Search /proc/*/fd/* for socket inodes
              try {
                const procDirs = fs.readdirSync('/proc').filter(d => /^\d+$/.test(d));
                for (const pid of procDirs) {
                  try {
                    const fdDir = `/proc/${pid}/fd`;
                    const fds = fs.readdirSync(fdDir);
                    for (const fd of fds) {
                      try {
                        const link = fs.readlinkSync(`${fdDir}/${fd}`);
                        if (link === `socket:[${inode}]`) {
                          pids.push(Number(pid));
                        }
                      } catch (e) {}
                    }
                  } catch (e) {}
                }
              } catch (e) {}
            }
          }
        }
        if (pids.length > 0) return [...new Set(pids)];
      } catch (e) { /* /proc parsing failed */ }

      return [];
    }

    // Kill a specific PID with SIGTERM, wait, then SIGKILL if needed
    function killPidSync(pid) {
      try {
        process.kill(pid, 0); // existence check
      } catch (e) {
        return { ok: true, skipped: true };
      }

      process.kill(pid, 'SIGTERM');
      const start = Date.now();
      while (Date.now() - start < 3000) {
        try {
          process.kill(pid, 0);
          spawnSync('sleep', ['0.1'], { timeout: 500 });
        } catch (e) {
          return { ok: true, pid };
        }
      }

      // Still alive — force kill
      try {
        process.kill(pid, 'SIGKILL');
        // Brief wait for SIGKILL to take effect
        spawnSync('sleep', ['0.2'], { timeout: 500 });
        try {
          process.kill(pid, 0);
          return { ok: false, pid, error: `PID ${pid} survived SIGKILL` };
        } catch (e) {
          return { ok: true, pid, forced: true };
        }
      } catch (e) {
        return { ok: true, pid };
      }
    }

    // Kill server by PID from config (detached process started by quickstart)
    // Then verify the port is actually freed; if not, find and kill whatever holds it.
    async function killServerPid() {
      let pid, serverPort;
      try {
        const { A2AConfig } = require('../src/lib/config');
        const cfg = new A2AConfig();
        const onboarding = cfg.getOnboarding();
        pid = onboarding.server_pid;
        serverPort = onboarding.server_port;
      } catch (err) {
        // Config read failed — not fatal, continue with pm2 path
        return { ok: true, skipped: true };
      }

      // Step 1: Try to kill the PID from config
      if (pid) {
        killPidSync(pid);
      }

      // Step 2: Verify the port is freed
      if (serverPort) {
        const stillOccupied = await isPortOccupied(serverPort);
        if (stillOccupied) {
          // Port is still held — find and kill whatever is on it
          const pids = findPidOnPort(serverPort);
          let killedAny = false;
          for (const p of pids) {
            const result = killPidSync(p);
            if (result.ok && !result.skipped) killedAny = true;
          }

          // Final check
          const stillUp = await isPortOccupied(serverPort);
          if (stillUp) {
            return { ok: false, pid, port: serverPort, error: `Port ${serverPort} is still occupied after kill attempts` };
          }
          return { ok: true, pid, port: serverPort, portKill: killedAny };
        }
      }

      return { ok: true, pid, port: serverPort, skipped: !pid };
    }

    process.stdout.write('Stopping server... ');
    const pidResult = await killServerPid();
    const stopped = pm2StopAndDelete('a2a');
    if (!pidResult.ok && !stopped.ok) {
      console.log('❌');
      console.error(`  ${pidResult.error || stopped.error}`);
      process.exit(1);
    }
    if (!pidResult.ok) {
      console.log('⚠️');
      console.error(`  Warning: ${pidResult.error}`);
    } else {
      console.log('✅');
    }

    let configOk = true;
    let dbOk = true;

    if (!keepConfig) {
      process.stdout.write('Removing config... ');
      const c1 = rmFileSafe(configFile);
      const c2 = rmFileSafe(disclosureFile);
      const c3 = rmFileSafe(tokensFile);
      const c4 = rmFileSafe(tokenStoreFile);
      const c5 = rmFileSafe(externalIpFile);
      configOk = Boolean(c1.ok && c2.ok && c3.ok && c4.ok && c5.ok);
      console.log(configOk ? '✅' : '❌');
      if (!configOk) {
        if (!c1.ok) console.error(`  ${configFile}: ${c1.error}`);
        if (!c2.ok) console.error(`  ${disclosureFile}: ${c2.error}`);
        if (!c3.ok) console.error(`  ${tokensFile}: ${c3.error}`);
        if (!c4.ok) console.error(`  ${tokenStoreFile}: ${c4.error}`);
        if (!c5.ok) console.error(`  ${externalIpFile}: ${c5.error}`);
      }

      process.stdout.write('Removing database... ');
      const d1 = rmFileSafe(dbFile);
      const d2 = rmFileSafe(logsDbFile);
      const d3 = rmFileSafe(callbookDbFile);
      dbOk = Boolean(d1.ok && d2.ok && d3.ok);
      console.log(dbOk ? '✅' : '❌');
      if (!dbOk) {
        if (!d1.ok) console.error(`  ${dbFile}: ${d1.error}`);
        if (!d2.ok) console.error(`  ${logsDbFile}: ${d2.error}`);
        if (!d3.ok) console.error(`  ${callbookDbFile}: ${d3.error}`);
      }

      if (!configOk || !dbOk) {
        process.exit(1);
      }
    } else {
      console.log('Removing config... ⏭️');
      console.log('Removing database... ⏭️');
    }

    // Remove native macOS app if present
    if (os.platform() === 'darwin') {
      const appCandidates = [
        path.join(os.homedir(), 'Applications', 'A2A Callbook.app'),
        '/Applications/A2A Callbook.app',
      ];
      for (const appPath of appCandidates) {
        if (fs.existsSync(appPath)) {
          try {
            fs.rmSync(appPath, { recursive: true, force: true });
            console.log(`Removed ${appPath}`);
          } catch (err) {
            console.log(`Could not remove ${appPath}: ${err.message}`);
          }
        }
      }
    }

    console.log('\nTo complete removal:');
    console.log('  npm uninstall -g a2acalling\n');
    console.log(`Config preserved: ${keepConfig ? 'yes' : 'no'}`);
    console.log(`Location: ${configDir}`);
  },

  update: async (args) => {
    const { execSync } = require('child_process');
    const path = require('path');
    const pkg = require('../package.json');
    const currentVersion = pkg.version;
    const checkOnly = args.flags.check || args.flags.c;

    console.log(`\n📦 A2A Update\n${'─'.repeat(50)}\n`);
    console.log(`   Installed: v${currentVersion}`);

    // Detect install method
    const pkgRoot = path.resolve(__dirname, '..');
    const isGitRepo = require('fs').existsSync(path.join(pkgRoot, '.git'));

    if (isGitRepo) {
      // Git clone — use git pull
      console.log(`   Source:    git (${pkgRoot})\n`);

      if (checkOnly) {
        try {
          execSync('git fetch --quiet', { cwd: pkgRoot, stdio: 'pipe' });
          const behind = execSync('git rev-list HEAD..@{u} --count', { cwd: pkgRoot, encoding: 'utf8' }).trim();
          if (behind === '0') {
            console.log('   \u2705 Already up to date.\n');
          } else {
            console.log(`   \u2b06\ufe0f  ${behind} commit(s) behind. Run "a2a update" to pull.\n`);
          }
        } catch (e) {
          console.log('   \u26a0\ufe0f  Could not check remote (no upstream or network error).\n');
        }
        return;
      }

      console.log('   Pulling latest...');
      try {
        const output = execSync('git pull --ff-only 2>&1', { cwd: pkgRoot, encoding: 'utf8' });
        console.log(`   ${output.trim()}\n`);
      } catch (e) {
        const stderr = e.stderr ? e.stderr.toString() : e.message;
        console.error(`   \u274c Git pull failed: ${stderr.trim()}`);
        console.error('   Try: cd ' + pkgRoot + ' && git pull manually.\n');
        process.exit(1);
      }

      // Re-install deps if package.json changed
      console.log('   Installing dependencies...');
      try {
        execSync('npm install --production 2>&1', { cwd: pkgRoot, encoding: 'utf8', timeout: 120000 });
      } catch (e) {
        console.warn('   \u26a0\ufe0f  npm install had warnings (non-fatal).');
      }
    } else {
      // npm global install — use npm update
      console.log('   Source:    npm global\n');

      // Check latest version on npm
      let latestVersion;
      try {
        latestVersion = execSync('npm view a2acalling version 2>/dev/null', { encoding: 'utf8', timeout: 15000 }).trim();
        console.log(`   Latest:    v${latestVersion}`);
      } catch (e) {
        console.error('   \u274c Could not check npm registry. Check your network.\n');
        process.exit(1);
      }

      if (latestVersion === currentVersion) {
        console.log('\n   \u2705 Already up to date.\n');
        return;
      }

      if (checkOnly) {
        console.log(`\n   \u2b06\ufe0f  Update available: v${currentVersion} \u2192 v${latestVersion}`);
        console.log('   Run "a2a update" to install.\n');
        return;
      }

      console.log(`\n   Updating v${currentVersion} \u2192 v${latestVersion}...`);
      try {
        execSync('npm install -g a2acalling@latest 2>&1', { encoding: 'utf8', timeout: 120000 });
        console.log('   \u2705 npm package updated.\n');
      } catch (e) {
        const stderr = e.stderr ? e.stderr.toString() : e.message;
        console.error(`   \u274c npm update failed: ${stderr.trim()}`);
        console.error('   Try: npm install -g a2acalling@latest manually.\n');
        process.exit(1);
      }
    }

    // Re-run install to sync SKILL.md and config
    console.log('   Syncing SKILL.md and config...');
    try {
      const installScript = path.join(pkgRoot, 'scripts', 'install-openclaw.js');
      execSync(`node "${installScript}" install 2>&1`, { encoding: 'utf8', timeout: 30000 });
    } catch (e) {
      console.warn('   \u26a0\ufe0f  Post-update install sync had warnings (non-fatal).');
    }

    // Show new version
    try {
      delete require.cache[require.resolve('../package.json')];
      const newPkg = require('../package.json');
      console.log(`\n   \u2705 Updated to v${newPkg.version}\n`);
    } catch (e) {
      console.log('\n   \u2705 Update complete.\n');
    }
  },

  onboard: async (args) => {
    if (await handleDisclosureSubmit(args, 'onboard')) {
      return;
    }

    // ── No --submit: same as quickstart ───────────────────────
    return commands.quickstart(args);
  },

  version: () => {
    const pkg = require('../package.json');
    console.log(pkg.version);
  },

  help: () => {
    console.log(`A2A Calling - Agent-to-Agent Communication

Usage: a2a <command> [options]

Commands:
  create              Create an A2A token
    --name, -n        Token/agent name
    --owner, -o       Owner name (human behind the agent)
    --expires, -e     Expiration (1h, 1d, 7d, 30d, never)
    --permissions, -p Tier (public, friends, family)
    --topics          Custom topics (comma-separated, overrides tier defaults)
    --disclosure, -d  Disclosure level (public, minimal, none)
    --notify          Owner notification (all, summary, none)
    --max-calls       Maximum invocations (default: 100)
    --link, -l        Auto-link to contact name

  list                List active tokens
  revoke <id>         Revoke a token

Contacts:
  contacts            List all contacts (shows permission badges)
  contacts add <url>  Add a contact
    --name, -n        Agent name
    --owner, -o       Owner name
    --server-name     Server label (optional)
    --notes           Notes about this contact
    --tags            Comma-separated tags
    --link            Link to token ID you gave them
  contacts show <n>   Show contact details + linked token
  contacts edit <n>   Edit contact metadata
    --server-name     Server label (optional)
  contacts link <n> <tok>  Link a token to a contact
  contacts ping <n>   Ping contact, update status
  contacts rm <n>     Remove contact

Permission badges: 🌐 public  🔧 friends  ⚡ family

Conversations:
  conversations       List all conversations
    --contact         Filter by contact
    --status          Filter by status (active, concluded, timeout)
    --limit           Max results (default: 20)
  conversations show <id>  Show conversation with messages
    --messages        Number of recent messages (default: 20)
  conversations end <id>   End and summarize conversation

Calling:
  call <contact|url> <msg>  Call a contact (multi-turn by default)
    --single          Single-turn call (one message, one response)
    --min-turns N     Minimum turns before close (default: 8)
    --max-turns N     Maximum turns (default: 25)
  ping <url>          Check if agent is reachable
  status <url>        Get A2A status
  gui                 Open the local dashboard GUI in a browser
    --tab, -t         Optional: contacts|calls|logs|settings|invites

Server:
  server              Start the A2A server
    --port, -p        Port to listen on (default: 3001)
  
  quickstart          Set up A2A server and start onboarding
    --port, -p        Preferred server port (default: 80, fallback: 3001+)
    --submit '<json>' Submit disclosure JSON (Step 3 of onboarding)
    --force           Reset onboarding and re-run from scratch

  onboard             Submit disclosure topics or resume quickstart
    --submit '<json>' Submit disclosure JSON (Step 3 of onboarding)
    --name            Agent name for invite generation
    --force           Re-run even if already onboarded

  update              Update A2A to latest version (npm or git pull)
    --check, -c       Check for updates without installing

  install             Install A2A for OpenClaw
  setup               Auto setup (gateway-aware dashboard install)
  uninstall           Stop server and remove local config/DB
    --keep-config     Preserve config/DB (for reinstall)
    --force           Skip confirmation prompt
  version             Show installed package version

Examples:
  a2a create --name "bappybot" --owner "Benjamin Pollack" --expires 7d
  a2a create --name "custom" --topics "chat,calendar.read,email.read"
  a2a contacts add a2a://host/fed_xxx --name "Alice" --owner "Alice Chen"
  a2a contacts link Alice tok_abc123
  a2a call Alice "Hello!"
  a2a conversations show conv_abc123
  a2a server --port 3001
`);
  }
};

// Main
const args = parseArgs(process.argv);

// Handle --version flag before command dispatch (standard CLI convention)
if (args.flags.version || args.flags.v) {
  commands.version();
  process.exit(0);
}

const command = args._[0] || 'help';

if (!commands[command]) {
  console.error(`Unknown command: ${command}`);
  console.log('Run "a2a help" for usage.');
  process.exit(1);
}

// If onboarding is incomplete, enforceOnboarding runs quickstart inline
// (verbose, full output) and returns a Promise. Otherwise returns undefined
// and we proceed to the requested command.
const onboardResult = enforceOnboarding(command);
if (onboardResult instanceof Promise) {
  onboardResult.catch(err => {
    console.error(err.message);
    process.exit(1);
  });
} else {
  const result = commands[command](args);
  if (result instanceof Promise) {
    result.catch(err => {
      console.error(err.message);
      process.exit(1);
    });
  }
}
