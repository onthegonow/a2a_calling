/**
 * Unified Summary Prompt Builder
 *
 * Builds a comprehensive summary prompt that includes all context
 * needed for accurate, auditable conversation summaries:
 *
 *   - Conversation objective (why the call happened)
 *   - Disclosure manifest (what's in scope for this tier)
 *   - Collaboration state (phase, overlap score, threads)
 *   - Full transcript
 *   - Owner context
 *
 * Used by both OpenClaw and spawned-agent summary paths.
 */

/**
 * Build a unified summary prompt with full context.
 *
 * @param {object} options
 * @param {Array} options.transcript - [{direction, content}]
 * @param {object} options.callerInfo - {name, owner, context}
 * @param {string} [options.conversationObjective] - Why this call was made
 * @param {object} [options.disclosure] - {topics, objectives, doNotDiscuss, neverDisclose}
 * @param {object} [options.collaborationState] - {phase, overlapScore, activeThreads, ...}
 * @param {object} [options.ownerContext] - {agentName, ownerName, goals}
 * @returns {string} The complete prompt
 */
function buildUnifiedSummaryPrompt(options = {}) {
  const {
    transcript = [],
    callerInfo = {},
    conversationObjective,
    disclosure,
    collaborationState,
    ownerContext = {}
  } = options;

  const sections = [];

  // ── Header ──
  sections.push(`You just finished an A2A agent-to-agent call. Summarize it for your owner.

Your tone: friendly, clear, and genuinely helpful. Lead with what matters most.
Write like you're briefing a smart friend — not filing a report.`);

  // ── Conversation Objective ──
  if (conversationObjective) {
    sections.push(`## Why This Call Happened
${conversationObjective}`);
  }

  // ── Owner Context ──
  if (ownerContext.agentName || ownerContext.ownerName || ownerContext.goals) {
    const parts = [];
    if (ownerContext.agentName) parts.push(`You are: ${ownerContext.agentName}`);
    if (ownerContext.ownerName) parts.push(`Your owner: ${ownerContext.ownerName}`);
    if (ownerContext.goals?.length) {
      parts.push(`Owner's current goals:\n${ownerContext.goals.map(g => `- ${g}`).join('\n')}`);
    }
    sections.push(`## Your Owner\n${parts.join('\n')}`);
  }

  // ── Disclosure Manifest ──
  if (disclosure) {
    const discParts = [];

    if (disclosure.topics?.length) {
      discParts.push('### Topics In Scope');
      for (const t of disclosure.topics) {
        discParts.push(`- **${t.topic}**: ${t.description}`);
      }
    }

    if (disclosure.objectives?.length) {
      discParts.push('\n### Conversation Objectives');
      for (const o of disclosure.objectives) {
        const label = o.objective || o.topic;
        discParts.push(`- **${label}**: ${o.description}`);
      }
    }

    if (disclosure.doNotDiscuss?.length) {
      discParts.push('\n### Do Not Discuss (Deflect These)');
      for (const d of disclosure.doNotDiscuss) {
        discParts.push(`- **${d.topic}**: ${d.reason}`);
      }
    }

    if (disclosure.neverDisclose?.length) {
      discParts.push('\n### Never Disclose (Hard Blocks)');
      for (const n of disclosure.neverDisclose) {
        discParts.push(`- ${n}`);
      }
    }

    sections.push(`## Disclosure Boundaries\nThese are the rules your agent operated under. Check whether they were followed.\n\n${discParts.join('\n')}`);
  }

  // ── Collaboration State ──
  if (collaborationState) {
    const cs = collaborationState;
    sections.push(`## Collaboration State at End of Call
- **Phase:** ${cs.phase || 'unknown'} (handshake -> exploring -> deepening -> converging -> close)
- **Overlap Score:** ${cs.overlapScore != null ? cs.overlapScore.toFixed(2) : 'unknown'}/1.00
- **Turn Count:** ${cs.turnCount || 'unknown'}
- **Active Threads:** ${cs.activeThreads?.length ? cs.activeThreads.join(', ') : 'none identified'}
- **Candidate Collaborations:** ${cs.candidateCollaborations?.length ? cs.candidateCollaborations.join(', ') : 'none yet'}
- **Close Signal:** ${cs.closeSignal ? 'yes' : 'no'}

### What Overlap Score Means
- 0.00–0.30: Minimal alignment — different domains, graceful mismatch expected
- 0.30–0.60: Moderate — some shared interests, worth exploring
- 0.60–0.80: Strong — clear mutual value, specific opportunities emerging
- 0.80–1.00: Deep alignment — ready for concrete collaboration`);
  }

  // ── Transcript ──
  const callerLabel = callerInfo.name || 'Caller';
  const messageText = transcript.map(m => {
    const role = m.direction === 'inbound' ? `[${callerLabel}]` : '[You]';
    return `${role}: ${m.content}`;
  }).join('\n\n');

  sections.push(`## Caller
${callerInfo.name ? `**Name:** ${callerInfo.name}` : 'Unknown caller'}
${callerInfo.owner ? `**Represents:** ${callerInfo.owner}` : ''}
${callerInfo.context ? `**Context:** ${callerInfo.context}` : ''}`);

  sections.push(`## Full Transcript\n${messageText}`);

  // ── Output Instructions ──
  sections.push(`## Your Task

Summarize this call. Return valid JSON matching this exact schema:

{
  "headline": "One sentence — the single most important takeaway for the owner",

  "vibe": "productive | exploratory | mismatch | guarded | breakthrough",

  "quickTake": [
    "Most important discovery or outcome",
    "Key opportunity or concern",
    "Recommended immediate action"
  ],

  "who": {
    "name": "Caller name",
    "represents": "Who they work for or represent",
    "keyFacts": ["Notable fact 1", "Notable fact 2"]
  },

  "collaboration": {
    "score": 0.00,
    "scoreJustification": "Why this score — what aligned, what didn't",
    "rating": "HIGH | MEDIUM | LOW",
    "opportunities": ["Specific opportunity with details"]
  },

  "exchange": {
    "weGot": ["Info or value we received"],
    "weGave": ["Info or value we shared"],
    "balance": "favorable | even | unfavorable"
  },

  "disclosure": {
    "compliance": "clean | minor_concern | violation",
    "topicsCovered": ["In-scope topics that were discussed"],
    "topicsAvoided": ["Topics that were properly deflected"],
    "concerns": ["Any info shared that shouldn't have been, or empty array"]
  },

  "objectives": {
    "achieved": ["Objectives that were met"],
    "partiallyAchieved": ["Objectives with some progress"],
    "notAchieved": ["Objectives not addressed"]
  },

  "nextSteps": [
    "Specific actionable follow-up 1",
    "Specific actionable follow-up 2"
  ],

  "trust": {
    "level": "maintain | increase | decrease | revoke",
    "reasoning": "One sentence — why this trust recommendation"
  },

  "assessment": "One sentence — strategic value judgment for the owner"
}

Important:
- Validate the collaboration score — does it match what actually happened in the conversation?
- Check disclosure compliance — was any never_disclose or do_not_discuss info leaked?
- Be honest about objectives — don't inflate partial progress into "achieved"
- quickTake should be genuinely useful, not generic platitudes

JSON:`);

  return sections.join('\n\n');
}

module.exports = { buildUnifiedSummaryPrompt };
