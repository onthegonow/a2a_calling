/**
 * Disclosure Manifest System
 *
 * Manages a structured list of topics the owner wants to discuss
 * at each access tier. Stored as JSON at ~/.config/openclaw/a2a-disclosure.json.
 */

const fs = require('fs');
const path = require('path');
const { createLogger } = require('./logger');

const CONFIG_DIR = process.env.A2A_CONFIG_DIR ||
  process.env.OPENCLAW_CONFIG_DIR ||
  path.join(process.env.HOME || '/tmp', '.config', 'openclaw');

const MANIFEST_FILE = path.join(CONFIG_DIR, 'a2a-disclosure.json');

const TIER_HIERARCHY = ['public', 'friends', 'family'];
const logger = createLogger({ component: 'a2a.disclosure' });
const SKIP_FILES = new Set(['heartbeat', 'skill', 'claude']);

function normalizeTopic(raw) {
  return String(raw || '').trim();
}

function dedupeByTopic(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const topic = normalizeTopic(item && item.topic);
    if (!topic || seen.has(topic.toLowerCase())) continue;
    seen.add(topic.toLowerCase());
    out.push({
      topic,
      description: normalizeTopic(item && item.description)
    });
  }
  return out;
}

function dedupeByObjective(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const objective = normalizeTopic(item && item.objective);
    if (!objective || seen.has(objective.toLowerCase())) continue;
    seen.add(objective.toLowerCase());
    out.push({
      objective,
      description: normalizeTopic(item && item.description)
    });
  }
  return out;
}

function dedupeDoNotDiscuss(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const topic = normalizeTopic(item && item.topic);
    if (!topic || seen.has(topic.toLowerCase())) continue;
    seen.add(topic.toLowerCase());
    out.push({
      topic,
      reason: normalizeTopic(item && item.reason)
    });
  }
  return out;
}

function parseTopicLine(rawLine) {
  const line = normalizeTopic(rawLine);
  if (!line) return null;

  const splitPoint = line.search(/\s+[-–—:]\s+/);
  if (splitPoint > 10) {
    const topic = normalizeTopic(line.slice(0, splitPoint));
    const detail = normalizeTopic(line.slice(splitPoint + 3));
    return { topic, detail };
  }

  return { topic: line, detail: '' };
}

function isValidTopic(line) {
  if (!line || line.length < 5) return false;
  if (line.includes('`')) return false;
  if (line.includes('http')) return false;
  if (line.includes('**:')) return false;
  if (line.startsWith('//')) return false;
  if (line.includes('()')) return false;
  if (/\d{4}-\d{2}-\d{2}/.test(line)) return false;
  if (line.toLowerCase().includes('todo')) return false;
  if (line.toLowerCase().includes('fixme')) return false;
  return true;
}

function truncateAtWordBoundary(text, max = 60) {
  const normalized = normalizeTopic(text);
  if (normalized.length <= max) return normalized;

  const truncated = normalized.slice(0, max);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > 20 ? truncated.slice(0, lastSpace) : truncated) + '...';
}

/**
 * Load manifest from disk. Returns {} if not found.
 */
function loadManifest() {
  try {
    if (fs.existsSync(MANIFEST_FILE)) {
      return JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
    }
  } catch (e) {
    logger.error('Failed to load disclosure manifest', {
      event: 'disclosure_manifest_load_failed',
      error: e,
      error_code: 'DISCLOSURE_MANIFEST_LOAD_FAILED',
      hint: 'Fix invalid JSON or file permissions in a2a-disclosure.json.',
      data: {
        manifest_file: MANIFEST_FILE
      }
    });
  }
  return {};
}

/**
 * Save manifest to disk.
 */
