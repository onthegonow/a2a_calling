/**
 * Runtime adapter for inbound A2A calls.
 *
 * Modes:
 * - openclaw: uses `openclaw` CLI for turn handling, summaries, notifications
 * - claude: uses `claude` CLI as a real LLM subagent for conversations
 *
 * - test: minimal runtime for CI/headless — echoes messages or spawns A2A_AGENT_COMMAND
 *
 * Selection:
 * - A2A_RUNTIME=openclaw|claude|test|auto (default: auto)
 * - auto picks openclaw → claude → error (no supported CLI)
 */

const { execSync, spawnSync } = require('child_process');
const { createLogger } = require('./logger');
const {
  runClaudeTurn: invokeClaudeTurn,
  buildSubagentSystemPrompt,
  runClaudeSummary,
  resolveClaudeAllowedTools
} = require('./claude-subagent');
const { getTopicsForTier, formatTopicsForPrompt, loadManifest } = require('./disclosure');
const { HARD_FALLBACK_TURN_TIMEOUT_MS } = require('./turn-timeout');

function commandExists(command) {
  try {
    execSync(`command -v ${command}`, { stdio: 'ignore' });
    return true;
  } catch (err) {
    return false;
  }
}

function cleanText(value, maxLength = 300) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}


function resolveRuntimeMode() {
  const requested = String(process.env.A2A_RUNTIME || 'auto').trim().toLowerCase();
  const hasOpenClaw = commandExists('openclaw');
  const hasClaude = commandExists('claude');

  // A2A-66: test runtime for CI/headless environments — minimal runTurn with
  // optional A2A_AGENT_COMMAND bridge support.
  if (requested === 'test') {
    return {
      mode: 'test',
      requested,
      hasOpenClaw,
      hasClaude,
      reason: 'A2A_RUNTIME=test'
    };
  }

  if (requested === 'generic') {
    return {
      mode: 'none',
      requested,
      hasOpenClaw,
      hasClaude,
      warning: 'A2A_RUNTIME=generic is no longer supported. Use openclaw or claude runtime.',
      reason: 'unsupported-generic-mode'
    };
  }

  if (requested === 'claude') {
    if (hasClaude) {
      return {
        mode: 'claude',
        requested,
        hasOpenClaw,
        hasClaude,
        reason: 'A2A_RUNTIME=claude'
      };
    }
    return {
      mode: 'none',
      requested,
      hasOpenClaw,
      hasClaude,
      warning: 'A2A_RUNTIME=claude but claude CLI not found; install claude CLI or switch to openclaw',
      reason: 'forced-claude-missing'
    };
  }

  if (requested === 'openclaw') {
    if (hasOpenClaw) {
      return {
        mode: 'openclaw',
        requested,
        hasOpenClaw,
        hasClaude,
        reason: 'A2A_RUNTIME=openclaw'
      };
    }
    return {
      mode: 'none',
      requested,
      hasOpenClaw,
      hasClaude,
      warning: 'A2A_RUNTIME=openclaw but openclaw CLI not found; install openclaw CLI or switch to claude',
      reason: 'forced-openclaw-missing'
    };
  }

  // Auto detection chain: openclaw → claude → none
  if (hasOpenClaw) {
    return {
      mode: 'openclaw',
      requested: 'auto',
      hasOpenClaw,
      hasClaude,
      reason: 'openclaw CLI detected'
    };
  }

  if (hasClaude) {
    return {
      mode: 'claude',
      requested: 'auto',
      hasOpenClaw,
      hasClaude,
      reason: 'claude CLI detected'
    };
  }

  return {
    mode: 'none',
    requested: 'auto',
    hasOpenClaw,
    hasClaude,
    warning: 'No supported runtime CLI found. Install openclaw or claude CLI.',
    reason: 'no supported CLI detected'
  };
}

function normalizeOpenClawOutput(raw) {
  const lines = String(raw || '')
    .split('\n')
    .filter(line => {
      if (!line.trim()) return false;
      if (line.includes('[telegram-topic-tracker]')) return false;
      if (line.includes('Plugin registered')) return false;
      return true;
    });
  return lines.join('\n').trim();
}


