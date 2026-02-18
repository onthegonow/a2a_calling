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
│  ├─ /api/a2a/*      → src/routes/a2a.js (inbound calls, tokens)  │
│  ├─ /api/callbook/* → src/routes/callbook.js (callbook sync)     │
│  └─ /dashboard/*    → src/routes/dashboard.js (API + SPA)        │
└───────────┬──────────────────────────────────────────────────────┘
            │
┌───────────▼──────────────────────────────────────────────────────┐
│  Core Libraries (src/lib/)                                        │
│  ├─ tokens.js         Token CRUD, validation, tiers               │
│  ├─ client.js         A2AClient for outbound calls                │
│  ├─ conversations.js  ConversationStore (SQLite)                  │
│  ├─ conversation-driver.js  Multi-turn call orchestration         │
│  ├─ summarizer.js     Call summary generation                     │
│  ├─ summary-prompt.js Unified summary prompt builder              │
│  ├─ summary-formatter.js  Format summaries for display            │
│  ├─ disclosure.js     Disclosure level enforcement                │
│  ├─ config.js         Config file management                      │
│  ├─ logger.js         Structured logger (SQLite + stdout)         │
│  ├─ call-monitor.js   Active call monitoring                      │
│  ├─ callbook.js       Contact/callbook management                 │
│  ├─ claude-subagent.js  Claude API integration for summaries      │
│  ├─ openclaw-integration.js  OpenClaw runtime hooks               │
│  ├─ prompt-template.js  Prompt template utilities                 │
│  ├─ runtime-adapter.js  Runtime mode detection (standalone/OCW)   │
│  ├─ dashboard-events.js  SSE event broadcasting                   │
│  ├─ external-ip.js    External IP/hostname detection              │
│  ├─ invite-host.js    Invite URL construction                     │
│  ├─ port-scanner.js   Available port detection                    │
│  ├─ pid-file.js       PID file management                         │
│  ├─ turn-timeout.js   Conversation turn timeout handling          │
│  ├─ update-checker.js Version update detection                    │
│  └─ update-manager.js Self-update orchestration                   │
└──────────────────────────────────────────────────────────────────┘
```

## Data Storage

- **Tokens**: JSON file at `~/.config/openclaw/a2a.json`
- **Conversations**: SQLite via `better-sqlite3` at `~/.config/openclaw/a2a-conversations.db`
- **Logs**: SQLite via `better-sqlite3` at `~/.config/openclaw/a2a-logs.db`
- **Config**: JSON at `~/.config/openclaw/a2a-config.json`
- **Disclosure**: JSON at `~/.config/openclaw/a2a-disclosure.json`

## Permission System

Three tiers with escalating capabilities:
- **public**: `context-read` only
- **friends**: `context-read`, `calendar.read`, `email.read`, `search`
- **family**: `context-read`, `calendar`, `email`, `search`, `tools`, `memory`

Three disclosure levels controlling information sharing:
- **public**: Shares freely within tier boundaries
- **minimal**: Direct answers only, no volunteered context
- **none**: Confirms capability, provides no information

## Dependencies

Only two runtime dependencies (intentionally minimal):
- `express` — HTTP server and routing
- `better-sqlite3` — SQLite for conversations and logs

## Dashboard

Single-page app served from `src/dashboard/public/`. Uses Shoelace web components. Communicates with the API via `/dashboard/api/*` routes.

## Native macOS App

Tauri v2 app at `native/macos/` wrapping the dashboard SPA. Provides native menus, notifications, and server lifecycle management.

## Testing

Zero-dependency test runner at `test/run.js` with custom assert API. Three test tiers:
- `test/unit/` — Unit tests for individual modules
- `test/integration/` — Integration tests for multi-module flows
- `test/e2e/` — End-to-end tests for full system flows

Test profiles at `test/profiles/` represent real personas with distinct permission tiers.
