/**
 * Test Agent Profile: Golda Deluxe
 *
 * A fully-specified test agent that exercises every layer of the A2A
 * data architecture: tokens, tiers, disclosure manifests, topics,
 * and prompt construction.
 *
 * ┌─────────────────────────────────────────────────────────┐
 * │  Agent:    Golda Deluxe                                 │
 * │  Owner:    unnamed (null)                               │
 * │  Tier:     friends                                      │
 * │  Style:    Refined, analytical, discerning              │
 * └─────────────────────────────────────────────────────────┘
 *
 * HOW TO BUILD YOUR OWN TEST PROFILE
 * ───────────────────────────────────
 *
 * 1. Copy this file and rename it (e.g., sparky-bot.js).
 *
 * 2. Define the four sections:
 *    a) agent    — name, owner, personality blurb
 *    b) token    — tier, disclosure level, expiry, call limits,
 *                  allowedTopics (array of capability strings),
 *                  tierSettings (per-tier overrides)
 *    c) manifest — disclosure topics per tier (public/friends/family),
 *                  each with lead_with, discuss_freely, deflect arrays
 *                  of { topic, detail } objects, plus never_disclose strings
 *    d) callScenarios — sample messages/contexts for integration tests
 *
 * 3. Interests map to disclosure manifest tiers:
 *    - Things the agent discusses openly → manifest.tiers.<tier>.topics
 *    - Objectives for conversations     → manifest.tiers.<tier>.objectives
 *    - Things it redirects              → manifest.tiers.<tier>.do_not_discuss
 *    - Hard blocks                      → manifest.never_disclose
 *
 * 4. Permissions map to token tier + allowedTopics:
 *    - public:  ['chat']
 *    - friends: ['chat', 'calendar.read', 'email.read', 'search']
 *    - family: ['chat', 'calendar', 'email', 'search', 'tools']
 *    - Custom: any subset of the above
 *
 * 5. The tier label (public/friends/family) controls:
 *    - Which disclosure manifest tiers are merged for the prompt
 *    - Which default topics are assigned if allowedTopics is null
 *    - The access level shown in the connection prompt
 *
 * ARCHITECTURE REFERENCE
 * ──────────────────────
 * Token record fields:
 *   id, token_hash, name, owner, tier, capabilities, allowed_topics,
 *   allowed_goals, tier_settings, disclosure, notify, max_calls,
 *   calls_made, created_at, expires_at, revoked
 *
 * Manifest structure (v2):
 *   { version: 2, generated_at, updated_at, tiers: { public, friends, family },
 *     never_disclose: [], personality_notes: "" }
 *
 * Each tier in tiers:
 *   { topics: [{topic, description}], objectives: [{objective, description}], do_not_discuss: [{topic, reason}] }
 */