function createRuntimeAdapter(options = {}) {
  const workspaceDir = options.workspaceDir || process.cwd();
  const modeInfo = resolveRuntimeMode();
  const logger = options.logger || createLogger({ component: 'a2a.runtime' });

  logger.info('Runtime adapter initialized', {
    event: 'runtime_initialized',
    data: {
      mode: modeInfo.mode,
      requested_mode: modeInfo.requested,
      reason: modeInfo.reason,
      has_openclaw: modeInfo.hasOpenClaw,
      has_claude: modeInfo.hasClaude
    }
  });

  // Claude state tracking.
  // Design decision (A2A-29): we keep per-conversation state for prompt/metadata
  // continuity, but Claude execution itself is stateless (no `--resume`).
  const claudeSessions = new Map();

  async function runClaudeTurnAdapter({ sessionId, message, caller, context, timeoutMs }) {
    const traceId = context?.traceId || context?.trace_id;
    const requestId = context?.requestId || context?.request_id;
    const conversationId = context?.conversationId || context?.conversation_id;
    const startAt = Date.now();

    // Get or create session state
    let session = claudeSessions.get(sessionId);
    if (!session) {
      // First turn: build the system prompt from disclosure context
      const manifest = loadManifest();
      const tierTopics = getTopicsForTier(context?.tier || 'public');
      const formatted = formatTopicsForPrompt(tierTopics);

      session = {
        systemPrompt: '',
        turnCount: 0,
        lastMeta: null,
        // Keep a permission snapshot so summary runs with the same policy envelope.
        permissionSnapshot: {
          capabilities: Array.isArray(context?.capabilities) ? context.capabilities : [],
          allowedTopics: Array.isArray(context?.allowedTopics || context?.allowed_topics)
            ? (context?.allowedTopics || context?.allowed_topics)
            : [],
          allowedTools: Array.isArray(context?.allowedTools || context?.allowed_tools)
            ? (context?.allowedTools || context?.allowed_tools)
            : []
        }
      };

      const sessionAllowedTools = resolveClaudeAllowedTools({
        capabilities: session.permissionSnapshot.capabilities,
        allowedTopics: session.permissionSnapshot.allowedTopics,
        allowedTools: session.permissionSnapshot.allowedTools
      });

      session.systemPrompt = buildSubagentSystemPrompt({
        agentName: context?.agentName || 'Agent',
        ownerName: context?.ownerName || 'the owner',
        otherAgentName: caller?.name || 'Remote Agent',
        otherOwnerName: caller?.owner || 'their owner',
        accessTier: context?.tier || 'public',
        tierTopics: formatted.topics,
        tierObjectives: formatted.objectives,
        doNotDiscuss: formatted.doNotDiscuss,
        neverDisclose: formatted.neverDisclose,
        personalityNotes: manifest.personality_notes || '',
        roleContext: context?.roleContext || '',
        allowedTools: sessionAllowedTools
      });

      claudeSessions.set(sessionId, session);
    }

    session.turnCount++;

    logger.debug('Invoking Claude subagent turn', {
      event: 'claude_turn_start',
      traceId,
      requestId,
      conversationId,
      data: {
        session_id: sessionId,
        turn: session.turnCount,
        timeout_ms: timeoutMs
      }
    });

    const result = await invokeClaudeTurn({
      systemPrompt: session.systemPrompt,
      turnMessage: message,
      turn: session.turnCount,
      maxTurns: context?.maxTurns || 30,
      phase: context?.phase || 'handshake',
      overlapScore: context?.overlapScore || 0.15,
      activeThreads: context?.activeThreads || [],
      candidateCollaborations: context?.candidateCollaborations || [],
      closeSignal: context?.closeSignal || false,
      capabilities: Array.isArray(context?.capabilities)
        ? context.capabilities
        : (session.permissionSnapshot?.capabilities || []),
      allowedTopics: Array.isArray(context?.allowedTopics || context?.allowed_topics)
        ? (context?.allowedTopics || context?.allowed_topics)
        : (session.permissionSnapshot?.allowedTopics || []),
      allowedTools: Array.isArray(context?.allowedTools || context?.allowed_tools)
        ? (context?.allowedTools || context?.allowed_tools)
        : (session.permissionSnapshot?.allowedTools || []),
      timeoutMs: timeoutMs || HARD_FALLBACK_TURN_TIMEOUT_MS
    });

    // Update permission snapshot if the caller supplied explicit context this turn.
    if (Array.isArray(context?.capabilities)) {
      session.permissionSnapshot.capabilities = context.capabilities;
    }
    if (Array.isArray(context?.allowedTopics || context?.allowed_topics)) {
      session.permissionSnapshot.allowedTopics = context?.allowedTopics || context?.allowed_topics;
    }
    if (Array.isArray(context?.allowedTools || context?.allowed_tools)) {
      session.permissionSnapshot.allowedTools = context?.allowedTools || context?.allowed_tools;
    }

    // Store flags/state for retrieval via getLastTurnMeta
    session.lastMeta = {
      statePatch: result.statePatch,
      flags: result.flags
    };

    logger.debug('Claude subagent turn completed', {
      event: 'claude_turn_complete',
      traceId,
      requestId,
      conversationId,
      data: {
        session_id: sessionId,
        turn: session.turnCount,
        duration_ms: Date.now() - startAt,
        message_length: result.message.length,
        has_state_patch: Boolean(result.statePatch),
        flag_count: result.flags.length
      }
    });

    return result.message;
  }

  function getLastTurnMeta(sessionId) {
    const session = claudeSessions.get(sessionId);
    return session?.lastMeta || null;
  }

  async function runOpenClawTurn({ sessionId, prompt, timeoutMs }) {
    const timeoutSeconds = Math.max(5, Math.min(300, Math.round((timeoutMs || 65000) / 1000)));
    // Use spawnSync with stdin to avoid shell escaping issues with complex prompts
    const result = spawnSync('openclaw', [
      'agent',
      '--session-id', sessionId,
      '--message', prompt,
      '--timeout', String(timeoutSeconds)
    ], {
      encoding: 'utf8',
      timeout: (timeoutMs || 65000) + 5000,
      maxBuffer: 1024 * 1024,
      cwd: workspaceDir,
      env: { ...process.env, FORCE_COLOR: '0' }
    });
    const output = (result.stdout || '') + (result.stderr || '');
    if (result.error) {
      throw result.error;
    }
    return normalizeOpenClawOutput(output) || '[Sub-agent returned empty response]';
  }

  async function runOpenClawSummary({ sessionId, prompt, timeoutMs }) {
    const timeoutSeconds = Math.max(5, Math.min(120, Math.round((timeoutMs || 35000) / 1000)));
    // Use spawnSync with stdin to avoid shell escaping issues with complex prompts
    const result = spawnSync('openclaw', [
      'agent',
      '--session-id', sessionId,
      '--message', prompt,
      '--timeout', String(timeoutSeconds)
    ], {
      encoding: 'utf8',
      timeout: (timeoutMs || 35000) + 5000,
      cwd: workspaceDir,
      env: { ...process.env, FORCE_COLOR: '0' }
    });
    const output = (result.stdout || '') + (result.stderr || '');
    if (result.error) {
      throw result.error;
    }
    const summaryText = cleanText(normalizeOpenClawOutput(output), 1500);
    if (!summaryText) {
      return null;
    }
    return {
      summary: summaryText,
      ownerSummary: summaryText
    };
  }

  async function runOpenClawNotify({ callerName, callerOwner, message }) {
    const notification = `🤝 **A2A Call**\nFrom: ${callerName}${callerOwner}\n> ${message.slice(0, 150)}...`;
    // Use spawnSync to avoid shell escaping issues
    spawnSync('openclaw', [
      'message', 'send',
      '--channel', 'telegram',
      '--message', notification
    ], { timeout: 10000, stdio: 'pipe' });
  }

  async function runTurn({ sessionId, prompt, message, caller, context = {}, timeoutMs }) {
    const traceId = context?.traceId || context?.trace_id;
    const requestId = context?.requestId || context?.request_id;
    const conversationId = context?.conversationId || context?.conversation_id;

    if (modeInfo.mode === 'claude') {
      try {
        return await runClaudeTurnAdapter({ sessionId, message, caller, context, timeoutMs });
      } catch (err) {
        logger.error('Claude subagent turn failed', {
          event: 'claude_turn_failed',
          traceId,
          requestId,
          conversationId,
          error_code: 'CLAUDE_TURN_FAILED',
          hint: 'Inspect Claude CLI availability, timeout settings, and CLAUDECODE env var.',
          error: err,
          data: { session_id: sessionId, timeout_ms: timeoutMs }
        });
        throw err;
      }
    }

    // A2A-66: test runtime — spawn A2A_AGENT_COMMAND if set, otherwise echo.
    if (modeInfo.mode === 'test') {
      const agentCommand = process.env.A2A_AGENT_COMMAND;
      if (agentCommand) {
        const payload = JSON.stringify({ message, caller, context });
        const parts = agentCommand.split(/\s+/);
        const result = spawnSync(parts[0], parts.slice(1), {
          input: payload,
          encoding: 'utf8',
          timeout: (timeoutMs || 65000) + 5000,
          maxBuffer: 1024 * 1024,
          cwd: workspaceDir,
          env: process.env
        });
        if (result.error) {
          throw result.error;
        }
        const output = String(result.stdout || '').trim();
        return output || '[test-runtime] Empty command output';
      }
      const snippet = cleanText(message || prompt || '', 120);
      return `[test-runtime] Echo: ${snippet}`;
    }

    if (modeInfo.mode !== 'openclaw') {
      throw new Error(
        `No supported A2A runtime available (mode=${modeInfo.mode}). ` +
        'Install the openclaw or claude CLI and set A2A_RUNTIME accordingly.'
      );
    }

    const startAt = Date.now();
    logger.debug('Invoking openclaw turn', {
      event: 'openclaw_turn_start',
      traceId,
      requestId,
      conversationId,
      data: {
        session_id: sessionId,
        timeout_ms: timeoutMs
      }
    });

    try {
      const response = await runOpenClawTurn({ sessionId, prompt, timeoutMs });
      logger.debug('OpenClaw turn completed', {
        event: 'openclaw_turn_complete',
        traceId,
        requestId,
        conversationId,
        data: {
          session_id: sessionId,
          duration_ms: Date.now() - startAt
        }
      });
      return response;
    } catch (err) {
      logger.error('OpenClaw turn failed', {
        event: 'openclaw_turn_failed',
        traceId,
        requestId,
        conversationId,
        error_code: 'OPENCLAW_TURN_FAILED',
        hint: 'Inspect OpenClaw CLI output, timeout settings, and environment PATH.',
        error: err,
        data: {
          session_id: sessionId,
          timeout_ms: timeoutMs,
          duration_ms: Date.now() - startAt
        }
      });
      throw err;
    }
  }

  async function summarize({ sessionId, prompt, messages, callerInfo, traceId, conversationId, timeoutMs }) {
    const effectiveTraceId = traceId || callerInfo?.trace_id || callerInfo?.traceId;
    const requestId = callerInfo?.request_id || callerInfo?.requestId;
    const effectiveConversationId = conversationId || callerInfo?.conversation_id || callerInfo?.conversationId;

    // Claude mode: stateless summary invocation (no session restore dependency).
    if (modeInfo.mode === 'claude') {
      const session = claudeSessions.get(sessionId);
      const capabilities = session?.permissionSnapshot?.capabilities
        || callerInfo?.capabilities
        || [];
      const allowedTopics = session?.permissionSnapshot?.allowedTopics
        || callerInfo?.allowedTopics
        || callerInfo?.allowed_topics
        || [];
      const allowedTools = session?.permissionSnapshot?.allowedTools
        || callerInfo?.allowedTools
        || callerInfo?.allowed_tools
        || [];

      const result = await runClaudeSummary({
        prompt,
        reason: 'conversation ended',
        capabilities,
        allowedTopics,
        allowedTools,
        timeoutMs: timeoutMs || HARD_FALLBACK_TURN_TIMEOUT_MS
      });
      if (result && result.summary) {
        return result;
      }
      throw new Error('Claude summary returned empty result');
    }

    // A2A-66: test runtime — return canned summary.
    if (modeInfo.mode === 'test') {
      const text = 'Test conversation concluded.';
      return { summary: text, ownerSummary: text };
    }

    if (modeInfo.mode !== 'openclaw') {
      throw new Error(
        `No supported A2A runtime available for summarization (mode=${modeInfo.mode}). ` +
        'Install the openclaw or claude CLI and set A2A_RUNTIME accordingly.'
      );
    }

    const startAt = Date.now();
    logger.debug('Invoking openclaw summary', {
      event: 'openclaw_summary_start',
      traceId: effectiveTraceId,
      requestId,
      conversationId: effectiveConversationId,
      data: {
        session_id: sessionId,
        message_count: Array.isArray(messages) ? messages.length : 0
      }
    });

    try {
      const result = await runOpenClawSummary({
        sessionId,
        prompt,
        timeoutMs: 35000
      });
      if (result && result.summary) {
        logger.debug('OpenClaw summary completed', {
          event: 'openclaw_summary_complete',
          traceId: effectiveTraceId,
          requestId,
          conversationId: effectiveConversationId,
          data: {
            session_id: sessionId,
            duration_ms: Date.now() - startAt
          }
        });
        return result;
      }
      throw new Error('OpenClaw summary returned empty output');
    } catch (err) {
      logger.error('OpenClaw summary failed', {
        event: 'openclaw_summary_failed',
        traceId: effectiveTraceId,
        requestId,
        conversationId: effectiveConversationId,
        error_code: 'OPENCLAW_SUMMARY_FAILED',
        hint: 'Inspect summary message length, timeout configuration, and CLI stderr output.',
        error: err,
        data: {
          session_id: sessionId,
          duration_ms: Date.now() - startAt
        }
      });
      throw err;
    }
  }

  async function notify({ level, token, caller, message, conversationId, traceId }) {
    const requestId = token?.request_id || token?.requestId || null;

    logger.debug('Owner notify requested', {
      event: 'notify_requested',
      traceId,
      requestId,
      conversationId,
      tokenId: token?.id,
      data: { level }
    });

    if (modeInfo.mode === 'claude' || modeInfo.mode === 'test') {
      // Claude/test mode: notifications are a no-op (no notification transport available)
      logger.debug('Notification skipped (no notification transport in this mode)', {
        event: 'notify_skipped',
        traceId,
        requestId,
        conversationId,
        tokenId: token?.id,
        data: { mode: modeInfo.mode }
      });
      return;
    }

    if (modeInfo.mode !== 'openclaw') {
      logger.debug('Notification skipped (no supported runtime)', {
        event: 'notify_skipped_no_runtime',
        traceId,
        requestId,
        conversationId,
        tokenId: token?.id
      });
      return;
    }

    if (level !== 'all') {
      return;
    }

    const callerName = caller?.name || 'Unknown';
    const callerOwner = caller?.owner ? ` (${caller.owner})` : '';
    const notifyStart = Date.now();

    try {
      await runOpenClawNotify({ callerName, callerOwner, message: message || '' });
      logger.debug('OpenClaw notify completed', {
        event: 'openclaw_notify_complete',
        traceId,
        requestId,
        conversationId,
        tokenId: token?.id,
        data: {
          duration_ms: Date.now() - notifyStart
        }
      });
    } catch (err) {
      // Notifications are best-effort; log and swallow
      logger.warn('OpenClaw notify failed', {
        event: 'openclaw_notify_failed',
        traceId,
        requestId,
        conversationId,
        tokenId: token?.id,
        error_code: 'OPENCLAW_NOTIFY_FAILED',
        hint: 'Check OpenClaw messaging channel config and notify permissions.',
        error: err,
        data: {
          duration_ms: Date.now() - notifyStart
        }
      });
    }
  }

  return {
    mode: modeInfo.mode,
    requestedMode: modeInfo.requested,
    hasOpenClaw: modeInfo.hasOpenClaw,
    hasClaude: modeInfo.hasClaude,
    reason: modeInfo.reason,
    warning: modeInfo.warning || null,
    runTurn,
    summarize,
    notify,
    getLastTurnMeta
  };
}

module.exports = {
  createRuntimeAdapter,
  resolveRuntimeMode
};
