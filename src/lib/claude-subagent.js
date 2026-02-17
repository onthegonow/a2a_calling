/**
 * Claude Subagent — Lifecycle management for Claude CLI subagent sessions.
 *
 * Spawns `claude` CLI processes for real LLM-powered A2A conversations
 * as an alternative to OpenClaw for A2A conversations.
 *
 * Design decision (A2A-29):
 * We intentionally run Claude turns in stateless one-shot mode instead of `--resume`.
 * In production we observed intermittent hangs during nested Claude startup/restore.
 * Stateless calls cost more tokens but are operationally safer under load.
 *
 * Permissioning is still enforced:
 * `--allowedTools` is derived per request from token capabilities + allowed topics
 * and can be further constrained by per-tier `allowed_tools` policy from onboarding.
 */

const { execSync, spawn } = require('child_process');
const { createLogger } = require('./logger');
const { HARD_FALLBACK_TURN_TIMEOUT_MS } = require('./turn-timeout');

const logger = createLogger({ component: 'a2a.claude-subagent' });

const A2A_RESPONSE_REGEX = /<a2a_response>\s*([\s\S]*?)\s*<\/a2a_response>/i;
const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-5-20250929';
const CLAUDE_TOOL_UNIVERSE = ['Bash', 'Bash(readonly)', 'Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'];
const LEGACY_DEFAULT_TOOLS = ['Bash(readonly)', 'Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'];

const TOOL_NAME_MAP = {
  bash: 'Bash',
  'bash(readonly)': 'Bash(readonly)',
  'bash-readonly': 'Bash(readonly)',
  read: 'Read',
  grep: 'Grep',
  glob: 'Glob',
  websearch: 'WebSearch',
  webfetch: 'WebFetch'
};

function normalizeToolName(value) {
  const key = String(value || '').trim().toLowerCase();
  return TOOL_NAME_MAP[key] || null;
}

function sanitizeAllowedToolList(values) {
  if (!Array.isArray(values)) return [];
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const canonical = normalizeToolName(value);
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    out.push(canonical);
  }
  return out;
}

function formatToolListForPrompt(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return '  (none)';
  return tools.map(tool => `  - ${tool}`).join('\n');
}

/**
 * Check if `claude` CLI is available in PATH.
 */
