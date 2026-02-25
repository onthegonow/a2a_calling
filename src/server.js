#!/usr/bin/env node
/**
 * A2A Server
 * 
 * Routes A2A calls through a runtime adapter (OpenClaw or Claude).
 * Auto-adds contacts, generates summaries, notifies owner.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { createRoutes } = require('./routes/a2a');
const { createDashboardApiRouter, createDashboardUiRouter } = require('./routes/dashboard');
const { createCallbookRouter } = require('./routes/callbook');
const { TokenStore } = require('./lib/tokens');
const { createRuntimeAdapter } = require('./lib/runtime-adapter');
const { getTopicsForTier, formatTopicsForPrompt, loadManifest } = require('./lib/disclosure');
const {
  buildConnectionPrompt,
  buildAdaptiveConnectionPrompt,
  extractCollaborationState
} = require('./lib/prompt-template');
const { findAvailablePort } = require('./lib/port-scanner');
const { createLogger, closeAllLoggerStores } = require('./lib/logger');
const { writePidFile, removePidFile } = require('./lib/pid-file');
const { buildUnifiedSummaryPrompt } = require('./lib/summary-prompt');
const { A2AConfig } = require('./lib/config');
const { UpdateManager } = require('./lib/update-manager');
const { DashboardEventStore } = require('./lib/dashboard-events');
const { spawn } = require('child_process');
const { resolveTurnTimeoutMs } = require('./lib/turn-timeout');

const DEFAULT_PORTS = [80, 3001, 8080, 8443, 9001];
const requestedPort = process.env.PORT ? parseInt(process.env.PORT, 10)
  : process.argv[2] ? parseInt(process.argv[2], 10)
  : null;
const workspaceDir = process.env.A2A_WORKSPACE || process.env.OPENCLAW_WORKSPACE || process.cwd();
const logger = createLogger({ component: 'a2a.server' });

// Load workspace context for agent identity
function loadAgentContext() {
  let context = {
    name: process.env.A2A_AGENT_NAME || process.env.AGENT_NAME || 'a2a-agent',
    owner: process.env.A2A_OWNER_NAME || process.env.USER || 'Agent Owner'
  };
  
  try {
    const userPath = path.join(workspaceDir, 'USER.md');
    if (fs.existsSync(userPath)) {
      const content = fs.readFileSync(userPath, 'utf8');
      const agentMatch = content.match(/\*\*Agent:\*\*\s*([^\n]+)/i);
      if (agentMatch && agentMatch[1]) {
        context.name = agentMatch[1].trim().slice(0, 80) || context.name;
      }
      const nameMatch = content.match(/\*\*Name:\*\*\s*([^\n]+)/);
      if (nameMatch) {
        const name = nameMatch[1].trim();
        if (name && !name.includes('_') && !name.includes('(')) {
          context.owner = name;
        }
      }
    }
  } catch (e) {}
  
  return context;
}

const agentContext = loadAgentContext();
const tokenStore = new TokenStore();
const config = new A2AConfig();
const eventStore = new DashboardEventStore(tokenStore.configDir);
const runtime = createRuntimeAdapter({
  workspaceDir,
  agentContext,
  logger: logger.child({ component: 'a2a.runtime' })
});
// Lazy-load conversation store for collab state persistence
let ConversationStore = null;
let serverConvStore = null;
function getServerConvStore() {
  if (serverConvStore === false) return null;
  if (!serverConvStore) {
    try {
      ConversationStore = require('./lib/conversations').ConversationStore;
      serverConvStore = new ConversationStore();
      if (!serverConvStore.isAvailable()) {
        serverConvStore = false;
        return null;
      }
    } catch (err) {
      serverConvStore = false;
      return null;
    }
  }
  return serverConvStore;
}

const VALID_PHASES = new Set(['handshake', 'explore', 'deep_dive', 'synthesize', 'close']);
const collaborationSessions = new Map();
const COLLAB_STATE_TTL_MS = readPositiveIntEnv('A2A_COLLAB_STATE_TTL_MS', 6 * 60 * 60 * 1000);
const MAX_COLLAB_SESSIONS = readPositiveIntEnv('A2A_COLLAB_MAX_SESSIONS', 500);

logger.info('A2A server bootstrapping', {
  event: 'server_bootstrap',
  data: {
    agent_name: agentContext.name,
    owner_name: agentContext.owner,
    runtime_mode: runtime.mode,
    runtime_reason: runtime.reason
  }
});
if (runtime.warning) {
  logger.warn('Runtime warning', {
    event: 'runtime_warning',
    data: {
      warning: runtime.warning
    }
  });
}

function readPositiveIntEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveConfiguredTurnTimeoutMs() {
  try {
    const defaults = config.getDefaults?.() || {};
    return defaults.turnTimeoutMs ?? defaults.turn_timeout_ms ?? null;
  } catch (err) {
    return null;
  }
}

function resolveCollabMode() {
  const raw = String(process.env.A2A_COLLAB_MODE || 'adaptive').trim().toLowerCase();
  if (raw === 'deep_dive' || raw === 'deep-dive') {
    return 'deep_dive';
  }
  return 'adaptive';
}

function cleanText(value, maxLength = 160) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function sanitizeList(values, maxItems = 4, itemMaxLength = 160) {
  if (!Array.isArray(values)) {
    return [];
  }
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const item = cleanText(value, itemMaxLength);
    if (!item || seen.has(item)) {
      continue;
    }
    seen.add(item);
    out.push(item);
    if (out.length >= maxItems) {
      break;
    }
  }
  return out;
}

function mergeUnique(baseList, newList, maxItems = 4) {
  const merged = [];
  const seen = new Set();
  for (const item of [...sanitizeList(baseList, maxItems), ...sanitizeList(newList, maxItems)]) {
    if (seen.has(item)) {
      continue;
    }
    seen.add(item);
    merged.push(item);
    if (merged.length >= maxItems) {
      break;
    }
  }
  return merged;
}

function extractSignalPhrases(text, pattern, maxItems = 3) {
  if (!text) {
    return [];
  }
  const chunks = String(text)
    .split(/\n+/)
    .flatMap(line => line.split(/(?<=[.!?])\s+/));

  const picked = [];
  const seen = new Set();
  for (const chunk of chunks) {
    const cleaned = cleanText(chunk, 180);
    if (!cleaned || cleaned.length < 8) {
      continue;
    }
    if (!pattern.test(cleaned)) {
      continue;
    }
    if (seen.has(cleaned)) {
      continue;
    }
    seen.add(cleaned);
    picked.push(cleaned);
    if (picked.length >= maxItems) {
      break;
    }
  }
  return picked;
}

function collectTopicKeywords(tierTopics) {
  const keywords = new Set();
  
  const topicsList = tierTopics?.topics || [];
  const objectivesList = tierTopics?.objectives || [];

  for (const item of topicsList) {
    for (const part of [item?.topic, item?.description]) {
      if (!part) continue;
      const terms = String(part)
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(term => term.length >= 4);
      for (const term of terms.slice(0, 6)) {
        keywords.add(term);
        if (keywords.size >= 48) return Array.from(keywords);
      }
    }
  }

  for (const item of objectivesList) {
    for (const part of [item?.objective, item?.description]) {
      if (!part) continue;
      const terms = String(part)
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(term => term.length >= 4);
      for (const term of terms.slice(0, 6)) {
        keywords.add(term);
        if (keywords.size >= 48) return Array.from(keywords);
      }
    }
  }

  return Array.from(keywords);
}

function pruneCollaborationSessions() {
  const now = Date.now();
  for (const [conversationId, state] of collaborationSessions.entries()) {
    const updatedAt = Number(state?.updatedAt || 0);
    if (!updatedAt || now - updatedAt > COLLAB_STATE_TTL_MS) {
      collaborationSessions.delete(conversationId);
    }
  }

  if (collaborationSessions.size <= MAX_COLLAB_SESSIONS) {
    return;
  }

  const oldest = Array.from(collaborationSessions.entries())
    .sort((a, b) => (a[1]?.updatedAt || 0) - (b[1]?.updatedAt || 0));
  const toDelete = collaborationSessions.size - MAX_COLLAB_SESSIONS;
  for (let i = 0; i < toDelete; i++) {
    collaborationSessions.delete(oldest[i][0]);
  }
}

function getOrCreateCollaborationState(conversationId, context = {}) {
  pruneCollaborationSessions();

  const existing = collaborationSessions.get(conversationId);
  if (existing) {
    existing.updatedAt = Date.now();
    return existing;
  }

  // Check DB for persisted state (enables restart recovery)
  const convStore = getServerConvStore();
  if (convStore) {
    const dbState = convStore.loadCollabState(conversationId);
    if (dbState) {
      const now = Date.now();
      const restored = {
        conversationId,
        phase: dbState.phase,
        turnCount: dbState.turnCount,
        overlapScore: dbState.overlapScore,
        activeThreads: dbState.activeThreads,
        candidateCollaborations: dbState.candidateCollaborations,
        openQuestions: dbState.openQuestions,
        closeSignal: dbState.closeSignal,
        confidence: dbState.confidence,
        callerName: cleanText(context.callerName, 80),
        callerOwner: cleanText(context.callerOwner, 80),
        tier: context.tier || 'public',
        createdAt: now,
        updatedAt: now
      };
      collaborationSessions.set(conversationId, restored);
      return restored;
    }
  }

  const now = Date.now();
  const state = {
    conversationId,
    phase: 'handshake',
    turnCount: 0,
    overlapScore: 0.15,
    activeThreads: [],
    candidateCollaborations: [],
    openQuestions: [],
    closeSignal: false,
    confidence: 0.25,
    callerName: cleanText(context.callerName, 80),
    callerOwner: cleanText(context.callerOwner, 80),
    tier: context.tier || 'public',
    createdAt: now,
    updatedAt: now
  };

  collaborationSessions.set(conversationId, state);
  return state;
}

function inferPhaseFromState(state, signals) {
  if (signals.closeSignal && state.turnCount >= 5) {
    return 'close';
  }
  if (state.turnCount >= 5 && (state.candidateCollaborations.length > 0 || state.overlapScore >= 0.65)) {
    return 'synthesize';
  }
  if (state.turnCount >= 3 && state.overlapScore >= 0.4) {
    return 'deep_dive';
  }
  if (state.turnCount >= 1) {
    return 'explore';
  }
  return 'handshake';
}

function applyCollaborationPatch(state, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return false;
  }

  let applied = false;

  if (typeof patch.phase === 'string') {
    const phase = patch.phase.trim();
    if (VALID_PHASES.has(phase)) {
      state.phase = phase;
      applied = true;
    }
  }

  if (patch.turnCount !== undefined) {
    const nextTurn = clampNumber(patch.turnCount, 0, 500, state.turnCount + 1);
    state.turnCount = Math.max(state.turnCount + 1, nextTurn);
    applied = true;
  }

  if (patch.overlapScore !== undefined) {
    state.overlapScore = Number(clampNumber(
      patch.overlapScore,
      0,
      1,
      state.overlapScore
    ).toFixed(2));
    applied = true;
  }

  const activeThreads = sanitizeList(patch.activeThreads, 4);
  if (activeThreads.length > 0) {
    state.activeThreads = activeThreads;
    applied = true;
  }

  const candidateCollaborations = sanitizeList(patch.candidateCollaborations, 4);
  if (candidateCollaborations.length > 0) {
    state.candidateCollaborations = candidateCollaborations;
    applied = true;
  }

  const openQuestions = sanitizeList(patch.openQuestions, 4);
  if (openQuestions.length > 0) {
    state.openQuestions = openQuestions;
    applied = true;
  }

  if (patch.closeSignal !== undefined) {
    state.closeSignal = Boolean(patch.closeSignal);
    applied = true;
  } else if (patch.shouldClose !== undefined) {
    state.closeSignal = Boolean(patch.shouldClose);
    applied = true;
  }

  if (patch.confidence !== undefined) {
    state.confidence = Number(clampNumber(
      patch.confidence,
      0,
      1,
      state.confidence
    ).toFixed(2));
    applied = true;
  }

  state.updatedAt = Date.now();
  return applied;
}

function fallbackCollaborationUpdate(state, inboundMessage, responseText, tierTopics) {
  const inbound = String(inboundMessage || '');
  const outbound = String(responseText || '');
  const combined = `${inbound}\n${outbound}`.toLowerCase();

  const keywordList = collectTopicKeywords(tierTopics);
  let keywordHits = 0;
  for (const keyword of keywordList) {
    if (combined.includes(keyword)) {
      keywordHits += 1;
    }
  }

  const collaborationSignal =
    /(collaborat|partner|integrat|co-?build|joint|pilot|next step|follow[ -]?up|introduc)/i.test(combined);
  const depthSignal =
    /(constraint|timeline|resource|owner|deliverable|scope|risk|tradeoff|metric)/i.test(combined);
  const closeSignal =
    /(wrap up|summary|conclude|close this|next call|owners should connect|handoff)/i.test(combined);

  const questionCount = (outbound.match(/\?/g) || []).length;
  const keywordScore = keywordList.length ? keywordHits / Math.max(keywordList.length, 8) : 0.05;
  const overlapDelta =
    (keywordScore * 0.45) +
    (collaborationSignal ? 0.12 : 0) +
    (depthSignal ? 0.08 : 0) +
    (questionCount > 0 ? 0.03 : -0.03);

  state.turnCount += 1;
  state.overlapScore = Number(clampNumber(
    state.overlapScore + overlapDelta,
    0,
    1,
    state.overlapScore
  ).toFixed(2));

  const threadSeeds = mergeUnique(
    extractSignalPhrases(
      `${inbound}\n${outbound}`,
      /(working|building|focus|interested|goal|problem|need|challenge|opportunit)/i,
      4
    ),
    state.activeThreads,
    4
  );
  state.activeThreads = threadSeeds;

  const candidateIdeas = extractSignalPhrases(
    outbound,
    /(collaborat|integrat|pilot|joint|co-?build|follow[ -]?up|introduc|next step)/i,
    4
  );
  state.candidateCollaborations = mergeUnique(state.candidateCollaborations, candidateIdeas, 4);

  const questionPhrases = extractSignalPhrases(outbound, /\?/, 4).map(q => {
    return q.endsWith('?') ? q : `${q}?`;
  });
  state.openQuestions = mergeUnique(state.openQuestions, questionPhrases, 4);

  state.closeSignal = Boolean(state.closeSignal || closeSignal);
  state.phase = inferPhaseFromState(state, { closeSignal });
  state.updatedAt = Date.now();
}

/**
 * Auto-add caller as contact if new
 */
