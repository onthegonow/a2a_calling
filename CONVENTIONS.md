# Conventions — A2A Calling

## Logging

Use the structured logger from `src/lib/logger.js`. Never use bare `console.log`.

```js
const { createLogger } = require('./logger');
const logger = createLogger({ component: 'a2a.mymodule' });
logger.info('Something happened', { event: 'my_event', data: { key: 'val' } });
```

Components follow dotted naming: `a2a.tokens`, `a2a.server`, `a2a.client`, etc.

## Error Handling

- Use the project's existing error patterns (e.g., `A2AError` from `src/lib/client.js`)
- Log errors with `logger.error()`, including error codes and hints
- HTTP responses use consistent JSON format: `{ success: false, error: { code, message } }`
- Do NOT create new error classes without strong justification

## Config Resolution

Config directory resolves via:
1. `process.env.A2A_CONFIG_DIR`
2. `process.env.OPENCLAW_CONFIG_DIR`
3. `~/.config/openclaw/`

Always use `src/lib/config.js` for config access. Do not hardcode paths.

## Testing

- Test runner: `node test/run.js` (zero-dependency, custom assert API)
- Test files: `*.test.js` in `test/unit/`, `test/integration/`, `test/e2e/`
- Test helpers: `test/helpers.js`
- Test profiles: `test/profiles/*.js` — real personas, not generic stubs
- Prefer testing through the public API of each module

## Dependencies

This project is intentionally minimal-dependency. Only two runtime deps:
- `express` — HTTP
- `better-sqlite3` — SQLite

Do NOT add new npm dependencies without explicit justification. Use Node.js built-ins.

## Module Pattern

All modules use CommonJS (`require`/`module.exports`). Each lib file exports a focused API. Large modules export a class (e.g., `TokenStore`, `ConversationStore`, `A2AClient`). Utility modules export functions.

## Naming

- Files: kebab-case (`call-monitor.js`, `dashboard-events.js`)
- Classes: PascalCase (`TokenStore`, `A2AClient`)
- Functions/variables: camelCase
- Constants: UPPER_SNAKE_CASE for true constants
- Token IDs: prefixed with `fed_` (federation tokens)
- Trace IDs: prefixed with `trace_`

## Dashboard

- Single-page app in `src/dashboard/public/`
- Uses Shoelace web components (`<sl-*>` elements)
- Communicates via fetch to `/dashboard/api/*` endpoints
- SSE for real-time updates via `src/lib/dashboard-events.js`
- Dark theme is the default; uses CSS custom properties for theming
- Sidebar navigation with tab switching (Contacts, Calls, Invites, Logs, Settings, Permissions, Health)
- Permissions tab uses tier cards with tool toggles and auto-save
- Drag-and-drop uses event delegation on stable parent containers (`.perm-sidebar` for sidebar items, zone containers for drop targets) — do NOT bind listeners directly to innerHTML-generated elements (A2A-61)

## Network Resilience (A2A-54)

Outbound client methods (`call()`, `end()`) automatically retry transient network errors with exponential backoff. Pattern:
- Use `withRetry(fn, { delays })` for retryable operations
- Only retry on transient errors (ECONNRESET, ECONNREFUSED, EPIPE, ENOTFOUND, EAI_AGAIN, timeout)
- Never retry HTTP 4xx/5xx — those are explicit server rejections
- All HTTP responses are size-capped at 2MB via `handleSizeCappedResponse()`
- Configurable retry delays via `_retryDelays` constructor option (used in tests with `[0,0,0]` for fast execution)

## Dashboard API Testing (A2A-56)

Dashboard API integration tests follow the pattern in `test/integration/dashboard-logs.test.js`:
- Mount `createDashboardApiRouter()` on an Express app
- Use `helpers.request()` for HTTP assertions (binds to 127.0.0.1 — bypasses auth)
- Bust module caches for `dashboard`, `logger`, `tokens`, `config`, `disclosure`, `conversations`, `callbook`, `dashboard-events`
- Call `loggerModule.closeAllLoggerStores()` in teardown to prevent SQLite handle leaks
- Pass `convStore` directly via `options.convStore` when testing calls endpoints

## Store Lifecycle (A2A-57)

All SQLite store classes (`ConversationStore`, `DashboardEventStore`, `CallbookStore`, `LoggerStore`) implement a `close()` method following this pattern:
```js
close() {
  if (this.db) {
    try { this.db.close(); } catch (_) {}
    this.db = null;
  }
}
```
- `close()` must be idempotent (safe to call multiple times)
- `close()` must be a no-op when DB was never initialized (`this.db === null`)
- The `server.js` `shutdown()` function closes all stores on SIGTERM/SIGINT: `serverConvStore`, `eventStore`, `callbookStore` (A2A-59), and logger stores
- All stores should be created at the `server.js` module level and passed to route factories — do NOT create stores inside route factories (A2A-59)
- Test teardown should call `store.close()` to prevent SQLite handle leaks

## Permission Tiers

Tokens have a tier (`public`, `friends`, `family`) and a disclosure level (`public`, `minimal`, `none`). These are enforced at the route level in `src/routes/a2a.js`.

## Route Hardening (A2A-53)

- Rate limit Map has eviction: entries are swept when Map exceeds 1000 entries (stale >24h first, then oldest by insertion order)
- Admin token comparison uses `timingSafeTokenEqual()` from `src/routes/a2a.js` — do NOT use `!==` for secret comparison
- Query parameter parsing follows the dashboard.js pattern: `Math.min(max, Math.max(min, Number.parseInt(String(value), 10) || defaultValue))`

## Retention & Cleanup (A2A-55)

All data stores implement retention cleanup following the `dashboard-events.js` auto-prune pattern:

- **Cleanup component**: Use `createLogger({ component: 'a2a.cleanup' })` for all retention logging
- **Best effort**: Prune failures are caught and logged as warnings — never crash the server
- **VACUUM threshold**: Only run SQLite VACUUM after >100 rows deleted (costly I/O)
- **Auto-prune**: Logger store prunes on every 1000th `write()` call (counter-based, like dashboard-events.js)
- **Recursion safety**: Logger `pruneOld()` uses `_pruning` flag to prevent auto-prune during explicit prune
- **Server startup**: `src/server.js` calls all three retention mechanisms after `writePidFile()`, before `updateManager.start()`
- **Config defaults**: `A2AConfig.getRetention()` merges partial config with defaults — never writes defaults to disk
- **Token grace period**: Expired tokens are kept for 1 hour after expiry (in-flight call protection)

## Anti-Patterns

- Do NOT use `console.log` — use the structured logger
- Do NOT add npm dependencies for things Node.js builtins handle
- Do NOT create new error classes — use existing patterns
- Do NOT hardcode config paths — use config resolution
- Do NOT use `var` — use `const` or `let`
- Do NOT use sync file I/O in request handlers (sync is OK in CLI and setup)
