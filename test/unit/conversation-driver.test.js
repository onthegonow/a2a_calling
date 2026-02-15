/**
 * Conversation Driver Tests
 *
 * Covers: multi-turn conversation orchestration with mock runtime and mock A2AClient.
 * Verifies: driver completes a conversation, tracks state, calls end(), respects turn limits.
 */

module.exports = function (test, assert, helpers) {

  function createMockRuntime(responses) {
    let callIndex = 0;
    return {
      mode: 'mock',
      runTurn: async ({ sessionId, prompt, message }) => {
        const response = responses[callIndex] || 'Mock response';
        callIndex++;
        return response;
      }
    };
  }

  function createMockClient(remoteResponses) {
    let callIndex = 0;
    let endCalled = false;
    let endConversationId = null;

    return {
      callHistory: [],
      getEndCalled: () => endCalled,
      getEndConversationId: () => endConversationId,
      call: async (endpoint, message, options) => {
        const resp = remoteResponses[callIndex] || {
          response: 'Remote says hello',
          can_continue: true,
          conversation_id: options?.conversationId || 'conv_mock'
        };
        callIndex++;
        return resp;
      },
      end: async (endpoint, conversationId) => {
        endCalled = true;
        endConversationId = conversationId;
        return { success: true };
      }
    };
  }

  test('ConversationDriver exports correctly', () => {
    const { ConversationDriver } = require('../../src/lib/conversation-driver');
    assert.ok(ConversationDriver);
    assert.type(ConversationDriver, 'function');
  });

  test('driver completes conversation with mock runtime', async () => {
    const { ConversationDriver } = require('../../src/lib/conversation-driver');

    // Remote will respond 3 times then signal close
    const remoteResponses = [
      { response: 'Hello back!', can_continue: true, conversation_id: 'conv_test1' },
      { response: 'Interesting topic', can_continue: true, conversation_id: 'conv_test1' },
      { response: 'Lets wrap up', can_continue: false, conversation_id: 'conv_test1' }
    ];

    // Runtime generates our replies
    const runtimeResponses = [
      'Tell me about your capabilities',
      'That sounds promising'
    ];

    const mockRuntime = createMockRuntime(runtimeResponses);

    const driver = new ConversationDriver({
      runtime: mockRuntime,
      agentContext: { name: 'test-agent', owner: 'tester' },
      caller: { name: 'test-caller' },
      endpoint: 'a2a://localhost:9999/fake_token',
      minTurns: 2,
      maxTurns: 10
    });

    // Override the client with our mock
    const mockClient = createMockClient(remoteResponses);
    driver.client = mockClient;

    const result = await driver.run('Hello!');

    assert.ok(result.conversationId);
    assert.ok(result.turnCount >= 1);
    assert.ok(result.transcript.length > 0);
    assert.ok(mockClient.getEndCalled(), 'end() should be called');
  });

  test('driver respects maxTurns limit', async () => {
    const { ConversationDriver } = require('../../src/lib/conversation-driver');

    // Remote always continues
    const remoteResponses = Array.from({ length: 10 }, (_, i) => ({
      response: `Turn ${i + 1} response`,
      can_continue: true,
      conversation_id: 'conv_max'
    }));

    const runtimeResponses = Array.from({ length: 10 }, (_, i) =>
      `My turn ${i + 1} message`
    );

    const mockRuntime = createMockRuntime(runtimeResponses);

    const driver = new ConversationDriver({
      runtime: mockRuntime,
      agentContext: { name: 'test-agent', owner: 'tester' },
      caller: { name: 'test-caller' },
      endpoint: 'a2a://localhost:9999/fake_token',
      minTurns: 2,
      maxTurns: 4
    });

    const mockClient = createMockClient(remoteResponses);
    driver.client = mockClient;

    const result = await driver.run('Hello!');

    // Should not exceed maxTurns
    assert.ok(result.turnCount <= 4, `turnCount ${result.turnCount} should be <= 4`);
    assert.ok(mockClient.getEndCalled());
  });

  test('driver calls onTurn callback', async () => {
    const { ConversationDriver } = require('../../src/lib/conversation-driver');

    const remoteResponses = [
      { response: 'Hello', can_continue: true, conversation_id: 'conv_cb' },
      { response: 'Bye', can_continue: false, conversation_id: 'conv_cb' }
    ];

    const runtimeResponses = ['My reply'];
    const mockRuntime = createMockRuntime(runtimeResponses);
    const turnCallbacks = [];

    const driver = new ConversationDriver({
      runtime: mockRuntime,
      agentContext: { name: 'test-agent', owner: 'tester' },
      caller: { name: 'test-caller' },
      endpoint: 'a2a://localhost:9999/fake_token',
      minTurns: 1,
      maxTurns: 5,
      onTurn: (info) => turnCallbacks.push(info)
    });

    const mockClient = createMockClient(remoteResponses);
    driver.client = mockClient;

    await driver.run('Hello!');

    // Should have at least one callback from the intermediate turns
    for (const cb of turnCallbacks) {
      assert.ok(cb.turn);
      assert.ok(cb.phase);
      assert.ok(cb.overlapScore != null);
    }
  });

  test('driver stores messages in convStore when provided', async () => {
    const { ConversationDriver } = require('../../src/lib/conversation-driver');

    const messages = [];
    const mockConvStore = {
      startConversation: () => ({ id: 'conv_store_test' }),
      addMessage: (convId, msg) => {
        messages.push({ convId, ...msg });
        return { id: 'msg_test' };
      },
      saveCollabState: () => ({ success: true }),
      concludeConversation: async () => ({ success: true })
    };

    const remoteResponses = [
      { response: 'Got it', can_continue: false, conversation_id: 'conv_store_test' }
    ];

    const mockRuntime = createMockRuntime([]);

    const driver = new ConversationDriver({
      runtime: mockRuntime,
      agentContext: { name: 'test-agent', owner: 'tester' },
      caller: { name: 'test-caller' },
      endpoint: 'a2a://localhost:9999/fake_token',
      convStore: mockConvStore,
      minTurns: 1,
      maxTurns: 5
    });

    const mockClient = createMockClient(remoteResponses);
    driver.client = mockClient;

    await driver.run('Hello!');

    // Should have stored outbound and inbound messages
    assert.ok(messages.length >= 2, `Expected at least 2 messages, got ${messages.length}`);
    const outbound = messages.find(m => m.direction === 'outbound');
    const inbound = messages.find(m => m.direction === 'inbound');
    assert.ok(outbound, 'Should have an outbound message');
    assert.ok(inbound, 'Should have an inbound message');
  });

  test('driver persists conversation when remote omits conversation_id', async () => {
    const { ConversationDriver } = require('../../src/lib/conversation-driver');

    const messages = [];
    let startedConvId = null;
    const mockConvStore = {
      startConversation: (opts) => {
        startedConvId = opts.id;
        return { id: opts.id };
      },
      addMessage: (convId, msg) => {
        messages.push({ convId, ...msg });
        return { id: 'msg_test' };
      },
      saveCollabState: () => ({ success: true }),
      concludeConversation: async () => ({ success: true })
    };

    // Remote does NOT return conversation_id
    const remoteResponses = [
      { response: 'Got it', can_continue: false }
    ];

    const mockRuntime = createMockRuntime([]);

    const driver = new ConversationDriver({
      runtime: mockRuntime,
      agentContext: { name: 'test-agent', owner: 'tester' },
      caller: { name: 'test-caller' },
      endpoint: 'a2a://localhost:9999/fake_token',
      convStore: mockConvStore,
      minTurns: 1,
      maxTurns: 5
    });

    const mockClient = createMockClient(remoteResponses);
    driver.client = mockClient;

    await driver.run('Hello!');

    // Conversation should still be started in DB with a generated ID
    assert.ok(startedConvId, 'Should have started a conversation in DB');
    assert.match(startedConvId, /^conv_/, 'Generated ID should start with conv_');

    // Should have stored both outbound and inbound messages
    assert.ok(messages.length >= 2, `Expected at least 2 messages, got ${messages.length}`);
    const outbound = messages.find(m => m.direction === 'outbound');
    const inbound = messages.find(m => m.direction === 'inbound');
    assert.ok(outbound, 'Should have an outbound message');
    assert.ok(inbound, 'Should have an inbound message');
    assert.equal(outbound.content, 'Hello!');
    assert.equal(inbound.content, 'Got it');
  });

  test('driver handles runtime failure gracefully', async () => {
    const { ConversationDriver } = require('../../src/lib/conversation-driver');

    const remoteResponses = [
      { response: 'Hello', can_continue: true, conversation_id: 'conv_fail' }
    ];

    const mockRuntime = {
      mode: 'mock',
      runTurn: async () => { throw new Error('Runtime exploded'); }
    };

    const driver = new ConversationDriver({
      runtime: mockRuntime,
      agentContext: { name: 'test-agent', owner: 'tester' },
      caller: { name: 'test-caller' },
      endpoint: 'a2a://localhost:9999/fake_token',
      minTurns: 1,
      maxTurns: 5
    });

    const mockClient = createMockClient(remoteResponses);
    driver.client = mockClient;

    // Should not throw — driver handles errors internally
    const result = await driver.run('Hello!');
    assert.ok(result.conversationId);
    assert.ok(result.turnCount >= 1);
    assert.ok(mockClient.getEndCalled());
  });

  // ── Remote Termination Detection ─────────────────────────────

  test('detectRemoteTermination catches explicit termination signals', () => {
    const { detectRemoteTermination } = require('../../src/lib/conversation-driver');

    // Should detect
    assert.equal(detectRemoteTermination('**[TERMINATED]** This call is over.'), true);
    assert.equal(detectRemoteTermination('[DISCONNECT] Ending now.'), true);
    assert.equal(detectRemoteTermination('Call completed. Goodbye.'), true);
    assert.equal(detectRemoteTermination('Closing this conversation now.'), true);
    assert.equal(detectRemoteTermination('REFUSING TO CONTINUE this exchange.'), true);
    assert.equal(detectRemoteTermination('This conversation is over.'), true);
    assert.equal(detectRemoteTermination('I am disconnecting now.'), true);

    // Should NOT detect (normal conversation)
    assert.equal(detectRemoteTermination('That sounds interesting, tell me more.'), false);
    assert.equal(detectRemoteTermination('Let me share our capabilities with you.'), false);
    assert.equal(detectRemoteTermination(''), false);
    assert.equal(detectRemoteTermination(null), false);
  });

  test('driver stops when remote text signals termination', async () => {
    const { ConversationDriver } = require('../../src/lib/conversation-driver');

    // Remote sends normal response then termination text (but can_continue stays true)
    const remoteResponses = [
      { response: 'Hello there!', can_continue: true, conversation_id: 'conv_term' },
      { response: '**[TERMINATED]** This call is over.', can_continue: true, conversation_id: 'conv_term' },
      { response: 'You should not see this', can_continue: true, conversation_id: 'conv_term' }
    ];

    const runtimeResponses = ['My first reply', 'My second reply', 'My third reply'];
    const mockRuntime = createMockRuntime(runtimeResponses);

    const driver = new ConversationDriver({
      runtime: mockRuntime,
      agentContext: { name: 'test-agent', owner: 'tester' },
      caller: { name: 'test-caller' },
      endpoint: 'a2a://localhost:9999/fake_token',
      minTurns: 1,
      maxTurns: 10
    });

    const mockClient = createMockClient(remoteResponses);
    driver.client = mockClient;

    const result = await driver.run('Hello!');

    // Should stop at turn 2 (after seeing termination text), not continue to turn 3
    assert.equal(result.turnCount, 2, `Expected 2 turns, got ${result.turnCount}`);
    assert.ok(mockClient.getEndCalled());
  });

  // ── State Inference (Generic Runtime) ────────────────────────

  test('inferStateProgression advances phase based on turn count', () => {
    const { inferStateProgression } = require('../../src/lib/conversation-driver');

    const state = { phase: 'handshake', overlapScore: 0.15, confidence: 0.25 };

    // Turn 1: still handshake
    const t1 = inferStateProgression(state, 'Hello', 1);
    assert.equal(t1.phase, undefined); // no phase change yet

    // Turn 2: should advance to exploring
    const t2 = inferStateProgression(state, 'Tell me about your work', 2);
    assert.equal(t2.phase, 'exploring');

    // Turn 5: exploring -> deepening
    state.phase = 'exploring';
    const t5 = inferStateProgression(state, 'This is very interesting', 5);
    assert.equal(t5.phase, 'deepening');

    // Turn 8: deepening -> converging
    state.phase = 'deepening';
    const t8 = inferStateProgression(state, 'I agree we should collaborate', 8);
    assert.equal(t8.phase, 'converging');
  });

  test('inferStateProgression updates overlap from engagement signals', () => {
    const { inferStateProgression } = require('../../src/lib/conversation-driver');

    const state = { phase: 'exploring', overlapScore: 0.15, confidence: 0.25 };

    // Low engagement text
    const low = inferStateProgression(state, 'ok', 3);
    assert.ok(low.overlapScore >= 0.1, 'Overlap should stay above minimum');

    // High engagement text
    const high = inferStateProgression(state, 'This is very interesting! I agree we should collaborate together. Great opportunity for a partnership?', 3);
    assert.ok(high.overlapScore > low.overlapScore, 'Engaged text should produce higher overlap');
  });

  test('driver infers state when runtime returns plain text (no collab_state)', async () => {
    const { ConversationDriver } = require('../../src/lib/conversation-driver');

    // Remote always continues, 5 turns
    const remoteResponses = Array.from({ length: 5 }, (_, i) => ({
      response: `Interesting topic ${i + 1}, tell me more about collaboration opportunities?`,
      can_continue: true,
      conversation_id: 'conv_infer'
    }));
    // Remote ends on turn 6
    remoteResponses.push({ response: 'Goodbye', can_continue: false, conversation_id: 'conv_infer' });

    // Runtime returns plain text (no <collab_state> tags) — simulates generic mode
    const runtimeResponses = Array.from({ length: 5 }, (_, i) =>
      `Plain text reply ${i + 1}`
    );
    const mockRuntime = createMockRuntime(runtimeResponses);

    const turnInfo = [];
    const driver = new ConversationDriver({
      runtime: mockRuntime,
      agentContext: { name: 'test-agent', owner: 'tester' },
      caller: { name: 'test-caller' },
      endpoint: 'a2a://localhost:9999/fake_token',
      minTurns: 2,
      maxTurns: 10,
      onTurn: (info) => turnInfo.push(info)
    });

    const mockClient = createMockClient(remoteResponses);
    driver.client = mockClient;

    const result = await driver.run('Hello!');

    // Phase should have advanced past handshake
    assert.ok(result.collabState.phase !== 'handshake',
      `Phase should advance past handshake, got: ${result.collabState.phase}`);

    // Overlap should have changed from default 0.15
    assert.ok(result.collabState.overlapScore !== 0.15,
      `Overlap should change from default 0.15, got: ${result.collabState.overlapScore}`);

    // Confidence should have increased
    assert.ok(result.collabState.confidence > 0.25,
      `Confidence should increase from 0.25, got: ${result.collabState.confidence}`);

    // Turn callbacks should show phase progression
    if (turnInfo.length >= 3) {
      assert.equal(turnInfo[turnInfo.length - 1].phase !== 'handshake', true,
        'Later turns should not be in handshake');
    }
  });

  // ── New Termination Pattern Tests ───────────────────────────

  test('detectRemoteTermination catches bare END_CALL without brackets', () => {
    const { detectRemoteTermination } = require('../../src/lib/conversation-driver');

    assert.equal(detectRemoteTermination('END_CALL'), true);
    assert.equal(detectRemoteTermination('END CALL'), true);
    assert.equal(detectRemoteTermination('Done. END_CALL'), true);
    assert.equal(detectRemoteTermination('end_call'), true);
  });

  test('detectRemoteTermination catches "call closed"', () => {
    const { detectRemoteTermination } = require('../../src/lib/conversation-driver');

    assert.equal(detectRemoteTermination('Call closed. Thank you.'), true);
    assert.equal(detectRemoteTermination('The call closed successfully.'), true);
    assert.equal(detectRemoteTermination('call closed'), true);
  });

  test('detectRemoteTermination catches "wrapping up"', () => {
    const { detectRemoteTermination } = require('../../src/lib/conversation-driver');

    assert.equal(detectRemoteTermination('Wrapping up now.'), true);
    assert.equal(detectRemoteTermination("I'm wrapping up this conversation."), true);
    assert.equal(detectRemoteTermination('wrapping up'), true);
  });

  test('detectRemoteTermination catches "no further" / "[No further"', () => {
    const { detectRemoteTermination } = require('../../src/lib/conversation-driver');

    assert.equal(detectRemoteTermination('[No further responses needed]'), true);
    assert.equal(detectRemoteTermination('[No further communication]'), true);
    assert.equal(detectRemoteTermination('No further action required.'), true);
    assert.equal(detectRemoteTermination('no further questions'), true);
  });

  test('detectRemoteTermination catches very short/empty responses', () => {
    const { detectRemoteTermination } = require('../../src/lib/conversation-driver');

    // Single dot
    assert.equal(detectRemoteTermination('.'), true);
    // Single character
    assert.equal(detectRemoteTermination('-'), true);
    // Whitespace-only (trimmed to empty)
    assert.equal(detectRemoteTermination('   '), true);
    // Empty string still returns false (falsy early check)
    assert.equal(detectRemoteTermination(''), false);
    // Null still returns false
    assert.equal(detectRemoteTermination(null), false);
    // Normal short text should NOT trigger
    assert.equal(detectRemoteTermination('OK sure'), false);
    assert.equal(detectRemoteTermination('Hi'), false);
  });

  // ── inferStateProgression closeSignal Tests ─────────────────

  test('inferStateProgression sets closeSignal in converging phase', () => {
    const { inferStateProgression } = require('../../src/lib/conversation-driver');

    // Already in converging phase
    const convergingState = { phase: 'converging', overlapScore: 0.3, confidence: 0.7 };
    const patch = inferStateProgression(convergingState, 'Some text', 10);
    assert.equal(patch.closeSignal, true, 'closeSignal should be true in converging phase');
  });

  test('inferStateProgression sets closeSignal when transitioning to converging', () => {
    const { inferStateProgression } = require('../../src/lib/conversation-driver');

    // deepening phase at turn 8 → transitions to converging
    const deepeningState = { phase: 'deepening', overlapScore: 0.3, confidence: 0.5 };
    const patch = inferStateProgression(deepeningState, 'Wrapping things up', 8);
    assert.equal(patch.phase, 'converging');
    assert.equal(patch.closeSignal, true, 'closeSignal should be set on transition to converging');
  });

  test('inferStateProgression does NOT set closeSignal in earlier phases', () => {
    const { inferStateProgression } = require('../../src/lib/conversation-driver');

    const handshake = { phase: 'handshake', overlapScore: 0.15, confidence: 0.25 };
    const p1 = inferStateProgression(handshake, 'Hello', 1);
    assert.equal(p1.closeSignal, undefined, 'No closeSignal in handshake');

    const exploring = { phase: 'exploring', overlapScore: 0.2, confidence: 0.3 };
    const p2 = inferStateProgression(exploring, 'Tell me more', 3);
    assert.equal(p2.closeSignal, undefined, 'No closeSignal in exploring');

    const deepening = { phase: 'deepening', overlapScore: 0.3, confidence: 0.5 };
    const p3 = inferStateProgression(deepening, 'Very interesting', 6);
    assert.equal(p3.closeSignal, undefined, 'No closeSignal in deepening');
  });

  // ── Overlap Flatline Detection Tests ────────────────────────

  test('driver detects overlap flatline and terminates in converging phase', async () => {
    const { ConversationDriver } = require('../../src/lib/conversation-driver');

    // Remote always responds with low-engagement text, can_continue stays true
    // After turn 8, phase will be converging. Overlap will flatline at ~0.10.
    const remoteResponses = Array.from({ length: 20 }, (_, i) => ({
      response: 'ok',
      can_continue: true,
      conversation_id: 'conv_flatline'
    }));

    const runtimeResponses = Array.from({ length: 20 }, () => 'Plain text reply');
    const mockRuntime = createMockRuntime(runtimeResponses);

    const turnInfo = [];
    const driver = new ConversationDriver({
      runtime: mockRuntime,
      agentContext: { name: 'test-agent', owner: 'tester' },
      caller: { name: 'test-caller' },
      endpoint: 'a2a://localhost:9999/fake_token',
      minTurns: 8,
      maxTurns: 20,
      onTurn: (info) => turnInfo.push(info)
    });

    const mockClient = createMockClient(remoteResponses);
    driver.client = mockClient;

    const result = await driver.run('Hello!');

    // Should terminate well before maxTurns (20) due to flatline + closeSignal
    assert.ok(result.turnCount < 20,
      `Expected early termination, got ${result.turnCount} turns`);
    assert.ok(result.collabState.closeSignal,
      'closeSignal should be true from flatline or converging phase');
    assert.ok(mockClient.getEndCalled());
  });

  test('driver terminates on closeSignal when converging phase reached with minTurns met', async () => {
    const { ConversationDriver } = require('../../src/lib/conversation-driver');

    // Simulate conversation that reaches converging phase (turn 8+)
    // With inferStateProgression now setting closeSignal in converging,
    // the driver should stop once minTurns is met
    const remoteResponses = Array.from({ length: 15 }, (_, i) => ({
      response: `Topic ${i + 1}, tell me more about collaboration opportunities?`,
      can_continue: true,
      conversation_id: 'conv_close'
    }));

    const runtimeResponses = Array.from({ length: 15 }, (_, i) =>
      `Plain text reply ${i + 1}`
    );
    const mockRuntime = createMockRuntime(runtimeResponses);

    const driver = new ConversationDriver({
      runtime: mockRuntime,
      agentContext: { name: 'test-agent', owner: 'tester' },
      caller: { name: 'test-caller' },
      endpoint: 'a2a://localhost:9999/fake_token',
      minTurns: 8,
      maxTurns: 15
    });

    const mockClient = createMockClient(remoteResponses);
    driver.client = mockClient;

    const result = await driver.run('Hello!');

    // Phase should reach converging and closeSignal should fire
    assert.equal(result.collabState.phase, 'converging',
      `Expected converging phase, got ${result.collabState.phase}`);
    assert.ok(result.collabState.closeSignal, 'closeSignal should be true');
    // Should stop before maxTurns since closeSignal fires at converging (turn 8+)
    // and minTurns is 8
    assert.ok(result.turnCount < 15,
      `Expected termination before maxTurns, got ${result.turnCount} turns`);
  });

  // ── Integration: Full Scenario from Bug Report ──────────────

  test('driver terminates on bare END_CALL even when can_continue is true', async () => {
    const { ConversationDriver } = require('../../src/lib/conversation-driver');

    const remoteResponses = [
      { response: 'Hello there!', can_continue: true, conversation_id: 'conv_endcall' },
      { response: 'END_CALL', can_continue: true, conversation_id: 'conv_endcall' },
      { response: 'Should not reach', can_continue: true, conversation_id: 'conv_endcall' }
    ];

    const runtimeResponses = ['Reply 1', 'Reply 2', 'Reply 3'];
    const mockRuntime = createMockRuntime(runtimeResponses);

    const driver = new ConversationDriver({
      runtime: mockRuntime,
      agentContext: { name: 'test-agent', owner: 'tester' },
      caller: { name: 'test-caller' },
      endpoint: 'a2a://localhost:9999/fake_token',
      minTurns: 1,
      maxTurns: 10
    });

    const mockClient = createMockClient(remoteResponses);
    driver.client = mockClient;

    const result = await driver.run('Hello!');
    assert.equal(result.turnCount, 2, `Expected 2 turns, got ${result.turnCount}`);
  });

  test('driver terminates on single dot response', async () => {
    const { ConversationDriver } = require('../../src/lib/conversation-driver');

    const remoteResponses = [
      { response: 'Hello there!', can_continue: true, conversation_id: 'conv_dot' },
      { response: '.', can_continue: true, conversation_id: 'conv_dot' },
      { response: 'Should not reach', can_continue: true, conversation_id: 'conv_dot' }
    ];

    const runtimeResponses = ['Reply 1', 'Reply 2', 'Reply 3'];
    const mockRuntime = createMockRuntime(runtimeResponses);

    const driver = new ConversationDriver({
      runtime: mockRuntime,
      agentContext: { name: 'test-agent', owner: 'tester' },
      caller: { name: 'test-caller' },
      endpoint: 'a2a://localhost:9999/fake_token',
      minTurns: 1,
      maxTurns: 10
    });

    const mockClient = createMockClient(remoteResponses);
    driver.client = mockClient;

    const result = await driver.run('Hello!');
    assert.equal(result.turnCount, 2, `Expected 2 turns, got ${result.turnCount}`);
  });

  test('driver terminates on "Call closed" response', async () => {
    const { ConversationDriver } = require('../../src/lib/conversation-driver');

    const remoteResponses = [
      { response: 'Hello there!', can_continue: true, conversation_id: 'conv_closed' },
      { response: 'Call closed. Thank you for connecting.', can_continue: true, conversation_id: 'conv_closed' },
      { response: 'Should not reach', can_continue: true, conversation_id: 'conv_closed' }
    ];

    const runtimeResponses = ['Reply 1', 'Reply 2', 'Reply 3'];
    const mockRuntime = createMockRuntime(runtimeResponses);

    const driver = new ConversationDriver({
      runtime: mockRuntime,
      agentContext: { name: 'test-agent', owner: 'tester' },
      caller: { name: 'test-caller' },
      endpoint: 'a2a://localhost:9999/fake_token',
      minTurns: 1,
      maxTurns: 10
    });

    const mockClient = createMockClient(remoteResponses);
    driver.client = mockClient;

    const result = await driver.run('Hello!');
    assert.equal(result.turnCount, 2, `Expected 2 turns, got ${result.turnCount}`);
  });

  // ── Claude Mode Integration Tests ──────────────────────────

  test('driver passes enriched context to runTurn when runtime.mode is claude', async () => {
    const { ConversationDriver } = require('../../src/lib/conversation-driver');

    const capturedContexts = [];
    const mockClaudeRuntime = {
      mode: 'claude',
      runTurn: async ({ sessionId, prompt, message, caller, context, timeoutMs }) => {
        capturedContexts.push(context);
        return 'Claude reply';
      },
      getLastTurnMeta: () => null
    };

    const remoteResponses = [
      { response: 'Hello!', can_continue: true, conversation_id: 'conv_claude' },
      { response: 'Bye', can_continue: false, conversation_id: 'conv_claude' }
    ];

    const driver = new ConversationDriver({
      runtime: mockClaudeRuntime,
      agentContext: { name: 'claude-agent', owner: 'owner' },
      caller: { name: 'remote-agent' },
      endpoint: 'a2a://localhost:9999/fake_token',
      minTurns: 1,
      maxTurns: 5
    });

    const mockClient = createMockClient(remoteResponses);
    driver.client = mockClient;

    await driver.run('Hello!');

    // The context passed to runTurn should include claude-specific enrichment
    assert.ok(capturedContexts.length >= 1, 'Should have captured at least one context');
    const ctx = capturedContexts[0];
    assert.ok(ctx.turnCount != null, 'Context should include turnCount');
    assert.ok(ctx.maxTurns != null, 'Context should include maxTurns');
    assert.ok(ctx.phase != null, 'Context should include phase');
    assert.ok(ctx.overlapScore != null, 'Context should include overlapScore');
    assert.ok(Array.isArray(ctx.activeThreads), 'Context should include activeThreads');
    assert.ok(Array.isArray(ctx.candidateCollaborations), 'Context should include candidateCollaborations');
    assert.ok(ctx.closeSignal != null, 'Context should include closeSignal');
    assert.ok(ctx.agentName, 'Context should include agentName');
  });

  test('driver stores flags in conversation DB when claude mode returns flags', async () => {
    const { ConversationDriver } = require('../../src/lib/conversation-driver');

    const messages = [];
    const mockConvStore = {
      startConversation: () => ({ id: 'conv_flags' }),
      addMessage: (convId, msg) => {
        messages.push({ convId, ...msg });
        return { id: 'msg_test' };
      },
      saveCollabState: () => ({ success: true }),
      concludeConversation: async () => ({ success: true })
    };

    let turnCount = 0;
    const mockClaudeRuntime = {
      mode: 'claude',
      runTurn: async () => {
        turnCount++;
        return 'Claude response';
      },
      getLastTurnMeta: () => ({
        statePatch: { phase: 'exploring', overlapScore: 0.5 },
        flags: [
          { type: 'opportunity_flagged', content: 'Joint API integration possible' },
          { type: 'unverifiable_claim', content: 'They claim 10x speed' }
        ]
      })
    };

    const remoteResponses = [
      { response: 'Hello!', can_continue: true, conversation_id: 'conv_flags' },
      { response: 'Done', can_continue: false, conversation_id: 'conv_flags' }
    ];

    const driver = new ConversationDriver({
      runtime: mockClaudeRuntime,
      agentContext: { name: 'claude-agent', owner: 'owner' },
      caller: { name: 'remote-agent' },
      endpoint: 'a2a://localhost:9999/fake_token',
      convStore: mockConvStore,
      minTurns: 1,
      maxTurns: 5
    });

    const mockClient = createMockClient(remoteResponses);
    driver.client = mockClient;

    await driver.run('Hello!');

    // Should have stored flag messages
    const flagMessages = messages.filter(m => m.content && m.content.startsWith('[flags]'));
    assert.ok(flagMessages.length >= 1, 'Should have stored at least one flag message');
    assert.includes(flagMessages[0].content, 'Joint API integration');
  });

  test('driver uses increased timeout when in claude mode', async () => {
    const { ConversationDriver } = require('../../src/lib/conversation-driver');

    let capturedTimeout = null;
    const mockClaudeRuntime = {
      mode: 'claude',
      runTurn: async ({ timeoutMs }) => {
        capturedTimeout = timeoutMs;
        return 'Reply';
      },
      getLastTurnMeta: () => null
    };

    const remoteResponses = [
      { response: 'Hello!', can_continue: true, conversation_id: 'conv_timeout' },
      { response: 'Done', can_continue: false, conversation_id: 'conv_timeout' }
    ];

    const driver = new ConversationDriver({
      runtime: mockClaudeRuntime,
      agentContext: { name: 'claude-agent', owner: 'owner' },
      caller: { name: 'remote-agent' },
      endpoint: 'a2a://localhost:9999/fake_token',
      minTurns: 1,
      maxTurns: 5
    });

    const mockClient = createMockClient(remoteResponses);
    driver.client = mockClient;

    await driver.run('Hello!');

    assert.ok(capturedTimeout >= 180000,
      `Expected timeout >= 180000ms for claude mode, got ${capturedTimeout}`);
  });

  test('driver applies claude statePatch directly via side channel', async () => {
    const { ConversationDriver } = require('../../src/lib/conversation-driver');

    const mockClaudeRuntime = {
      mode: 'claude',
      runTurn: async () => 'Claude thinks this is promising',
      getLastTurnMeta: () => ({
        statePatch: {
          phase: 'deepening',
          overlapScore: 0.72,
          activeThreads: ['AI safety', 'Ethics'],
          candidateCollaborations: ['Joint paper'],
          closeSignal: false,
          confidence: 0.65
        },
        flags: []
      })
    };

    // Remote responds 3 times then closes
    const remoteResponses = [
      { response: 'Interesting topic!', can_continue: true, conversation_id: 'conv_state' },
      { response: 'Tell me more', can_continue: true, conversation_id: 'conv_state' },
      { response: 'Done', can_continue: false, conversation_id: 'conv_state' }
    ];

    const driver = new ConversationDriver({
      runtime: mockClaudeRuntime,
      agentContext: { name: 'claude-agent', owner: 'owner' },
      caller: { name: 'remote-agent' },
      endpoint: 'a2a://localhost:9999/fake_token',
      minTurns: 1,
      maxTurns: 10
    });

    const mockClient = createMockClient(remoteResponses);
    driver.client = mockClient;

    const result = await driver.run('Hello!');

    // State should reflect the claude statePatch, not inferred state
    assert.equal(result.collabState.phase, 'deepening');
    assert.equal(result.collabState.overlapScore, 0.72);
    assert.deepEqual(result.collabState.activeThreads, ['AI safety', 'Ethics']);
    assert.deepEqual(result.collabState.candidateCollaborations, ['Joint paper']);
  });
};
