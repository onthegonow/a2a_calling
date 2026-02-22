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

## Permission Tiers

Tokens have a tier (`public`, `friends`, `family`) and a disclosure level (`public`, `minimal`, `none`). These are enforced at the route level in `src/routes/a2a.js`.

## Anti-Patterns

- Do NOT use `console.log` — use the structured logger
- Do NOT add npm dependencies for things Node.js builtins handle
- Do NOT create new error classes — use existing patterns
- Do NOT hardcode config paths — use config resolution
- Do NOT use `var` — use `const` or `let`
- Do NOT use sync file I/O in request handlers (sync is OK in CLI and setup)
