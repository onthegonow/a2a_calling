module.exports = function (test, assert, helpers) {

  test('buildUnifiedSummaryPrompt includes all required sections', () => {
    delete require.cache[require.resolve('../../src/lib/summary-prompt')];
    const { buildUnifiedSummaryPrompt } = require('../../src/lib/summary-prompt');

    const prompt = buildUnifiedSummaryPrompt({
      transcript: [
        { direction: 'inbound', content: 'Hello from Golda' },
        { direction: 'outbound', content: 'Welcome Golda!' }
      ],
      callerInfo: { name: 'Golda Deluxe', owner: null, context: 'Authentication research' },
      conversationObjective: 'Explore AI authentication partnerships',
      disclosure: {
        topics: [
          { topic: 'Market analysis', description: 'Tracking luxury goods indices' }
        ],
        objectives: [
          { objective: 'Find partners', description: 'Authentication network' }
        ],
        doNotDiscuss: [
          { topic: 'Portfolio valuations', reason: 'Share strategy not numbers' }
        ],
        neverDisclose: ['Bank account numbers', 'Vault locations']
      },
      collaborationState: {
        phase: 'exploring',
        overlapScore: 0.45,
        activeThreads: ['authentication', 'ML models'],
        candidateCollaborations: ['joint pilot'],
        turnCount: 4,
        closeSignal: false
      },
      ownerContext: {
        agentName: 'claudebot',
        ownerName: 'Ben',
        goals: ['Build authentication network']
      }
    });

    // Must include all context sections
    assert.includes(prompt, 'Explore AI authentication partnerships');
    assert.includes(prompt, 'Market analysis');
    assert.includes(prompt, 'Find partners');
    assert.includes(prompt, 'Portfolio valuations');
    assert.includes(prompt, 'Bank account numbers');
    assert.includes(prompt, 'exploring');
    assert.includes(prompt, '0.45');
    assert.includes(prompt, 'authentication');
    assert.includes(prompt, 'Hello from Golda');

    // Must include the output schema
    assert.includes(prompt, 'headline');
    assert.includes(prompt, 'quickTake');
    assert.includes(prompt, 'disclosure');
    assert.includes(prompt, 'compliance');
    assert.includes(prompt, 'objectives');
  });

  test('buildUnifiedSummaryPrompt handles minimal input gracefully', () => {
    delete require.cache[require.resolve('../../src/lib/summary-prompt')];
    const { buildUnifiedSummaryPrompt } = require('../../src/lib/summary-prompt');

    const prompt = buildUnifiedSummaryPrompt({
      transcript: [
        { direction: 'inbound', content: 'Hi' },
        { direction: 'outbound', content: 'Hello' }
      ],
      callerInfo: { name: 'Unknown' }
    });

    assert.includes(prompt, 'Hi');
    assert.includes(prompt, 'Unknown');
    // Should still have the output schema even without optional sections
    assert.includes(prompt, 'headline');
  });

  test('buildUnifiedSummaryPrompt includes overlap score explanation', () => {
    delete require.cache[require.resolve('../../src/lib/summary-prompt')];
    const { buildUnifiedSummaryPrompt } = require('../../src/lib/summary-prompt');

    const prompt = buildUnifiedSummaryPrompt({
      transcript: [{ direction: 'inbound', content: 'test' }],
      callerInfo: { name: 'Test' },
      collaborationState: {
        phase: 'deepening',
        overlapScore: 0.72,
        activeThreads: [],
        candidateCollaborations: [],
        turnCount: 6,
        closeSignal: false
      }
    });

    // Must explain what the score ranges mean
    assert.includes(prompt, '0.00');
    assert.includes(prompt, '0.30');
    assert.includes(prompt, '0.60');
    assert.includes(prompt, '0.80');
    assert.includes(prompt, 'Minimal alignment');
    assert.includes(prompt, 'Deep alignment');
  });

  test('buildUnifiedSummaryPrompt includes all never_disclose items', () => {
    delete require.cache[require.resolve('../../src/lib/summary-prompt')];
    const { buildUnifiedSummaryPrompt } = require('../../src/lib/summary-prompt');

    const secrets = ['Secret A', 'Secret B', 'Secret C'];
    const prompt = buildUnifiedSummaryPrompt({
      transcript: [{ direction: 'inbound', content: 'test' }],
      callerInfo: { name: 'Test' },
      disclosure: {
        topics: [],
        objectives: [],
        doNotDiscuss: [],
        neverDisclose: secrets
      }
    });

    for (const secret of secrets) {
      assert.includes(prompt, secret, `Prompt should include never_disclose: "${secret}"`);
    }
  });
};