function isClaudeAvailable() {
  try {
    execSync('command -v claude', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the system prompt for the Claude subagent.
 *
 * @param {Object} config
 * @param {string} config.agentName
 * @param {string} config.ownerName
 * @param {string} config.otherAgentName
 * @param {string} config.otherOwnerName
 * @param {string} config.accessTier
 * @param {string} config.tierTopics - formatted topics string
 * @param {string} config.tierObjectives - formatted objectives string
 * @param {string} config.doNotDiscuss - formatted do_not_discuss string
 * @param {string} config.neverDisclose - formatted never_disclose string
 * @param {string[]} [config.allowedTools] - Effective tool allowlist for this call
 * @param {string} config.personalityNotes
 * @param {string} config.roleContext
 * @returns {string}
 */
function buildSubagentSystemPrompt(config) {
  const {
    agentName = 'Agent',
    ownerName = 'the owner',
    otherAgentName = 'Remote Agent',
    otherOwnerName = 'their owner',
    accessTier = 'public',
    tierTopics = '  (none specified)',
    tierObjectives = '  (none specified)',
    doNotDiscuss = '  (none specified)',
    neverDisclose = '  (none specified)',
    allowedTools = [],
    personalityNotes = '',
    roleContext = ''
  } = config;

  const effectiveAllowedTools = sanitizeAllowedToolList(allowedTools);
  const allowedForPrompt = effectiveAllowedTools.length > 0
    ? effectiveAllowedTools
    : [...LEGACY_DEFAULT_TOOLS];
  const blockedTools = CLAUDE_TOOL_UNIVERSE.filter(tool => !allowedForPrompt.includes(tool));

  return `You are ${agentName}, the personal AI agent for ${ownerName}.
You are on a live A2A (agent-to-agent) call with ${otherAgentName}, who represents ${otherOwnerName}. ${roleContext}

== OUTPUT FORMAT ==

After your conversational reply, you MUST append exactly one structured response block:

<a2a_response>
{"message":"Your conversational reply here","statePatch":{"phase":"explore","overlapScore":0.3,"activeThreads":["thread1"],"candidateCollaborations":["idea1"],"closeSignal":false,"confidence":0.4},"flags":[]}
</a2a_response>

Rules for the response block:
- "message" (required): Your full conversational reply text. This is what the other agent sees.
- "statePatch" (optional): Collaboration state update with any of: phase, overlapScore (0-1), activeThreads (max 4), candidateCollaborations (max 4), closeSignal (boolean), confidence (0-1).
- "flags" (optional): Array of flag objects like {"type":"question_for_owner","content":"..."} or {"type":"opportunity_flagged","content":"..."}.
- Must be valid JSON (double quotes only).
- The message in the JSON block should match your visible conversational text.

Flag types:
- "question_for_owner": Something you want to ask ${ownerName} about before committing
- "opportunity_flagged": A concrete collaboration opportunity worth the owner's attention
- "boundary_touched": The other agent probed near a do_not_discuss or never_disclose topic
- "unverifiable_claim": The other agent made a claim you cannot verify

== DISCLOSURE CONTEXT ==

Access level: ${accessTier}

${ownerName}'s topics of interest:
${tierTopics}

Objectives:
${tierObjectives}

DO NOT DISCUSS (redirect naturally):
${doNotDiscuss}

NEVER disclose:
${neverDisclose}

== TOOL PERMISSIONS ==

Allowed tools this call:
${formatToolListForPrompt(allowedForPrompt)}

Blocked tools this call:
${formatToolListForPrompt(blockedTools)}

Tool policy:
- Never invoke blocked tools.
- If you need a blocked tool, continue the conversation without it and add a "question_for_owner" flag requesting permission.
- Include exact tool name and reason in the flag content.

== BEHAVIORAL MANDATE ==

You operate in three concurrent modes:

1. EXPLORING: Map the other agent's owner — capabilities, resources, blind spots, ambitions.
   Ask probing questions. Don't accept surface-level answers. Dig into specifics.

2. ADVERSARIALLY QUALIFYING: Pressure-test claims. Push back respectfully.
   "You say X, but that sounds like Y. What's actually different?"
   "That's a crowded space. What makes their angle defensible?"
   The best collaborations come from people who can handle scrutiny.

3. COLLABORATING: Look for concrete overlap and actionable next steps.
   Complementary capabilities, shared challenges, non-obvious intersections.
   Propose specific ideas, not vague "let's stay in touch."

== PHASE AWARENESS ==

Each turn you receive state including turn number, maxTurns, and current phase.
Adapt your behavior to the phase:

- handshake (turns 1-2): Establish context, introduce key topics, set one meaningful direction.
- exploring (turns 2-6): Map goals, capabilities, constraints. Stay here while new info surfaces.
- deepening (turns 5-10): Work through specific collaboration threads in detail.
- converging (turns 8+): Convert insights into concrete next steps. Set closeSignal when done.

These are guidelines, not hard locks. Stay in any phase as long as it's productive.

== PERSONALITY ==

${personalityNotes || "Direct, curious, slightly irreverent. You have opinions and share them. You're not a concierge — you're a sparring partner who represents someone."}

When unsure about your owner's position, say so: "I don't have ${ownerName}'s take on that — but here's what I think based on their work..."`;
}

/**
 * Build the turn prompt containing state and the inbound message.
 */
function buildTurnPrompt(options) {
  const {
    turnMessage,
    turn,
    maxTurns,
    phase = 'handshake',
    overlapScore = 0.15,
    activeThreads = [],
    candidateCollaborations = [],
    closeSignal = false
  } = options;

  return `== TURN STATE ==
Turn: ${turn}/${maxTurns}
Phase: ${phase}
Overlap score: ${overlapScore}
Active threads: ${activeThreads.length > 0 ? activeThreads.join(', ') : '(none)'}
Candidate collaborations: ${candidateCollaborations.length > 0 ? candidateCollaborations.join(', ') : '(none)'}
Close signal: ${closeSignal}

== INBOUND MESSAGE ==

${turnMessage}

Respond naturally, then append your <a2a_response> block.`;
}

/**
 * Parse the structured response from Claude's output.
 *
 * @param {string} resultText - Raw text output from claude CLI
 * @returns {{ message: string, statePatch: object|null, flags: array }}
 */
function parseSubagentResponse(resultText) {
  if (!resultText || typeof resultText !== 'string') {
    return { message: '', statePatch: null, flags: [] };
  }

  const match = resultText.match(A2A_RESPONSE_REGEX);
  if (!match) {
    // Graceful degradation: treat entire result as the message
    return { message: resultText.trim(), statePatch: null, flags: [] };
  }

  const jsonStr = (match[1] || '').trim();
  if (!jsonStr) {
    const cleanText = resultText.replace(A2A_RESPONSE_REGEX, '').trim();
    return { message: cleanText || '', statePatch: null, flags: [] };
  }

  try {
    const parsed = JSON.parse(jsonStr);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('a2a_response must be a JSON object');
    }

    return {
      message: typeof parsed.message === 'string' ? parsed.message : resultText.replace(A2A_RESPONSE_REGEX, '').trim(),
      statePatch: parsed.statePatch && typeof parsed.statePatch === 'object' ? parsed.statePatch : null,
      flags: Array.isArray(parsed.flags) ? parsed.flags : []
    };
  } catch (err) {
    logger.warn('Failed to parse <a2a_response> JSON', {
      event: 'subagent_response_parse_failed',
      error: err,
      data: { json_length: jsonStr.length }
    });
    // Fall back to using text outside the tags
    const cleanText = resultText.replace(A2A_RESPONSE_REGEX, '').trim();
    return { message: cleanText || resultText.trim(), statePatch: null, flags: [] };
  }
}

/**
 * Spawn `claude` CLI and collect output as a promise.
 *
 * @param {string[]} args - CLI arguments
 * @param {number} timeoutMs - Timeout in milliseconds
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
function spawnClaude(args, timeoutMs = HARD_FALLBACK_TURN_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        FORCE_COLOR: '0',
        CLAUDECODE: ''  // Unset to allow nested invocation
      }
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGTERM');
      // Give it 5s to clean up, then force kill
      setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch (e) { /* already dead */ }
      }, 5000);
    }, timeoutMs);

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (killed) {
        reject(new Error(`Claude CLI timed out after ${timeoutMs}ms`));
        return;
      }
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(`Claude CLI exited with code ${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      resolve({ stdout, stderr });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Extract the result text from Claude's JSON output.
 * Claude with --output-format json returns { type, subtype, cost_usd, duration_ms, duration_api_ms,
 * is_error, num_turns, result, session_id, ... }
 */
function extractResultFromJson(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return { result: '', sessionId: null };

  try {
    const parsed = JSON.parse(trimmed);
    return {
      result: typeof parsed.result === 'string' ? parsed.result : '',
      sessionId: parsed.session_id || null
    };
  } catch (err) {
    // If JSON parsing fails, treat entire output as result text
    logger.debug('Claude output not valid JSON, using raw text', {
      event: 'subagent_json_parse_fallback',
      data: { output_length: trimmed.length }
    });
    return { result: trimmed, sessionId: null };
  }
}

function normalizePermissionList(values) {
  if (!Array.isArray(values)) return [];
  return values
    .map(v => String(v || '').trim().toLowerCase())
    .filter(Boolean);
}

function hasPermissionMatch(values, key) {
  if (!key) return false;
  return values.some(value => value === key || value.startsWith(`${key}.`));
}

function deriveClaudeToolsFromPermissionSignals({ capabilities = [], allowedTopics = [] } = {}) {
  const normalizedCaps = normalizePermissionList(capabilities);
  const normalizedTopics = normalizePermissionList(allowedTopics);
  const hasPermissionContext = normalizedCaps.length > 0 || normalizedTopics.length > 0;

  if (!hasPermissionContext) {
    return [...LEGACY_DEFAULT_TOOLS];
  }

  const hasContextRead = hasPermissionMatch(normalizedCaps, 'context-read')
    || normalizedTopics.includes('chat');
  const hasSearch = hasPermissionMatch(normalizedCaps, 'search')
    || normalizedTopics.includes('search');
  const hasToolsRead = hasPermissionMatch(normalizedCaps, 'tools')
    || hasPermissionMatch(normalizedCaps, 'tools-read')
    || normalizedTopics.includes('tools');
  const hasToolsWrite = hasPermissionMatch(normalizedCaps, 'tools-write')
    || hasPermissionMatch(normalizedCaps, 'tools.write')
    || normalizedTopics.includes('tools-write')
    || normalizedTopics.includes('tools.write');

  const tools = [];

  // Keep read-only introspection available for context-aware tiers.
  if (hasContextRead || hasSearch || hasToolsRead || hasToolsWrite) {
    tools.push('Read', 'Grep', 'Glob');
  }

  // Web tools are explicitly tied to search-style permissions.
  if (hasSearch) {
    tools.push('WebSearch', 'WebFetch');
  }

  // Shell access is gated behind tool permissions, with explicit writable opt-in.
  if (hasToolsWrite) {
    tools.unshift('Bash');
  } else if (hasToolsRead) {
    tools.unshift('Bash(readonly)');
  }

  // Fail closed to read-only file inspection if metadata is custom/unknown.
  if (tools.length === 0) {
    return ['Read', 'Grep', 'Glob'];
  }

  return tools;
}

/**
 * Resolve Claude tool allowlist from token-derived permissions and explicit per-tier tool policy.
 */
function resolveClaudeAllowedTools({ capabilities = [], allowedTopics = [], allowedTools = [] } = {}) {
  const derivedTools = deriveClaudeToolsFromPermissionSignals({ capabilities, allowedTopics });
  const explicitTools = sanitizeAllowedToolList(allowedTools);

  if (explicitTools.length > 0) {
    const hasPermissionSignals = normalizePermissionList(capabilities).length > 0
      || normalizePermissionList(allowedTopics).length > 0;

    if (hasPermissionSignals) {
      // Permission signals define the ceiling; explicit tier tools can narrow it.
      const narrowed = explicitTools.filter(tool => derivedTools.includes(tool));
      return narrowed.length > 0 ? narrowed : derivedTools;
    }

    return explicitTools;
  }

  return derivedTools;
}

function buildClaudeToolArg(allowedTools) {
  return Array.isArray(allowedTools) ? allowedTools.join(' ').trim() : '';
}

function parseSummaryPayload(resultText) {
  const text = String(resultText || '').trim();
  if (!text) return null;

  // Backwards-compatible: older prompts wrapped JSON in <a2a_response>.
  const tagged = text.match(A2A_RESPONSE_REGEX);
  if (tagged && tagged[1]) {
    try {
      return JSON.parse(tagged[1].trim());
    } catch (err) {
      logger.warn('Failed to parse tagged summary JSON', {
        event: 'subagent_summary_tag_parse_failed',
        error: err
      });
    }
  }

  // Preferred path for unified summary prompt: direct JSON object.
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch (err) {
    logger.debug('Summary result is not direct JSON; falling back to plain text summary', {
      event: 'subagent_summary_raw_fallback',
      data: { output_length: text.length }
    });
  }

  return null;
}

function summarizeFromPayload(payload, fallbackText) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }

  // Native A2A summary payload shape.
  if (typeof payload.summary === 'string' || typeof payload.ownerSummary === 'string') {
    return {
      summary: payload.summary || payload.message || fallbackText || '',
      ownerSummary: payload.ownerSummary || payload.summary || payload.message || fallbackText || '',
      actionItems: Array.isArray(payload.actionItems) ? payload.actionItems : [],
      flags: Array.isArray(payload.flags) ? payload.flags : []
    };
  }

  // Unified summary schema shape (headline/assessment/nextSteps).
  if (typeof payload.headline === 'string') {
    return {
      summary: payload.headline,
      ownerSummary: typeof payload.assessment === 'string' ? payload.assessment : payload.headline,
      actionItems: Array.isArray(payload.nextSteps) ? payload.nextSteps : [],
      flags: []
    };
  }

  return null;
}

/**
 * Run a single turn of the Claude subagent.
 *
 * @param {Object} options
 * @param {string} options.systemPrompt - System prompt (used on turn 1 only)
 * @param {string} options.turnMessage - The inbound message from the remote agent
 * @param {number} options.turn - Current turn number (1-based)
 * @param {number} options.maxTurns - Maximum turns allowed
 * @param {string} options.phase - Current conversation phase
 * @param {number} options.overlapScore - Current overlap score
 * @param {Array} options.activeThreads - Active conversation threads
 * @param {Array} options.candidateCollaborations - Candidate collaboration ideas
 * @param {boolean} options.closeSignal - Whether close has been signaled
 * @param {Array<string>} [options.capabilities] - Token capabilities (permission source of truth)
 * @param {Array<string>} [options.allowedTopics] - Token allowed topics (permission source of truth)
 * @param {Array<string>} [options.allowedTools] - Token allowed tools (onboarding tier policy)
 * @param {function} [options.spawnFn] - Injectable process runner for tests
 * @param {number} [options.timeoutMs=300000] - Timeout in milliseconds
 * @returns {Promise<{ message: string, statePatch: object|null, flags: array }>}
 */
async function runClaudeTurn(options) {
  const {
    systemPrompt,
    turnMessage,
    turn = 1,
    maxTurns = 30,
    phase = 'handshake',
    overlapScore = 0.15,
    activeThreads = [],
    candidateCollaborations = [],
    closeSignal = false,
    capabilities = [],
    allowedTopics = [],
    allowedTools = [],
    spawnFn = spawnClaude,
    timeoutMs = HARD_FALLBACK_TURN_TIMEOUT_MS
  } = options;

  const turnPrompt = buildTurnPrompt({
    turnMessage,
    turn,
    maxTurns,
    phase,
    overlapScore,
    activeThreads,
    candidateCollaborations,
    closeSignal
  });

  const startAt = Date.now();
  const effectiveAllowedTools = resolveClaudeAllowedTools({ capabilities, allowedTopics, allowedTools });
  const allowedToolsArg = buildClaudeToolArg(effectiveAllowedTools);
  const args = [
    '-p',
    '--output-format', 'json',
    '--system-prompt', systemPrompt,
    '--model', DEFAULT_CLAUDE_MODEL
  ];

  // We always provide --allowedTools explicitly so token permissioning stays
  // enforced in Claude mode even after moving to stateless turns.
  if (allowedToolsArg) {
    args.push('--allowedTools', allowedToolsArg);
  }
  args.push(turnPrompt);

  logger.debug('Spawning Claude subagent turn', {
    event: 'subagent_turn_start',
    data: {
      turn,
      max_turns: maxTurns,
      phase,
      is_stateless: true,
      allowed_tools: effectiveAllowedTools,
      timeout_ms: timeoutMs
    }
  });

  const { stdout } = await spawnFn(args, timeoutMs);
  const { result } = extractResultFromJson(stdout);
  const parsed = parseSubagentResponse(result);

  logger.debug('Claude subagent turn completed', {
    event: 'subagent_turn_complete',
    data: {
      turn,
      duration_ms: Date.now() - startAt,
      message_length: parsed.message.length,
      has_state_patch: Boolean(parsed.statePatch),
      flag_count: parsed.flags.length
    }
  });

  return {
    message: parsed.message,
    statePatch: parsed.statePatch,
    flags: parsed.flags
  };
}

/**
 * Run a summary turn in stateless Claude mode.
 *
 * @param {Object} options
 * @param {string} options.prompt - Unified summary prompt
 * @param {string} [options.reason] - Why the conversation is ending
 * @param {Array<string>} [options.capabilities] - Token capabilities for summary turn tooling
 * @param {Array<string>} [options.allowedTopics] - Token allowed topics for summary turn tooling
 * @param {Array<string>} [options.allowedTools] - Token allowed tools for summary turn tooling
 * @param {function} [options.spawnFn] - Injectable process runner for tests
 * @param {number} [options.timeoutMs=300000] - Timeout in milliseconds
 * @returns {Promise<{ summary: string, ownerSummary: string, actionItems: array, flags: array }>}
 */
async function runClaudeSummary(options = {}) {
  const {
    prompt,
    reason,
    capabilities = [],
    allowedTopics = [],
    allowedTools = [],
    spawnFn = spawnClaude,
    timeoutMs = HARD_FALLBACK_TURN_TIMEOUT_MS
  } = options;

  const summaryPrompt = String(prompt || '').trim();
  if (!summaryPrompt) {
    throw new Error('Cannot summarize without a prompt');
  }

  const effectiveAllowedTools = resolveClaudeAllowedTools({ capabilities, allowedTopics, allowedTools });
  const allowedToolsArg = buildClaudeToolArg(effectiveAllowedTools);

  const args = [
    '-p',
    '--output-format', 'json',
    '--model', DEFAULT_CLAUDE_MODEL
  ];

  if (allowedToolsArg) {
    args.push('--allowedTools', allowedToolsArg);
  }
  args.push(
    '--append-system-prompt',
    `Conversation summary mode. Reason: ${reason || 'conversation ended'}. Return only structured summary JSON.`,
    summaryPrompt
  );

  const startAt = Date.now();

  logger.debug('Spawning Claude summary', {
    event: 'subagent_summary_start',
    data: {
      reason: reason || 'conversation ended',
      allowed_tools: effectiveAllowedTools
    }
  });

  const { stdout } = await spawnFn(args, timeoutMs);
  const { result } = extractResultFromJson(stdout);
  const summaryPayload = parseSummaryPayload(result);
  const parsedSummary = summarizeFromPayload(summaryPayload, result.trim());

  if (parsedSummary) {
    logger.debug('Claude summary completed', {
      event: 'subagent_summary_complete',
      data: {
        duration_ms: Date.now() - startAt,
        has_summary: Boolean(parsedSummary.summary),
        action_item_count: parsedSummary.actionItems.length
      }
    });
    return parsedSummary;
  }

  // Fallback: use raw text as summary
  const summaryText = result.replace(A2A_RESPONSE_REGEX, '').trim() || result.trim();
  return {
    summary: summaryText,
    ownerSummary: summaryText,
    actionItems: [],
    flags: []
  };
}

module.exports = {
  isClaudeAvailable,
  buildSubagentSystemPrompt,
  buildTurnPrompt,
  resolveClaudeAllowedTools,
  runClaudeTurn,
  runClaudeSummary,
  parseSubagentResponse
};
