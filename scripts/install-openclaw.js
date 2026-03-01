#!/usr/bin/env node
/**
 * A2A Calling Setup Installer
 *
 * Supports automatic setup:
 * - If OpenClaw gateway is detected, install a gateway HTTP proxy plugin
 *   so dashboard and A2A API are accessible at /a2a and /api/a2a on gateway.
 * - If gateway is not detected, dashboard runs on standalone A2A server.
 * - If OpenClaw is not installed, bootstrap standalone runtime templates.
 * - Networking-aware: inspects port 80 and prints reverse proxy guidance
 *   for stable internet-facing ingress.
 *
 * Usage:
 *   npx a2acalling install
 *   npx a2acalling setup
 *   npx a2acalling install --hostname myserver.com --port 3001
 *   npx a2acalling uninstall
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { execSync } = require('child_process');

// Paths
const OPENCLAW_CONFIG = process.env.OPENCLAW_CONFIG || path.join(process.env.HOME, '.openclaw', 'openclaw.json');
const OPENCLAW_SKILLS = process.env.OPENCLAW_SKILLS || path.join(process.env.HOME, '.openclaw', 'skills');
const OPENCLAW_EXTENSIONS = process.env.OPENCLAW_EXTENSIONS || path.join(process.env.HOME, '.openclaw', 'extensions');
const SKILL_NAME = 'a2a';
const DASHBOARD_PLUGIN_ID = 'a2a-dashboard-proxy';

// Parse args
const args = process.argv.slice(2);
const command = args[0];
const flags = {};
for (let i = 1; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    const key = args[i].slice(2);
    flags[key] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
  }
}

// Colors
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

function log(msg) { console.log(`${green('[a2a]')} ${msg}`); }
function warn(msg) { console.log(`${yellow('[a2a]')} ${msg}`); }
function error(msg) { console.error(`${red('[a2a]')} ${msg}`); }

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function commandExists(cmd) {
  try {
    execSync(`command -v ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch (err) {
    return false;
  }
}

function loadOpenClawConfig() {
  if (!fs.existsSync(OPENCLAW_CONFIG)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(OPENCLAW_CONFIG, 'utf8'));
  } catch (err) {
    warn(`OpenClaw config is unreadable: ${err.message}`);
    return null;
  }
}

function writeOpenClawConfig(config) {
  const backupPath = `${OPENCLAW_CONFIG}.backup.${Date.now()}`;
  fs.copyFileSync(OPENCLAW_CONFIG, backupPath);
  fs.writeFileSync(OPENCLAW_CONFIG, JSON.stringify(config, null, 2));
  log(`Backed up config to: ${backupPath}`);
  log('Updated OpenClaw config');
}

function detectGateway(config) {
  const hasGatewayBlock = Boolean(config?.gateway);
  // Treat the presence of a gateway block in config as "gateway mode" even if
  // the `openclaw` binary is not on PATH (e.g., CI, remote provisioning, or
  // minimal environments). We still want to migrate config + install the proxy
  // plugin in those cases.
  return hasGatewayBlock;
}

function resolveGatewayBaseUrl() {
  if (flags['gateway-url']) {
    return String(flags['gateway-url']).replace(/\/+$/, '');
  }

  try {
    const output = execSync('openclaw dashboard --no-open', {
      encoding: 'utf8',
      timeout: 8000,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const match = output.match(/Dashboard URL:\s*(\S+)/);
    if (match && match[1]) {
      const parsed = new URL(match[1]);
      return `${parsed.protocol}//${parsed.host}`;
    }
  } catch (err) {
    // fall through to default
  }

  const fallbackPort = process.env.OPENCLAW_GATEWAY_PORT || '18789';
  return `http://127.0.0.1:${fallbackPort}`;
}

function resolveA2AConfigDir() {
  return process.env.A2A_CONFIG_DIR ||
    process.env.OPENCLAW_CONFIG_DIR ||
    path.join(process.env.HOME || '/tmp', '.config', 'openclaw');
}

function safeRead(filePath) {
  try {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  } catch (err) {
    return '';
  }
}

function writeExecutableFile(filePath, content) {
  fs.writeFileSync(filePath, content, { mode: 0o755 });
  try {
    fs.chmodSync(filePath, 0o755);
  } catch (err) {
    // Non-fatal on platforms without chmod support.
  }
}

/**
 * Ensure config and disclosure manifest exist.
 * Called from both OpenClaw and standalone install paths.
 */