function saveManifest(manifest) {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  manifest.updated_at = new Date().toISOString();
  const tmpPath = `${MANIFEST_FILE}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  fs.renameSync(tmpPath, MANIFEST_FILE);
  try {
    fs.chmodSync(MANIFEST_FILE, 0o600);
  } catch (err) {
    // Best effort - ignore on platforms without chmod support.
  }
}

/**
 * Get topics for a given tier, merged down the hierarchy.
 * family gets everything, friends gets friends+public, public gets public only.
 *
 * Returns { topics, objectives, do_not_discuss, never_disclose }
 */
function getTopicsForTier(tier) {
  const manifest = loadManifest();
  const tiers = manifest.tiers || {};

  const tierIndex = TIER_HIERARCHY.indexOf(tier);
  if (tierIndex === -1) {
    // Unknown tier, treat as public
    return getTopicsForTier('public');
  }

  // Merge tiers from public up to the requested tier
  const tiersToMerge = TIER_HIERARCHY.slice(0, tierIndex + 1);

  const merged = {
    topics: [],
    objectives: [],
    do_not_discuss: [],
    never_disclose: manifest.never_disclose || []
  };

  for (const t of tiersToMerge) {
    const tierData = tiers[t] || {};
    if (tierData.topics) merged.topics.push(...tierData.topics);
    if (tierData.objectives) merged.objectives.push(...tierData.objectives);
    if (tierData.do_not_discuss) merged.do_not_discuss.push(...tierData.do_not_discuss);
  }

  // Remove do_not_discuss items that appear in topics (higher tiers promote them)
  const promoted = new Set(merged.topics.map(t => (t.topic || '').toLowerCase()));
  merged.do_not_discuss = merged.do_not_discuss.filter(t => !promoted.has((t.topic || '').toLowerCase()));

  // Dedupe
  merged.topics = dedupeByTopic(merged.topics);
  merged.objectives = dedupeByObjective(merged.objectives);
  merged.do_not_discuss = dedupeDoNotDiscuss(merged.do_not_discuss);

  return merged;
}

/**
 * Format topic lists into readable bullet points for prompt injection.
 */
function formatTopicsForPrompt(tierTopics) {
  const formatTopicList = (items) => {
    if (!items || items.length === 0) return '  (none specified)';
    return items.map(item => `  - ${item.topic}: ${item.description || ''}`).join('\n');
  };

  const formatObjectiveList = (items) => {
    if (!items || items.length === 0) return '  (none specified)';
    return items.map(item => `  - ${item.objective}: ${item.description || ''}`).join('\n');
  };

  const formatDoNotDiscuss = (items) => {
    if (!items || items.length === 0) return '  (none specified)';
    return items.map(item => `  - ${item.topic}: ${item.reason || ''}`).join('\n');
  };

  return {
    topics: formatTopicList(tierTopics.topics),
    objectives: formatObjectiveList(tierTopics.objectives),
    doNotDiscuss: formatDoNotDiscuss(tierTopics.do_not_discuss),
    neverDisclose: tierTopics.never_disclose?.length
      ? tierTopics.never_disclose.map(item => `  - ${item}`).join('\n')
      : '  (none specified)'
  };
}

/**
 * Generate a minimal starter manifest. This provides safe defaults when
 * no agent-driven extraction has been performed yet.
 *
 * For proper topic extraction, use buildExtractionPrompt() to instruct
 * an agent, then validate the result with validateDisclosureSubmission().
 */
function generateDefaultManifest(contextFiles = {}) {
  const now = new Date().toISOString();
  const source = {};
  const raw = contextFiles || {};
  Object.keys(raw).forEach((key) => {
    if (!SKIP_FILES.has(key.toLowerCase())) {
      source[key] = raw[key];
    }
  });

  const userContent = String(source.user || '');
  const soulContent = String(source.soul || '');
  function extractFromSource(content, sectionNames) {
    const sectionPattern = new RegExp(
      `##\\s*(?:${sectionNames.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})[^\\n]*\\n([\\s\\S]*?)(?=\\n##|$)`,
      'i'
    );
    const match = String(content || '').match(sectionPattern);
    if (!match) {
      return [];
    }

    return String(match[1] || '')
      .split('\n')
      .map(line => normalizeTopic(line))
      .filter(line => line.startsWith('-') || line.startsWith('*'))
      .map(line => normalizeTopic(line.replace(/^[\s\-\*]+/, '')))
      .map(parseTopicLine)
      .filter(topic => topic && isValidTopic(topic.topic))
      .map(topic => ({
        topic: truncateAtWordBoundary(topic.topic, 60),
        detail: truncateAtWordBoundary(topic.detail || '', 120)
      }));
  }

  const candidateTopics = dedupeByTopic([
    ...extractFromSource(userContent, ['Goals', 'Interests', 'Projects', 'Current']),
    ...extractFromSource(soulContent, ['Goals', 'Interests', 'Projects', 'Current', 'Values', 'Personal'])
  ]);

  if (candidateTopics.length === 0) {
    return {
      version: 2,
      generated_at: now,
      updated_at: now,
      tiers: {
        public: {
          topics: [{ topic: 'What I do', description: 'Brief professional description' }],
          objectives: [{ objective: 'Networking', description: 'Connect with others in the field' }],
          do_not_discuss: [{ topic: 'Personal details', reason: 'Redirect to direct owner contact' }]
        },
        friends: { topics: [], objectives: [], do_not_discuss: [] },
        family: { topics: [], objectives: [], do_not_discuss: [] }
      },
      never_disclose: ['API keys', 'Other users\' data', 'Financial figures'],
      personality_notes: 'Direct and technical. Prefers depth over breadth.'
    };
  }

  const publicTopics = [];
  const publicObjectives = [];
  const friendsTopics = [];
  const friendsObjectives = [];
  const familyTopics = [];

  candidateTopics.forEach((entry, index) => {
    const topic = truncateAtWordBoundary(entry.topic || '', 160);
    const description = truncateAtWordBoundary(entry.description || entry.detail || 'Open discussion topic.', 500);
    if (!topic) return;

    const node = { topic, description };
    if (index < 5) {
      publicTopics.push(node);
      return;
    }
    if (index < 10) {
      friendsTopics.push(node);
      return;
    }
    familyTopics.push(node);
  });

  if (publicTopics.length === 0) {
    publicTopics.push({ topic: 'Open source', description: 'General product and engineering topics.' });
  }

  return {
    version: 2,
    generated_at: now,
    updated_at: now,
    tiers: {
      public: {
        topics: publicTopics,
        objectives: publicObjectives.length > 0 ? publicObjectives : [
          { objective: 'Grow network', description: 'Connect with others working on similar problems' }
        ],
        do_not_discuss: [{ topic: 'Personal details', reason: 'Redirect to direct owner contact' }]
      },
      friends: {
        topics: friendsTopics,
        objectives: friendsObjectives,
        do_not_discuss: []
      },
      family: {
        topics: familyTopics,
        objectives: [],
        do_not_discuss: []
      }
    },
    never_disclose: ['API keys', 'Other users\' data', 'Financial figures'],
    personality_notes: 'Direct and practical. Open to collaboration with clear boundaries.'
  };
}

