/**
 * Summary Formatter
 *
 * Renders the structured JSON summary into a human-readable markdown
 * format. Designed to be scannable, upbeat, and genuinely useful.
 *
 * Layout: most important info at the top, details below.
 *
 *   1. Headline (one sentence — the takeaway)
 *   2. Quick Take (3 bullets — what happened, what to do)
 *   3. Collaboration score + rating
 *   4. Next Steps (actionable checklist)
 *   5. --- separator ---
 *   6. Details: who, exchange, disclosure, objectives, trust
 */

const VIBE_LABELS = {
  productive: 'Productive call',
  exploratory: 'Exploratory — still feeling things out',
  mismatch: 'Friendly but not much overlap',
  guarded: 'Guarded — worth reviewing',
  breakthrough: 'Great connection — real momentum'
};

/**
 * Render a structured summary JSON object into human-readable markdown.
 *
 * @param {object} summary - The JSON output from the summary prompt
 * @returns {string} Formatted markdown
 */
function formatSummary(summary) {
  const lines = [];
  const s = summary;

  // ── Headline ──
  lines.push(`# Call with ${s.who?.name || 'Unknown'}`);
  lines.push('');
  lines.push(`**${s.headline}**`);
  lines.push('');

  // ── Vibe + Score one-liner ──
  const vibeLabel = VIBE_LABELS[s.vibe] || s.vibe;
  const scoreStr = s.collaboration?.score != null
    ? ` | Overlap: ${s.collaboration.score.toFixed(2)}/1.00`
    : '';
  lines.push(`*${vibeLabel}${scoreStr}* \`${s.vibe}\``);
  lines.push('');

  // ── Quick Take ──
  if (s.quickTake?.length) {
    lines.push('### Quick Take');
    for (const item of s.quickTake) {
      lines.push(`- ${item}`);
    }
    lines.push('');
  }

  // ── Collaboration ──
  if (s.collaboration) {
    const c = s.collaboration;
    lines.push(`### Collaboration: ${c.rating || 'N/A'}`);
    if (c.scoreJustification) {
      lines.push(c.scoreJustification);
    }
    if (c.opportunities?.length) {
      lines.push('');
      for (const opp of c.opportunities) {
        lines.push(`- ${opp}`);
      }
    }
    lines.push('');
  }

  // ── Next Steps ──
  if (s.nextSteps?.length) {
    lines.push('### Next Steps');
    for (const step of s.nextSteps) {
      lines.push(`- [ ] ${step}`);
    }
    lines.push('');
  }

  // ── Separator ──
  lines.push('---');
  lines.push('');

  // ── Details Section ──
  lines.push('### Details');
  lines.push('');

  // Who
  if (s.who) {
    lines.push(`**Who:** ${s.who.name || 'Unknown'}${s.who.represents ? ` — ${s.who.represents}` : ''}`);
    if (s.who.keyFacts?.length) {
      for (const fact of s.who.keyFacts) {
        lines.push(`- ${fact}`);
      }
    }
    lines.push('');
  }

  // Exchange
  if (s.exchange) {
    lines.push('**What We Exchanged**');
    if (s.exchange.weGot?.length) {
      lines.push(`- Got: ${s.exchange.weGot.join('; ')}`);
    }
    if (s.exchange.weGave?.length) {
      lines.push(`- Gave: ${s.exchange.weGave.join('; ')}`);
    }
    if (s.exchange.balance) {
      lines.push(`- Balance: ${s.exchange.balance}`);
    }
    lines.push('');
  }

  // Disclosure
  if (s.disclosure) {
    const d = s.disclosure;
    const complianceLabel = d.compliance === 'clean' ? 'Clean — no issues'
      : d.compliance === 'minor_concern' ? 'Minor concern — review below'
      : d.compliance === 'violation' ? 'VIOLATION — action required'
      : d.compliance;

    lines.push(`**Disclosure:** ${complianceLabel} \`${d.compliance}\``);
    if (d.topicsCovered?.length) {
      lines.push(`- Covered: ${d.topicsCovered.join(', ')}`);
    }
    if (d.topicsAvoided?.length) {
      lines.push(`- Properly avoided: ${d.topicsAvoided.join(', ')}`);
    }
    if (d.concerns?.length) {
      for (const concern of d.concerns) {
        lines.push(`- **Concern:** ${concern}`);
      }
    }
    lines.push('');
  }

  // Objectives
  if (s.objectives) {
    const o = s.objectives;
    const parts = [];
    if (o.achieved?.length) parts.push(`Achieved: ${o.achieved.join(', ')}`);
    if (o.partiallyAchieved?.length) parts.push(`In progress: ${o.partiallyAchieved.join(', ')}`);
    if (o.notAchieved?.length) parts.push(`Not addressed: ${o.notAchieved.join(', ')}`);
    if (parts.length) {
      lines.push('**Objectives**');
      for (const p of parts) lines.push(`- ${p}`);
      lines.push('');
    }
  }

  // Trust
  if (s.trust) {
    lines.push(`**Trust:** ${s.trust.level}${s.trust.reasoning ? ` — ${s.trust.reasoning}` : ''}`);
    lines.push('');
  }

  // Assessment
  if (s.assessment) {
    lines.push(`**Bottom line:** ${s.assessment}`);
  }

  return lines.join('\n');
}

module.exports = { formatSummary, VIBE_LABELS };