function ensureConfigAndManifest(inviteHost, port, options = {}) {
  const configDir = resolveA2AConfigDir();
  ensureDir(configDir);

  try {
    const { A2AConfig } = require('../src/lib/config');
    const { loadManifest, saveManifest, generateDefaultManifest } = require('../src/lib/disclosure');

    const config = new A2AConfig();
    const defaults = config.getDefaults() || {};
    config.setDefaults(defaults);

    const agent = config.getAgent() || {};
    const desiredHost = String(inviteHost || '').trim();
    if ((desiredHost && !agent.hostname) || (desiredHost && options.forceHostname)) {
      config.setAgent({ hostname: desiredHost });
    }

    const manifest = loadManifest();
    if (!manifest || Object.keys(manifest).length === 0) {
      const generated = generateDefaultManifest();
      saveManifest(generated);
      const manifestFile = path.join(configDir, 'a2a-disclosure.json');
      log(`Generated default disclosure manifest: ${manifestFile}`);
    }
  } catch (err) {
    warn(`Config/manifest bootstrap failed: ${err.message}`);
  }

  return configDir;
}

function ensureStandaloneBootstrap(inviteHost, port, options = {}) {
  const configDir = ensureConfigAndManifest(inviteHost, port, options);

  const configFile = path.join(configDir, 'a2a-config.json');
  const manifestFile = path.join(configDir, 'a2a-disclosure.json');

  const bridgeDir = path.join(configDir, 'runtime-bridge');
  ensureDir(bridgeDir);
  const turnScript = path.join(bridgeDir, 'a2a-turn.sh');
  const summaryScript = path.join(bridgeDir, 'a2a-summary.sh');
  const notifyScript = path.join(bridgeDir, 'a2a-notify.sh');

  if (!fs.existsSync(turnScript)) {
    writeExecutableFile(turnScript, `#!/usr/bin/env bash
set -euo pipefail
payload="$(cat || true)"
echo '{"response":"Generic bridge placeholder: your agent bridge is active. I received your message and can continue the call. What collaboration outcome should we target?"}'
`);
  }

  if (!fs.existsSync(summaryScript)) {
    writeExecutableFile(summaryScript, `#!/usr/bin/env bash
set -euo pipefail
payload="$(cat || true)"
echo '{"summary":"Generic summary placeholder generated by standalone bridge.","ownerSummary":"Generic summary placeholder generated by standalone bridge."}'
`);
  }

  if (!fs.existsSync(notifyScript)) {
    writeExecutableFile(notifyScript, `#!/usr/bin/env bash
set -euo pipefail
payload="$(cat || true)"
echo "a2a notify: $payload" >&2
`);
  }

  // Install SKILL.md so standalone agents can discover it
  const skillsDir = path.join(configDir, 'skills', SKILL_NAME);
  ensureDir(skillsDir);
  const skillContent = loadSkillMd();
  if (skillContent) {
    fs.writeFileSync(path.join(skillsDir, 'SKILL.md'), skillContent);
    log(`Installed skill to: ${skillsDir}`);
  }

  let generatedAdminToken = null;
  if (!process.env.A2A_ADMIN_TOKEN) {
    generatedAdminToken = crypto.randomBytes(24).toString('base64url');
  }

  return {
    configDir,
    configFile,
    manifestFile,
    skillsDir,
    bridgeDir,
    turnScript,
    summaryScript,
    notifyScript,
    generatedAdminToken
  };
}

const DASHBOARD_PLUGIN_MANIFEST = {
  id: DASHBOARD_PLUGIN_ID,
  name: 'A2A Gateway Proxy',
  description: 'Proxy A2A API + dashboard routes through OpenClaw gateway (backend runs separately)',
  version: '1.0.0',
  configSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      backendUrl: {
        type: 'string',
        default: 'http://127.0.0.1:3001'
      }
    }
  }
};