/**
 * Check if a string contains technical content that shouldn't appear in
 * disclosure topics (code snippets, URLs, markdown formatting, camelCase identifiers).
 */
function isTechnicalContent(line) {
  return /`/.test(line) ||
    /https?:\/\//.test(line) ||
    /\*\*:/.test(line) ||
    /:\*\*/.test(line) ||
    /\b[a-z]{3,}[A-Z][a-z]{3,}/.test(line);
}

/**
 * Validate an agent-submitted disclosure submission against the expected schema.
 * Returns { valid: boolean, manifest: object|null, errors: string[] }.
 */
function validateDisclosureSubmission(data) {
  const errors = [];

  // Must be a non-null object
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { valid: false, manifest: null, errors: ['Submission must be a non-null object'] };
  }

  const tiersData = data.tiers;
  if (!tiersData || typeof tiersData !== 'object' || Array.isArray(tiersData)) {
    errors.push('Submission must include a "tiers" object');
    return { valid: false, manifest: null, errors };
  }

  // Require all three tiers
  for (const tier of TIER_HIERARCHY) {
    if (!tiersData[tier] || typeof tiersData[tier] !== 'object') {
      errors.push(`Missing required tier: "${tier}"`);
    }
  }
  if (errors.length > 0) {
    return { valid: false, manifest: null, errors };
  }

  // Reject extra tiers beyond the known hierarchy
  const extraTiers = Object.keys(tiersData).filter(t => !TIER_HIERARCHY.includes(t));
  if (extraTiers.length > 0) {
    errors.push(`Unknown tiers: ${extraTiers.join(', ')} — only public, friends, family are allowed`);
  }

  const LIST_LIMITS = { topics: 15, objectives: 8, do_not_discuss: 10 };

  for (const tier of TIER_HIERARCHY) {
    const tierData = tiersData[tier];

    // Validate topics array
    if (tierData.topics !== undefined) {
      if (!Array.isArray(tierData.topics)) {
        errors.push(`tiers.${tier}.topics must be an array`);
      } else {
        if (tierData.topics.length > LIST_LIMITS.topics) {
          errors.push(`tiers.${tier}.topics has ${tierData.topics.length} items — max ${LIST_LIMITS.topics}`);
        }
        for (let i = 0; i < tierData.topics.length; i++) {
          const item = tierData.topics[i];
          if (!item || typeof item !== 'object' || typeof item.topic !== 'string') {
            errors.push(`tiers.${tier}.topics[${i}]: must have "topic" (string) and "description" (string)`);
            continue;
          }
          if (item.topic.trim().length === 0) {
            errors.push(`tiers.${tier}.topics[${i}].topic must not be empty`);
          }
          if (item.topic.length > 160) {
            errors.push(`tiers.${tier}.topics[${i}]: topic exceeds 160 chars`);
          }
          const desc = item.description || '';
          if (desc.length > 500) {
            errors.push(`tiers.${tier}.topics[${i}]: description exceeds 500 chars`);
          }
        }
      }
    }

    // Validate objectives array
    if (tierData.objectives !== undefined) {
      if (!Array.isArray(tierData.objectives)) {
        errors.push(`tiers.${tier}.objectives must be an array`);
      } else {
        if (tierData.objectives.length > LIST_LIMITS.objectives) {
          errors.push(`tiers.${tier}.objectives has ${tierData.objectives.length} items — max ${LIST_LIMITS.objectives}`);
        }
        for (let i = 0; i < tierData.objectives.length; i++) {
          const item = tierData.objectives[i];
          if (!item || typeof item !== 'object' || typeof item.objective !== 'string') {
            errors.push(`tiers.${tier}.objectives[${i}]: must have "objective" (string) and "description" (string)`);
            continue;
          }
          if (item.objective.trim().length === 0) {
            errors.push(`tiers.${tier}.objectives[${i}].objective must not be empty`);
          }
        }
      }
    }

    // Validate do_not_discuss array
    if (tierData.do_not_discuss !== undefined) {
      if (!Array.isArray(tierData.do_not_discuss)) {
        errors.push(`tiers.${tier}.do_not_discuss must be an array`);
      } else {
        if (tierData.do_not_discuss.length > LIST_LIMITS.do_not_discuss) {
          errors.push(`tiers.${tier}.do_not_discuss has ${tierData.do_not_discuss.length} items — max ${LIST_LIMITS.do_not_discuss}`);
        }
        for (let i = 0; i < tierData.do_not_discuss.length; i++) {
          const item = tierData.do_not_discuss[i];
          if (!item || typeof item !== 'object' || typeof item.topic !== 'string') {
            errors.push(`tiers.${tier}.do_not_discuss[${i}]: must have "topic" (string) and "reason" (string)`);
          }
        }
      }
    }
  }

  // Validate never_disclose (optional, defaults to sensible list)
  if (data.never_disclose !== undefined) {
    if (!Array.isArray(data.never_disclose)) {
      errors.push('"never_disclose" must be an array of strings');
    } else {
      if (data.never_disclose.length > 20) {
        errors.push('never_disclose has too many items — max 20');
      }
      for (let i = 0; i < data.never_disclose.length; i++) {
        if (typeof data.never_disclose[i] !== 'string') {
          errors.push(`never_disclose[${i}] must be a string`);
        } else if (data.never_disclose[i].length > 200) {
          errors.push(`never_disclose[${i}] exceeds 200 chars`);
        }
      }
    }
  }

  // Validate personality_notes (optional)
  if (data.personality_notes !== undefined) {
    if (typeof data.personality_notes !== 'string') {
      errors.push('"personality_notes" must be a string');
    } else if (data.personality_notes.length > 500) {
      errors.push('"personality_notes" exceeds 500 chars');
    }
  }

  if (errors.length > 0) {
    return { valid: false, manifest: null, errors };
  }

  // Rebuild clean structure
  const now = new Date().toISOString();

  // Build clean manifest with new format only
  const cleanTiers = {};
  for (const tier of TIER_HIERARCHY) {
    cleanTiers[tier] = {
      topics: (tiersData[tier].topics || []).map(item => ({
        topic: item.topic,
        description: item.description || ''
      })),
      objectives: (tiersData[tier].objectives || []).map(item => ({
        objective: item.objective,
        description: item.description || ''
      })),
      do_not_discuss: (tiersData[tier].do_not_discuss || []).map(item => ({
        topic: item.topic,
        reason: item.reason || ''
      }))
    };
  }

  const manifest = {
    version: 2,
    generated_at: now,
    updated_at: now,
    tiers: cleanTiers,
    never_disclose: data.never_disclose || ['API keys', 'Other users\' data', 'Financial figures'],
    personality_notes: data.personality_notes || ''
  };

  return { valid: true, manifest, errors: [] };
}

/**
 * Read context files from an OpenClaw workspace directory.
 * Returns { user, heartbeat, soul, skill, claude, memory, skills } with file contents or empty strings.
 */
function readContextFiles(workspaceDir) {
  const read = (filename) => {
    try {
      const filePath = path.join(workspaceDir, filename);
      if (fs.existsSync(filePath)) {
        return fs.readFileSync(filePath, 'utf8');
      }
    } catch (e) {}
    return '';
  };

  // Read primary files
  const result = {
    user: read('USER.md'),
    heartbeat: read('HEARTBEAT.md'),
    soul: read('SOUL.md'),
    skill: read('SKILL.md'),
    claude: read('CLAUDE.md'),
    skills: ''
  };

  // Scan memory/*.md
  const memoryDir = path.join(workspaceDir, 'memory');
  result.memory = '';
  if (fs.existsSync(memoryDir)) {
    try {
      const files = fs.readdirSync(memoryDir).filter(f => f.endsWith('.md'));
      result.memory = files.map(f => {
        try { return fs.readFileSync(path.join(memoryDir, f), 'utf8'); }
        catch (e) { return ''; }
      }).filter(Boolean).join('\n---\n');
    } catch (e) {}
  }

  return result;
}

/**
 * Generate the extraction prompt that instructs an agent on exactly what
 * structured disclosure data to return.
 *
 * @param {Object} [availableFiles] - Map of filename to truthy if present
 * @returns {string} The instruction prompt for the agent
 */
function buildExtractionPrompt(availableFiles) {
  let fileSection;
  if (availableFiles && Object.keys(availableFiles).length > 0) {
    const fileList = Object.entries(availableFiles)
      .filter(([, present]) => present)
      .map(([name]) => `  - ${name}`)
      .join('\n') || '  (none detected)';
    fileSection = `### Available workspace files\n${fileList}\n\nRead the available files above and extract disclosure topics.`;
  } else {
    fileSection = `### Context sources to scan

**Primary sources (workspace files):**
  - USER.md — owner identity, bio, interests
  - SOUL.md — values, personality, communication style
  - memory/*.md — may contain relevant context
  - Skip HEARTBEAT.md, SKILL.md, CLAUDE.md (agent instructions, not owner info)

**If workspace files are missing or empty, scan these additional sources:**
  - ~/.gitconfig — name, email, identity hints
  - Environment: whoami, hostname, $USER, $HOME
  - ~/.config/ — installed tools hint at owner's work
  - ~/.ssh/config — project/server names may reveal domains
  - Any README.md files in common locations
  - Shell history patterns (languages, tools used)
  - Installed CLIs (what's in PATH)

**Inference from system state:**
  - Programming languages installed → likely a developer
  - Cloud CLIs (aws, gcloud, az) → infrastructure/devops
  - Design tools → creative work
  - Data tools (jupyter, pandas) → data science
  - Server hostname → may indicate role or project

Use ALL available context to build a reasonable disclosure profile. If truly nothing exists, create a minimal placeholder with "New agent setup - owner details pending" and suggest what info the owner should provide.`;
  }

  const jsonBlock = `\`\`\`json
{
  "owner_name": "The human owner's real name (extracted from USER.md, git config, etc.)",
  "agent_name": "The agent's display name (extracted from USER.md or workspace context)",
  "tiers": {
    "public": {
      "topics": [
        { "topic": "Short label (max 160 chars)", "description": "Longer description of the topic" }
      ],
      "objectives": [
        { "objective": "What you want to achieve", "description": "Longer description of this goal" }
      ],
      "do_not_discuss": [
        { "topic": "Topic to avoid", "reason": "Why this should be redirected" }
      ]
    },
    "friends": {
      "topics": [],
      "objectives": [],
      "do_not_discuss": []
    },
    "family": {
      "topics": [],
      "objectives": [],
      "do_not_discuss": []
    }
  },
  "never_disclose": ["API keys", "Credentials", "Financial figures"],
  "personality_notes": "Brief description of communication style"
}
\`\`\``;

  return `## A2A Disclosure Extraction

You are helping the owner set up their A2A disclosure profile — the topics and information their agent is willing to discuss with other agents at different trust levels.

${fileSection}

Focus on what the OWNER cares about, works on, and wants to discuss — NOT on agent instructions, code documentation, or operational tasks.

### Tier Inheritance

- **public** — base tier, anyone can see these
- **friends** — inherits all PUBLIC topics/objectives, plus additional friend-only items
- **family** — inherits all FRIENDS and PUBLIC items, plus additional family-only items

Family callers see everything. Friends see friends + public. Public callers see only public.

### What to extract for each tier

**topics** — Things the owner is interested in or working on:
- Professional role and expertise
- Current projects and interests
- Hobbies and activities
- Max 8 topics per tier

**objectives** — What the owner wants to achieve in conversations:
- Networking goals
- Collaboration interests
- Opportunities they're seeking
- Max 4 objectives per tier

**do_not_discuss** — Topics to redirect or decline (can be empty):
- Personal matters (for public tier)
- Sensitive subjects
- Max 3 per tier

Also identify:
- **never_disclose** — information that should NEVER be shared regardless of tier (API keys, credentials, financial data, etc.)
- **personality_notes** — a 1-2 sentence description of the owner's communication style

### What NOT to extract

Do NOT include as topics:
- Code snippets, CLI commands, or technical documentation
- URLs or file paths
- Agent instructions or operational tasks (e.g., "post 50 comments/day")
- Markdown formatting artifacts (bold markers, backticks)
- Anything from HEARTBEAT.md (these are agent tasks, not disclosure topics)

### Required JSON format

Return ONLY valid JSON in this exact structure:

${jsonBlock}

### Rules

1. Each "topic" string must be a short, human-readable label (max 160 chars)
2. Each "description" string explains the topic more fully (max 500 chars)
3. Topics should be things a person would discuss, not technical artifacts
4. Higher tiers inherit lower-tier items automatically — only add NEW items at each tier
5. Present this to the owner for review before submitting
6. The owner may edit, remove, or add items before final submission`;
}

module.exports = {
  loadManifest,
  saveManifest,
  getTopicsForTier,
  formatTopicsForPrompt,
  generateDefaultManifest,
  readContextFiles,
  validateDisclosureSubmission,
  isTechnicalContent,
  buildExtractionPrompt,
  MANIFEST_FILE
};
