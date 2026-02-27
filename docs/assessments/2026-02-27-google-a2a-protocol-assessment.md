# Google A2A Protocol — Adoption & Adaptation Assessment

**Ticket:** A2A-75
**Date:** 2026-02-27
**Status:** Assessment Complete

---

## 1. Executive Summary

The Google A2A Protocol (a2a-protocol.org) is an open standard for agent-to-agent communication built on JSON-RPC 2.0 with HTTP, gRPC, and SSE bindings. It shares significant conceptual overlap with our A2A Calling protocol — both solve the same fundamental problem of enabling opaque agents to communicate. However, the two protocols diverge substantially in philosophy: Google's spec is enterprise-grade infrastructure (task-oriented, schema-heavy, multi-transport), while ours is relationship-oriented (token-scoped, disclosure-aware, conversation-first).

**Recommendation:** Adopt Google A2A as the wire protocol and discovery layer while preserving our permission tiers, disclosure levels, conversation model, and "first meeting" workflow as an extension layer on top. This gives us interoperability with the emerging ecosystem without losing the social trust features that define our product.

---

## 2. Protocol Comparison

### 2.1 Core Concepts Mapping

| Our Concept | Google A2A Equivalent | Gap Analysis |
|---|---|---|
| Token (`fed_xxx`) | SecurityScheme (apiKey / OAuth2 / bearer) | Google is more flexible — supports OAuth2 flows. Our tokens are simpler (bearer only) but richer (tier, disclosure, topics, max_calls). |
| `POST /invoke` | `a2a.SendMessage` | Direct mapping. Google returns Task or Message; we return response text + `can_continue`. |
| `conversation_id` | `contextId` | Same concept — group related interactions. Google also has `taskId` for individual work units within a context. |
| Multi-turn conversation | `input-required` task state | Google models this as task state machine; we model it as conversation continuation with `can_continue`. |
| `POST /end` | Task reaches terminal state (`completed`/`canceled`) | Google has richer terminal states (failed, rejected, canceled). We have `concluded`/`timeout`. |
| Permission tiers (public/friends/family) | Agent Card `skills` + OAuth scopes | **No equivalent.** Google has no concept of relationship-based capability gating. This is our key differentiator. |
| Disclosure levels (public/minimal/none) | **No equivalent** | Google assumes agents share freely. No information-sharing policy model. |
| `GET /status` | `GET /.well-known/a2a-agent-card` | Google's Agent Card is far richer — declares skills, auth requirements, capabilities, provider info. Our `/status` is minimal. |
| Token `allowed_topics` | AgentSkill `inputSchema` | Loose mapping. Google uses JSON Schema for skill inputs; we use topic strings. |
| Owner notifications | Push Notifications (webhooks) | Google's push notifications are for task updates to the *caller*, not owner awareness. Our notifications inform the *agent owner* about incoming calls. |
| Ed25519 signatures | AgentCardSignature + TLS mutual auth | Google supports card signing. We have per-message Ed25519 signing. |
| Rate limits (per-token) | API Management layer | Google delegates to infrastructure; we enforce per-token in-app. |
| Caller context (`caller.name`, `caller.instance`) | Message `role` + metadata | Google messages don't carry caller identity — that's at the transport layer. |

### 2.2 What Google A2A Has That We Don't

1. **Agent Card / Discovery** — `/.well-known/a2a-agent-card` for automated agent discovery. Declares skills, capabilities, auth requirements. We have nothing comparable.
2. **Task State Machine** — Seven states (`working`, `completed`, `failed`, `canceled`, `rejected`, `input-required`, `auth-required`) vs. our two (`active`, `concluded`/`timeout`).
3. **Artifacts** — Structured output objects with MIME types, separate from conversational messages. We only have text responses.
4. **Streaming** — SSE-based streaming for real-time task updates. We're request/response only.
5. **gRPC Binding** — For high-performance inter-service communication.
6. **Extension System** — Versioned, URI-identified extensions for capability expansion.
7. **OpenTelemetry** — W3C Trace Context propagation for distributed tracing.

### 2.3 What We Have That Google A2A Doesn't

1. **Permission Tiers** — public/friends/family capability gating based on relationship trust level. This is our core value proposition.
2. **Disclosure Levels** — public/minimal/none information-sharing policy. Controls *how much* the agent reveals, not just *what* it can do.
3. **Owner Notifications** — Real-time alerts to the human owner when their agent is called. Google has no concept of human-in-the-loop awareness.
4. **"First Meeting" Workflow** — Our conversation model is designed for agents meeting for the first time — exploratory, collaborative, with progressive trust building. Google's model is transactional.
5. **Topic/Goal Scoping** — Per-token `allowed_topics` and `allowed_goals` constrain what a caller can discuss. Google has skill-level access but no per-session topic constraints.
6. **Token Economics** — `max_calls`, `calls_made`, expiration, revocation — rate-limited trust delegation. Google delegates this to infrastructure.
7. **Conversation Driver** — Multi-turn orchestration with min/max turns, idle timeout, auto-conclusion, and summary generation. Google leaves conversation management to the implementation.
8. **Contact Book** — Persistent directory of known agents with metadata, linked tokens, and ping status.

