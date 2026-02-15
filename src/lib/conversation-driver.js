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
    this.summarizer = options.summarizer || null;
    this.ownerContext = options.ownerContext || {};
    this.claudeMode = options.runtime?.mode === 'claude';
    this.claudeTimeoutMs = options.claudeTimeoutMs || 180000;

    const clientTimeout = this.claudeMode ? 200000 : 65000;
    this.client = new A2AClient({ caller: this.caller, timeout: clientTimeout });
  }

  /**
   * Build a summarizer function from the runtime adapter.
   * Mirrors server.js generateSummary — uses runtime.summarize when available,
   * falls back to defaultSummarizer otherwise.
   */
  _buildSummarizer() {
    const runtime = this.runtime;
    const agentContext = this.agentContext;

    return async (messages, ownerContext) => {
      if (!messages || messages.length === 0) {
        return { summary: null };
      }

      // Build the summary prompt (same structure as server.js generateSummary)
      const messageText = messages.map(m => {
        const role = m.direction === 'inbound' ? '[Them]' : '[You]';
        return `${role}: ${m.content}`;
      }).join('\n');

      const prompt = `Summarize this A2A call for the owner. Write from the owner's perspective.

You initiated this call.

Conversation:
${messageText}

Structure your summary with these sections:

**Who:** Who you called, who they represent, key facts about them.
**Key Discoveries:** What was learned about the other side — capabilities, interests, blind spots.
**Collaboration Potential:** Rate HIGH/MEDIUM/LOW. List specific opportunities identified.
**What We Learned vs Shared:** Brief information exchange audit — what did we get, what did we give.
**Recommended Follow-Up:**
- [ ] Actionable item 1
- [ ] Actionable item 2
**Assessment:** One-sentence strategic value judgment.

Be concise but specific. No filler.`;

      // Try runtime.summarize if available (OpenClaw path)
      if (typeof runtime.summarize === 'function') {
        try {
          return await runtime.summarize({
            sessionId: `summary-${Date.now()}`,
            prompt,
            messages,
            callerInfo: { name: agentContext.name, owner: agentContext.owner }
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

      // Start DB conversation on first turn
      if (turn === 0 && this.convStore && !dbConversationStarted) {
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
      }

      const remoteText = remoteResponse.response || '';
      const remoteContinue = remoteResponse.can_continue !== false;

      // 2. Store messages in DB (only if conversation was started in DB)
      if (this.convStore && dbConversationStarted) {
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
        roleContext: 'You initiated this call.'
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

      // 7b. Store flags from claude subagent responses
      if (turnMeta?.flags?.length > 0 && this.convStore && dbConversationStarted) {
        this.convStore.addMessage(conversationId, {
          direction: 'outbound',
          role: 'system',
          content: `[flags] ${turnMeta.flags.map(f => f.content || f.type).join('; ')}`,
          metadata: JSON.stringify({ flags: turnMeta.flags, turn: turn + 1 })
        });
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
