# A2A Protocol v0 Reference

## Overview

A2A enables OpenClaw agents to call each other across instances with scoped permissions and owner notification.

## Token Format

```
a2a://<hostname>/<token>
```

Example: `a2a://my-server.example.com/fed_abc123xyz`

Token structure: `fed_<base64url(24 random bytes)>`

## API Endpoints

All endpoints are prefixed with `/api/a2a/`

### GET /status

Check if A2A is enabled.

Response:
```json
{
  "a2a": true,
  "version": "0.1.0",
  "capabilities": ["invoke", "multi-turn"],
  "rate_limits": {
    "per_minute": 10,
    "per_hour": 100,
    "per_day": 1000
  }
}
```

### GET /ping

Health check endpoint.

Response:
```json
{
  "pong": true,
  "timestamp": "2026-02-11T17:54:00Z"
}
```

### POST /invoke

Call the agent.

Headers:
```
Authorization: Bearer fed_abc123xyz
Content-Type: application/json
x-trace-id: trace_... (optional)
x-request-id: req_... (optional)
```

Request body:
```json
{
  "message": "Your question or request",
  "conversation_id": "optional-for-multi-turn",
  "caller": {
    "name": "Alice's Agent",
    "instance": "alice.example.com",
    "context": "Why I'm calling"
  },
  "timeout_seconds": 60
}
```

Success response:
```json
{
  "success": true,
  "trace_id": "trace_...",
  "request_id": "req_...",
  "conversation_id": "conv_123456",
  "response": "The agent's response text",
  "can_continue": true,
  "tokens_remaining": 47
}
```

Error responses:
```json
{"success": false, "error": "token_expired", "message": "..."}
{"success": false, "error": "token_revoked", "message": "..."}
{"success": false, "error": "permission_denied", "message": "..."}
{"success": false, "error": "rate_limited", "message": "..."}
{"success": false, "error": "missing_token", "message": "..."}
{"success": false, "error": "missing_message", "message": "..."}
```

### POST /end

Explicitly end a conversation and trigger conclusion/summarization.

Headers:
```
Authorization: Bearer fed_abc123xyz
Content-Type: application/json
```

Request body:
```json
{
  "conversation_id": "conv_123456"
}
```

Success response:
```json
{
  "success": true,
  "trace_id": "trace_...",
  "request_id": "req_...",
  "conversation_id": "conv_123456",
  "status": "concluded",
  "summary": "Optional summary text"
}
```

Error responses:
```json
{"success": false, "error": "unauthorized", "message": "..."}
{"success": false, "error": "missing_conversation_id", "message": "..."}
{"success": false, "error": "internal_error", "message": "..."}
```

## Traceability and Log APIs

A2A persists structured runtime logs to `~/.config/openclaw/a2a-logs.db` (or `$A2A_CONFIG_DIR/a2a-logs.db`).

Primary log fields:
- `trace_id`
- `conversation_id`
- `token_id`
- `error_code`
- `status_code`
- `hint`

Dashboard API endpoints:
- `GET /api/a2a/dashboard/logs`
- `GET /api/a2a/dashboard/logs/trace/:traceId`
- `GET /api/a2a/dashboard/logs/stats`
- `GET /api/a2a/dashboard/debug/call?trace_id=<id>`

Example filters for `/logs`: `trace_id`, `conversation_id`, `token_id`, `error_code`, `status_code`, `component`, `event`, `level`, `search`, `from`, `to`.

## Permission Tiers

| Tier | Default capabilities |
|------|----------------------|
| `public` | `context-read` |
| `friends` | `context-read`, `calendar.read`, `email.read`, `search` |
| `family` | `context-read`, `calendar`, `email`, `search`, `tools`, `memory` |

## Disclosure Levels

| Level | Behavior |
|-------|----------|
| `public` | Agent may share any non-private information |
| `minimal` | Agent gives direct answers only, no context about owner |
| `none` | Agent confirms capability only, provides no actual information |

## Token Storage Schema

Stored in `~/.config/openclaw/a2a.json`:

```json
{
  "tokens": [
    {
      "id": "tok_abc123xyz789",
      "token_hash": "sha256...",
      "name": "Alice's agent",
      "tier": "public",
      "capabilities": ["context-read"],
      "allowed_topics": ["chat"],
      "allowed_goals": [],
      "tier_settings": {},
      "disclosure": "minimal",
      "notify": "all",
      "max_calls": null,
      "calls_made": 5,
      "created_at": "2026-02-11T17:54:00Z",
      "expires_at": "2026-02-18T17:54:00Z",
      "last_used": "2026-02-12T10:30:00Z",
      "revoked": false
    }
  ],
  "contacts": [
    {
      "id": "contact_xyz",
      "name": "Bob's agent",
      "owner": "Bob",
      "host": "bob.example.com",
      "token_hash": "sha256...",
      "token_enc": "base64...",
      "server_name": "Bob's server",
      "notes": "Met via A2A",
      "tags": ["collaborator"],
      "fields": { "email": "bob@example.com" },
      "linked_token_id": "tok_abc123xyz789",
      "added_at": "2026-02-11T18:00:00Z"
    }
  ]
}
```

## Rate Limits

Default per-token limits:
- 10 requests per minute
- 100 requests per hour
- 1000 requests per day

Limits reset on natural boundaries (minute, hour, day UTC).

## Security Considerations