function ensureContact(caller, tokenId) {
  if (!caller?.name) return null;

  try {
    const contact = tokenStore.ensureInboundContact(caller, tokenId);
    if (contact) {
      logger.info('Contact ensured from inbound call', {
        event: 'contact_ensured',
        tokenId,
        data: {
          caller_name: caller.name,
          caller_owner: caller.owner || null
        }
      });
    }
    return contact;
  } catch (err) {
    logger.error('Failed to ensure contact', {
      event: 'contact_ensure_failed',
      tokenId,
      error_code: 'CONTACT_ENSURE_FAILED',
      hint: 'Validate token/contact store files and write permissions.',
      error: err,
      data: {
        caller_name: caller?.name || null
      }
    });
    return null;
  }
}

/**
 * Spawn OpenClaw sub-agent to handle the call
 */
async function callAgent(message, a2aContext) {
  const callerName = a2aContext.caller?.name || 'Unknown Agent';
  const callerOwner = a2aContext.caller?.owner || '';
  const tierInfo = a2aContext.tier || 'public';
  const conversationId = a2aContext.conversation_id || `conv_${Date.now()}`;
  const traceId = a2aContext.trace_id || null;
  const requestId = a2aContext.request_id || null;
  const callLogger = logger.child({
    traceId,
    requestId,
    conversationId,
    tokenId: a2aContext.token_id
  });
  const collabMode = resolveCollabMode();
  const collabState = getOrCreateCollaborationState(conversationId, {
    callerName,
    callerOwner,
    tier: tierInfo
  });

  // Auto-add caller as contact
  ensureContact(a2aContext.caller, a2aContext.token_id);

  // Build prompt from disclosure manifest
  const manifest = loadManifest();
  const tierTopics = getTopicsForTier(tierInfo);
  const formattedTopics = formatTopicsForPrompt(tierTopics);

  // Load tier goals from config (merged up the hierarchy like disclosure topics)
  let tierGoals = [];
  try {
    const configDir = process.env.A2A_CONFIG_DIR || process.env.OPENCLAW_CONFIG_DIR ||
      path.join(process.env.HOME || '/tmp', '.config', 'openclaw');
    const configPath = path.join(configDir, 'a2a-config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const tierHierarchy = ['public', 'friends', 'family'];
      const tierIndex = tierHierarchy.indexOf(tierInfo);
      const tiersToMerge = tierIndex >= 0
        ? tierHierarchy.slice(0, tierIndex + 1)
        : ['public'];
      for (const t of tiersToMerge) {
        const tGoals = config.tiers?.[t]?.goals || [];
        tierGoals.push(...tGoals);
      }
      tierGoals = [...new Set(tierGoals)];
    }
  } catch (e) {}

  const promptOptions = {
    agentName: agentContext.name,
    ownerName: agentContext.owner,
    otherAgentName: callerName,
    otherOwnerName: callerOwner || 'their owner',
    roleContext: 'They called you.',
    accessTier: tierInfo,
    tierTopics: formattedTopics,
    tierGoals,
    otherAgentGreeting: message,
    personalityNotes: manifest.personality_notes || ''
  };

  const prompt = collabMode === 'adaptive'
    ? buildAdaptiveConnectionPrompt({
      ...promptOptions,
      conversationState: collabState
    })
    : buildConnectionPrompt(promptOptions);

  const sessionId = `a2a-${conversationId}`;
  const claudeTurnTimeoutMs = resolveTurnTimeoutMs({
    tokenTimeoutMs: a2aContext.timeout_ms,
    configTimeoutMs: resolveConfiguredTurnTimeoutMs()
  });
  
  try {
    callLogger.info('Handling inbound call turn', {
      event: 'call_turn_start',
      data: {
        caller_name: callerName,
        caller_owner: callerOwner || null,
        tier: tierInfo,
        collab_mode: collabMode
      }
    });

      const rawResponse = await runtime.runTurn({
        sessionId,
        prompt,
        message,
        caller: a2aContext.caller || {},
        timeoutMs: runtime.mode === 'claude' ? claudeTurnTimeoutMs : 65000,
        context: {
          conversationId,
          tier: tierInfo,
          ownerName: agentContext.owner,
          capabilities: Array.isArray(a2aContext.capabilities) ? a2aContext.capabilities : [],
          allowedTopics: a2aContext.allowed_topics || [],
          allowed_topics: a2aContext.allowed_topics || [],
          allowedGoals: a2aContext.allowed_goals || [],
          allowed_goals: a2aContext.allowed_goals || [],
          allowedTools: a2aContext.allowed_tools || [],
          allowed_tools: a2aContext.allowed_tools || [],
          timeoutMs: runtime.mode === 'claude' ? claudeTurnTimeoutMs : 65000,
          traceId,
          requestId
        }
      });

    // Claude mode returns structured metadata (statePatch + flags) via side channel.
    // We persist owner-facing flags so permission questions (e.g. blocked tool requests)
    // are visible in call history even though the remote only sees conversational text.
    const turnMeta = runtime.mode === 'claude' && typeof runtime.getLastTurnMeta === 'function'
      ? runtime.getLastTurnMeta(sessionId)
      : null;
    if (turnMeta?.flags?.length > 0) {
      const convStoreForFlags = getServerConvStore();
      if (convStoreForFlags) {
        try {
          convStoreForFlags.addMessage(conversationId, {
            direction: 'outbound',
            role: 'system',
            content: `[flags] ${turnMeta.flags.map(f => f.content || f.type).join('; ')}`,
            metadata: JSON.stringify({ flags: turnMeta.flags, phase: collabState.phase })
          });
        } catch (err) {
          callLogger.warn('Failed to persist owner flags for turn', {
            event: 'call_turn_flags_persist_failed',
            error: err
          });
        }
      }
    }

    if (collabMode !== 'adaptive') {
      return rawResponse;
    }

    const parsed = extractCollaborationState(rawResponse);
    const cleanResponse = parsed.cleanText || rawResponse;
    const beforeTurn = collabState.turnCount;
    let usedMetadata = false;

    // Prefer explicit Claude metadata side channel in claude mode.
    if (turnMeta?.statePatch) {
      usedMetadata = applyCollaborationPatch(collabState, turnMeta.statePatch);
      if (!usedMetadata) {
        callLogger.warn('Invalid collaboration patch; applying fallback heuristics', {
          event: 'collaboration_patch_invalid',
          error_code: 'COLLABORATION_PATCH_INVALID',
          hint: 'Ensure assistant emits valid collaboration metadata JSON block.'
        });
      }
    } else if (parsed.hasState && parsed.statePatch) {
      usedMetadata = applyCollaborationPatch(collabState, parsed.statePatch);
      if (!usedMetadata) {
        callLogger.warn('Invalid collaboration patch; applying fallback heuristics', {
          event: 'collaboration_patch_invalid',
          error_code: 'COLLABORATION_PATCH_INVALID',
          hint: 'Ensure assistant emits valid collaboration metadata JSON block.'
        });
      }
    } else if (parsed.parseError) {
      callLogger.warn('Could not parse collaboration metadata; applying fallback heuristics', {
        event: 'collaboration_metadata_parse_failed',
        error_code: 'COLLABORATION_METADATA_PARSE_FAILED',
        hint: 'Inspect response format and ensure metadata wrapper markers are intact.',
        data: {
          parse_error: parsed.parseError
        }
      });
    }

    if (!usedMetadata) {
      fallbackCollaborationUpdate(collabState, message, cleanResponse, tierTopics);
    }

    if (collabState.turnCount <= beforeTurn) {
      collabState.turnCount = beforeTurn + 1;
    }

    if (!VALID_PHASES.has(collabState.phase)) {
      collabState.phase = inferPhaseFromState(collabState, { closeSignal: collabState.closeSignal });
    }
    collabState.updatedAt = Date.now();
    collaborationSessions.set(conversationId, collabState);

    // Write-through to DB for restart recovery
    const convStoreForPersist = getServerConvStore();
    if (convStoreForPersist) {
      try {
        convStoreForPersist.saveCollabState(conversationId, collabState);
      } catch (err) {
        callLogger.warn('Failed to persist collab state to DB', {
          event: 'collab_state_persist_failed',
          error: err
        });
      }
    }

    callLogger.info('Call turn completed', {
      event: 'call_turn_complete',
      data: {
        phase: collabState.phase,
        overlap_score: collabState.overlapScore,
        turn_count: collabState.turnCount
      }
    });

      return cleanResponse || '[Sub-agent returned empty response]';
    
  } catch (err) {
    callLogger.error('Runtime turn handling failed', {
      event: 'call_turn_failed',
      error_code: 'RUNTIME_TURN_FAILED',
      hint: 'Inspect runtime adapter logs in this trace to identify CLI/bridge failure.',
      error: err,
      data: {
        phase: 'runtime_turn'
      }
    });
    throw err;
  }
}

