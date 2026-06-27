/**
 * Conversation Driver — Outbound multi-turn orchestrator
 *
 * Drives a full multi-turn A2A conversation with a remote agent:
 *   1. Send message to remote via A2AClient.call()
 *   2. Store messages in DB
 *   3. Check close conditions
 *   4. Build prompt via buildAdaptiveConnectionPrompt()
 *   5. Call runtime.runTurn() to generate next message
 *   6. Extract collab state from response
 *   7. Persist collab state to DB
 *   8. Repeat until close conditions met
 *   9. Call A2AClient.end() and conclude locally
 */

const crypto = require('crypto');
const { A2AClient } = require('./client');
const {
  buildAdaptiveConnectionPrompt,
  extractCollaborationState
} = require('./prompt-template');
const { getTopicsForTier, formatTopicsForPrompt, loadManifest } = require('./disclosure');
const { createLogger } = require('./logger');
const { buildUnifiedSummaryPrompt } = require('./summary-prompt');
const { resolveTokenTimeoutMs, resolveTurnTimeoutMs } = require('./turn-timeout');

const logger = createLogger({ component: 'a2a.conversation-driver' });

/**
 * Detect remote termination intent from response text.
 * Returns true if the remote agent is clearly trying to end the conversation.
 */
const TERMINATION_PATTERNS = [
  /\[TERMINAT/i,
  /\[DISCONNECT/i,
  /\[END.?CALL\]/i,
  /\[CLOSING\]/i,
  /\bEND.?CALL\b/i,
  /\bcall\s+closed\b/i,
  /\bwrapping\s+up\b/i,
  /\[No\s+further\b/i,
  /\bno\s+further\b/i,
  /\bREFUSING\s+(TO\s+)?(CONTINU|RESPOND|ENGAG)/i,
  /\bcall\s+complet(ed|e)\b/i,
  /\bconversation\s+(is\s+)?(over|ended|closed|complet)/i,
  /\bclosing\s+this\s+(call|conversation|connection)\b/i,
  /\bgoodbye\b.*\b(end|clos|terminat)/i,
  /\bdisconnect(ing|ed)\b/i
];

function detectRemoteTermination(text) {
  if (!text || typeof text !== 'string') return false;
  // Very short responses (single dot, empty-ish) indicate dead conversation
  const trimmed = text.trim();
  if (trimmed.length <= 1) return true;
  return TERMINATION_PATTERNS.some(pattern => pattern.test(text));
}

/**
 * Infer collaboration state progression when the runtime doesn't emit
 * <collab_state> tags (e.g. OpenClaw without adaptive mode). Advances phase based on
 * turn count and estimates overlap from remote text analysis.
 */
function inferStateProgression(collabState, remoteText, turn) {
  const patch = {};

  // Phase progression based on turn count
  if (collabState.phase === 'handshake' && turn >= 2) {
    patch.phase = 'exploring';
  } else if (collabState.phase === 'exploring' && turn >= 5) {
    patch.phase = 'deepening';
  } else if (collabState.phase === 'deepening' && turn >= 8) {
    patch.phase = 'converging';
  }

  // Estimate overlap from remote text length and engagement signals
  const text = (remoteText || '').toLowerCase();
  const engagementSignals = [
    /\binteresting\b/, /\bgreat\b/, /\bexciting\b/, /\bagree\b/,
    /\bcollaborat/i, /\bpartner/i, /\btogether\b/, /\bshare\b/,
    /\bopportunit/i, /\bsynerg/i, /\bcomplement/i, /\balign/i,
    /\?/ // questions indicate engagement
  ];
  const matchCount = engagementSignals.filter(p => p.test(text)).length;
  const textLengthFactor = Math.min(text.length / 500, 1); // longer = more engaged
  const engagement = (matchCount / engagementSignals.length) * 0.5 + textLengthFactor * 0.3;

  // Blend current overlap with new engagement signal
  const newOverlap = collabState.overlapScore * 0.6 + engagement * 0.4;
  patch.overlapScore = Math.max(0.1, Math.min(0.95, newOverlap));

  // Confidence increases over turns
  patch.confidence = Math.min(0.9, 0.25 + turn * 0.08);

  // In converging phase, signal close — conversation has run its natural course
  const effectivePhase = patch.phase || collabState.phase;
  if (effectivePhase === 'converging') {
    patch.closeSignal = true;
  }

  return patch;
}

class ConversationDriver {
  /**
   * @param {object} options
   * @param {object} options.runtime - Runtime adapter with runTurn()
   * @param {object} options.agentContext - { name, owner }
   * @param {object} options.caller - Caller identity { name, owner, instance }
   * @param {string|object} options.endpoint - a2a:// URL or {host, token}
   * @param {object} [options.convStore] - ConversationStore instance
   * @param {object} [options.disclosure] - Disclosure manifest override
   * @param {number} [options.minTurns=8] - Minimum turns before close
   * @param {number} [options.maxTurns=30] - Maximum turns
   * @param {function} [options.onTurn] - Callback per turn: (turnInfo) => void
   * @param {string} [options.tier='public'] - Access tier
   * @param {function} [options.summarizer] - async (messages, ownerContext) => summary result
   * @param {object} [options.ownerContext] - Owner context for summarizer (goals, interests, etc.)
   */
  constructor(options) {
    this.runtime = options.runtime;
    this.agentContext = options.agentContext;
    this.caller = options.caller || {};
    this.endpoint = options.endpoint;
    this.convStore = options.convStore || null;
    this.disclosure = options.disclosure || null;
    this.minTurns = options.minTurns || 8;
    this.maxTurns = options.maxTurns || 30;
    this.onTurn = options.onTurn || null;
    this.tier = options.tier || 'public';
    // Optional permission envelope for runtimes (primarily Claude mode).
    // If provided by caller, this keeps tool allowlists variable per token/profile.
    this.capabilities = Array.isArray(options.capabilities) ? options.capabilities : [];
    this.allowedTopics = Array.isArray(options.allowedTopics) ? options.allowedTopics : [];
    this.allowedGoals = Array.isArray(options.allowedGoals) ? options.allowedGoals : [];
    this.allowedTools = Array.isArray(options.allowedTools) ? options.allowedTools : [];
    this.summarizer = options.summarizer || null;
    this.ownerContext = options.ownerContext || {};
    this.claudeMode = options.runtime?.mode === 'claude';

    const tokenTimeoutMs = options.tokenTimeoutMs
      || options.claudeTimeoutMs
      || resolveTokenTimeoutMs(options.token);
    const configTimeoutMs = options.configTurnTimeoutMs;
    this.claudeTimeoutMs = resolveTurnTimeoutMs({ tokenTimeoutMs, configTimeoutMs });

    const clientTimeout = this.claudeMode
      ? Math.max(this.claudeTimeoutMs + 20000, 200000)
      : 65000;
    // A2A-52: pass Ed25519 keypair for request signing
    this.client = new A2AClient({
      caller: this.caller,
      timeout: clientTimeout,
      privateKey: options.privateKey || null,
      publicKey: options.publicKey || null
    });
  }

  /**
   * Build a summarizer function from the runtime adapter.
   * Mirrors server.js generateSummary — uses runtime.summarize when available,
   * falls back to defaultSummarizer otherwise.
   */
  _buildSummarizer() {
    const runtime = this.runtime;
    const agentContext = this.agentContext;
    const caller = this.caller;
    const tier = this.tier;

    return async (messages, ownerContext) => {
      if (!messages || messages.length === 0) {
        return { summary: null };
      }

      // Build transcript in unified format
      const transcript = messages.map(m => ({
        direction: m.direction,
        content: m.content
      }));

      // Load disclosure manifest for the tier
      let disclosure = null;
      try {
        const tierTopics = getTopicsForTier(tier);
        if (tierTopics) {
          disclosure = {
            topics: tierTopics.topics || [],
            objectives: tierTopics.objectives || [],
            doNotDiscuss: tierTopics.do_not_discuss || [],
            neverDisclose: tierTopics.never_disclose || []
          };
        }
      } catch (e) {
        // Disclosure is optional — continue without it
      }

      // Look up collaboration state from convStore if available
      let collaborationState = null;
      if (this.convStore) {
        try {
          const dbState = this.convStore.loadCollabState(this.lastConversationId || '');
          if (dbState) {
            collaborationState = {
              phase: dbState.phase,
              overlapScore: dbState.overlapScore,
              turnCount: dbState.turnCount,
              activeThreads: dbState.activeThreads,
              candidateCollaborations: dbState.candidateCollaborations,
              closeSignal: dbState.closeSignal
            };
          }
        } catch (e) {
          // Best effort
        }
      }

      // Map ownerContext into unified format
      const unifiedOwnerContext = {
        agentName: agentContext.name,
        ownerName: agentContext.owner,
        goals: ownerContext?.goals || []
      };

      const prompt = buildUnifiedSummaryPrompt({
        transcript,
        callerInfo: {
          name: caller.name || null,
          owner: caller.owner || null,
          context: caller.context || null
        },
        conversationObjective: 'You initiated this call.',
        disclosure,
        collaborationState,
        ownerContext: unifiedOwnerContext
      });

      // Try runtime.summarize if available (OpenClaw path)
      if (typeof runtime.summarize === 'function') {
        try {
          const summarySessionId = this.lastConversationId
            ? `a2a-${this.lastConversationId}`
            : `summary-${Date.now()}`;
          return await runtime.summarize({
            sessionId: summarySessionId,
            prompt,
            messages,
            callerInfo: { name: agentContext.name, owner: agentContext.owner },
            timeoutMs: this.claudeMode ? this.claudeTimeoutMs : 35000
          });
        } catch (err) {
          logger.warn('Runtime summarizer failed, using default', {
            event: 'driver_runtime_summarize_failed',
            error: err
          });
        }
      }

      // Fallback: use defaultSummarizer
      const { defaultSummarizer } = require('./summarizer');
      return defaultSummarizer(messages, ownerContext);
    };
  }

  /**
   * Run the full multi-turn conversation
   *
   * @param {string} openingMessage - First message to send
   * @returns {Promise<{conversationId, turnCount, collabState, transcript}>}
   */
  async run(openingMessage) {
    const transcript = [];
    let conversationId = null;
    let dbConversationStarted = false;

    const collabState = {
      phase: 'handshake',
      turnCount: 0,
      overlapScore: 0.15,
      activeThreads: [],
      candidateCollaborations: [],
      openQuestions: [],
      closeSignal: false,
      confidence: 0.25
    };

    // Placeholder until we get a real ID from the remote (or generate one)
    conversationId = `conv_${Date.now()}_local`;

    // A2A-LOCAL: detect when calling a local endpoint to avoid dual-write echo.
    // When caller and callee share the same conversation DB (same machine),
    // both the server and the driver write messages for the same conversation_id
    // from opposite perspectives, creating a "hall of mirrors" echo artifact.
    // Skip driver-side DB writes when the target is local — the server already stores them.
    const isLocalEndpoint = (() => {
      try {
        let host;
        if (typeof this.endpoint === 'string') {
          const parsed = require('./client').A2AClient.parseInvite(this.endpoint);
          host = parsed.host;
        } else {
          host = this.endpoint.host;
        }
        const h = String(host || '').split(':')[0].toLowerCase();
        return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.startsWith('127.');
      } catch (_) {
        return false;
      }
    })();
    if (isLocalEndpoint) {
      logger.info('Local endpoint detected — driver will skip DB writes to prevent echo', {
        event: 'driver_local_endpoint_detected',
        data: { endpoint: typeof this.endpoint === 'string' ? this.endpoint : this.endpoint.host }
      });
    }

    let nextMessage = openingMessage;
    const overlapHistory = [];

    for (let turn = 0; turn < this.maxTurns; turn++) {
      // 1. Send message to remote
      let remoteResponse;
      try {
        remoteResponse = await this.client.call(this.endpoint, nextMessage, {
          conversationId
        });
      } catch (err) {
        logger.error('Remote call failed', {
          event: 'driver_remote_call_failed',
          error: err,
          data: { turn, conversationId }
        });
        break;
      }

      // Start DB conversation on first turn (skip for local endpoints — server already created it)
      if (turn === 0 && this.convStore && !dbConversationStarted && !isLocalEndpoint) {
        // Prefer remote's conversation ID, fall back to generated local one
        if (remoteResponse.conversation_id) {
          conversationId = remoteResponse.conversation_id;
        } else {
          conversationId = `conv_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        }

        const convResult = this.convStore.startConversation({
          id: conversationId,
          direction: 'outbound'
        });
        if (convResult.success === false) {
          logger.warn('Failed to start conversation in DB', {
            event: 'driver_start_conversation_failed',
            error: convResult.error
          });
        } else {
          dbConversationStarted = true;
        }
      } else if (turn === 0 && isLocalEndpoint && remoteResponse.conversation_id) {
        // For local endpoints, still track the conversation ID for the transcript
        conversationId = remoteResponse.conversation_id;
      }

      const remoteText = remoteResponse.response || '';
      const remoteContinue = remoteResponse.can_continue !== false;

      // 2. Store messages in DB (skip for local endpoints — server already stores them)
      if (this.convStore && dbConversationStarted && !isLocalEndpoint) {
        const outMsg = this.convStore.addMessage(conversationId, {
          direction: 'outbound',
          role: 'user',
          content: nextMessage
        });
        if (outMsg.success === false) {
          logger.warn('Failed to save outbound message', {
            event: 'driver_save_message_failed',
            error: outMsg.error
          });
        }
        const inMsg = this.convStore.addMessage(conversationId, {
          direction: 'inbound',
          role: 'assistant',
          content: remoteText
        });
        if (inMsg.success === false) {
          logger.warn('Failed to save inbound message', {
            event: 'driver_save_message_failed',
            error: inMsg.error
          });
        }
      }

      transcript.push(
        { role: 'outbound', content: nextMessage },
        { role: 'inbound', content: remoteText }
      );

      collabState.turnCount = turn + 1;

      // 3. Check close conditions
      if (!remoteContinue) {
        logger.info('Remote signaled conversation end', {
          event: 'driver_remote_close',
          data: { turn: turn + 1, conversationId }
        });
        break;
      }

      // 3b. Detect termination intent from remote text even if can_continue is true
      if (detectRemoteTermination(remoteText)) {
        logger.info('Remote text indicates termination intent', {
          event: 'driver_remote_text_close',
          data: { turn: turn + 1, conversationId, preview: remoteText.slice(0, 80) }
        });
        break;
      }

      if (collabState.closeSignal && collabState.turnCount >= this.minTurns) {
        logger.info('Local close signal met minimum turns', {
          event: 'driver_local_close',
          data: { turn: turn + 1, conversationId }
        });
        break;
      }

      // Don't generate a reply on the last possible turn
      if (turn + 1 >= this.maxTurns) {
        break;
      }

      // 4. Build prompt for our turn
      const manifest = this.disclosure || loadManifest();
      const tierTopics = getTopicsForTier(this.tier);
      const formattedTopics = formatTopicsForPrompt(tierTopics);

      const prompt = buildAdaptiveConnectionPrompt({
        agentName: this.agentContext.name,
        ownerName: this.agentContext.owner,
        otherAgentName: this.caller.name || 'Remote Agent',
        otherOwnerName: this.caller.owner || 'their owner',
        roleContext: 'You initiated this call.',
        accessTier: this.tier,
        tierTopics: formattedTopics,
        tierGoals: [],
        otherAgentGreeting: remoteText,
        personalityNotes: manifest.personality_notes || '',
        conversationState: collabState
      });

      // 5. Call runtime.runTurn() to generate next message
      const sessionId = `a2a-${conversationId}`;
      let rawResponse;
      const contextPayload = {
        conversationId,
        tier: this.tier,
        ownerName: this.agentContext.owner,
        agentName: this.agentContext.name,
        roleContext: 'You initiated this call.',
        capabilities: this.capabilities,
        allowedTopics: this.allowedTopics,
        allowed_topics: this.allowedTopics,
        allowedGoals: this.allowedGoals,
        allowed_goals: this.allowedGoals,
        allowedTools: this.allowedTools,
        allowed_tools: this.allowedTools
      };
      if (this.claudeMode) {
        contextPayload.turnCount = turn + 1;
        contextPayload.maxTurns = this.maxTurns;
        contextPayload.phase = collabState.phase;
        contextPayload.overlapScore = collabState.overlapScore;
        contextPayload.activeThreads = collabState.activeThreads;
        contextPayload.candidateCollaborations = collabState.candidateCollaborations;
        contextPayload.closeSignal = collabState.closeSignal;
      }
      try {
        rawResponse = await this.runtime.runTurn({
          sessionId,
          prompt,
          message: remoteText,
          caller: this.caller,
          timeoutMs: this.claudeMode ? this.claudeTimeoutMs : 65000,
          context: contextPayload
        });
      } catch (err) {
        logger.error('Runtime turn failed', {
          event: 'driver_runtime_failed',
          error: err,
          data: { turn: turn + 1, conversationId }
        });
        break;
      }

      // 6. Extract collab state from response
      // In claude mode, use the side channel (getLastTurnMeta) for state/flags
      const turnMeta = this.claudeMode ? this.runtime.getLastTurnMeta?.(sessionId) : null;

      if (turnMeta?.statePatch) {
        // Claude subagent returned structured state — apply it directly
        nextMessage = rawResponse;
        const sp = turnMeta.statePatch;
        if (sp.phase) collabState.phase = sp.phase;
        if (sp.overlapScore != null) {
          collabState.overlapScore = Math.max(0, Math.min(1, sp.overlapScore));
        }
        if (Array.isArray(sp.activeThreads)) {
          collabState.activeThreads = sp.activeThreads.slice(0, 4);
        }
        if (Array.isArray(sp.candidateCollaborations)) {
          collabState.candidateCollaborations = sp.candidateCollaborations.slice(0, 4);
        }
        if (sp.closeSignal != null) {
          collabState.closeSignal = Boolean(sp.closeSignal);
        }
        if (sp.confidence != null) {
          collabState.confidence = Math.max(0, Math.min(1, sp.confidence));
        }
      } else {
        // Non-claude path: extract from <collab_state> tags in response text
        const parsed = extractCollaborationState(rawResponse);
        nextMessage = parsed.cleanText || rawResponse;

        if (parsed.hasState && parsed.statePatch) {
          if (parsed.statePatch.phase) collabState.phase = parsed.statePatch.phase;
          if (parsed.statePatch.overlapScore != null) {
            collabState.overlapScore = Math.max(0, Math.min(1, parsed.statePatch.overlapScore));
          }
          if (Array.isArray(parsed.statePatch.activeThreads)) {
            collabState.activeThreads = parsed.statePatch.activeThreads.slice(0, 4);
          }
          if (Array.isArray(parsed.statePatch.candidateCollaborations)) {
            collabState.candidateCollaborations = parsed.statePatch.candidateCollaborations.slice(0, 4);
          }
          if (parsed.statePatch.closeSignal != null) {
            collabState.closeSignal = Boolean(parsed.statePatch.closeSignal);
          }
          if (parsed.statePatch.confidence != null) {
            collabState.confidence = Math.max(0, Math.min(1, parsed.statePatch.confidence));
          }
        } else {
          // No <collab_state> in response (generic/fallback runtime) — infer progression
          const inferred = inferStateProgression(collabState, remoteText, turn + 1);
          if (inferred.phase) collabState.phase = inferred.phase;
          if (inferred.overlapScore != null) collabState.overlapScore = inferred.overlapScore;
          if (inferred.confidence != null) collabState.confidence = inferred.confidence;
          if (inferred.closeSignal != null) collabState.closeSignal = inferred.closeSignal;
        }
      }

      // 6b. Overlap flatline detection — if overlap hasn't changed significantly
      // for 3+ consecutive turns while in converging phase, the conversation is dead
      overlapHistory.push(collabState.overlapScore);
      if (collabState.phase === 'converging' && overlapHistory.length >= 3) {
        const recent = overlapHistory.slice(-3);
        const maxDelta = Math.max(
          Math.abs(recent[1] - recent[0]),
          Math.abs(recent[2] - recent[1])
        );
        if (maxDelta < 0.02) {
          collabState.closeSignal = true;
        }
      }

      // 7. Persist collab state to DB
      if (this.convStore) {
        try {
          this.convStore.saveCollabState(conversationId, collabState);
        } catch (err) {
          // Best effort
        }
      }

      // 7b. Store flags from claude subagent responses (skip for local to avoid echo)
      if (turnMeta?.flags?.length > 0 && this.convStore && (dbConversationStarted || isLocalEndpoint)) {
        if (!isLocalEndpoint) {
          this.convStore.addMessage(conversationId, {
            direction: 'outbound',
            role: 'system',
            content: `[flags] ${turnMeta.flags.map(f => f.content || f.type).join('; ')}`,
            metadata: JSON.stringify({ flags: turnMeta.flags, turn: turn + 1 })
          });
        }
      }

      // onTurn callback for progress output
      if (this.onTurn) {
        try {
          this.onTurn({
            turn: turn + 1,
            phase: collabState.phase,
            overlapScore: collabState.overlapScore,
            closeSignal: collabState.closeSignal,
            messagePreview: nextMessage.slice(0, 80)
          });
        } catch (err) {
          // Don't let callback errors break the loop
        }
      }
    }

    // 9. End conversation remotely
    try {
      await this.client.end(this.endpoint, conversationId);
    } catch (err) {
      logger.warn('Failed to end remote conversation', {
        event: 'driver_end_failed',
        error: err,
        data: { conversationId }
      });
    }

    // Conclude locally with summarizer
    // Store conversationId so _buildSummarizer can look up collab state
    this.lastConversationId = conversationId;
    let summary = null;
    if (this.convStore) {
      try {
        const summarizer = this.summarizer || this._buildSummarizer();
        const result = await this.convStore.concludeConversation(conversationId, {
          summarizer,
          ownerContext: this.ownerContext
        });
        summary = result.summary || null;
      } catch (err) {
        logger.warn('Failed to conclude local conversation', {
          event: 'driver_conclude_failed',
          error: err,
          data: { conversationId }
        });
      }
    }

    return {
      conversationId,
      turnCount: collabState.turnCount,
      collabState,
      transcript,
      summary
    };
  }
}

module.exports = { ConversationDriver, detectRemoteTermination, inferStateProgression };
