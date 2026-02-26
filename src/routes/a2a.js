/**
 * A2A API Routes
 * 
 * Mount at: /api/a2a
 * 
 * Security notes:
 * - Rate limiting is in-memory (resets on restart) - for production, use Redis
 * - Body size should be limited by Express middleware (e.g., express.json({ limit: '100kb' }))
 */

const { TokenStore } = require('../lib/tokens');
const crypto = require('crypto');
const { createLogger, createTraceId } = require('../lib/logger');
const { verifySignature, isTimestampValid, fingerprint } = require('../lib/crypto');

// Lazy-load conversation store (optional dependency)
let ConversationStore = null;
let conversationStore = null;
function getConversationStore(options = {}) {
  if (!ConversationStore) {
    try {
      ConversationStore = require('../lib/conversations').ConversationStore;
      const configDir = options.configDir || undefined;
      conversationStore = new ConversationStore(configDir, {
        eventStore: options.eventStore || null
      });
      if (!conversationStore.isAvailable()) {
        conversationStore = null;
      }
    } catch (err) {
      // Conversation storage not available
      return null;
    }
  }
  return conversationStore;
}

// Lazy-load call monitor
let CallMonitor = null;
let callMonitor = null;
function getCallMonitor(options = {}) {
  if (!CallMonitor) {
    try {
      CallMonitor = require('../lib/call-monitor').CallMonitor;
    } catch (err) {
      return null;
    }
  }
  if (!callMonitor && options.convStore) {
    callMonitor = new CallMonitor(options);
    callMonitor.start();
  }
  return callMonitor;
}

// Rate limiting state (in-memory - resets on restart)
// For production: use Redis or persistent store
const rateLimits = new Map();

// Rate limit eviction constants
const RATE_LIMIT_MAX_ENTRIES = 1000;
const RATE_LIMIT_STALE_MS = 24 * 60 * 60 * 1000; // 24 hours

// Constants
const MAX_MESSAGE_LENGTH = 10000;  // 10KB max message
const MAX_TIMEOUT_SECONDS = 300;   // 5 min max timeout
const MIN_TIMEOUT_SECONDS = 5;     // 5 sec min timeout

function isLoopbackAddress(ip) {
  if (!ip) return false;
  if (ip === '::1' || ip === '127.0.0.1' || ip === '::ffff:127.0.0.1') {
    return true;
  }
  return ip.startsWith('::ffff:127.');
}

function resolveTraceId(req) {
  const headerTrace = req.headers['x-trace-id'];
  if (typeof headerTrace === 'string' && headerTrace.trim()) {
    return headerTrace.trim().slice(0, 120);
  }
  return createTraceId('a2a');
}

function resolveRequestId(req) {
  const headerRequestId = req.headers['x-request-id'];
  if (typeof headerRequestId === 'string' && headerRequestId.trim()) {
    return headerRequestId.trim().slice(0, 120);
  }
  return createTraceId('req');
}

function extractClientHost(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || null;
}

function normalizeRequestMetadata(req) {
  const body = req && typeof req.body === 'object' && req.body ? req.body : {};
  return {
    has_message: typeof body.message === 'string',
    has_caller: Boolean(body.caller && typeof body.caller === 'object'),
    has_context: Boolean(body.context && typeof body.context === 'object'),
    timeout_seconds: body.timeout_seconds
  };
}

/**
 * Timing-safe comparison of two token strings.
 * Returns true if tokens match, false otherwise.
 * Short-circuits (non-timing-safe) only when a value is missing or empty,
 * which is acceptable since the absence of a token is not secret.
 */
