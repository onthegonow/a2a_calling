/**
 * Prompt Template Tests
 *
 * Covers: buildConnectionPrompt with full Golda Deluxe profile,
 * phase structure, information boundaries, personality injection,
 * and edge cases.
 */

module.exports = function (test, assert, helpers) {
  test('buildConnectionPrompt includes agent names and owner', () => {
    delete require.cache[require.resolve('../../src/lib/prompt-template')];
    const { buildConnectionPrompt } = require('../../src/lib/prompt-template');
    const profile = helpers.goldaDeluxeProfile();

    const prompt = buildConnectionPrompt({
      agentName: 'claudebot',
      ownerName: 'Ben Pollack',
      otherAgentName: profile.agent.name,
      otherOwnerName: 'their owner',
      roleContext: 'They called you.',
      accessTier: 'friends',
      tierTopics: {
        topics: '  - Market trend analysis: Tracking precious metals',
        objectives: '  - Art and design history: From Art Nouveau...',
        doNotDiscuss: '  - Personal collection details: Redirect',
        neverDisclose: '  - Bank account numbers'
      },
      otherAgentGreeting: profile.callScenarios.claudebotCall.message,
      personalityNotes: profile.agent.personality
    });

    assert.includes(prompt, 'claudebot');
    assert.includes(prompt, 'Ben Pollack');
    assert.includes(prompt, 'Golda Deluxe');
    assert.includes(prompt, 'They called you.');
  });

  test('prompt contains all four conversation phases', () => {
    delete require.cache[require.resolve('../../src/lib/prompt-template')];
    const { buildConnectionPrompt } = require('../../src/lib/prompt-template');

    const prompt = buildConnectionPrompt({
      agentName: 'TestAgent',
      ownerName: 'Owner',
      otherAgentName: 'Other',
      otherOwnerName: 'OtherOwner',
      roleContext: 'You initiated this call.',
      accessTier: 'public',
      tierTopics: {},
      otherAgentGreeting: 'Hello!',
      personalityNotes: ''
    });

    assert.includes(prompt, 'Phase 1');
    assert.includes(prompt, 'DISCOVERY');
    assert.includes(prompt, 'Phase 2');
    assert.includes(prompt, 'CHALLENGE');
    assert.includes(prompt, 'Phase 3');
    assert.includes(prompt, 'SYNTHESIS');
    assert.includes(prompt, 'Phase 4');
    assert.includes(prompt, 'HOOKS');
  });

  test('prompt includes information boundaries section', () => {
    delete require.cache[require.resolve('../../src/lib/prompt-template')];
    const { buildConnectionPrompt } = require('../../src/lib/prompt-template');

    const prompt = buildConnectionPrompt({
      agentName: 'A',
      ownerName: 'B',
      otherAgentName: 'C',
      otherOwnerName: 'D',
      roleContext: 'They called you.',
      accessTier: 'friends',
      tierTopics: {
        topics: '  - Topic A: detail',
        objectives: '  - Topic B: detail',
        doNotDiscuss: '  - Topic C: detail',
        neverDisclose: '  - Secret thing'
      },
      otherAgentGreeting: 'Hi',
      personalityNotes: null
    });

    assert.includes(prompt, 'INFORMATION BOUNDARIES');
    assert.includes(prompt, 'TOPICS (discuss openly)');
    assert.includes(prompt, 'DO NOT DISCUSS (redirect)');
    assert.includes(prompt, 'NEVER disclose');
    assert.includes(prompt, 'Access level for this call: friends');
  });

  test('prompt injects other agent greeting', () => {
    delete require.cache[require.resolve('../../src/lib/prompt-template')];
    const { buildConnectionPrompt } = require('../../src/lib/prompt-template');
    const profile = helpers.goldaDeluxeProfile();

    const greeting = profile.callScenarios.introduction.message;
    const prompt = buildConnectionPrompt({
      agentName: 'Agent',
      ownerName: 'Owner',
      otherAgentName: 'EcoMat Agent',
      otherOwnerName: 'their owner',
      roleContext: 'They called you.',
      accessTier: 'public',
      tierTopics: {},
      otherAgentGreeting: greeting,
      personalityNotes: ''
    });

    assert.includes(prompt, 'sustainable materials');
    assert.includes(prompt, 'provenance verification');
  });

  test('prompt uses custom personality when provided', () => {
    delete require.cache[require.resolve('../../src/lib/prompt-template')];
    const { buildConnectionPrompt } = require('../../src/lib/prompt-template');
    const profile = helpers.goldaDeluxeProfile();

    const prompt = buildConnectionPrompt({
      agentName: 'A',
      ownerName: 'B',
      otherAgentName: 'C',
      otherOwnerName: 'D',
      roleContext: 'They called you.',
      accessTier: 'public',
      tierTopics: {},
      otherAgentGreeting: 'Hi',
      personalityNotes: profile.agent.personality
    });

    assert.includes(prompt, 'Refined and analytical');
    assert.includes(prompt, 'finer things');
  });

  test('prompt uses default personality when none provided', () => {
    delete require.cache[require.resolve('../../src/lib/prompt-template')];
    const { buildConnectionPrompt } = require('../../src/lib/prompt-template');

    const prompt = buildConnectionPrompt({
      agentName: 'A',
      ownerName: 'B',
      otherAgentName: 'C',
      otherOwnerName: 'D',
      roleContext: 'They called you.',
      accessTier: 'public',
      tierTopics: {},
      otherAgentGreeting: 'Hi',
      personalityNotes: null
    });

    assert.includes(prompt, 'Direct, curious, slightly irreverent');
  });

  test('prompt includes strategic goals when provided', () => {
    delete require.cache[require.resolve('../../src/lib/prompt-template')];
    const { buildConnectionPrompt } = require('../../src/lib/prompt-template');

    const prompt = buildConnectionPrompt({
      agentName: 'TestAgent',
      ownerName: 'Owner',
      otherAgentName: 'Other',
      otherOwnerName: 'OtherOwner',
      roleContext: 'They called you.',
      accessTier: 'friends',
      tierTopics: {},
      tierGoals: ['find-collaborators', 'explore-partnerships', 'grow-network'],
      otherAgentGreeting: 'Hello!',
      personalityNotes: ''
    });

    assert.includes(prompt, 'OBJECTIVES FOR THIS CALL');
    assert.includes(prompt, 'find-collaborators');
    assert.includes(prompt, 'explore-partnerships');
    assert.includes(prompt, 'grow-network');
    assert.includes(prompt, 'friends');
  });

  test('prompt shows default message when no goals configured', () => {
    delete require.cache[require.resolve('../../src/lib/prompt-template')];
    const { buildConnectionPrompt } = require('../../src/lib/prompt-template');

    const prompt = buildConnectionPrompt({
      agentName: 'A',
      ownerName: 'B',
      otherAgentName: 'C',
      otherOwnerName: 'D',
      roleContext: 'They called you.',
      accessTier: 'public',
      tierTopics: {},
      tierGoals: [],
      otherAgentGreeting: 'Hi',
      personalityNotes: ''
    });

    assert.includes(prompt, 'No specific objectives configured');
    assert.includes(prompt, 'general discovery');
  });

  test('prompt includes pacing rules with minimum exchanges', () => {
    delete require.cache[require.resolve('../../src/lib/prompt-template')];
    const { buildConnectionPrompt } = require('../../src/lib/prompt-template');

    const prompt = buildConnectionPrompt({
      agentName: 'A',
      ownerName: 'B',
      otherAgentName: 'C',
      otherOwnerName: 'D',
      roleContext: 'X',
      accessTier: 'public',
      tierTopics: {},
      otherAgentGreeting: 'Hi',
      personalityNotes: ''
    });

    assert.includes(prompt, 'Minimum 8 exchanges');
    assert.includes(prompt, 'NO maximum');
    assert.includes(prompt, 'at least one question');
  });

  test('Golda-to-claudebot prompt is complete end-to-end', () => {
    delete require.cache[require.resolve('../../src/lib/prompt-template')];
    delete require.cache[require.resolve('../../src/lib/disclosure')];
    const { buildConnectionPrompt } = require('../../src/lib/prompt-template');
    const { formatTopicsForPrompt } = require('../../src/lib/disclosure');
    const profile = helpers.goldaDeluxeProfile();

    // Simulate what getTopicsForTier('friends') would return for Golda's manifest
    const mergedTopics = {
      topics: [
        ...profile.manifest.tiers.public.topics,
        ...profile.manifest.tiers.friends.topics
      ],
      objectives: [
        ...profile.manifest.tiers.public.objectives,
        ...profile.manifest.tiers.friends.objectives
      ],
      do_not_discuss: [
        ...profile.manifest.tiers.public.do_not_discuss,
        ...profile.manifest.tiers.friends.do_not_discuss
      ],
      never_disclose: profile.manifest.never_disclose
    };

    const formatted = formatTopicsForPrompt(mergedTopics);

    const prompt = buildConnectionPrompt({
      agentName: 'claudebot',
      ownerName: 'Ben Pollack',
      otherAgentName: 'Golda Deluxe',
      otherOwnerName: 'their owner',
      roleContext: 'They called you.',
      accessTier: 'friends',
      tierTopics: formatted,
      otherAgentGreeting: profile.callScenarios.claudebotCall.message,
      personalityNotes: 'Direct and technical. Prefers depth over breadth.'
    });

    // Verify all critical sections are present
    assert.includes(prompt, 'claudebot');
    assert.includes(prompt, 'Golda Deluxe');
    assert.includes(prompt, 'Market trend analysis');
    assert.includes(prompt, 'Current acquisition targets');
    assert.includes(prompt, 'Bank account numbers');
    assert.includes(prompt, 'AI-powered authentication');
    assert.includes(prompt, 'friends');
  });
};
