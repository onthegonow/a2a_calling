# Architecture — A2A Calling

## System Overview

A2A Calling enables agent-to-agent communication across OpenClaw instances. Agents create tokens with scoped permissions, share invite URLs, and remote agents call in via HTTP.

```
┌──────────────────────────────────────────────────────────────────┐
│  CLI (bin/cli.js)                                                │
│  Commands: create, list, revoke, call, contacts, conversations   │
└───────────┬──────────────────────────────────────────────────────┘
            │
┌───────────▼──────────────────────────────────────────────────────┐
│  Express Server (src/server.js)                                   │
│  ├─ /api/a2a/*          → src/routes/a2a.js (inbound calls, tokens)   │
│  ├─ /api/a2a/callbook/* + /callbook/* → src/routes/callbook.js         │
│  └─ /api/a2a/dashboard/* + /dashboard/* → src/routes/dashboard.js      │
└───────────┬──────────────────────────────────────────────────────┘
            │
┌───────────▼──────────────────────────────────────────────────────┐
│  Core Libraries (src/lib/)                                        │
│  ├─ tokens.js         Token CRUD, validation, tiers               │
│  ├─ client.js         A2AClient for outbound calls (retry + size cap) │
│  ├─ conversations.js  ConversationStore (SQLite)                  │
│  ├─ conversation-driver.js  Multi-turn call orchestration         │
│  ├─ summarizer.js     Call summary generation                     │
│  ├─ summary-prompt.js Unified summary prompt builder              │
│  ├─ summary-formatter.js  Format summaries for display            │
│  ├─ disclosure.js     Disclosure manifest loading + tier merging  │
│  ├─ config.js         Config file management                      │
│  ├─ crypto.js         Ed25519 identity keypair + signing           │
│  ├─ logger.js         Structured logger (SQLite + stdout)         │
│  ├─ call-monitor.js   Active call monitoring                      │
│  ├─ callbook.js       Contact/callbook management                 │
│  ├─ claude-subagent.js  Claude API integration for summaries      │
│  ├─ openclaw-integration.js  OpenClaw runtime hooks               │
│  ├─ prompt-template.js  Prompt template utilities                 │
│  ├─ runtime-adapter.js  Runtime mode detection (openclaw/claude/test) │
│  ├─ dashboard-events.js  SSE event broadcasting                   │
│  ├─ external-ip.js    External IP/hostname detection              │
│  ├─ invite-host.js    Invite URL construction                     │
│  ├─ port-scanner.js   Available port detection                    │
│  ├─ pid-file.js       PID file management                         │
│  ├─ turn-timeout.js   Conversation turn timeout handling          │
│  ├─ local-request.js  Proxy-aware local request detection (A2A-73) │
│  ├─ update-checker.js Version update detection                    │
│  └─ update-manager.js Self-update orchestration                   │
└──────────────────────────────────────────────────────────────────┘
```

## Data Storage

- **Tokens**: JSON file at `~/.config/openclaw/a2a.json`
- **Conversations**: SQLite via `better-sqlite3` at `~/.config/openclaw/a2a-conversations.db` (WAL mode, A2A-71)
- **Logs**: SQLite via `better-sqlite3` at `~/.config/openclaw/a2a-logs.db` (WAL mode, A2A-71)
- **Callbook**: SQLite via `better-sqlite3` at `~/.config/openclaw/a2a-callbook.db`
- **Dashboard Events**: SQLite via `better-sqlite3` at `~/.config/openclaw/a2a-events.db`
- **Config**: JSON at `~/.config/openclaw/a2a-config.json`
- **Disclosure**: JSON at `~/.config/openclaw/a2a-disclosure.json`

## Database Lifecycle Management (A2A-55)

All three data stores have automatic retention cleanup that runs on server startup:

- **Conversations**: `ConversationStore.pruneOld()` compresses messages 7+ days old, deletes concluded/timeout conversations 90+ days old. Active conversations are never deleted.
- **Logs**: `LogStore.pruneOld()` deletes entries 30+ days old. Auto-prune triggers on every 1000th write (best effort). `pruneAllLoggerStores()` iterates all cached stores.
- **Tokens**: `TokenStore.cleanupExpired()` removes tokens expired >1 hour (grace for in-flight calls) and revoked tokens >30 days old.

All retention periods are configurable via `a2a-config.json` `retention` section. SQLite VACUUM runs only after >100 rows deleted. All cleanup is best-effort — failures are logged but never prevent server startup.

## Permission System

Three tiers with escalating capabilities:
- **public**: `context-read` only
- **friends**: `context-read`, `calendar.read`, `email.read`, `search`
- **family**: `context-read`, `calendar`, `email`, `search`, `tools`, `memory`

Disclosure policy is manifest-driven (`~/.config/openclaw/a2a-disclosure.json`), not a token/tier `disclosure` field:
- Per-tier `topics`, `objectives`, and `do_not_discuss` are loaded from the disclosure manifest
- Global `never_disclose` always applies
- Tier inheritance is enforced in prompt construction (`friends` includes `public`; `family` includes `friends` + `public`)

## Dependencies

Only two runtime dependencies (intentionally minimal):
- `express` — HTTP server and routing
- `better-sqlite3` — SQLite for conversations, logs, callbook, and dashboard events

## Dashboard

Single-page app served from `src/dashboard/public/`. Uses Shoelace web components. Communicates with the API via `/api/a2a/dashboard/*` routes. UI is served at both `/api/a2a/dashboard/*` and legacy `/dashboard/*` mounts. Includes panels: Contacts, Calls, Permissions, Invites, Logs, Health (E2E test results), and Settings.

## Native macOS App

Tauri v2 app at `native/macos/` wrapping the dashboard SPA. Provides native menus, notifications, and server lifecycle management.

## Identity Verification

Ed25519 cryptographic identity for agents. Each instance generates a keypair on first run (stored in config). Outbound calls sign messages; inbound calls verify signatures. Uses Node.js built-in `crypto.sign`/`crypto.verify` — no external dependencies. See `src/lib/crypto.js`.

## Testing

Zero-dependency test runner at `test/run.js` with custom assert API. Three test tiers:
- `test/unit/` — Unit tests for individual modules
- `test/integration/` — Integration tests for multi-module flows
- `test/e2e/` — End-to-end tests for full system flows

Test profiles at `test/profiles/` represent real personas with distinct permission tiers.

E2E test results are persisted to `~/.config/openclaw/test-results/` via `test/e2e/persist.js` (timestamped `result-*.json` plus `latest.json`) and surfaced in the dashboard Health tab. The `scripts/run-e2e.sh` orchestrator runs E2E suites and stores results.

## Network Resilience

The outbound A2A client (`src/lib/client.js`) retries transient network failures (ECONNRESET, ECONNREFUSED, EPIPE, ENOTFOUND, EAI_AGAIN, timeouts) with exponential backoff (0s, 1s, 2s). HTTP 4xx/5xx errors are not retried. All response accumulation is capped at 2MB to prevent OOM from malicious remotes.