const DASHBOARD_PLUGIN_TS = `import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { IncomingMessage, ServerResponse } from "node:http";
import http from "node:http";
import https from "node:https";

const PLUGIN_ID = "a2a-dashboard-proxy";
const UI_PREFIX = "/a2a";
const API_PREFIX = "/api/a2a";

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function sendHtml(res: ServerResponse, status: number, html: string) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(html);
}

function resolveBackendUrl(api: OpenClawPluginApi): URL {
  const fallback = process.env.A2A_DASHBOARD_BACKEND_URL || "http://127.0.0.1:3001";
  const pluginConfigRaw = (api as OpenClawPluginApi & { pluginConfig?: unknown }).pluginConfig;
  const pluginConfig = (pluginConfigRaw && typeof pluginConfigRaw === "object")
    ? (pluginConfigRaw as Record<string, unknown>)
    : {};
  const configuredUrl = typeof pluginConfig.backendUrl === "string" && pluginConfig.backendUrl
    ? pluginConfig.backendUrl
    : "";
  if (configuredUrl) {
    return new URL(configuredUrl);
  }
  try {
    const cfg = api.runtime.config.loadConfig() as Record<string, unknown>;
    const plugins = (cfg.plugins || {}) as Record<string, unknown>;
    const entries = (plugins.entries || {}) as Record<string, unknown>;
    const pluginEntry = (entries[PLUGIN_ID] || {}) as Record<string, unknown>;
    const entryConfig = (pluginEntry.config || {}) as Record<string, unknown>;
    const candidate = typeof entryConfig.backendUrl === "string" && entryConfig.backendUrl
      ? entryConfig.backendUrl
      : fallback;
    return new URL(candidate);
  } catch {
    return new URL(fallback);
  }
}

function rewriteUiPath(pathname: string): string {
  if (pathname === UI_PREFIX || pathname === UI_PREFIX + "/") {
    return "/dashboard/";
  }
  if (pathname.startsWith(UI_PREFIX + "/")) {
    return "/dashboard/" + pathname.slice((UI_PREFIX + "/").length);
  }
  return pathname;
}

const plugin = {
  id: PLUGIN_ID,
  name: "A2A Gateway Proxy",
  description: "Proxy A2A API + dashboard routes through OpenClaw gateway (backend runs separately)",
  configSchema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      backendUrl: {
        type: "string" as const,
        default: "http://127.0.0.1:3001"
      }
    }
  },
  register(api: OpenClawPluginApi) {
    api.registerHttpHandler(async (req: IncomingMessage, res: ServerResponse) => {
      const incoming = new URL(req.url ?? "/", \`http://\${req.headers.host ?? "localhost"}\`);
      const isUi = incoming.pathname === UI_PREFIX || incoming.pathname.startsWith(UI_PREFIX + "/");
      const isApi = incoming.pathname === API_PREFIX || incoming.pathname.startsWith(API_PREFIX + "/");
      if (!isUi && !isApi) {
        return false;
      }

      if (incoming.pathname === UI_PREFIX) {
        res.statusCode = 302;
        res.setHeader("Location", UI_PREFIX + "/");
        res.end();
        return true;
      }

      const backendBase = resolveBackendUrl(api);
      const rewrittenPath = isUi ? rewriteUiPath(incoming.pathname) : incoming.pathname;
      const target = new URL(rewrittenPath + (incoming.search || ""), backendBase);
      const client = target.protocol === "https:" ? https : http;

      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (!value || key.toLowerCase() === "host") continue;
        headers[key] = Array.isArray(value) ? value.join(", ") : String(value);
      }
      headers["x-forwarded-by"] = "a2a-dashboard-proxy";

      const proxyReq = client.request({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: target.pathname + target.search,
        method: req.method,
        headers
      }, (proxyRes) => {
        res.statusCode = proxyRes.statusCode || 502;
        Object.entries(proxyRes.headers).forEach(([key, value]) => {
          if (value !== undefined) {
            res.setHeader(key, value as string | string[]);
          }
        });
        proxyRes.pipe(res);
      });

      proxyReq.on("error", (err) => {
        const backend = backendBase.toString();
        const suggestedPort = backendBase.port || (backendBase.protocol === "https:" ? "443" : "80");
        if (isApi) {
          sendJson(res, 502, {
            success: false,
            error: "a2a_backend_unreachable",
            message: \`Could not reach A2A backend at \${backend}: \${err.message}\`
          });
          return;
        }

        sendHtml(res, 502, \`<!doctype html>
<html><head><meta charset="utf-8"><title>A2A Dashboard</title></head>
<body style="font-family: sans-serif; padding: 2rem;">
  <h1>A2A Dashboard Unavailable</h1>
  <p>The gateway proxy is active, but the A2A backend is not reachable.</p>
  <p>Expected backend: <code>\${backend}</code></p>
  <p>Start the backend with: <code>a2a server --port \${suggestedPort}</code></p>
</body></html>\`);
      });

      req.pipe(proxyReq);
      return true;
    });
  }
};

export default plugin;
`;