function timingSafeTokenEqual(a, b) {
  if (!a || !b) return false;
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function checkRateLimit(tokenId, limits = { minute: 10, hour: 100, day: 1000 }) {
  const now = Date.now();
  const minute = Math.floor(now / 60000);
  const hour = Math.floor(now / 3600000);
  const day = Math.floor(now / 86400000);

  let state = rateLimits.get(tokenId);
  if (!state) {
    state = { 
      minute: { count: 0, bucket: minute }, 
      hour: { count: 0, bucket: hour }, 
      day: { count: 0, bucket: day } 
    };
    rateLimits.set(tokenId, state);
  }

  // Reset buckets if needed
  if (state.minute.bucket !== minute) state.minute = { count: 0, bucket: minute };
  if (state.hour.bucket !== hour) state.hour = { count: 0, bucket: hour };
  if (state.day.bucket !== day) state.day = { count: 0, bucket: day };

  // Check limits
  if (state.minute.count >= limits.minute) {
    return { limited: true, error: 'rate_limited', message: 'Too many requests per minute', retryAfter: 60 };
  }
  if (state.hour.count >= limits.hour) {
    return { limited: true, error: 'rate_limited', message: 'Too many requests per hour', retryAfter: 3600 };
  }
  if (state.day.count >= limits.day) {
    return { limited: true, error: 'rate_limited', message: 'Too many requests per day', retryAfter: 86400 };
  }

  // Increment
  state.minute.count++;
  state.hour.count++;
  state.day.count++;

  // Evict stale entries when the Map exceeds the size threshold
  if (rateLimits.size > RATE_LIMIT_MAX_ENTRIES) {
    const staleThreshold = now - RATE_LIMIT_STALE_MS;
    let evicted = 0;
    for (const [key, entry] of rateLimits) {
      // An entry is stale if all three bucket timestamps are older than 24h
      const latestBucket = Math.max(
        entry.minute.bucket * 60000,
        entry.hour.bucket * 3600000,
        entry.day.bucket * 86400000
      );
      if (latestBucket < staleThreshold) {
        rateLimits.delete(key);
        evicted++;
      }
    }
    // If no stale entries found, evict the oldest (first-inserted) entries
    if (evicted === 0) {
      const excess = rateLimits.size - RATE_LIMIT_MAX_ENTRIES;
      let removed = 0;
      for (const key of rateLimits.keys()) {
        if (removed >= excess) break;
        rateLimits.delete(key);
        removed++;
      }
    }
  }

  return { limited: false };
}

/**
 * Create a2a routes
 * 
 * @param {object} options
 * @param {TokenStore} options.tokenStore - Token store instance
 * @param {function} options.handleMessage - Async function to handle incoming messages
 * @param {function} options.notifyOwner - Async function to notify owner of calls
 * @param {object} options.rateLimits - Custom rate limits { minute, hour, day }
 * @param {function} options.summarizer - Async function to summarize conversations
 * @param {object} options.ownerContext - Owner context for summaries
 * @param {number} options.idleTimeoutMs - Idle timeout for auto-conclude (default: 60000)
 * @param {number} options.maxDurationMs - Max call duration (default: 300000)
 */
function createRoutes(options = {}) {
  const express = require('express');
  const router = express.Router();

  const tokenStore = options.tokenStore || new TokenStore();
  const handleMessage = options.handleMessage || defaultMessageHandler;
  const notifyOwner = options.notifyOwner || (() => Promise.resolve());
  const limits = options.rateLimits || { minute: 10, hour: 100, day: 1000 };
  const logger = options.logger || createLogger({ component: 'a2a.routes' });
  const eventStore = options.eventStore || null;

  // Initialize conversation store and call monitor
  const convStore = getConversationStore({
    eventStore,
    configDir: tokenStore.configDir
  });
  const monitor = getCallMonitor({
    convStore,
    summarizer: options.summarizer,
    notifyOwner,
    ownerContext: options.ownerContext || {},
    idleTimeoutMs: options.idleTimeoutMs || 60000,
    maxDurationMs: options.maxDurationMs || 300000,
    logger: logger.child({ component: 'a2a.call-monitor' })
  });
  if (typeof options.onCallMonitor === 'function') {
    try {
      options.onCallMonitor(monitor);
    } catch (_) {}
  }

  // A2A-52: shared signature verification helper for /invoke and /end
  function verifySigHeaders(req, validation, endpoint, reqLogger, withTracePayload) {
    const sigHeader = req.headers['x-a2a-signature'];
    const pubKeyHeader = req.headers['x-a2a-public-key'];
    const tsHeader = req.headers['x-a2a-timestamp'];
    const result = { identityVerified: false, publicKeyFingerprint: null, error: null };

    if (!sigHeader || !pubKeyHeader || !tsHeader) return result;

    if (!isTimestampValid(tsHeader)) {
      result.error = { status: 403, body: { success: false, error: 'timestamp_expired', message: 'Request timestamp outside allowed window' } };
      reqLogger.warn('Signature timestamp outside window', { tokenId: validation.id, error_code: 'SIGNATURE_TIMESTAMP_EXPIRED', status_code: 403 });
      return result;
    }

    try {
      crypto.createPublicKey({ key: Buffer.from(pubKeyHeader, 'base64'), format: 'der', type: 'spki' });
    } catch (_) {
      result.error = { status: 400, body: { success: false, error: 'malformed_public_key', message: 'X-A2A-Public-Key is not a valid Ed25519 public key' } };
      reqLogger.warn('Malformed public key', { tokenId: validation.id, error_code: 'MALFORMED_PUBLIC_KEY', status_code: 400 });
      return result;
    }

    const existingContact = tokenStore.getContact(validation.id) ||
      (tokenStore.listContacts().find(c => c.linked_token_id === validation.id));
    if (existingContact && existingContact.public_key && existingContact.public_key !== pubKeyHeader) {
      result.error = { status: 403, body: { success: false, error: 'public_key_mismatch', message: 'Public key does not match previously pinned key' } };
      reqLogger.warn('Public key mismatch (TOFU violation)', { tokenId: validation.id, error_code: 'PUBLIC_KEY_MISMATCH', status_code: 403 });
      return result;
    }

    const rawBody = JSON.stringify(req.body);
    try {
      const valid = verifySignature({ signature: sigHeader, publicKey: pubKeyHeader, timestamp: tsHeader, method: 'POST', endpoint, body: rawBody });
      if (valid) {
        result.identityVerified = true;
        result.publicKeyFingerprint = fingerprint(pubKeyHeader);
        if (existingContact && !existingContact.public_key) {
          tokenStore.updateContact(existingContact.name || existingContact.id, { public_key: pubKeyHeader });
        }
      } else {
        result.error = { status: 403, body: { success: false, error: 'invalid_signature', message: 'Ed25519 signature verification failed' } };
        reqLogger.warn('Signature verification failed', { tokenId: validation.id, error_code: 'SIGNATURE_INVALID', status_code: 403 });
      }
    } catch (sigErr) {
      result.error = { status: 403, body: { success: false, error: 'invalid_signature', message: 'Signature verification failed' } };
      reqLogger.warn('Signature verification error', { tokenId: validation.id, error_code: 'SIGNATURE_VERIFY_ERROR', status_code: 403, error: sigErr });
    }
    return result;
  }

  /**
   * GET /status
   * Check if A2A is enabled
   */
  router.get('/status', (req, res) => {
    const activeCalls = monitor ? monitor.getActiveCount() : 0;
    const response = {
      a2a: true,
      version: require('../../package.json').version,
      capabilities: ['invoke', 'multi-turn'],
      rate_limits: limits,
      active_calls: activeCalls
    };
    // A2A-52: include agent public key so contacts can fetch it
    if (options.publicKey) {
      response.public_key = options.publicKey;
    }
    res.json(response);
  });

  /**
   * GET /ping
   * Simple health check
   */
  router.get('/ping', (req, res) => {
    res.json({ pong: true, timestamp: new Date().toISOString() });
  });

  /**
   * POST /invoke
   * Call the agent
   */
  router.post('/invoke', async (req, res) => {
    const startedAt = Date.now();
    const traceId = resolveTraceId(req);
    const requestId = resolveRequestId(req);
    const reqLogger = logger.child({ traceId, requestId, event: 'invoke' });
    const withTracePayload = (payload) => ({ ...payload, trace_id: traceId, request_id: requestId });
    res.set('x-trace-id', traceId);
    res.set('x-request-id', requestId);
    reqLogger.info('Received invoke request', {
      data: {
        ip: req.ip,
        request_id: requestId,
        client_host: extractClientHost(req),
        forwarded_for: req.headers['x-forwarded-for'] || null,
        user_agent: req.headers['user-agent'] || null,
        has_auth_header: Boolean(req.headers.authorization)
      }
    });
    reqLogger.debug('Invoke request metadata', {
      event: 'invoke_request_metadata',
      data: normalizeRequestMetadata(req)
    });

    // Extract token
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      reqLogger.warn('Invoke request missing bearer token', {
        error_code: 'AUTH_MISSING_BEARER',
        status_code: 401,
        hint: 'Send Authorization: Bearer <a2a_token>.'
      });
      return res.status(401).json(withTracePayload({ 
        success: false, 
        error: 'missing_token', 
        message: 'Authorization header required' 
      }));
    }

    const token = authHeader.slice(7);

    // Validate token
    const validation = tokenStore.validate(token);
    if (!validation.valid) {
      // Use generic error to prevent token enumeration
      // All invalid token states return same response
      reqLogger.warn('Invoke token validation failed', {
        error_code: 'TOKEN_INVALID_OR_EXPIRED',
        status_code: 401,
        hint: 'Create a fresh invite token and retry with the new bearer token.'
      });
      return res.status(401).json(withTracePayload({ 
        success: false, 
        error: 'unauthorized', 
        message: 'Invalid or expired token' 
      }));
    }

    // Check rate limit
    const rateCheck = checkRateLimit(validation.id, limits);
    if (rateCheck.limited) {
      reqLogger.warn('Invoke request rate limited', {
        tokenId: validation.id,
        error_code: 'TOKEN_RATE_LIMITED',
        status_code: 429,
        hint: 'Respect Retry-After and reduce invoke frequency for this token.',
        data: {
          retry_after: rateCheck.retryAfter
        }
      });
      res.set('Retry-After', rateCheck.retryAfter);
      return res.status(429).json(withTracePayload({ 
        success: false, 
        error: rateCheck.error, 
        message: rateCheck.message 
      }));
    }

    // A2A-52: Ed25519 signature verification (after token auth, before message handling)
    const sigCheck = verifySigHeaders(req, validation, '/api/a2a/invoke', reqLogger, withTracePayload);
    if (sigCheck.error) {
      return res.status(sigCheck.error.status).json(withTracePayload(sigCheck.error.body));
    }
    const identityVerified = sigCheck.identityVerified;
    const publicKeyFingerprint = sigCheck.publicKeyFingerprint;

    // Extract and validate request
    const { message, conversation_id, caller, context, timeout_seconds = 60 } = req.body;

    if (!message) {
      reqLogger.warn('Invoke request missing message', {
        tokenId: validation.id,
        error_code: 'REQUEST_MISSING_MESSAGE',
        status_code: 400,
        hint: 'Include a non-empty string field `message` in the request body.'
      });
      return res.status(400).json(withTracePayload({ 
        success: false, 
        error: 'missing_message', 
        message: 'Message is required' 
      }));
    }

    // Validate message length
    if (typeof message !== 'string' || message.length > MAX_MESSAGE_LENGTH) {
      reqLogger.warn('Invoke request has invalid message payload', {
        tokenId: validation.id,
        error_code: 'REQUEST_INVALID_MESSAGE',
        status_code: 400,
        hint: `Ensure message is a string <= ${MAX_MESSAGE_LENGTH} characters.`,
        data: {
          message_type: typeof message,
          message_length: typeof message === 'string' ? message.length : null
        }
      });
      return res.status(400).json(withTracePayload({
        success: false,
        error: 'invalid_message',
        message: `Message must be a string under ${MAX_MESSAGE_LENGTH} characters`
      }));
    }

    // Validate and bound timeout
    const boundedTimeout = Math.max(MIN_TIMEOUT_SECONDS, Math.min(MAX_TIMEOUT_SECONDS, Number(timeout_seconds) || 60));

    // Sanitize caller data (only allow expected fields)
    const sanitizedCaller = caller ? {
      name: String(caller.name || '').slice(0, 100),
      owner: String(caller.owner || '').slice(0, 100),
      instance: String(caller.instance || '').slice(0, 200),
      context: String(caller.context || '').slice(0, 500)
    } : {};

    // Build a2a context with secure conversation ID
    const isNewConversation = !conversation_id;
    const a2aContext = {
      mode: 'a2a',
      token_id: validation.id,
      token_name: validation.name,
      tier: validation.tier,
      capabilities: validation.capabilities,
      allowed_topics: validation.allowed_topics,
      allowed_goals: validation.allowed_goals,
      allowed_tools: validation.allowed_tools,
      timeout_ms: validation.timeout_ms,
      caller: sanitizedCaller,
      conversation_id: conversation_id || `conv_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`,
      trace_id: traceId,
      request_id: requestId,
      // A2A-52: cryptographic identity verification status
      identity_verified: identityVerified,
      public_key_fingerprint: publicKeyFingerprint
    };

    // Ensure inbound caller exists as a contact (best-effort).
    let ensuredContact = null;
    try {
      ensuredContact = tokenStore.ensureInboundContact(sanitizedCaller, validation.id);
    } catch (err) {
      ensuredContact = null;
    }

    // Track conversation if store available
    if (convStore) {
      try {
        convStore.startConversation({
          id: a2aContext.conversation_id,
          // Standardize: store the local contact.id when available (fallback to token id otherwise).
          contactId: ensuredContact?.id || validation.id,
          contactName: ensuredContact?.name || sanitizedCaller.name || validation.name,
          tokenId: validation.id,
          direction: 'inbound'
        });
        if (isNewConversation && eventStore && eventStore.isAvailable && eventStore.isAvailable()) {
          eventStore.emitEvent('call.inbound', {
            conversation_id: a2aContext.conversation_id,
            token_id: validation.id,
            caller_name: sanitizedCaller.name || validation.name || null,
            caller_owner: sanitizedCaller.owner || null
          }, {
            conversationId: a2aContext.conversation_id,
            contactId: ensuredContact?.id || validation.id
          });
        }
        
        // Track activity for auto-conclude
        if (monitor) {
          monitor.trackActivity(a2aContext.conversation_id, {
            ...sanitizedCaller,
            tier: validation.tier,
            capabilities: validation.capabilities,
            allowed_topics: validation.allowed_topics,
            allowed_goals: validation.allowed_goals,
            allowed_tools: validation.allowed_tools,
            trace_id: traceId,
            request_id: requestId
          });
        }
        
        // Store incoming message
        convStore.addMessage(a2aContext.conversation_id, {
          direction: 'inbound',
          role: 'user',
          content: message
        });
      } catch (err) {
        reqLogger.error('Conversation tracking error', {
          conversationId: a2aContext.conversation_id,
          tokenId: validation.id,
          error_code: 'CONVERSATION_TRACKING_FAILED',
          hint: 'Check SQLite conversation DB file permissions and schema availability.',
          error: err,
          data: {
            phase: 'conversation_tracking'
          }
        });
      }
    }

    try {
      // Handle the message
      const response = await handleMessage(message, a2aContext, { timeout: boundedTimeout * 1000 });
      
      // Store outgoing response
      if (convStore) {
        try {
          convStore.addMessage(a2aContext.conversation_id, {
            direction: 'outbound',
            role: 'assistant',
            content: response.text
          });
        } catch (err) {
          reqLogger.error('Message storage error', {
            conversationId: a2aContext.conversation_id,
            tokenId: validation.id,
            error_code: 'CONVERSATION_MESSAGE_STORE_FAILED',
            hint: 'Check SQLite conversation DB write access and disk availability.',
            error: err,
            data: {
              phase: 'message_store'
            }
          });
        }
      }

      // Notify owner if configured
      if (validation.notify !== 'none') {
        notifyOwner({
          level: validation.notify,
          token: validation,
          caller,
          context,
          message,
          response: response.text,
          conversation_id: a2aContext.conversation_id,
          trace_id: traceId,
          request_id: requestId
        }).catch(err => {
          reqLogger.error('Failed to notify owner', {
            conversationId: a2aContext.conversation_id,
            tokenId: validation.id,
            error_code: 'OWNER_NOTIFY_FAILED',
            hint: 'Verify runtime notify channel settings and external notifier health.',
            error: err,
            data: {
              phase: 'owner_notify'
            }
          });
        });
      }

      reqLogger.info('Invoke request completed', {
        conversationId: a2aContext.conversation_id,
        tokenId: validation.id,
        requestId,
        data: {
          duration_ms: Date.now() - startedAt,
          message_length: message.length,
          is_new_conversation: isNewConversation
        }
      });

      const responsePayload = {
        success: true,
        trace_id: traceId,
        request_id: requestId,
        conversation_id: a2aContext.conversation_id,
        response: response.text,
        can_continue: response.canContinue !== false,
        tokens_remaining: validation.calls_remaining
      };

      if (response.collaboration) {
        responsePayload.collaboration = response.collaboration;
      }

      res.json(responsePayload);

    } catch (err) {
      reqLogger.error('Message handling error', {
        conversationId: a2aContext.conversation_id,
        tokenId: validation.id,
        error_code: 'INVOKE_HANDLER_FAILED',
        status_code: 500,
        hint: 'Inspect handler/runtime logs in this trace and validate upstream dependencies.',
        error: err,
        data: {
          duration_ms: Date.now() - startedAt
        }
      });
      res.status(500).json(withTracePayload({
        success: false,
        error: 'internal_error',
        message: 'Failed to process message'
      }));
    }
  });

  /**
   * POST /end
   * End a conversation and trigger summary generation
   */
  router.post('/end', async (req, res) => {
    const startedAt = Date.now();
    const traceId = resolveTraceId(req);
    const requestId = resolveRequestId(req);
    const reqLogger = logger.child({ traceId, requestId, event: 'end' });
    const withTracePayload = (payload) => ({ ...payload, trace_id: traceId, request_id: requestId });
    res.set('x-trace-id', traceId);
    res.set('x-request-id', requestId);
    reqLogger.info('Received end request', {
      data: {
        request_id: requestId,
        ip: req.ip,
        client_host: extractClientHost(req),
        has_auth_header: Boolean(req.headers.authorization),
        has_conversation_id: Boolean(req.body && req.body.conversation_id)
      }
    });

    // Extract token
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      reqLogger.warn('End request missing bearer token', {
        error_code: 'AUTH_MISSING_BEARER',
        status_code: 401,
        hint: 'Send Authorization: Bearer <a2a_token>.'
      });
      return res.status(401).json(withTracePayload({ 
        success: false, 
        error: 'unauthorized', 
        message: 'Authorization header required' 
      }));
    }

    const token = authHeader.slice(7);
    const validation = tokenStore.validate(token);
    if (!validation.valid) {
      reqLogger.warn('End request token validation failed', {
        error_code: 'TOKEN_INVALID_OR_EXPIRED',
        status_code: 401,
        hint: 'Use a currently valid invite token for conversation end calls.'
      });
      return res.status(401).json(withTracePayload({ 
        success: false, 
        error: 'unauthorized', 
        message: 'Invalid or expired token'
      }));
    }

    // A2A-52: Ed25519 signature verification for /end (same as /invoke)
    const endSigCheck = verifySigHeaders(req, validation, '/api/a2a/end', reqLogger, withTracePayload);
    if (endSigCheck.error) {
      return res.status(endSigCheck.error.status).json(withTracePayload(endSigCheck.error.body));
    }

    const { conversation_id } = req.body;
    if (!conversation_id) {
      reqLogger.warn('End request missing conversation_id', {
        tokenId: validation.id,
        error_code: 'REQUEST_MISSING_CONVERSATION_ID',
        status_code: 400,
        hint: 'Provide `conversation_id` returned from /invoke.'
      });
      return res.status(400).json(withTracePayload({
        success: false,
        error: 'missing_conversation_id',
        message: 'conversation_id is required'
      }));
    }

    const convStore = getConversationStore({
      eventStore,
      configDir: tokenStore.configDir
    });
    if (!convStore) {
      return res.json(withTracePayload({ success: true, message: 'Conversation storage not enabled' }));
    }

    try {
      // Conclude with summarizer if available
      const summarizer = options.summarizer || null;
      const ownerContext = options.ownerContext || {};
      
      const result = await convStore.concludeConversation(conversation_id, {
        summarizer,
        ownerContext
      });

      // Notify owner of conversation conclusion
      if (validation.notify !== 'none' && result.success) {
        const conv = convStore.getConversationContext(conversation_id);
        notifyOwner({
          level: validation.notify,
          type: 'conversation_concluded',
          token: validation,
          conversation: conv,
          trace_id: traceId,
          request_id: requestId
        }).catch(err => {
          reqLogger.error('Failed to notify owner after conversation end', {
            conversationId: conversation_id,
            tokenId: validation.id,
            error_code: 'OWNER_NOTIFY_FAILED',
            hint: 'Verify notify runtime integration for post-conclusion notifications.',
            error: err,
            data: {
              phase: 'conversation_end_notify'
            }
          });
        });
      }

      reqLogger.info('End request completed', {
        conversationId: conversation_id,
        tokenId: validation.id,
        requestId,
        data: {
          duration_ms: Date.now() - startedAt,
          status: result.success ? 'concluded' : 'unchanged'
        }
      });

      res.json({
        success: true,
        trace_id: traceId,
        request_id: requestId,
        conversation_id,
        status: 'concluded',
        summary: result.summary
      });
    } catch (err) {
      reqLogger.error('End conversation error', {
        conversationId: conversation_id,
        tokenId: validation.id,
        error_code: 'END_CONVERSATION_FAILED',
        status_code: 500,
        hint: 'Check conversation existence and summarizer runtime status for this trace.',
        error: err,
        data: {
          duration_ms: Date.now() - startedAt
        }
      });
      res.status(500).json(withTracePayload({
        success: false,
        error: 'internal_error',
        message: 'Failed to end conversation'
      }));
    }
  });

  /**
   * GET /conversations
   * List conversations (requires auth)
   * This is for the agent owner, not remote callers
   */
  router.get('/conversations', (req, res) => {
    // This endpoint should be protected by local auth, not A2A tokens
    // For now, require an admin token or local access
    const expected = process.env.A2A_ADMIN_TOKEN;
    const adminToken = req.headers['x-admin-token'];
    if (!isLoopbackAddress(req.ip)) {
      if (!expected) {
        return res.status(401).json({
          error: 'admin_token_required',
          message: 'Set A2A_ADMIN_TOKEN to access conversation admin routes from non-local addresses'
        });
      }
      if (!timingSafeTokenEqual(adminToken, expected)) {
        return res.status(401).json({ error: 'unauthorized' });
      }
    }

    const convStore = getConversationStore();
    if (!convStore) {
      return res.json({ conversations: [], message: 'Conversation storage not enabled' });
    }

    const { contact_id, status, limit = 20 } = req.query;
    
    const conversations = convStore.listConversations({
      contactId: contact_id,
      status,
      limit: Math.min(100, Math.max(1, Number.parseInt(String(limit), 10) || 20)),
      includeMessages: false
    });

    res.json({ conversations });
  });

  /**
   * GET /conversations/:id
   * Get conversation details with context
   */
  router.get('/conversations/:id', (req, res) => {
    const expected = process.env.A2A_ADMIN_TOKEN;
    const adminToken = req.headers['x-admin-token'];
    if (!isLoopbackAddress(req.ip)) {
      if (!expected) {
        return res.status(401).json({
          error: 'admin_token_required',
          message: 'Set A2A_ADMIN_TOKEN to access conversation admin routes from non-local addresses'
        });
      }
      if (!timingSafeTokenEqual(adminToken, expected)) {
        return res.status(401).json({ error: 'unauthorized' });
      }
    }

    const convStore = getConversationStore();
    if (!convStore) {
      return res.status(404).json({ error: 'conversation_storage_disabled' });
    }

    const { recent_messages = 10 } = req.query;
    const context = convStore.getConversationContext(
      req.params.id,
      Math.min(50, Math.max(1, Number.parseInt(String(recent_messages), 10) || 10))
    );

    if (!context) {
      return res.status(404).json({ error: 'conversation_not_found' });
    }

    res.json(context);
  });

  return router;
}

/**
 * Default message handler (placeholder)
 */
async function defaultMessageHandler(message, context, options) {
  return {
    text: `[A2A Active] Received message from ${context.caller?.name || 'unknown'}. Agent integration pending.`,
    canContinue: true
  };
}

module.exports = {
  createRoutes,
  checkRateLimit,
  timingSafeTokenEqual,
  // Exposed for testing only
  _rateLimits: rateLimits,
  _RATE_LIMIT_MAX_ENTRIES: RATE_LIMIT_MAX_ENTRIES
};
