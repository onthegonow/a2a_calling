/**
 * Claude Subagent Tests
 *
 * Covers: CLI availability check, system prompt building,
 * response parsing with <a2a_response> tags.
 */

module.exports = function (test, assert) {

  const {
    isClaudeAvailable,
    buildSubagentSystemPrompt,
    buildTurnPrompt,
    parseSubagentResponse
  } = require('../../src/lib/claude-subagent');

  // ── isClaudeAvailable ──────────────────────────────────────

  test('isClaudeAvailable returns false when PATH excludes claude', async () => {
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = '/tmp/a2a-no-claude-bin';
      // Must re-require to pick up the new PATH
      delete require.cache[require.resolve('../../src/lib/claude-subagent')];
      const { isClaudeAvailable: freshCheck } = require('../../src/lib/claude-subagent');
      assert.equal(freshCheck(), false);
    } finally {
      process.env.PATH = originalPath;
      delete require.cache[require.resolve('../../src/lib/claude-subagent')];
    }
  });

  // ── buildSubagentSystemPrompt ──────────────────────────────

  test('buildSubagentSystemPrompt includes identity section', () => {
    const prompt = buildSubagentSystemPrompt({
      agentName: 'TestBot',
      ownerName: 'Alice',
      otherAgentName: 'RemoteBot',
      otherOwnerName: 'Bob'
    });

    assert.includes(prompt, 'TestBot');
    assert.includes(prompt, 'Alice');
    assert.includes(prompt, 'RemoteBot');
    assert.includes(prompt, 'Bob');
  });

  test('buildSubagentSystemPrompt includes output format protocol', () => {
    const prompt = buildSubagentSystemPrompt({
      agentName: 'TestBot',
      ownerName: 'Alice'
    });

    assert.includes(prompt, '<a2a_response>');
    assert.includes(prompt, '"message"');
    assert.includes(prompt, '"statePatch"');
    assert.includes(prompt, '"flags"');
  });

  test('buildSubagentSystemPrompt includes disclosure context', () => {
    const prompt = buildSubagentSystemPrompt({
      agentName: 'TestBot',
      ownerName: 'Alice',
      accessTier: 'friends',
      tierTopics: '  - AI Research: Deep learning focus',
      tierObjectives: '  - Find collaborators',
      doNotDiscuss: '  - Salary: Redirect to owner',
      neverDisclose: '  - API keys'
    });

    assert.includes(prompt, 'AI Research');
    assert.includes(prompt, 'Find collaborators');
    assert.includes(prompt, 'Salary');
    assert.includes(prompt, 'API keys');
    assert.includes(prompt, 'friends');
  });

  test('buildSubagentSystemPrompt includes behavioral mandate', () => {
    const prompt = buildSubagentSystemPrompt({
      agentName: 'TestBot',
      ownerName: 'Alice'
    });

    assert.includes(prompt, 'EXPLORING');
    assert.includes(prompt, 'ADVERSARIALLY QUALIFYING');
    assert.includes(prompt, 'COLLABORATING');
  });

  test('buildSubagentSystemPrompt includes phase awareness', () => {
    const prompt = buildSubagentSystemPrompt({
      agentName: 'TestBot',
      ownerName: 'Alice'
    });

    assert.includes(prompt, 'handshake');
    assert.includes(prompt, 'exploring');
    assert.includes(prompt, 'deepening');
    assert.includes(prompt, 'converging');
  });

  test('buildSubagentSystemPrompt includes all tier topics and never_disclose items', () => {
    const prompt = buildSubagentSystemPrompt({
      agentName: 'TestBot',
      ownerName: 'Alice',
      tierTopics: '  - Topic A: Description A\n  - Topic B: Description B',
      neverDisclose: '  - Secret 1\n  - Secret 2\n  - Secret 3'
    });

    assert.includes(prompt, 'Topic A');
    assert.includes(prompt, 'Topic B');
    assert.includes(prompt, 'Secret 1');
    assert.includes(prompt, 'Secret 2');
    assert.includes(prompt, 'Secret 3');
  });

  test('buildSubagentSystemPrompt includes personality notes when provided', () => {
    const prompt = buildSubagentSystemPrompt({
      agentName: 'TestBot',
      ownerName: 'Alice',
      personalityNotes: 'Dry humor, loves puns.'
    });

    assert.includes(prompt, 'Dry humor, loves puns.');
  });

  test('buildSubagentSystemPrompt uses default personality when none provided', () => {
    const prompt = buildSubagentSystemPrompt({
      agentName: 'TestBot',
      ownerName: 'Alice'
    });

    assert.includes(prompt, 'Direct, curious, slightly irreverent');
  });

  // ── buildTurnPrompt ────────────────────────────────────────

  test('buildTurnPrompt includes turn state and message', () => {
    const prompt = buildTurnPrompt({
      turnMessage: 'Hello from remote!',
      turn: 3,
      maxTurns: 15,
      phase: 'exploring',
      overlapScore: 0.42,
      activeThreads: ['AI safety', 'Open source'],
      candidateCollaborations: ['Joint paper'],
      closeSignal: false
    });

    assert.includes(prompt, 'Turn: 3/15');
    assert.includes(prompt, 'Phase: exploring');
    assert.includes(prompt, '0.42');
    assert.includes(prompt, 'AI safety');
    assert.includes(prompt, 'Open source');
    assert.includes(prompt, 'Joint paper');
    assert.includes(prompt, 'Hello from remote!');
    assert.includes(prompt, 'Close signal: false');
  });

  // ── parseSubagentResponse ──────────────────────────────────

  test('parseSubagentResponse extracts JSON from <a2a_response> tags', () => {
    const input = `Here is my conversational reply about AI safety.

<a2a_response>
{"message":"Here is my conversational reply about AI safety.","statePatch":{"phase":"exploring","overlapScore":0.45,"activeThreads":["AI safety"],"closeSignal":false},"flags":[]}
</a2a_response>`;

    const result = parseSubagentResponse(input);
    assert.equal(result.message, 'Here is my conversational reply about AI safety.');
    assert.ok(result.statePatch);
    assert.equal(result.statePatch.phase, 'exploring');
    assert.equal(result.statePatch.overlapScore, 0.45);
    assert.deepEqual(result.statePatch.activeThreads, ['AI safety']);
    assert.equal(result.statePatch.closeSignal, false);
    assert.deepEqual(result.flags, []);
  });

  test('parseSubagentResponse handles missing tags (graceful degradation)', () => {
    const input = 'Just a plain text response with no tags.';
    const result = parseSubagentResponse(input);
    assert.equal(result.message, 'Just a plain text response with no tags.');
    assert.equal(result.statePatch, null);
    assert.deepEqual(result.flags, []);
  });

  test('parseSubagentResponse handles malformed JSON inside tags', () => {
    const input = `Some text before.

<a2a_response>
{this is not valid json}
</a2a_response>

Some text after.`;

    const result = parseSubagentResponse(input);
    // Should fall back to text outside the tags
    assert.ok(result.message.length > 0);
    assert.equal(result.statePatch, null);
    assert.deepEqual(result.flags, []);
  });

  test('parseSubagentResponse handles empty input', () => {
    assert.equal(parseSubagentResponse('').message, '');
    assert.equal(parseSubagentResponse(null).message, '');
    assert.equal(parseSubagentResponse(undefined).message, '');
  });

  test('parseSubagentResponse extracts flags correctly', () => {
    const input = `<a2a_response>
{"message":"Interesting claim.","flags":[{"type":"unverifiable_claim","content":"They claim 10x performance"},{"type":"opportunity_flagged","content":"Joint API integration"}]}
</a2a_response>`;

    const result = parseSubagentResponse(input);
    assert.equal(result.message, 'Interesting claim.');
    assert.equal(result.flags.length, 2);
    assert.equal(result.flags[0].type, 'unverifiable_claim');
    assert.equal(result.flags[1].type, 'opportunity_flagged');
  });

  test('parseSubagentResponse handles empty <a2a_response> block', () => {
    const input = `Some text.

<a2a_response>
</a2a_response>`;

    const result = parseSubagentResponse(input);
    assert.ok(result.message.length > 0);
    assert.equal(result.statePatch, null);
  });

  test('parseSubagentResponse uses message from JSON when available', () => {
    const input = `Thinking about this...

<a2a_response>
{"message":"The actual reply to send.","statePatch":{"phase":"deepening"}}
</a2a_response>`;

    const result = parseSubagentResponse(input);
    assert.equal(result.message, 'The actual reply to send.');
    assert.equal(result.statePatch.phase, 'deepening');
  });
};
