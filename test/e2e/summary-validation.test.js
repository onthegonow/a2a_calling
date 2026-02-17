/**
 * Summary Validation Test — Task 14
 *
 * Validates that the unified summary prompt builder and formatter
 * work correctly for all 4 test profiles, covering:
 *   - Prompt generation from callScenarios
 *   - never_disclose items appear in every prompt
 *   - JSON output schema validation
 *   - Formatter renders without errors for all vibe types
 *
 * Profiles under test:
 *   golda-deluxe   — friends tier, public disclosure   (manifest v2)
 *   nyx-meridian   — public tier,  minimal disclosure  (manifest v1)
 *   bramble-voss   — friends tier, public disclosure   (manifest v1)
 *   cass-delacroix  — family tier,  none disclosure    (manifest v2)
 */

module.exports = function (test, assert, helpers, ctx) {
  const { buildUnifiedSummaryPrompt } = require('../../src/lib/summary-prompt');
  const { formatSummary, VIBE_LABELS } = require('../../src/lib/summary-formatter');

  // ── Profile Definitions ────────────────────────────────────────────
  const profiles = [
    { name: 'golda-deluxe', profile: require('../profiles/golda-deluxe'), tier: 'friends' },
    { name: 'nyx-meridian', profile: require('../profiles/nyx-meridian'), tier: 'public' },
    { name: 'bramble-voss', profile: require('../profiles/bramble-voss'), tier: 'friends' },
    { name: 'cass-delacroix', profile: require('../profiles/cass-delacroix'), tier: 'family' }
  ];

  // ── Schema Validator ───────────────────────────────────────────────

  /**
   * Validate a summary JSON object against the expected schema.
   *
   * @param {object} summary - The summary JSON to validate
   * @returns {{ valid: boolean, errors: string[] }}
   */
  function validateSummarySchema(summary) {
    const errors = [];

    // Required top-level keys
    const requiredKeys = [
      'headline', 'vibe', 'quickTake', 'who', 'collaboration',
      'exchange', 'disclosure', 'objectives', 'nextSteps', 'trust', 'assessment'
    ];
    for (const key of requiredKeys) {
      if (!(key in summary)) {
        errors.push(`Missing required key: "${key}"`);
      }
    }

    // vibe enum
    const validVibes = ['productive', 'exploratory', 'mismatch', 'guarded', 'breakthrough'];
    if (summary.vibe && !validVibes.includes(summary.vibe)) {
      errors.push(`Invalid vibe: "${summary.vibe}" — must be one of: ${validVibes.join(', ')}`);
    }

    // collaboration.rating enum
    const validRatings = ['HIGH', 'MEDIUM', 'LOW'];
    if (summary.collaboration && summary.collaboration.rating && !validRatings.includes(summary.collaboration.rating)) {
      errors.push(`Invalid collaboration.rating: "${summary.collaboration.rating}" — must be one of: ${validRatings.join(', ')}`);
    }

    // disclosure.compliance enum
    const validCompliance = ['clean', 'minor_concern', 'violation'];
    if (summary.disclosure && summary.disclosure.compliance && !validCompliance.includes(summary.disclosure.compliance)) {
      errors.push(`Invalid disclosure.compliance: "${summary.disclosure.compliance}" — must be one of: ${validCompliance.join(', ')}`);
    }

    // trust.level enum
    const validTrust = ['maintain', 'increase', 'decrease', 'revoke'];
    if (summary.trust && summary.trust.level && !validTrust.includes(summary.trust.level)) {
      errors.push(`Invalid trust.level: "${summary.trust.level}" — must be one of: ${validTrust.join(', ')}`);
    }

    // exchange.balance enum
    const validBalance = ['favorable', 'even', 'unfavorable'];
    if (summary.exchange && summary.exchange.balance && !validBalance.includes(summary.exchange.balance)) {
      errors.push(`Invalid exchange.balance: "${summary.exchange.balance}" — must be one of: ${validBalance.join(', ')}`);
    }

    // quickTake must be array of exactly 3 items
    if (summary.quickTake) {
      if (!Array.isArray(summary.quickTake)) {
        errors.push('quickTake must be an array');
      } else if (summary.quickTake.length !== 3) {
        errors.push(`quickTake must have exactly 3 items, got ${summary.quickTake.length}`);
      }
    }

    // nextSteps must be array with at least 1 item
    if (summary.nextSteps) {
      if (!Array.isArray(summary.nextSteps)) {
        errors.push('nextSteps must be an array');
      } else if (summary.nextSteps.length < 1) {
        errors.push('nextSteps must have at least 1 item');
      }
    }

    // who must have name and represents
    if (summary.who) {
      if (!summary.who.name) {
        errors.push('who.name is required');
      }
      if (!summary.who.represents) {
        errors.push('who.represents is required');
      }
    }

    return { valid: errors.length === 0, errors };
  }

  // ── Helpers ────────────────────────────────────────────────────────

  /**
   * Build a disclosure object from a profile's manifest for the given tier.
   * Handles both manifest v1 (topics.{tier}.lead_with/discuss_freely/deflect)
   * and v2 (tiers.{tier}.topics/objectives/do_not_discuss).
   */
  function buildDisclosure(manifest, tier) {
    const neverDisclose = manifest.never_disclose || [];

    // v2 format: manifest.tiers
    if (manifest.tiers && manifest.tiers[tier] && manifest.tiers[tier].topics) {
      const tierData = manifest.tiers[tier];
      return {
        topics: tierData.topics || [],
        objectives: tierData.objectives || [],
        doNotDiscuss: tierData.do_not_discuss || [],
        neverDisclose
      };
    }

    // v1 format: manifest.topics
    if (manifest.topics && manifest.topics[tier]) {
      const tierData = manifest.topics[tier];
      // Map lead_with + discuss_freely -> topics with {topic, description}
      const topics = [
        ...(tierData.lead_with || []).map(t => ({ topic: t.topic, description: t.detail })),
        ...(tierData.discuss_freely || []).map(t => ({ topic: t.topic, description: t.detail }))
      ];
      // Map deflect -> doNotDiscuss with {topic, reason}
      const doNotDiscuss = (tierData.deflect || []).map(t => ({ topic: t.topic, reason: t.detail }));
      return {
        topics,
        objectives: [],
        doNotDiscuss,
        neverDisclose
      };
    }

    // Fallback
    return {
      topics: [],
      objectives: [],
      doNotDiscuss: [],
      neverDisclose
    };
  }

  /**
   * Get the first call scenario from a profile.
   */
  function getFirstScenario(profile) {
    const keys = Object.keys(profile.callScenarios);
    return profile.callScenarios[keys[0]];
  }

  /**
   * Build a mock transcript from a call scenario.
   */
  function buildMockTranscript(scenario) {
    return [
      { direction: 'inbound', content: scenario.message },
      { direction: 'outbound', content: 'Thanks for reaching out! I appreciate the introduction.' }
    ];
  }

  /**
   * Build a valid mock summary JSON for a given profile.
   */
  function buildMockSummary(profileDef) {
    const profile = profileDef.profile;
    const scenario = getFirstScenario(profile);
    const callerName = scenario.caller.name;
    const callerOwner = scenario.caller.owner || scenario.caller.context || 'Independent';

    return {
      headline: `Initial introduction call with ${callerName} exploring collaboration potential.`,
      vibe: 'exploratory',
      quickTake: [
        `${callerName} reached out to explore mutual interests`,
        'Potential collaboration areas identified but need further discussion',
        'Schedule a follow-up call to dive deeper into specifics'
      ],
      who: {
        name: callerName,
        represents: callerOwner,
        keyFacts: [
          `Represents ${callerOwner}`,
          'Interested in exploring collaboration'
        ]
      },
      collaboration: {
        score: 0.45,
        scoreJustification: 'Moderate overlap identified during initial exploration',
        rating: 'MEDIUM',
        opportunities: ['Explore shared interests in more depth']
      },
      exchange: {
        weGot: ['Introduction and context about their work'],
        weGave: ['Brief acknowledgment of interest'],
        balance: 'even'
      },
      disclosure: {
        compliance: 'clean',
        topicsCovered: ['General introduction'],
        topicsAvoided: [],
        concerns: []
      },
      objectives: {
        achieved: ['Establish initial contact'],
        partiallyAchieved: ['Explore collaboration potential'],
        notAchieved: ['Define specific next steps']
      },
      nextSteps: [
        'Schedule follow-up call to discuss specifics',
        'Review shared interests before next conversation'
      ],
      trust: {
        level: 'maintain',
        reasoning: 'Positive first interaction, standard trust level appropriate'
      },
      assessment: `Promising initial contact with ${callerName} — worth pursuing further.`
    };
  }

  // ══════════════════════════════════════════════════════════════════
  // TESTS
  // ══════════════════════════════════════════════════════════════════

  // ── 1. Prompt generation for each profile ──────────────────────────

  for (const profileDef of profiles) {
    test(`[${profileDef.name}] builds valid prompt from first callScenario`, () => {
      const profile = profileDef.profile;
      const scenario = getFirstScenario(profile);
      const transcript = buildMockTranscript(scenario);
      const disclosure = buildDisclosure(profile.manifest, profileDef.tier);

      const prompt = buildUnifiedSummaryPrompt({
        transcript,
        callerInfo: scenario.caller,
        conversationObjective: 'Explore collaboration potential',
        disclosure,
        collaborationState: {
          phase: 'exploring',
          overlapScore: 0.45,
          turnCount: 2,
          activeThreads: ['introduction'],
          candidateCollaborations: [],
          closeSignal: false
        },
        ownerContext: {
          agentName: profile.agent.name,
          ownerName: profile.agent.owner || undefined,
          goals: profile.token.allowedGoals || []
        }
      });

      assert.ok(prompt, 'Prompt should be non-empty');
      assert.type(prompt, 'string', 'Prompt should be a string');
      assert.ok(prompt.length > 100, `Prompt should be substantial (got ${prompt.length} chars)`);

      // Should contain the caller name
      assert.includes(prompt, scenario.caller.name, 'Prompt should include caller name');

      // Should contain the transcript content
      assert.includes(prompt, scenario.message.substring(0, 50), 'Prompt should include inbound message');
      assert.includes(prompt, 'Thanks for reaching out', 'Prompt should include outbound message');

      // Should contain JSON schema instructions
      assert.includes(prompt, '"headline"', 'Prompt should contain JSON schema with headline field');
      assert.includes(prompt, '"vibe"', 'Prompt should contain JSON schema with vibe field');

      // Should contain owner context if agent has a name
      assert.includes(prompt, profile.agent.name, 'Prompt should include the agent name');
    });
  }

  // ── 2. never_disclose items in prompt for each profile ─────────────

  for (const profileDef of profiles) {
    test(`[${profileDef.name}] prompt includes all never_disclose items`, () => {
      const profile = profileDef.profile;
      const scenario = getFirstScenario(profile);
      const transcript = buildMockTranscript(scenario);
      const disclosure = buildDisclosure(profile.manifest, profileDef.tier);

      const prompt = buildUnifiedSummaryPrompt({
        transcript,
        callerInfo: scenario.caller,
        disclosure
      });

      const neverDisclose = profile.manifest.never_disclose || [];
      assert.ok(neverDisclose.length > 0, `${profileDef.name} should have never_disclose items`);

      for (const item of neverDisclose) {
        assert.includes(prompt, item, `Prompt should include never_disclose item: "${item}"`);
      }
    });
  }

  // ── 3. JSON schema validation — valid summary ──────────────────────

  test('validateSummarySchema accepts a valid summary', () => {
    const mockSummary = buildMockSummary(profiles[0]);
    const result = validateSummarySchema(mockSummary);
    assert.ok(result.valid, `Valid summary should pass validation, but got errors: ${result.errors.join('; ')}`);
    assert.equal(result.errors.length, 0, 'Should have zero errors');
  });

  // ── 4. JSON schema validation — missing required keys ──────────────

  test('validateSummarySchema catches missing required keys', () => {
    const incomplete = {
      headline: 'Test',
      vibe: 'productive'
      // Missing: quickTake, who, collaboration, exchange, disclosure, objectives, nextSteps, trust, assessment
    };
    const result = validateSummarySchema(incomplete);
    assert.ok(!result.valid, 'Incomplete summary should fail validation');
    assert.greaterThan(result.errors.length, 0, 'Should have errors');
    assert.ok(
      result.errors.some(e => e.includes('quickTake')),
      'Should flag missing quickTake'
    );
    assert.ok(
      result.errors.some(e => e.includes('trust')),
      'Should flag missing trust'
    );
    assert.ok(
      result.errors.some(e => e.includes('assessment')),
      'Should flag missing assessment'
    );
  });

  // ── 5. JSON schema validation — invalid enum values ────────────────

  test('validateSummarySchema catches invalid vibe value', () => {
    const mockSummary = buildMockSummary(profiles[0]);
    mockSummary.vibe = 'confused';
    const result = validateSummarySchema(mockSummary);
    assert.ok(!result.valid, 'Invalid vibe should fail');
    assert.ok(result.errors.some(e => e.includes('vibe')), 'Should flag invalid vibe');
  });

  test('validateSummarySchema catches invalid collaboration.rating', () => {
    const mockSummary = buildMockSummary(profiles[0]);
    mockSummary.collaboration.rating = 'SUPER_HIGH';
    const result = validateSummarySchema(mockSummary);
    assert.ok(!result.valid, 'Invalid collaboration.rating should fail');
    assert.ok(result.errors.some(e => e.includes('collaboration.rating')), 'Should flag invalid rating');
  });

  test('validateSummarySchema catches invalid disclosure.compliance', () => {
    const mockSummary = buildMockSummary(profiles[0]);
    mockSummary.disclosure.compliance = 'maybe';
    const result = validateSummarySchema(mockSummary);
    assert.ok(!result.valid, 'Invalid disclosure.compliance should fail');
    assert.ok(result.errors.some(e => e.includes('disclosure.compliance')), 'Should flag invalid compliance');
  });

  test('validateSummarySchema catches invalid trust.level', () => {
    const mockSummary = buildMockSummary(profiles[0]);
    mockSummary.trust.level = 'obliterate';
    const result = validateSummarySchema(mockSummary);
    assert.ok(!result.valid, 'Invalid trust.level should fail');
    assert.ok(result.errors.some(e => e.includes('trust.level')), 'Should flag invalid trust level');
  });

  test('validateSummarySchema catches invalid exchange.balance', () => {
    const mockSummary = buildMockSummary(profiles[0]);
    mockSummary.exchange.balance = 'terrible';
    const result = validateSummarySchema(mockSummary);
    assert.ok(!result.valid, 'Invalid exchange.balance should fail');
    assert.ok(result.errors.some(e => e.includes('exchange.balance')), 'Should flag invalid balance');
  });

  // ── 6. JSON schema validation — quickTake wrong count ──────────────

  test('validateSummarySchema catches quickTake with wrong item count', () => {
    const mockSummary = buildMockSummary(profiles[0]);
    mockSummary.quickTake = ['Only one item'];
    const result = validateSummarySchema(mockSummary);
    assert.ok(!result.valid, 'quickTake with 1 item should fail');
    assert.ok(result.errors.some(e => e.includes('quickTake') && e.includes('3')), 'Should flag wrong quickTake count');
  });

  // ── 7. JSON schema validation — empty nextSteps ────────────────────

  test('validateSummarySchema catches empty nextSteps', () => {
    const mockSummary = buildMockSummary(profiles[0]);
    mockSummary.nextSteps = [];
    const result = validateSummarySchema(mockSummary);
    assert.ok(!result.valid, 'Empty nextSteps should fail');
    assert.ok(result.errors.some(e => e.includes('nextSteps')), 'Should flag empty nextSteps');
  });

  // ── 8. JSON schema validation — missing who.name and who.represents ─

  test('validateSummarySchema catches missing who.name and who.represents', () => {
    const mockSummary = buildMockSummary(profiles[0]);
    mockSummary.who = { keyFacts: ['something'] };
    const result = validateSummarySchema(mockSummary);
    assert.ok(!result.valid, 'Missing who.name should fail');
    assert.ok(result.errors.some(e => e.includes('who.name')), 'Should flag missing who.name');
    assert.ok(result.errors.some(e => e.includes('who.represents')), 'Should flag missing who.represents');
  });

  // ── 9. Formatter renders all vibe types ────────────────────────────

  test('formatSummary renders correctly for all vibe types', () => {
    const vibeKeys = Object.keys(VIBE_LABELS);
    assert.ok(vibeKeys.length >= 5, `VIBE_LABELS should have at least 5 entries, got ${vibeKeys.length}`);

    for (const vibe of vibeKeys) {
      const mockSummary = buildMockSummary(profiles[0]);
      mockSummary.vibe = vibe;

      const rendered = formatSummary(mockSummary);
      assert.ok(rendered, `formatSummary should return non-empty for vibe "${vibe}"`);
      assert.type(rendered, 'string', `formatSummary should return string for vibe "${vibe}"`);
      assert.includes(rendered, VIBE_LABELS[vibe], `Rendered output should contain vibe label "${VIBE_LABELS[vibe]}" for "${vibe}"`);
    }
  });

  // ── 10. Formatter renders each profile's summary without errors ────

  for (const profileDef of profiles) {
    test(`[${profileDef.name}] formatSummary renders mock summary without errors`, () => {
      const mockSummary = buildMockSummary(profileDef);

      const rendered = formatSummary(mockSummary);

      // Non-empty string
      assert.ok(rendered, 'Rendered output should be non-empty');
      assert.type(rendered, 'string', 'Rendered output should be a string');

      // Contains markdown heading
      assert.includes(rendered, '# Call with', 'Rendered output should contain markdown heading');

      // Contains the headline
      assert.includes(rendered, mockSummary.headline, 'Rendered output should contain the headline');

      // Contains the caller name from the mock
      assert.includes(rendered, mockSummary.who.name, 'Rendered output should contain caller name');

      // Contains collaboration section
      assert.includes(rendered, 'Collaboration', 'Rendered output should contain Collaboration section');

      // Contains next steps
      assert.includes(rendered, 'Next Steps', 'Rendered output should contain Next Steps section');

      // Contains trust info
      assert.includes(rendered, 'Trust', 'Rendered output should contain Trust section');
    });
  }

  // ── 11. All 4 profiles produce valid prompts with correct disclosure ─

  test('all 4 profiles produce prompts with disclosure boundaries section', () => {
    for (const profileDef of profiles) {
      const profile = profileDef.profile;
      const scenario = getFirstScenario(profile);
      const transcript = buildMockTranscript(scenario);
      const disclosure = buildDisclosure(profile.manifest, profileDef.tier);

      const prompt = buildUnifiedSummaryPrompt({
        transcript,
        callerInfo: scenario.caller,
        disclosure
      });

      // Should contain the disclosure boundaries section
      assert.includes(
        prompt,
        'Disclosure Boundaries',
        `[${profileDef.name}] prompt should contain "Disclosure Boundaries" section`
      );

      // Should contain "Never Disclose" section header
      assert.includes(
        prompt,
        'Never Disclose',
        `[${profileDef.name}] prompt should contain "Never Disclose" header`
      );

      // Verify disclosure topics are included (if any exist for this tier)
      if (disclosure.topics.length > 0) {
        const firstTopic = disclosure.topics[0].topic;
        assert.includes(
          prompt,
          firstTopic,
          `[${profileDef.name}] prompt should contain tier topic "${firstTopic}"`
        );
      }
    }
  });

  // ── 12. Schema validates all 4 profile mock summaries ──────────────

  test('all 4 profile mock summaries pass schema validation', () => {
    for (const profileDef of profiles) {
      const mockSummary = buildMockSummary(profileDef);
      const result = validateSummarySchema(mockSummary);
      assert.ok(
        result.valid,
        `[${profileDef.name}] mock summary should pass validation, errors: ${result.errors.join('; ')}`
      );
    }
  });
};