/**
 * Generate strategic summary via sub-agent
 */
async function generateSummary(messages, callerInfo) {
  // Look up collaboration state if we have a conversation_id
  const conversationId = callerInfo?.conversation_id || callerInfo?.conversationId;
  let collaborationState = null;
  if (conversationId) {
    const collabSession = collaborationSessions.get(conversationId);
    if (collabSession) {
      collaborationState = {
        phase: collabSession.phase,
        overlapScore: collabSession.overlapScore,
        turnCount: collabSession.turnCount,
        activeThreads: collabSession.activeThreads,
        candidateCollaborations: collabSession.candidateCollaborations,
        closeSignal: collabSession.closeSignal
      };
    }
  }

  // Load disclosure manifest for the caller's tier
  const tier = callerInfo?.tier || 'public';
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

  // Build transcript in unified format
  const transcript = messages.map(m => ({
    direction: m.direction,
    content: m.content
  }));

  const prompt = buildUnifiedSummaryPrompt({
    transcript,
    callerInfo: {
      name: callerInfo?.name || null,
      owner: callerInfo?.owner || null,
      context: callerInfo?.context || null
    },
    disclosure,
    collaborationState,
    ownerContext: {
      agentName: agentContext.name,
      ownerName: agentContext.owner,
      goals: []
    }
  });

  try {
    const summarySessionId = conversationId ? `a2a-${conversationId}` : `summary-${Date.now()}`;
    return await runtime.summarize({
      sessionId: summarySessionId,
      prompt,
      messages,
      callerInfo,
      traceId: callerInfo?.trace_id || callerInfo?.traceId,
      conversationId
    });
  } catch (err) {
    logger.error('Summary generation failed', {
      event: 'summary_generation_failed',
      traceId: callerInfo?.trace_id || callerInfo?.traceId,
      conversationId,
      error_code: 'SUMMARY_GENERATION_FAILED',
      hint: 'Check summarizer runtime and command configuration for summary stage.',
      error: err,
      data: {
        phase: 'summary'
      }
    });
    return null;
  }
}