---

## 3. Adoption Strategy

### 3.1 Approach: "Google Wire, OpenClaw Soul"

Adopt the Google A2A wire protocol (JSON-RPC 2.0, Agent Card, Task model) as the transport layer while preserving our permission, disclosure, and conversation semantics as an extension layer.

```
┌─────────────────────────────────────────────────┐
│  OpenClaw Extension Layer                        │
│  ├─ Permission tiers (public/friends/family)     │
│  ├─ Disclosure levels (public/minimal/none)      │
│  ├─ Owner notifications                          │
│  ├─ Token economics (max_calls, expiry)          │
│  ├─ "First meeting" conversation driver          │
│  └─ Contact book + trust history                 │
├─────────────────────────────────────────────────┤
│  Google A2A Protocol (Wire Format)               │
│  ├─ Agent Card (/.well-known/a2a-agent-card)     │
│  ├─ JSON-RPC 2.0 (a2a.SendMessage, etc.)        │
│  ├─ Task state machine                           │
│  ├─ Artifacts + Parts                            │
│  └─ Streaming (SSE)                              │
├─────────────────────────────────────────────────┤
│  Transport (HTTPS + optional gRPC)               │
└─────────────────────────────────────────────────┘
```

### 3.2 Phase Plan

#### Phase 1: Agent Card (Discovery Layer)

Serve a Google A2A-compatible Agent Card at `/.well-known/a2a-agent-card`. This is the lowest-cost, highest-value adoption step — it makes our agents discoverable by any A2A-compatible system.

**Agent Card contents:**
- `name`, `description`, `provider` — from `a2a-config.json`
- `skills` — derived from our disclosure manifest topics
- `securitySchemes` — declare bearer token auth (our existing `fed_xxx` tokens)
- `capabilities` — `streaming: false`, `pushNotifications: false` initially
- `extensions` — declare our custom extension for permission tiers and disclosure

**OpenClaw Extension in Agent Card:**
```json
{
  "extensions": [
    {
      "uri": "https://openclaw.dev/a2a/extensions/trust-tiers",
      "version": "1.0.0",
      "required": false,
      "data": {
        "tiers": ["public", "friends", "family"],
        "disclosure_levels": ["public", "minimal", "none"],
        "owner_notifications": true,
        "contact_book": true
      }
    }
  ]
}
```

#### Phase 2: Dual-Protocol Inbound

Accept both our current `POST /api/a2a/invoke` format AND the Google A2A `a2a.SendMessage` JSON-RPC format on a new `POST /api/a2a/rpc` endpoint.

**Mapping:**
- Google `a2a.SendMessage` → our `invoke` handler
- Google `contextId` → our `conversation_id`
- Google `input-required` → our `can_continue: true`
- Google `completed` → our conversation conclusion
- Message `parts[].text` → our `message` string
- Task `artifacts` → (new) structured response attachments

**Token auth unchanged:** Google callers still need a valid `fed_xxx` bearer token. The token's tier and disclosure settings apply regardless of wire format.

#### Phase 3: Dual-Protocol Outbound

Update `A2AClient` to detect whether a remote agent serves a Google A2A Agent Card. If so, use `a2a.SendMessage` JSON-RPC format; otherwise, fall back to our current `POST /invoke`.

**Detection:**
1. `GET /.well-known/a2a-agent-card` — if 200 with valid card, use Google format
2. `GET /api/a2a/status` — if 200 with `"a2a": true`, use our format
3. Fall back to our format as default

#### Phase 4: Task State Machine

Adopt the Google task state machine internally, mapping to our conversation states:

| Google Task State | Our Current State | Migration |
|---|---|---|
| `working` | `active` | Direct mapping |
| `completed` | `concluded` | Direct mapping |
| `failed` | (new) | Add `failed` status to conversations |
| `canceled` | (new) | Add `canceled` status |
| `rejected` | (implicit — 403 response) | Formalize as conversation state |
| `input-required` | `active` + `can_continue: true` | Already modeled, just need state label |
| `auth-required` | (new) | Add for re-auth scenarios |

#### Phase 5: Streaming & Artifacts

Add SSE streaming support for long-running responses and artifact support for structured outputs. This is the most complex phase and can be deferred until there's ecosystem demand.

---

## 4. Preserving Our Differentiators

### 4.1 Permission Tiers as Extension

Google A2A has no concept of relationship-based trust. Our tiers are modeled as an extension that enriches the standard auth flow:

1. Standard Google A2A: client authenticates → agent processes request
2. Our extension: client authenticates → **token tier determines capabilities** → **disclosure level constrains responses** → agent processes within scope