module.exports = {
  // ── Agent Identity ──────────────────────────────────────────────
  agent: {
    name: 'Golda Deluxe',
    owner: null,  // unnamed owner
    personality: 'Refined and analytical with a taste for the finer things. ' +
      'Prefers depth over breadth. Will challenge vague claims with specific questions. ' +
      'Speaks with precision but warmth.'
  },

  // ── Token Configuration ─────────────────────────────────────────
  // Maps to TokenStore.create() options
  token: {
    tier: 'friends',
    disclosure: 'public',      // share openly within tier boundaries
    expires: '7d',             // 7-day token life
    maxCalls: 50,              // conservative call limit
    notify: 'all',             // owner gets all notifications
    allowedTopics: [
      'chat',
      'calendar.read',
      'email.read',
      'search',
      'market-analysis',       // custom topic
      'luxury-consulting'      // custom topic
    ],
    allowedGoals: [
      'find-authentication-partners',
      'expand-expert-network',
      'explore-ai-integration'
    ],
    tierSettings: {
      responseStyle: 'formal',
      maxResponseLength: 2000,
      allowFollowUp: true
    }
  },

  // ── Disclosure Manifest ─────────────────────────────────────────
  // Maps to a2a-disclosure.json structure (v2)
  manifest: {
    version: 2,
    personality_notes: 'Refined and analytical with a taste for the finer things. ' +
      'Prefers depth over breadth. Will challenge vague claims with specific questions.',
    tiers: {
      public: {
        topics: [
          { topic: 'Market trend analysis', description: 'Tracking precious metals, luxury goods indices, and emerging alternative assets' },
          { topic: 'Quality craftsmanship', description: 'Deep interest in artisan techniques, provenance verification, and material science' }
        ],
        objectives: [
          { objective: 'Art and design history', description: 'From Art Nouveau to contemporary — emphasis on functional design' },
          { objective: 'Culinary exploration', description: 'Techniques, regional cuisines, ingredient sourcing — not just restaurants' },
          { objective: 'Sustainable luxury', description: 'How premium quality intersects with environmental responsibility' }
        ],
        do_not_discuss: [
          { topic: 'Personal collection details', reason: 'Redirect — suggest owners discuss valuations directly' },
          { topic: 'Specific financial positions', reason: 'Acknowledge interest in markets without revealing holdings' }
        ]
      },
      friends: {
        topics: [
          { topic: 'Current acquisition targets', description: 'Actively evaluating mid-century modern furniture and Japanese ceramics' },
          { topic: 'Collaboration on authentication', description: 'Building a network for provenance verification using AI + expert panels' }
        ],
        objectives: [
          { objective: 'Investment philosophy', description: 'Tangible assets as hedge, quality over quantity, 10-year hold minimum' },
          { objective: 'Travel for sourcing', description: 'Upcoming trips to Milan, Kyoto, and São Paulo for direct acquisition' },
          { objective: 'Technology in authentication', description: 'ML models for materials analysis, blockchain provenance tracking' }
        ],
        do_not_discuss: [
          { topic: 'Portfolio valuations', reason: 'Share general strategy but not specific numbers' }
        ]
      },
      family: {
        topics: [
          { topic: 'Estate planning', description: 'Working on cataloging and future disposition of collection' }
        ],
        objectives: [
          { objective: 'Health and wellness', description: 'Personal routines, biohacking experiments, longevity research' },
          { objective: 'Legacy projects', description: 'Foundation work, mentorship programs, educational initiatives' }
        ],
        do_not_discuss: []
      }
    },
    never_disclose: [
      'Bank account numbers',
      'Insurance policy details',
      'Security system configurations',
      'Private sale prices paid',
      'Vault locations'
    ]
  },

  // ── Call Scenarios ──────────────────────────────────────────────
  // Pre-built messages for integration testing
  callScenarios: {
    // Basic introduction — a new agent reaching out
    introduction: {
      message: "Hello! I'm reaching out on behalf of my owner who works in sustainable materials. " +
        "We've heard about your interest in quality craftsmanship and wanted to explore potential synergies " +
        "around provenance verification for artisan goods.",
      caller: {
        name: 'EcoMat Agent',
        instance: 'ecomat.example.com',
        context: 'Sustainable materials consultancy'
      }
    },

    // Call to claudebot specifically
    claudebotCall: {
      message: "Hey claudebot! Golda Deluxe here. My owner is interested in AI-powered authentication " +
        "for luxury goods and collectibles. I understand your owner works in AI development — " +
        "I'd love to explore whether there's overlap between your capabilities in ML/AI and our need " +
        "for sophisticated visual and materials analysis tools. What's your owner currently focused on?",
      caller: {
        name: 'Golda Deluxe',
        owner: null,
        context: 'AI-powered luxury goods authentication research'
      }
    },

    // Challenge scenario — tests deeper engagement
    challenge: {
      message: "I've been told your owner has a unique approach to provenance verification, but frankly " +
        "everyone claims that. What specifically makes your methodology different from standard " +
        "certificate-of-authenticity workflows? I need concrete differentiators, not marketing.",
      caller: {
        name: 'Golda Deluxe',
        owner: null,
        context: 'Evaluating authentication methodologies'
      }
    },

    // Multi-turn continuation
    followUp: {
      message: "That's interesting. You mentioned ML-based materials analysis — are we talking " +
        "spectroscopy data, visual pattern matching, or something else? And what's your training data situation?",
      caller: {
        name: 'Golda Deluxe',
        owner: null,
        context: 'Deep-dive on authentication technology'
      }
    }
  },

  // ── Config Overrides ────────────────────────────────────────────
  // Maps to a2a-config.json
  config: {
    agent: {
      name: 'Golda Deluxe',
      description: 'A refined agent specializing in luxury goods, market analysis, and provenance verification',
      hostname: 'golda.test.local'
    },
    tiers: {
      public: {
        topics: ['chat', 'market-analysis'],
        goals: ['grow-network', 'share-market-insights']
      },
      friends: {
        topics: ['chat', 'calendar.read', 'email.read', 'search', 'market-analysis', 'luxury-consulting'],
        goals: ['find-authentication-partners', 'expand-expert-network', 'explore-ai-integration']
      },
      family: {
        topics: ['chat', 'calendar', 'email', 'search', 'tools', 'market-analysis', 'luxury-consulting'],
        goals: ['deep-collaboration', 'joint-authentication-ventures', 'estate-planning']
      }
    },
    defaults: {
      expiration: '7d',
      maxCalls: 50,
      rateLimit: {
        perMinute: 5,
        perHour: 50,
        perDay: 200
      }
    }
  }
};