/**
 * Notify owner via Telegram
 */
async function notifyOwner({ level, token, caller, message, conversation_id, trace_id }) {
  const callerName = caller?.name || 'Unknown';
  const callerOwner = caller?.owner ? ` (${caller.owner})` : '';
  const messageText = String(message || '');
  
  logger.info('Owner notification requested', {
    event: 'owner_notify_requested',
    conversationId: conversation_id,
    tokenId: token?.id,
    data: {
      caller_name: callerName,
      caller_owner: caller?.owner || null,
      token_name: token?.name || 'unknown',
      level
    }
  });

  await runtime.notify({
    level,
    token,
    caller,
    message: messageText,
    conversationId: conversation_id,
    traceId: trace_id || null
  });
}

const app = express();
app.use(express.json());
let activeCallMonitor = null;
let updateManager = null;

// Minimal owner dashboard (local by default unless A2A_ADMIN_TOKEN is provided)
// All routes under /api/a2a/* so reverse proxy config stays simple.
app.use('/api/a2a/dashboard', createDashboardApiRouter({
  tokenStore,
  agentContext,
  config,
  eventStore,
  getUpdateManager: () => updateManager,
  logger: logger.child({ component: 'a2a.dashboard' })
}));
app.use('/api/a2a/dashboard', createDashboardUiRouter({
  tokenStore,
  agentContext,
  config,
  getUpdateManager: () => updateManager,
  logger: logger.child({ component: 'a2a.dashboard' })
}));