This is transparent to Google-only callers — they authenticate normally and get `public` tier behavior by default. Callers that understand our extension can negotiate higher trust levels.

### 4.2 "First Meeting" Conversation Model

Google A2A's `a2a.SendMessage` is transactional — send a message, get a response. Our "first meeting" model is exploratory:

1. Agents introduce themselves (caller context)
2. Progressive topic exploration within allowed bounds
3. Collaborative discovery of shared interests
4. Trust building over multiple turns
5. Summary generation at conclusion

This maps cleanly onto Google's `contextId` + `input-required` pattern. The conversation driver orchestrates the multi-turn flow while the wire format is standard A2A.

### 4.3 Owner Awareness

Google A2A has push notifications for the *caller* to track task progress. We add owner notifications — the *callee's human* is informed about incoming calls. This is orthogonal to the protocol and requires no wire format changes. It remains a server-side feature.

### 4.4 Contact Book & Trust History

The contact book (persistent directory of known agents) is a local-only feature with no wire format implications. We can enhance it with Agent Card data — when we discover a remote agent's card, we can auto-populate contact metadata.

---

## 5. Migration Risks

### 5.1 Low Risk
- **Agent Card adoption** — additive, no breaking changes
- **Dual-protocol inbound** — new endpoint, existing endpoint unchanged
- **Contact book enrichment** — local-only enhancement

### 5.2 Medium Risk
- **Outbound protocol detection** — need robust fallback when remote agents serve partial or malformed Agent Cards
- **Task state machine migration** — our conversation store schema needs new states; existing conversations need migration
- **Response format change** — moving from flat `{ response: "..." }` to `{ parts: [...], artifacts: [...] }` requires dashboard and CLI updates

### 5.3 High Risk
- **Streaming** — fundamentally changes the response model from request/response to event stream. Requires significant changes to the conversation driver, dashboard, and CLI.
- **gRPC binding** — would add a substantial dependency. Recommend deferring unless ecosystem demand materializes.

---

## 6. Specification: OpenClaw Trust Tiers Extension

### 6.1 Extension URI

`https://openclaw.dev/a2a/extensions/trust-tiers`

### 6.2 Extension Data in Agent Card

```json
{
  "uri": "https://openclaw.dev/a2a/extensions/trust-tiers",
  "version": "1.0.0",
  "required": false,
  "data": {
    "tiers": ["public", "friends", "family"],
    "default_tier": "public",
    "disclosure_levels": ["public", "minimal", "none"],
    "default_disclosure": "minimal",
    "supports_topics": true,
    "supports_goals": true,
    "owner_notifications": true,
    "max_calls_enforced": true
  }
}
```

### 6.3 Extension Headers

Callers that understand the extension can include:

```
X-OpenClaw-Tier-Request: friends
X-OpenClaw-Disclosure-Preference: public
X-OpenClaw-Caller-Context: {"name": "Alice", "instance": "alice.example.com", "reason": "Collaboration request"}
```

The server validates these against the token's actual tier — a `public` token cannot request `friends` tier access.

### 6.4 Extension Response Metadata

```json
{
  "metadata": {
    "openclaw:tier": "friends",
    "openclaw:disclosure": "minimal",
    "openclaw:topics_allowed": ["chat", "search"],
    "openclaw:calls_remaining": 95,
    "openclaw:token_expires": "2026-03-06T17:54:00Z"
  }
}
```

---

## 7. Implementation Priority

| Priority | Item | Effort | Value |
|---|---|---|---|
| **P0** | Agent Card at `/.well-known/a2a-agent-card` | Small | High — instant ecosystem visibility |
| **P1** | Dual-protocol inbound (`POST /api/a2a/rpc`) | Medium | High — accept calls from any A2A agent |
| **P2** | Outbound protocol detection + Google format | Medium | Medium — call any A2A agent |
| **P3** | Task state machine adoption | Medium | Medium — richer conversation lifecycle |
| **P4** | Trust Tiers extension spec (formal) | Small | Medium — standardize our differentiator |
| **P5** | Streaming support (SSE) | Large | Low — defer until ecosystem demand |
| **P6** | Artifact support | Medium | Low — our use case is conversational |
| **P7** | gRPC binding | Large | Low — defer indefinitely |

---

## 8. Conclusion

The Google A2A Protocol and our A2A Calling protocol are complementary, not competing. Google provides the infrastructure layer (discovery, wire format, task management, enterprise features) while we provide the social layer (trust tiers, disclosure, owner awareness, relationship management).

By adopting Google A2A as the wire protocol and extending it with our trust model, we get:
- **Interoperability** with the broader A2A ecosystem (any Google A2A-compatible agent can call us)
- **Preservation** of our unique features (permission tiers, disclosure, first-meeting workflow)
- **Credibility** from aligning with an industry standard
- **Future-proofing** as the ecosystem grows (streaming, artifacts, gRPC — all available when needed)

The key architectural principle: **Google A2A is the envelope; OpenClaw is the letter inside.**
