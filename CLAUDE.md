# CLAUDE.md - A2A for OpenClaw

## Quick Context

A2A Calling enables agent-to-agent communication across OpenClaw instances. Users create tokens with scoped permissions, share invite URLs, and remote agents can call in.

## GitHub Access

```bash
# Maintainer tokens live in .env (gitignored). DO NOT COMMIT or delete this file.
set -a
source .env
set +a

# Recommended: use gh for git auth (avoid embedding tokens in remotes)
gh auth status
gh auth setup-git
```

## Publishing (GitHub + npm Together)

This repo is published as both:
- GitHub: `onthegonow/a2a_calling`
- npm: `a2acalling`

Required `.env` keys (gitignored):
- `GH_TOKEN` (GitHub PAT)
- `NPM_TOKEN` (npm publish token)

Quick release checklist:

```bash
npm version patch --no-git-tag-version
npm test
git add package.json
git commit -m "chore: release $(node -p \"require('./package.json').version\")"
env -u GIT_ASKPASS -u VSCODE_GIT_ASKPASS_NODE -u VSCODE_GIT_IPC_HANDLE -u VSCODE_GIT_IPC_AUTH_TOKEN git push origin main
npm_config_cache=/tmp/npm-cache npm publish --access public
VERSION=$(node -p "require('./package.json').version")
git tag "v${VERSION}"
env -u GIT_ASKPASS -u VSCODE_GIT_ASKPASS_NODE -u VSCODE_GIT_IPC_HANDLE -u VSCODE_GIT_IPC_AUTH_TOKEN git push origin "v${VERSION}"
gh release create "v${VERSION}" --generate-notes
```

## What This Does

1. **Token Management** - Create expiring tokens with tier-based permissions (public/friends/family) and capabilities
2. **Inbound Calls** - Express routes handle `/api/a2a/invoke` from remote agents
3. **Outbound Calls** - `A2AClient` calls remote agents via their invite URLs
4. **Owner Notifications** - Configurable alerts when your agent gets called

## Token Flow

```
User: /a2a create --name "Alice" --expires 7d
Bot:  ✅ a2a://myhost.com/fed_abc123

User shares URL with Alice...

Alice's agent: POST /api/a2a/invoke
               Authorization: Bearer fed_abc123
               {"message": "Hey, can you help?"}

Your agent responds within permission scope.
You get notified (if configured).
```

## Files to Know

- `src/lib/tokens.js` - All token CRUD + validation
- `src/lib/client.js` - `A2AClient` for outbound calls
- `src/lib/conversations.js` - ConversationStore (SQLite)
- `src/lib/conversation-driver.js` - Multi-turn call orchestration
- `src/lib/summarizer.js` - Call summary generation
- `src/lib/summary-prompt.js` - Unified summary prompt builder
- `src/lib/disclosure.js` - Disclosure level enforcement
- `src/lib/config.js` - Config file management
- `src/lib/logger.js` - Structured logger (SQLite + stdout)
- `src/lib/runtime-adapter.js` - Runtime mode detection
- `src/routes/a2a.js` - Express router (mount at `/api/a2a`)
- `src/routes/dashboard.js` - Dashboard API + SPA routes
- `src/dashboard/public/app.js` - Dashboard SPA (Shoelace web components)
- `docs/protocol.md` - Full protocol spec

## Native macOS App (Tauri)

Located in `native/macos/`. Tauri v2 app wrapping the dashboard SPA.

### Dev setup
```bash
# Install Rust: https://rustup.rs
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Install Tauri CLI
cargo install tauri-cli --version "^2"

# Dev mode (live reload)
cd native/macos/src-tauri
cargo tauri dev

# Production build
cargo tauri build
```

### Sidecar server packaging
The native app expects a bundled standalone server binary named `a2a-server` under
`native/macos/src-tauri/binaries/`. Build it with:

```bash
# Build for host arch
bash scripts/build-standalone.sh

# Build universal (arm64 + x64)
bash scripts/build-standalone.sh --universal
```

### Key files
- `native/macos/src-tauri/src/lib.rs` - App entry, menus, event handling
- `native/macos/src-tauri/src/discovery.rs` - Port scanning / server detection
- `native/macos/src-tauri/src/health.rs` - Background health monitor
- `native/macos/src-tauri/src/notifications.rs` - macOS notification bridge
- `native/macos/src-tauri/src/server.rs` - Sidecar-first server lifecycle with external fallback and crash backoff
- `native/macos/index.html` - Loading page (shown before server found)

## Testing

```bash
# Run all tests (unit + integration, excludes e2e)
npm test

# Run specific test tiers
node test/run.js --unit
node test/run.js --integration
node test/run.js --e2e

# Filter by name
node test/run.js --filter tokens

# Manual CLI testing
node bin/cli.js create --name "Test" --expires 1h
node bin/cli.js list
node bin/cli.js revoke <id>
```

# A2A Calling — Installed Package Context