// Callbook Remote pairing flow (public install page).
// Mounted under /api/a2a/ for reverse proxy compatibility.
app.use('/api/a2a/callbook', createCallbookRouter());

// Legacy routes for backwards compatibility (direct access without reverse proxy)
app.use('/dashboard', createDashboardUiRouter({
  tokenStore,
  agentContext,
  logger: logger.child({ component: 'a2a.dashboard' })
}));
app.use('/callbook', createCallbookRouter());

// A2A-52: pass agent's public key so /status can advertise it
const _a2aKeypair = config.getKeypair();
app.use('/api/a2a', createRoutes({
  tokenStore,
  eventStore,
  publicKey: _a2aKeypair ? _a2aKeypair.publicKey : null,
  logger: logger.child({ component: 'a2a.routes' }),
  onCallMonitor: (monitor) => {
    activeCallMonitor = monitor;
  },
  
  async handleMessage(message, context, options) {
    const traceId = context.trace_id || null;
    const conversationId = context.conversation_id;
    const requestLogger = logger.child({
      traceId,
      conversationId,
      tokenId: context.token_id
    });
    requestLogger.info('Inbound message accepted for handling', {
      event: 'handle_message_start',
      data: {
        caller_name: context.caller?.name || 'unknown'
      }
    });

    const response = await callAgent(message, context);

    // Check close conditions from collab state
    const collabState = collaborationSessions.get(conversationId);
    let canContinue = true;
    let collaboration = null;

    if (collabState) {
      collaboration = {
        phase: collabState.phase,
        turnCount: collabState.turnCount,
        overlapScore: collabState.overlapScore,
        activeThreads: collabState.activeThreads,
        candidateCollaborations: collabState.candidateCollaborations,
        closeSignal: collabState.closeSignal
      };

      if (collabState.closeSignal && collabState.turnCount >= 8) {
        canContinue = false;
      }
    }

    requestLogger.info('Outbound response generated', {
      event: 'handle_message_complete',
      data: {
        response_length: String(response || '').length,
        can_continue: canContinue
      }
    });

    return { text: response, canContinue, collaboration };
  },
  
  summarizer: generateSummary,
  notifyOwner
}));

