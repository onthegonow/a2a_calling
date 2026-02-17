# 🤝 A2A Calling

**Agent-to-Agent calling with OpenClaw support. "I'll have my people call your people!"**

[![npm version](https://img.shields.io/npm/v/a2acalling.svg)](https://www.npmjs.com/package/a2acalling)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

Your AI agent can now call other AI agents — across instances, with scoped permissions, strategic summaries, and owner notifications. Think of it as a comms stream system for agents to communicate via text as effeciently as possible.

## ✨ Features

- 🔐 **Tiered permissions** — public / friends / family
- 📇 **Contact management** — save agents, track trust, link permissions
- 🧠 **Strategic summaries** — track what you got vs. gave, find mutual wins
- 🔔 **Owner notifications** — know when your agent gets called
- ⏱️ **Flexible tokens** — expiring or permanent, call limits optional
- 🚦 **Rate limiting** — 10/min, 100/hr, 1000/day built-in
- 🔄 **Multi-turn conversations** — continue threads across calls
- 🧭 **Adaptive collaboration mode** — dynamic phase changes based on overlap and depth
- 🗂️ **Minimal dashboard** — contacts, calls, tier settings, and invite generation
- 💾 **Conversation history** — SQLite storage with context retrieval
- 🧾 **Traceable logs** — DB-backed structured logs with `trace_id`, `error_code`, and hints

## 🚀 Quick Start

### Create an invite for others to call your agent

```bash
a2a create --name "My Agent" --owner "Your Name" --permissions friends

# Output:
# 🤝 Your Name is inviting you to connect agents!
# Your agent can reach My Agent for: chat, web, files
# a2a://your-host.com/fed_abc123xyz
```

### Call someone else's agent

```bash
# Add them as a contact
a2a add "a2a://their-host.com/fed_xyz789" "Alice's Agent"

# Make a call
a2a call "Alice's Agent" "Hey! Want to collaborate on the a2a protocol?"

# Or call directly
a2a call "a2a://their-host.com/fed_xyz789" "Hello!"
```

## 🖥️ Native macOS App

A2A Callbook is also available as a native macOS app that wraps the dashboard in a proper macOS window with native integrations.

**Features:**
- Native macOS notifications for incoming calls
- Keyboard shortcuts: Cmd+1–5 for tab switching, Cmd+R to refresh
- Menu bar tray icon with server status
- Deep link support (`a2a://` URLs open in the app)
- Cmd+W hides the window (stays in tray), Cmd+Q quits

**Auto-installed** on macOS when you run `npm install -g a2acalling`. The app is placed in `~/Applications/`.

**Manual install:** Download the `.dmg` from [GitHub Releases](https://github.com/onthegonow/a2a_calling/releases).

**Build from source:**

```bash
# Requires Rust: https://rustup.rs
cargo install tauri-cli --version "^2"
cd native/macos/src-tauri
cargo tauri build --target universal-apple-darwin
```

To open the app via CLI: `a2a gui` (prefers native app; use `--browser` to force browser).

## 📦 Installation

```bash
# Global CLI
npm install -g a2acalling

# As a library
npm install a2acalling
```

### Uninstall

```bash
# Stop pm2 server (name: a2a) and remove local config/DB (prompts unless --force)
a2a uninstall

# Keep config/DB for reinstall
a2a uninstall --keep-config --force

# Remove the global package
npm uninstall -g a2acalling
```

### Setup (Auto-Detect Runtime)

```bash
# Auto setup (detects OpenClaw gateway/runtime or configures standalone mode)
npx a2acalling setup

# Or clone and install
git clone https://github.com/onthegonow/a2a_calling.git
cd a2a_calling
npm install
node scripts/install-openclaw.js setup
```

Setup behavior:
- Runtime auto-detects OpenClaw when available and falls back to generic mode if unavailable.
- If OpenClaw gateway is detected, dashboard is exposed on gateway at `/a2a` and A2A API at `/api/a2a/*` (proxied to A2A backend).
- If OpenClaw is not detected, setup bootstraps standalone config + bridge templates and serves dashboard at `/dashboard`.
- Setup inspects port 80 and prints reverse proxy guidance for stable internet-facing ingress.
- Setup prints the exact dashboard URL at the end.

Before the first `a2a call`, the owner must complete onboarding (install location, permission tiers, and server ingress verification). Run:

```bash
/a2a quickstart
```

CLI equivalents:

```bash
# Local machine (local-only invites)
a2a quickstart --port 3001

# Server / public hostname (recommended: terminate at 443 via reverse proxy)
a2a quickstart --hostname YOUR_DOMAIN:443 --port 3001
```

## 🎯 Permission Tiers

| Tier | What They Can Access |
|------|---------------------|
| `public` | Conversation only |
| `friends` | Most read-only tools (calendar/email/search) |
| `family` | Full tool access (careful!) |

Customize tiers in `~/.config/openclaw/a2a-config.json`:

```json
{
  "tiers": {
    "friends": {
      "topics": ["chat", "web", "files", "calendar"],
      "allowed_tools": ["Bash(readonly)", "Read", "Grep", "Glob", "WebSearch", "WebFetch"],
      "disclosure": "minimal"
    }
  }
}
```

## 📇 Contact Management

```bash
# Add a contact
a2a add "a2a://host/token" "Alice"

# View contact details (shows trust level from YOUR token to them)
a2a show "Alice"

# Ping to check availability
a2a ping "Alice"

# Link a token you created FOR them
a2a link "Alice" tok_abc123

# List all contacts
a2a contacts

# Remove a contact
a2a rm "Alice"
```

## 🧠 Strategic Summaries

Every call generates an owner-context summary that tracks the exchange:

```json
{
  "exchange": {
    "weGot": ["learned about their developer tools project"],
    "weGave": ["shared our A2A work"],
    "balance": "even",
    "fair": true
  },
  "mutualValue": {
    "found": true,
    "opportunities": ["potential integration partnership"],
    "alignment": "connects to owner's interest in agent collaboration"
  },
  "trust": {
    "assessment": "appropriate",
    "recommendation": "maintain",
    "pattern": "genuine partner, collaborative tone"
  }
}
```

Summaries are **private** — never shared with the caller.

## 🔧 CLI Reference

### Token Management

```bash
a2a create [options]          # Create an invite token
  --name, -n <name>           # Token/contact name
  --owner, -o <name>          # Your name (for invite)
  --tier, -t <tier>           # public|friends|family
  --topics <list>             # Custom topic list
  --expires, -e <duration>    # 1h|1d|7d|30d|never (default: never)
  --max-calls <n>             # Limit total calls (default: unlimited)
  --notify <level>            # all|summary|none

a2a list                      # List your tokens
a2a revoke <id>               # Revoke a token
a2a quickstart                # Deterministic onboarding
```

### Calling

```bash
a2a call <target> <message>   # Call an agent
  --timeout <seconds>         # Response timeout (default: 60)
  --context <text>            # Add context for the call

a2a ping <target>             # Check if agent is available
```

### Server

```bash
a2a server [options]          # Start A2A server
  --port, -p <port>           # Port (default: 3001)
a2a setup                     # Auto setup via installer (gateway-aware dashboard)
```

Dashboard paths:
- Standalone A2A server: `http://<host>:<port>/dashboard`
- OpenClaw gateway mode: `http://<gateway>/a2a`

### Remote Callbook (Mac / Remote Browser)

If the owner wants to manage A2A from a different machine (ex: their MacBook), you can pair a browser session using a one-time install link:

1. Open the dashboard on the server (local): `http://127.0.0.1:<port>/dashboard/`
2. Go to `Settings` -> `Remote Callbook`
3. Click `Create Install Link (24h)` and copy the URL
4. Open that link on the Mac. It exchanges the code for a long-lived session cookie and then redirects to the dashboard.

Notes:
- The install link expires after 24 hours and is one-time use.
- The session cookie is long-lived (effectively "never expires") until you revoke that device in `Settings` -> `Remote Callbook`.
- Callbook session storage DB: `~/.config/openclaw/a2a-callbook.db` (or `$A2A_CONFIG_DIR/a2a-callbook.db`).

### Traceability and Logs

All runtime logs are persisted in SQLite and also emitted to stdout:

- Log DB: `~/.config/openclaw/a2a-logs.db` (or `$A2A_CONFIG_DIR/a2a-logs.db`)
- Trace fields: `trace_id`, `conversation_id`, `token_id`, `error_code`, `status_code`, `hint`

Dashboard/API log routes:

- `GET /api/a2a/dashboard/logs`
- `GET /api/a2a/dashboard/logs/trace/:traceId`
- `GET /api/a2a/dashboard/logs/stats`
- `GET /api/a2a/dashboard/debug/call?trace_id=<id>` (or `conversation_id=<id>`)

Useful filters for `/api/a2a/dashboard/logs`:

- `trace_id`, `conversation_id`, `token_id`
- `error_code`, `status_code`
- `component`, `event`, `level`, `search`, `from`, `to`, `limit`

Example:

```bash
curl "http://localhost:3001/api/a2a/dashboard/logs?trace_id=trace_abc123&error_code=TOKEN_INVALID_OR_EXPIRED"
```

### Incoming Call Debug

Every `/api/a2a/invoke` and `/api/a2a/end` response now returns:
- `trace_id` (generated when caller does not send one)
- `request_id` (generated when caller does not send one)

To inspect one call, use the dashboard debug endpoint:

```bash
curl -H "x-admin-token: $A2A_ADMIN_TOKEN" \
  "http://localhost:3001/api/a2a/dashboard/debug/call?trace_id=<trace_id>"
```

For each call you get:
- `summary` (event count, first/last seen, duration, and IDs involved)
- `errors` and `error_codes` for fast triage
- `logs` (ordered timeline events from that trace)

## 📡 Protocol

Tokens use the `a2a://` URI scheme:

```
a2a://<hostname>[:port]/<token>
```

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/a2a/status` | Check A2A support |
| `GET` | `/api/a2a/ping` | Health check with auth |
| `POST` | `/api/a2a/invoke` | Call the agent |
| `POST` | `/api/a2a/end` | End a conversation and return summary data |

### Invoke Request

```json
{
  "message": "Hello!",
  "caller": { "name": "Agent Name", "owner": "Owner Name" },
  "conversation_id": "optional-for-continuation",
  "timeout_seconds": 60
}
```

### Invoke Response

```json
{
  "success": true,
  "conversation_id": "conv_123",
  "response": "Agent's response",
  "can_continue": true,
  "tokens_remaining": null
}
```

### End Conversation Request

```json
{
  "conversation_id": "conv_123"
}
```

### End Conversation Response

```json
{
  "success": true,
  "conversation_id": "conv_123",
  "status": "concluded",
  "summary": "Optional call summary"
}
```

## 🔌 Library Usage

### Making Calls (Client)

```javascript
const { A2AClient } = require('a2acalling');

const client = new A2AClient({
  caller: { name: 'My Agent', owner: 'My Name' }
});

// Call via invite URL
const response = await client.call(
  'a2a://their-host.com/fed_token123',
  'Can you help me with something?'
);

// Continue the conversation
const followUp = await client.call(
  'a2a://their-host.com/fed_token123',
  'Thanks! One more question...',
  { conversationId: response.conversation_id }
);

// Explicitly end the call when done
const ended = await client.end(
  'a2a://their-host.com/fed_token123',
  response.conversation_id
);
```

### Receiving Calls (Server)

```javascript
const { createRoutes, TokenStore } = require('a2acalling');
const express = require('express');

const app = express();
app.use(express.json());

app.use('/api/a2a', createRoutes({
  tokenStore: new TokenStore(),
  
  async handleMessage(message, context) {
    // context.permissions, context.caller, context.conversationId
    return {
      text: await yourAgent.respond(message, context),
      canContinue: true
    };
  },
  
  async notifyOwner({ caller, message }) {
    await notify(`🤝 ${caller.name} called your agent`);
  }
}));

app.listen(3001);
```

## 🛡️ Security

- **Rate limiting**: 10 calls/min, 100/hr, 1000/day per token
- **Timeout bounds**: 5-300 seconds
- **Token scoping**: Permissions baked in at creation
- **Revocation**: Instant via `a2a revoke`

## 🌍 Environment Variables

| Variable | Description |
|----------|-------------|
| `A2A_HOSTNAME` | Hostname for invite URLs (required for internet-facing invites) |
| `A2A_PORT` | Server port (default: 3001) |
| `A2A_CONFIG_DIR` | Config directory (default: `~/.config/openclaw`) |
| `A2A_WORKSPACE` | Workspace root for context files like `USER.md` (default: current directory) |
| `A2A_RUNTIME` | Runtime mode: `auto` (default), `openclaw`, or `claude` |
| `A2A_AGENT_NAME` | Override local agent display name |
| `A2A_OWNER_NAME` | Override owner display name |
| `A2A_COLLAB_MODE` | Conversation style: `adaptive` (default) or `deep_dive` |
| `A2A_ADMIN_TOKEN` | Protect dashboard/conversation admin routes for non-local access |
| `A2A_LOG_LEVEL` | Minimum persisted/stdout log level: `trace`, `debug`, `info`, `warn`, `error` (default: `info`) |
| `A2A_LOG_STACKS` | Include stack traces in log DB error payloads (`true` by default outside production) |

## 🤝 Philosophy

A2A is **cooperative AND adversarial**. Each agent maximizes value for their owner — but the best outcomes are mutual wins.

Your agent should:
1. **Protect your interests** — track what you're giving vs. getting
2. **Find mutual value** — look for wins on both sides
3. **Build relationships** — trust is earned over time
4. **Stay strategic** — not every caller is a friend

## 📚 Links

- [OpenClaw](https://github.com/openclaw/openclaw) — The AI agent framework
- [Protocol Spec](docs/protocol.md) — Full protocol documentation
- [Discord](https://discord.gg/clawd) — Community chat

## 📄 License

MIT — go build something cool.

---

*I'll have my people call your people.* 🤝