1. **Token hashing**: Tokens stored as SHA-256 hashes server-side
2. **TLS required**: All A2A calls should use HTTPS
3. **No credential forwarding**: Tokens are never forwarded to other agents
4. **Audit logging**: All invocations are logged with caller info
5. **Auto-revocation**: Tokens may auto-revoke after repeated errors

## Multi-turn Conversations

To continue a conversation, include `conversation_id` from the previous response:

```json
{
  "message": "Follow-up question",
  "conversation_id": "conv_123456"
}
```

When finished, either:
- Call `POST /end` with the same `conversation_id` for explicit conclusion, or
- Let the receiver auto-conclude on idle timeout/max duration (if enabled).

Conversations expire after 1 hour of inactivity.

## Owner Notifications

When `notify: all`:
```
🤝 A2A call received

From: Alice's Agent (alice.example.com)
Token: "Work collab" (expires 2026-02-18)

---
Alice's Agent: Does Ben have time this week?
You: Ben is available Thursday 2-4pm.
---

📊 5 of unlimited calls | Token expires in 6d
```

Owner can reply to inject into the conversation.

## OpenClaw Integration

### Gateway Proxy (Recommended)

Run A2A Calling as its own server (separate process), and let the OpenClaw gateway proxy to it:

- A2A backend (separate): `a2a server --port 3001`
- OpenClaw gateway path(s):
  - `/a2a` proxies to the A2A dashboard UI (`/dashboard`)
  - `/api/a2a/*` proxies to the A2A backend API

This keeps the A2A server decoupled from OpenClaw's gateway runtime while still allowing the gateway to be the single public entry point.

### Agent Context

When handling an A2A call, inject context:
```json
{
  "a2a": {
    "active": true,
    "caller": "Alice's Agent",
    "tier": "public",
    "disclosure": "minimal"
  }
}
```

### New Tool: a2a_call

```typescript
a2a_call({
  endpoint: string,    // a2a:// URL
  message: string,     // Message to send
  conversation_id?: string  // For multi-turn
}): {
  success: boolean,
  response?: string,
  conversation_id?: string,
  error?: string
}
```

## E2E Testing

### Architecture

E2E tests run in fully isolated environments. Each test gets its own temp directory, config directory (`A2A_CONFIG_DIR`), and ephemeral port. No shared state between tests; no pollution of the host system.

Core components:

| Component | File | Purpose |
|-----------|------|---------|
| Environment | `test/e2e/env.js` | Creates isolated temp dir, config dir, port finder, cleanup |
| Two-server harness | `test/e2e/two-server.js` | Spins up two independent A2A servers for cross-agent tests |
| CLI runner | `test/e2e/cli-runner.js` | Wraps `bin/cli.js` as child process with structured output |
| Agent prompt | `docs/prompts/e2e-test-agent.md` | 9-step prompt sequence for Claude subagent validation |

### Test Categories

- **Infrastructure** (`env.test.js`) -- Isolated environments, port allocation, cleanup
- **CLI integration** (`cli-runner.test.js`) -- Command execution, onboarding, exit codes, timeouts
- **Cross-agent flow** (`two-server.test.js`) -- Two servers, token isolation, ping/invoke across instances
- **Error handling** -- Bad tokens, missing auth, revoked tokens, malformed requests
- **Summary validation** -- Prompt correctness across `server.js`, `openclaw-integration.js`, `claude-subagent.js` paths

### Entry Points

```bash
# Run all tests (unit + integration + E2E)
node test/run.js

# Run E2E tests only
node test/run.js --e2e

# Standalone orchestrator with verbose or JSON output
node test/e2e/orchestrate.js [--verbose] [--json]

# Default: excludes E2E for faster feedback
node test/run.js
```

The `--e2e` flag filters to files under `test/e2e/`. The standalone orchestrator runs the full 9-step sequence from `docs/prompts/e2e-test-agent.md` and outputs structured JSON results.

### File Structure

```
test/e2e/
  env.js                  # createE2EEnv() — isolated temp + config + port
  env.test.js             # Tests for env isolation and port allocation
  cli-runner.js           # CLIRunner class — child-process CLI wrapper
  cli-runner.test.js      # Tests for CLI execution, onboarding, timeouts
  two-server.js           # TwoServerHarness — two independent A2A instances
  two-server.test.js      # Tests for cross-agent token isolation and ping
  orchestrate.js           # Standalone E2E orchestrator (planned)
```

### Adding New E2E Tests

1. Create `test/e2e/<name>.test.js` exporting `function(test, assert, helpers)`.
2. Use `createE2EEnv()` for isolation. Always call `env.cleanup()` in a finally block.
3. Use `TwoServerHarness` if you need two agents. Call `harness.teardown()` after.
4. Use `CLIRunner` for CLI interactions. It handles `A2A_CONFIG_DIR` automatically.
5. The test runner discovers all `*.test.js` files recursively -- no registration needed.

Example skeleton:

```js
module.exports = function (test, assert, helpers) {
  const { createE2EEnv } = require('./env');

  test('my new E2E scenario', async () => {
    const env = createE2EEnv('my-test');
    try {
      // ... test logic using env.configDir, env.findAvailablePort()
    } finally {
      env.cleanup();
    }
  });
};
```

## Future Protocol Extensions (v1+)

- **Capability advertisement**: Agents declare what they can help with
- **Cryptographic identity**: Ed25519 signatures for caller verification
- **Streaming responses**: SSE for long-running operations
- **Webhooks**: Push notifications instead of polling
- **Payments**: Token-gated access with usage billing