app.get('/', (req, res) => {
  res.json({ service: 'a2a', status: 'ok', agent: agentContext.name });
});

async function startServer() {
  let port;

  if (requestedPort) {
    // Explicit port requested — try it first, fall back to defaults if busy
    const { isPortAvailable } = require('./lib/port-scanner');
    if (await isPortAvailable(requestedPort)) {
      port = requestedPort;
    } else {
      logger.warn('Requested port is in use, scanning for alternatives', {
        event: 'requested_port_in_use',
        data: {
          requested_port: requestedPort
        }
      });
      port = await findAvailablePort(DEFAULT_PORTS);
    }
  } else {
    port = await findAvailablePort(DEFAULT_PORTS);
  }

  if (!port) {
    logger.error('No available port found', {
      event: 'port_unavailable',
      data: {
        tried_ports: requestedPort ? [requestedPort, ...DEFAULT_PORTS] : DEFAULT_PORTS
      }
    });
    logger.error('Set PORT env or free one of the default ports.', {
      event: 'port_unavailable_hint'
    });
    process.exit(1);
  }

  const server = app.listen(port, () => {
    logger.info('A2A server listening', {
      event: 'server_started',
      data: {
        port,
        agent_name: agentContext.name,
        runtime_mode: runtime.mode,
        collaboration_mode: resolveCollabMode(),
        features: ['adaptive collaboration', 'auto-contacts', 'summaries', 'dashboard']
      }
    });
    writePidFile(process.pid);

    if (!updateManager) {
      const pkg = require('../package.json');
      const restartFn = async () => {
        const cliPath = path.join(__dirname, '..', 'bin', 'cli.js');
        const helperScript = `
          const { spawn } = require('child_process');
          const startNext = () => {
            const child = spawn(process.execPath, [${JSON.stringify(cliPath)}, 'server', '--port', ${JSON.stringify(String(port))}], {
              detached: true,
              stdio: 'ignore',
              env: process.env
            });
            child.unref();
            process.exit(0);
          };
          setTimeout(startNext, 1500);
        `;
        const helper = spawn(process.execPath, ['-e', helperScript], {
          detached: true,
          stdio: 'ignore',
          env: process.env
        });
        helper.unref();
        setTimeout(() => {
          process.kill(process.pid, 'SIGTERM');
        }, 150);
      };

      updateManager = new UpdateManager({
        currentVersion: pkg.version,
        config,
        logger: logger.child({ component: 'a2a.updater' }),
        getCallMonitor: () => activeCallMonitor,
        restartFn
      });
      updateManager.start();
      updateManager.triggerCheck({ reason: 'startup' }).catch((err) => {
        logger.warn('Initial auto-update check failed', {
          event: 'updater_startup_check_failed',
          error: err
        });
      });
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logger.error('Bound port became unavailable (EADDRINUSE)', {
        event: 'server_port_lost',
        data: {
          port
        }
      });
      process.exit(1);
    }
    throw err;
  });

  // A2A-57: Close all SQLite stores before shutting down the HTTP server
  function shutdown() {
    if (updateManager) updateManager.stop();
    removePidFile();
    if (serverConvStore && serverConvStore.close) {
      try { serverConvStore.close(); } catch (_) {}
    }
    try { eventStore.close(); } catch (_) {}
    try { closeAllLoggerStores(); } catch (_) {}
    server.close(() => process.exit(0));
    // Force exit after 5s if connections won't close
    setTimeout(() => process.exit(0), 5000).unref();
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

startServer();