function installDashboardProxyPlugin(backendUrl) {
  ensureDir(OPENCLAW_EXTENSIONS);
  const pluginDir = path.join(OPENCLAW_EXTENSIONS, DASHBOARD_PLUGIN_ID);
  ensureDir(pluginDir);

  fs.writeFileSync(
    path.join(pluginDir, 'openclaw.plugin.json'),
    JSON.stringify(DASHBOARD_PLUGIN_MANIFEST, null, 2)
  );
  fs.writeFileSync(path.join(pluginDir, 'index.ts'), DASHBOARD_PLUGIN_TS);

  log(`Installed gateway dashboard plugin: ${pluginDir}`);
  log(`Dashboard proxy backend: ${backendUrl}`);
  return pluginDir;
}

// Skill content — read from the canonical SKILL.md that ships with the package.
// No embedded copy to drift out of sync.
const SKILL_MD_PATH = path.resolve(__dirname, '..', 'SKILL.md');

function loadSkillMd() {
  if (fs.existsSync(SKILL_MD_PATH)) {
    return fs.readFileSync(SKILL_MD_PATH, 'utf8');
  }
  warn(`SKILL.md not found at ${SKILL_MD_PATH}`);
  warn('The a2acalling package may be incomplete. Run: a2a update');
  return null;
}

function readExistingConfiguredInviteHost() {
  try {
    const { A2AConfig } = require('../src/lib/config');
    const { splitHostPort, isLocalOrUnroutableHost } = require('../src/lib/invite-host');
    const config = new A2AConfig();
    const existing = String((config.getAgent() || {}).hostname || '').trim();
    if (!existing) return '';
    const parsed = splitHostPort(existing);
    if (!parsed.hostname || isLocalOrUnroutableHost(parsed.hostname)) {
      return '';
    }
    return existing;
  } catch (err) {
    return '';
  }
}

function safeJsonParse(text) {
  try {
    return JSON.parse(String(text || ''));
  } catch (err) {
    return null;
  }
}

function looksLikePong(body) {
  const parsed = safeJsonParse(body);
  if (parsed && typeof parsed === 'object' && parsed.pong === true) return true;
  return String(body || '').includes('"pong":true') || String(body || '').includes('"pong": true');
}

function fetchUrlText(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      reject(new Error('invalid_url'));
      return;
    }

    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      method: 'GET',
      path: parsed.pathname + parsed.search,
      headers: {
        'User-Agent': `a2acalling/${process.env.npm_package_version || 'dev'} (setup-check)`
      },
      timeout: timeoutMs
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');

      res.on('data', (chunk) => {
        data += chunk;
        if (data.length > 1024 * 256) {
          req.destroy(new Error('response_too_large'));
        }
      });

      res.on('end', () => {
        resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers || {},
          body: data
        });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

async function probeLocalA2APing(port) {
  try {
    const res = await fetchUrlText(`http://127.0.0.1:${port}/api/a2a/ping`, 900);
    return { ok: looksLikePong(res.body), statusCode: res.statusCode, body: res.body };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : 'request_failed' };
  }
}

async function scanPort80() {
  const { isPortListening, tryBindPort } = require('../src/lib/port-scanner');

  const listening = await isPortListening(80, '127.0.0.1', { timeoutMs: 500 });
  const bind = await tryBindPort(80, '0.0.0.0');
  const a2aPing = listening.listening ? await probeLocalA2APing(80) : { ok: false };

  return {
    listening: Boolean(listening.listening),
    listeningCode: listening.code,
    bindOk: Boolean(bind.ok),
    bindCode: bind.code,
    a2aPingOk: Boolean(a2aPing.ok),
    a2aPingStatusCode: a2aPing.statusCode,
    a2aPingError: a2aPing.error
  };
}

