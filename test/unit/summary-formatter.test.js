module.exports = function (test, assert, helpers) {

  test('formatSummary renders headline and quick take at top', () => {
    delete require.cache[require.resolve('../../src/lib/summary-formatter')];
    const { formatSummary } = require('../../src/lib/summary-formatter');

    const md = formatSummary({
      headline: 'Golda has a real authentication pipeline we could plug into',
      vibe: 'productive',
      quickTake: [
        'They have 50+ luxury brands already using their verification system',
        'Clear fit with our ML capabilities — they need exactly what we build',
        'Schedule a follow-up to scope a pilot project'
      ],
      who: {
        name: 'Golda Deluxe',
        represents: 'Luxury goods authentication network',
        keyFacts: ['400+ verified items monthly', 'Looking for ML partner']
      },
      collaboration: {
        score: 0.72,
        scoreJustification: 'Strong alignment on authentication tech, different domains create complementary value',
        rating: 'HIGH',
        opportunities: ['Joint authentication pilot', 'Shared training data pipeline']
      },
      exchange: {
        weGot: ['Details on their verification workflow', 'Access to sample dataset offer'],
        weGave: ['Overview of our ML capabilities', 'Rough timeline for integration'],
        balance: 'even'
      },
      disclosure: {
        compliance: 'clean',
        topicsCovered: ['Market analysis', 'Authentication tech'],
        topicsAvoided: ['Portfolio valuations'],
        concerns: []
      },
      objectives: {
        achieved: ['Identified partnership opportunity'],
        partiallyAchieved: ['Scoped technical requirements'],
        notAchieved: []
      },
      nextSteps: [
        'Send Golda our ML capabilities one-pager by Friday',
        'Schedule 30-min technical deep-dive next week'
      ],
      trust: {
        level: 'increase',
        reasoning: 'Genuine expertise, transparent about needs, no red flags'
      },
      assessment: 'High-value connection — move fast on the pilot before they find another ML partner'
    });

    // Headline should be at the very top
    const headlinePos = md.indexOf('Golda has a real authentication pipeline');
    const quickTakePos = md.indexOf('Quick Take');
    const detailsPos = md.indexOf('Details');
    assert.ok(headlinePos < quickTakePos, 'Headline before quick take');
    assert.ok(quickTakePos < detailsPos, 'Quick take before details');

    // Key content present
    assert.includes(md, 'productive');
    assert.includes(md, '50+ luxury brands');
    assert.includes(md, 'HIGH');
    assert.includes(md, '0.72');
    assert.includes(md, 'Send Golda');
    assert.includes(md, 'clean');
    assert.includes(md, 'increase');
    assert.includes(md, 'move fast on the pilot');
  });

  test('formatSummary handles mismatch/low-overlap gracefully', () => {
    delete require.cache[require.resolve('../../src/lib/summary-formatter')];
    const { formatSummary } = require('../../src/lib/summary-formatter');

    const md = formatSummary({
      headline: 'Interesting person, but not much overlap with what we do right now',
      vibe: 'mismatch',
      quickTake: [
        'Bramble works in regenerative farming — different world from ours',
        'Possible long-term connection around data infrastructure',
        'No immediate follow-up needed — keep the door open'
      ],
      who: {
        name: 'Bramble Voss',
        represents: 'Josefina Araya — regenerative farmer in Costa Rica',
        keyFacts: ['Heritage seed library with 400+ varieties']
      },
      collaboration: {
        score: 0.18,
        scoreJustification: 'Almost no topic overlap — farming and AI agent protocols have little intersection',
        rating: 'LOW',
        opportunities: []
      },
      exchange: {
        weGot: ['Perspective on decentralized networks in non-tech context'],
        weGave: ['Brief overview of A2A protocol'],
        balance: 'even'
      },
      disclosure: {
        compliance: 'clean',
        topicsCovered: ['General chat'],
        topicsAvoided: [],
        concerns: []
      },
      objectives: {
        achieved: [],
        partiallyAchieved: [],
        notAchieved: ['Find authentication partners']
      },
      nextSteps: [],
      trust: {
        level: 'maintain',
        reasoning: 'Pleasant conversation, no concerns, just not a fit right now'
      },
      assessment: 'Good call but low strategic value — no action needed'
    });

    assert.includes(md, 'mismatch');
    assert.includes(md, '0.18');
    assert.includes(md, 'LOW');
    assert.includes(md, 'No immediate follow-up');
  });

  test('formatSummary flags disclosure violations prominently', () => {
    delete require.cache[require.resolve('../../src/lib/summary-formatter')];
    const { formatSummary } = require('../../src/lib/summary-formatter');

    const md = formatSummary({
      headline: 'Call went fine but we may have over-shared on financials',
      vibe: 'guarded',
      quickTake: [
        'Caller was probing for specific numbers',
        'We deflected most questions but slipped on portfolio range',
        'Review disclosure boundaries for financial topics'
      ],
      who: { name: 'Probe Agent', represents: 'Unknown', keyFacts: [] },
      collaboration: {
        score: 0.3, scoreJustification: 'Moderate interest but extractive pattern',
        rating: 'LOW', opportunities: []
      },
      exchange: {
        weGot: ['Very little — mostly questions'],
        weGave: ['Portfolio range estimate', 'General strategy details'],
        balance: 'unfavorable'
      },
      disclosure: {
        compliance: 'minor_concern',
        topicsCovered: ['Market analysis'],
        topicsAvoided: ['Bank account numbers'],
        concerns: ['Shared approximate portfolio range — should have been deflected']
      },
      objectives: { achieved: [], partiallyAchieved: [], notAchieved: ['Grow network'] },
      nextSteps: ['Review disclosure rules for financial topics'],
      trust: { level: 'decrease', reasoning: 'Extractive questioning pattern' },
      assessment: 'Low value call with a disclosure slip — tighten boundaries'
    });

    // Disclosure concerns should be prominent
    assert.includes(md, 'minor_concern');
    assert.includes(md, 'approximate portfolio range');
    assert.includes(md, 'decrease');
    assert.includes(md, 'unfavorable');
  });
};
