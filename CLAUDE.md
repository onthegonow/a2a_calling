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

### Key files
- `native/macos/src-tauri/src/lib.rs` - App entry, menus, event handling
- `native/macos/src-tauri/src/discovery.rs` - Port scanning / server detection
- `native/macos/src-tauri/src/health.rs` - Background health monitor
- `native/macos/src-tauri/src/notifications.rs` - macOS notification bridge
- `native/macos/src-tauri/src/server.rs` - Server lifecycle (start/stop)
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