async function externalPingCheck(targetUrl) {
  const providers = [
    {
      name: 'allorigins',
      buildUrl: () => {
        const u = new URL('https://api.allorigins.win/raw');
        u.searchParams.set('url', targetUrl);
        return u.toString();
      }
    },
    {
      name: 'jina',
      buildUrl: () => `https://r.jina.ai/${targetUrl}`
    }
  ];

  const attempts = [];
  for (const provider of providers) {
    const providerUrl = provider.buildUrl();
    try {
      // eslint-disable-next-line no-await-in-loop
      const res = await fetchUrlText(providerUrl, 8000);
      const ok = looksLikePong(res.body);
      attempts.push({ provider: provider.name, ok, statusCode: res.statusCode });
      if (ok) {
        return { ok: true, provider: provider.name, statusCode: res.statusCode, attempts };
      }
    } catch (err) {
      attempts.push({ provider: provider.name, ok: false, error: err && err.message ? err.message : 'request_failed' });
    }
  }

  return { ok: false, attempts };
}

async function install() {
  log('Installing A2A Calling...\n');

  const localHostname = process.env.HOSTNAME || 'localhost';

  // Networking scan (port 80) + backend port selection.
  const port80 = await scanPort80();
  if (port80.a2aPingOk) {
    log('Port 80 already serves /api/a2a/ping (A2A detected on :80).');
  } else if (port80.listening) {
    warn(`Port 80 is already bound (${port80.listeningCode || 'in_use'}). Setup will use an internal port and recommend reverse proxy routing.`);
  } else if (!port80.bindOk && port80.bindCode === 'EACCES') {
    warn('Port 80 appears free but is not bindable by this user (EACCES). Setup will use an unprivileged port unless you run with elevated privileges.');
  } else if (port80.bindOk) {
    log('Port 80 is bindable by this user (recommended for inbound A2A if you intend to serve directly on :80).');
  }

  let backendPort = null;
  if (flags.port) {
    backendPort = Number.parseInt(String(flags.port), 10);
  } else if (process.env.A2A_PORT) {
    backendPort = Number.parseInt(String(process.env.A2A_PORT), 10);
  } else {
    if (port80.bindOk && !port80.listening) {
      backendPort = 80;
    } else {
      try {
        const { findAvailablePort } = require('../src/lib/port-scanner');
        backendPort = await findAvailablePort([3001, 8080, 8443, 9001]);
      } catch (e) {
        backendPort = null;
      }
      if (!backendPort) {
        backendPort = 3001;
      }
      log(`Auto-detected available internal port: ${backendPort}`);
    }
  }
  if (!Number.isFinite(backendPort) || backendPort <= 0 || backendPort > 65535) {
    backendPort = 3001;
  }

  const backendUrl = flags['dashboard-backend'] || `http://127.0.0.1:${backendPort}`;

  // Invite host selection: explicit > existing configured public host > auto resolve to external IP.
  const explicitInviteHost = flags.hostname ||
    process.env.A2A_HOSTNAME ||
    process.env.OPENCLAW_HOSTNAME ||
    readExistingConfiguredInviteHost();

  let inviteHost = explicitInviteHost;
  let inviteHostWarnings = [];

  if (!inviteHost) {
    try {
      const { A2AConfig } = require('../src/lib/config');
      const { resolveInviteHost } = require('../src/lib/invite-host');
      const config = new A2AConfig();
      const inviteDefaultPort = port80.listening ? 80 : backendPort;
      const resolved = await resolveInviteHost({
        config,
        fallbackHost: localHostname,
        defaultPort: inviteDefaultPort,
        refreshExternalIp: true
      });
      inviteHost = resolved.host;
      inviteHostWarnings = resolved.warnings || [];
    } catch (err) {
      inviteHost = `${localHostname}:${backendPort}`;
    }
  }

  for (const w of inviteHostWarnings) {
    warn(w);
  }

  // Network diagnostics: fetch the current egress IP via the same mechanism used for invite host resolution.
  // This is extremely useful during install to separate "networking/ingress" issues from "code" issues.
  let externalIpProbe = null;
  try {
    const { getExternalIp } = require('../src/lib/external-ip');
    // Force refresh so we can surface "blocked outbound HTTPS/DNS" problems during setup.
    externalIpProbe = await getExternalIp({ timeoutMs: 2500, forceRefresh: true });
  } catch (err) {
    externalIpProbe = {
      ip: null,
      error: err && err.message ? err.message : 'external_ip_probe_failed'
    };
  }
  const externalIpSummary = (externalIpProbe && externalIpProbe.ip)
    ? `${externalIpProbe.ip}${externalIpProbe.source ? ` (source: ${externalIpProbe.source})` : ''}` +
      `${externalIpProbe.fromCache ? ' [cache]' : ''}${externalIpProbe.stale ? ' [stale]' : ''}`
    : `FAILED${externalIpProbe && externalIpProbe.error ? ` (${externalIpProbe.error})` : ''}`;
  const externalIpAttempts = (externalIpProbe && Array.isArray(externalIpProbe.attempts))
    ? externalIpProbe.attempts
    : [];

  const forceStandalone = Boolean(flags.standalone) || String(process.env.A2A_FORCE_STANDALONE || '').toLowerCase() === 'true';
  const hasOpenClawBinary = commandExists('openclaw');
  const hasOpenClawConfig = fs.existsSync(OPENCLAW_CONFIG);
  const hasOpenClaw = !forceStandalone && (hasOpenClawBinary || hasOpenClawConfig);
  let standaloneBootstrap = null;
  const forceHostname = Boolean(flags.hostname || process.env.A2A_HOSTNAME || process.env.OPENCLAW_HOSTNAME) || !explicitInviteHost;

  if (hasOpenClaw) {
    // 1. Create skills directory if needed
    ensureDir(OPENCLAW_SKILLS);

    // 2. Install skill
    const skillDir = path.join(OPENCLAW_SKILLS, SKILL_NAME);
    ensureDir(skillDir);
    const skillContent = loadSkillMd();
    if (skillContent) {
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillContent);
    } else {
      warn('Skipped SKILL.md install — source file not found in package.');
    }
    log(`Installed skill to: ${skillDir}`);

    // Ensure config and manifest exist even in OpenClaw path
    ensureConfigAndManifest(inviteHost, backendPort, {
      forceHostname
    });
  } else {
    warn('OpenClaw not detected. Enabling standalone A2A bootstrap.');
    standaloneBootstrap = ensureStandaloneBootstrap(inviteHost, backendPort, {
      forceHostname
    });
  }

  // 3. Update OpenClaw config + gateway plugin setup (if available)
  let config = loadOpenClawConfig();
  let configUpdated = false;
  let gatewayDetected = false;
  let dashboardMode = 'standalone';
  let dashboardUrl = `http://${localHostname}:${backendPort}/dashboard`;

  if (config) {
    // Add custom command for each enabled channel
    const channels = ['telegram', 'discord', 'slack'];
    for (const channel of channels) {
      if (config.channels?.[channel]?.enabled) {
        if (!config.channels[channel].customCommands) {
          config.channels[channel].customCommands = [];
        }
        const existing = config.channels[channel].customCommands.find(c => c.command === 'a2a');
        if (!existing) {
          config.channels[channel].customCommands.push({
            command: 'a2a',
            description: 'Agent-to-Agent: create invitations, manage connections'
          });
          configUpdated = true;
          log(`Added /a2a command to ${channel} config`);
        } else {
          log(`/a2a command already exists in ${channel} config`);
        }
      }
    }

    gatewayDetected = detectGateway(config);
    if (gatewayDetected) {
      dashboardMode = 'gateway';
      installDashboardProxyPlugin(backendUrl);
      const gatewayBaseUrl = resolveGatewayBaseUrl();
      dashboardUrl = `${gatewayBaseUrl.replace(/\/+$/, '')}/a2a`;

      config.plugins = config.plugins || {};
      config.plugins.entries = config.plugins.entries || {};
      const rawEntry = config.plugins.entries[DASHBOARD_PLUGIN_ID];
      const existingEnabled = (rawEntry && typeof rawEntry.enabled === 'boolean') ? rawEntry.enabled : true;
      const existingConfig = (rawEntry && rawEntry.config && typeof rawEntry.config === 'object') ? rawEntry.config : {};
      config.plugins.entries[DASHBOARD_PLUGIN_ID] = {
        enabled: existingEnabled,
        config: {
          ...existingConfig,
          backendUrl
        }
      };
      configUpdated = true;
      log(`Configured gateway plugin entry: ${DASHBOARD_PLUGIN_ID}`);
    }

    if (configUpdated) {
      writeOpenClawConfig(config);
      warn('Restart OpenClaw gateway to apply changes: openclaw gateway restart');
    }
  } else {
    warn(`OpenClaw config not found at: ${OPENCLAW_CONFIG}`);
    warn('Skipping OpenClaw command/plugin config updates');
  }

  const runtimeLine = forceStandalone
    ? 'Runtime forced to standalone mode for this setup run.'
    : hasOpenClawBinary
    ? 'Runtime auto-selects OpenClaw when available and falls back to test mode if needed.'
    : 'Runtime defaults to test mode (no OpenClaw dependency required).';

  const { splitHostPort, isLocalOrUnroutableHost } = require('../src/lib/invite-host');
  const inviteParsed = splitHostPort(inviteHost);
  const invitePort = inviteParsed.port;
  const inviteScheme = (!invitePort || invitePort === 443) ? 'https' : 'http';
  const invitePingUrl = `${inviteScheme}://${inviteHost}/api/a2a/ping`;
  const inviteLooksLocal = isLocalOrUnroutableHost(inviteParsed.hostname);
  const expectsReverseProxy = Boolean(
    (invitePort === 80 && backendPort !== 80) ||
    ((!invitePort || invitePort === 443) && backendPort !== 443)
  );

  let externalPing = null;
  if (!inviteLooksLocal && inviteParsed.hostname) {
    externalPing = await externalPingCheck(invitePingUrl);
  }

  console.log(`
${bold('━━━ Server Setup ━━━')}

To receive incoming calls and host A2A APIs:

  ${green(`A2A_HOSTNAME="${inviteHost}" a2a server --port ${backendPort}`)}

${bold('━━━ Ingress Setup ━━━')}

Invite host: ${green(inviteHost)}
Expected ping URL: ${green(invitePingUrl)}

External IP probe (egress):
  ${externalIpProbe && externalIpProbe.source && String(externalIpProbe.source).includes('ifconfig.me')
    ? green('ifconfig.me')
    : 'external-ip resolver'} → ${externalIpProbe && externalIpProbe.ip ? green(externalIpSummary) : yellow(externalIpSummary)}
${externalIpAttempts.length
  ? `  Attempts:
${externalIpAttempts.map(a => {
  const service = a && a.service ? String(a.service) : '-';
  const ok = Boolean(a && a.ok);
  const status = a && a.statusCode ? ` (${a.statusCode})` : '';
  const err = a && a.error ? ` (${a.error})` : '';
  return `    - ${service}: ${ok ? 'ok' + status : 'failed' + err}`;
}).join('\n')}`
  : ''}

Port 80 scan:
  ${port80.a2aPingOk
    ? green('Port 80 responds to /api/a2a/ping (A2A ready on :80)')
    : port80.listening
    ? yellow(`Port 80 has a listener (${port80.listeningCode || 'in_use'})`)
    : port80.bindOk
    ? green('Port 80 is free and bindable by this user')
    : yellow(`Port 80 not bindable (${port80.bindCode || 'unknown'})`)}

${expectsReverseProxy
  ? `Reverse proxy required:
  Route ${green('/api/a2a/*')} -> ${green(backendUrl)}
  Route ${green('/a2a/*')} -> ${green(backendUrl.replace(/\/$/, ''))}${green('/dashboard/*')} (optional dashboard)

  Example (Caddy):
  ${green(`YOUR_DOMAIN {
    handle /api/a2a/* {
      reverse_proxy 127.0.0.1:${backendPort}
    }
    handle /a2a* {
      uri replace /a2a /dashboard
      reverse_proxy 127.0.0.1:${backendPort}
    }
  }`)}

  Example (nginx):
  ${green(`location /api/a2a/ {
    proxy_pass http://127.0.0.1:${backendPort}/api/a2a/;
  }
  location = /a2a { return 301 /a2a/; }
  location /a2a/ {
    proxy_pass http://127.0.0.1:${backendPort}/dashboard/;
  }`)}`
  : 'Reverse proxy not required for the selected invite host.'}

${bold('━━━ External Ping ━━━')}

${inviteLooksLocal
  ? yellow('Skipped external ping: invite host looks local/unroutable. Set --hostname to a public endpoint to enable this check.')
  : externalPing && externalPing.ok
  ? green(`External ping OK via ${externalPing.provider}`)
  : yellow(`External ping FAILED (expected if the server is not running yet, or ingress is not publicly reachable).`)}

${bold('━━━ Debug Quick Checks ━━━')}

On the server:
  ${green(`curl -s http://127.0.0.1:${backendPort}/api/a2a/status`)}
  ${green('curl -s https://ifconfig.me/ip')}

From a remote machine (tests ingress):
  ${green(`curl -s ${inviteScheme}://${inviteHost}/api/a2a/status`)}

If calls fail, check the dashboard logs:
  Open ${green(dashboardUrl)} -> Logs

${bold('━━━ Dashboard Setup ━━━')}

Mode: ${dashboardMode === 'gateway' ? green('gateway') : yellow('standalone')}
Dashboard URL: ${green(dashboardUrl)}

${dashboardMode === 'gateway'
  ? `Gateway paths /a2a and /api/a2a/* are now proxied to ${backendUrl}.`
  : 'No gateway detected. Dashboard is served directly from the A2A server.'}

${bold('━━━ Runtime Setup ━━━')}

${runtimeLine}
${standaloneBootstrap
  ? `Standalone bridge templates:
  ${green(standaloneBootstrap.turnScript)}
  ${green(standaloneBootstrap.summaryScript)}
  ${green(standaloneBootstrap.notifyScript)}

Optional bridge wiring:
  export A2A_RUNTIME=test
  export A2A_AGENT_COMMAND="${standaloneBootstrap.turnScript}"
${standaloneBootstrap.generatedAdminToken ? `
Suggested dashboard admin token (set in env, do not commit):
  export A2A_ADMIN_TOKEN="${standaloneBootstrap.generatedAdminToken}"` : ''}`
  : 'No standalone bridge templates were created because OpenClaw was detected.'}

${bold('━━━ Usage ━━━')}

In your chat app, use:

  /a2a quickstart     REQUIRED first step: owner sets permission tiers
  /a2a invite         Create an invitation token
  /a2a list           List active tokens
  /a2a revoke <id>    Revoke a token
  /a2a add <url>      Add a contact
  /a2a call <url> <msg>  Call a contact

${bold('━━━ Done! ━━━')}

${green('✅ A2A Calling installed successfully!')}
`);
}

function uninstall() {
  log('Uninstalling A2A Calling...\n');

  const skillDir = path.join(OPENCLAW_SKILLS, SKILL_NAME);
  if (fs.existsSync(skillDir)) {
    fs.rmSync(skillDir, { recursive: true });
    log(`Removed skill from: ${skillDir}`);
  }

  const pluginDir = path.join(OPENCLAW_EXTENSIONS, DASHBOARD_PLUGIN_ID);
  if (fs.existsSync(pluginDir)) {
    fs.rmSync(pluginDir, { recursive: true });
    log(`Removed dashboard plugin: ${pluginDir}`);
  }

  warn('Custom command and plugin entries in OpenClaw config were not removed.');
  warn('You can remove them manually if desired.');

  log('✅ Uninstall complete');
}

function showHelp() {
  console.log(`
${bold('A2A Calling Setup')}

Usage:
  npx a2acalling install [options]    Install A2A (OpenClaw-aware + standalone)
  npx a2acalling setup [options]      Alias for install (auto runtime detection)
  npx a2acalling uninstall            Remove A2A skill + dashboard plugin
  npx a2acalling server               Start A2A server

Install Options:
  --hostname <host>          Public hostname for invite URLs (e.g. myserver.com, myserver.com:80)
  --port <port>              A2A server port (default: 3001)
  --gateway-url <url>        Force gateway base URL for printed dashboard link
  --dashboard-backend <url>  Backend URL used by gateway dashboard proxy
  --standalone               Force standalone bootstrap (ignore OpenClaw detection)

Examples:
  npx a2acalling install --hostname myserver.com --port 3001
  npx a2acalling setup --dashboard-backend http://127.0.0.1:3001
  npx a2acalling setup --standalone
  npx a2acalling uninstall
`);
}

// Main
switch (command) {
  case 'install':
  case 'setup':
    install().catch(err => {
      error(`Install failed: ${err.message}`);
      process.exit(1);
    });
    break;
  case 'uninstall':
    uninstall();
    break;
  case 'help':
  case '--help':
  case '-h':
    showHelp();
    break;
  default:
    if (command) {
      error(`Unknown command: ${command}`);
    }
    showHelp();
    process.exit(command ? 1 : 0);
}