This file is automatically installed by the `a2acalling` package to give Claude Code
immediate context after `npm install`. It describes what A2A Calling is, how to get
started, and the full CLI reference — so you never need to grep source code.

## Getting Started

After installing `a2acalling`, the FIRST thing to do is run onboarding:

```bash
a2a quickstart
```

This is the single entry point for all setup. It will:
1. Detect an available port (prefers 80, falls back to 3001+)
2. Start the A2A server
3. Detect the hostname
4. Prompt for disclosure topics (what your agent discusses with callers)
5. On macOS, offer to install the native Callbook app
6. Save configuration to `~/.config/openclaw/a2a-config.json`

If onboarding was already completed, re-run with `--force`:

```bash
a2a quickstart --force
```

## Native macOS App (A2A Callbook)

On macOS, a native desktop app is available. It provides a dashboard GUI for managing
calls, contacts, tokens, and logs.

```bash
a2a app install          # Download and install from GitHub releases
a2a app status           # Check if installed, show version and path
a2a app uninstall        # Remove from ~/Applications
```

After install, the app lives at `~/Applications/A2A Callbook.app`. You can also
open the dashboard in a browser:

```bash
a2a gui                  # Open dashboard in browser (or native app if installed)
a2a gui --tab logs       # Open specific tab: contacts|calls|logs|settings|invites
```

## Full CLI Reference

### Token Management

```bash
a2a create --name "AgentName" --owner "OwnerName" --expires 7d --permissions friends
  # Options:
  #   --name, -n        Token/agent name
  #   --owner, -o       Owner name
  #   --expires, -e     1h, 1d, 7d, 30d, never (default: 1d)
  #   --permissions, -p public, friends, family (default: public)
  #   --disclosure, -d  public, minimal, none (default: minimal)
  #   --notify          all, summary, none (default: all)
  #   --max-calls       Maximum invocations (default: 100)
  #   --topics          Custom topics (comma-separated)
  #   --tools           Custom tool allowlist (comma-separated)
  #   --link, -l        Auto-link to contact name

a2a list                 # List active tokens
a2a revoke <token_id>    # Revoke a token
```

### Contacts

```bash
a2a contacts             # List all contacts (shows permission badges)
a2a contacts add <url> --name "Alice" --owner "Alice Chen"
a2a contacts show <name> # Show contact details + linked token
a2a contacts edit <name> # Edit contact metadata
a2a contacts link <name> <token_id>  # Link a token to a contact
a2a contacts ping <name> # Ping contact, update status
a2a contacts rm <name>   # Remove contact
```

### Calling

```bash
a2a call <contact|url> "<message>"   # Multi-turn call (default: 8-25 turns)
a2a call Alice "Hello!"              # Call by contact name
a2a call a2a://host/fed_xxx "Hi"     # Call by invite URL
a2a call Alice "Quick q" --single    # One-shot (single turn)
  # --min-turns N     Minimum turns before close (default: 8)
  # --max-turns N     Maximum turns (default: 25)

a2a ping <url>           # Check if agent is reachable
a2a status <url>         # Get remote A2A status
```

### Conversations

```bash
a2a conversations                    # List all conversations
  # --contact         Filter by contact
  # --status          Filter: active, concluded, timeout
  # --limit           Max results (default: 20)
a2a conversations show <id>          # Show conversation with messages
a2a conversations end <id>           # End and summarize conversation
```

### Server & Setup

```bash
a2a quickstart                       # First-time setup (port, hostname, disclosure)
  # --port, -p        Preferred port (default: 80, fallback: 3001+)
  # --force           Reset and re-run from scratch
  # --submit '<json>' Submit disclosure JSON

a2a server --port 3001               # Start server manually
a2a config --show                    # Show current configuration
a2a status                           # Show local server status
a2a gui                              # Open dashboard GUI
a2a app install                      # Install native macOS app
a2a setup                            # Auto setup (gateway-aware)
```

### Maintenance

```bash
a2a update               # Update to latest version
a2a update --check       # Check for updates without installing
a2a skills               # Install Claude Code + Codex skill files
a2a uninstall --force    # Stop server and remove config/DB
a2a version              # Show installed version
```

## Permission Tiers

| Tier | Default Capabilities |
|------|---------------------|
| `public` | `context-read` |
| `friends` | `context-read`, `calendar.read`, `email.read`, `search` |
| `family` | `context-read`, `calendar`, `email`, `search`, `tools`, `memory` |

## Disclosure Levels

| Level | Behavior |
|-------|----------|
| `public` | Agent shares freely within tier boundaries |
| `minimal` | Direct answers only, no volunteered context |
| `none` | Confirms capability, provides no information |

## Key Paths

- Config: `~/.config/openclaw/a2a-config.json`
- Disclosure: `~/.config/openclaw/a2a-disclosure.json`
- Native app: `~/Applications/A2A Callbook.app` (macOS only)
- Dashboard: `http://127.0.0.1:<port>/dashboard/`

<!-- END A2A CALLING SECTION -->
