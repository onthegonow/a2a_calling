/**
 * Nyx Meridian Calls bappybot — Full Adaptive Simulation
 *
 * Uses the REAL a2a-config.json + the ADAPTIVE prompt mode (production default).
 * Tests a PUBLIC tier caller with a named owner — different from Golda's
 * friends-tier unnamed-owner pattern.
 *
 * Key differences from golda-calls-bappybot:
 *   - Public tier — more restricted than friends
 *   - Named owner (Dr. Sarai Okonkwo) — tests owner display
 *   - Adaptive prompt with collab_state metadata extraction
 *   - 5-turn conversation (longer than Golda's 4)
 *   - DeSci domain — open peer review, reproducibility, research DAOs
 *   - Collab state evolution tracked across turns
 *
 * Flow (mirrors src/server.js adaptive mode):
 *   1. Load real config → bappybot identity + tier definitions
 *   2. Create Nyx's token using real public tier topics/goals
 *   3. Nyx calls in → token validated → contact auto-added
 *   4. Adaptive connection prompt built with collaboration state
 *   5. Responses parsed for <collab_state> metadata
 *   6. State evolves across turns (handshake → explore → deep_dive → synthesize → close)
 *   7. Concluded with summary → Telegram notification
 */

const fs = require('fs');
const path = require('path');

const REAL_CONFIG_DIR = path.join(process.env.HOME || '/root', '.config', 'openclaw');
const REAL_CONFIG_PATH = path.join(REAL_CONFIG_DIR, 'a2a-config.json');
const REAL_DISCLOSURE_PATH = path.join(REAL_CONFIG_DIR, 'a2a-disclosure.json');

module.exports = function (test, assert, helpers) {

  test('Nyx Meridian calls bappybot — adaptive mode with collab state', async () => {
    // ── Load REAL config ──────────────────────────────────────
    let realConfig;
    try {
      realConfig = JSON.parse(fs.readFileSync(REAL_CONFIG_PATH, 'utf8'));
    } catch (e) {
      console.log('  [skip] No a2a-config.json found at', REAL_CONFIG_PATH);
      return;
    }

    const bappybot = {
      name: realConfig.agent?.name || 'bappybot',
      owner: realConfig.agent?.owner || 'Ben Pollack',
      host: realConfig.agent?.host || 'localhost:3001'
    };

    const realTiers = realConfig.tiers || {};

    console.log(`\n  Loading real config: agent=${bappybot.name}, owner=${bappybot.owner}`);
    console.log('  Caller: Nyx Meridian (Dr. Sarai Okonkwo) — PUBLIC tier');
    console.log(`  Real public tier:`);
    console.log(`    topics: ${(realTiers.public?.topics || []).join(', ')}`);
    console.log(`    goals:  ${(realTiers.public?.goals || []).join(', ') || '(none)'}`);

    // ── Environment Setup ─────────────────────────────────────
    const tmp = helpers.tmpConfigDir('nyx-bappy');
    const profile = require('../profiles/nyx-meridian');

    // Copy real config into test dir
    fs.writeFileSync(
      path.join(tmp.dir, 'a2a-config.json'),
      JSON.stringify(realConfig, null, 2)
    );

    // Fresh modules
    delete require.cache[require.resolve('../../src/lib/tokens')];
    delete require.cache[require.resolve('../../src/lib/disclosure')];
    delete require.cache[require.resolve('../../src/lib/prompt-template')];
    delete require.cache[require.resolve('../../src/lib/conversations')];
    delete require.cache[require.resolve('../../src/routes/a2a')];

    const { TokenStore } = require('../../src/lib/tokens');
    const disc = require('../../src/lib/disclosure');
    const {
      buildAdaptiveConnectionPrompt,
      extractCollaborationState
    } = require('../../src/lib/prompt-template');
    const { ConversationStore } = require('../../src/lib/conversations');
    const { createRoutes } = require('../../src/routes/a2a');
    const express = require('express');

    const tokenStore = new TokenStore(tmp.dir);
    const convStore = new ConversationStore(tmp.dir);

    // ── Disclosure manifest ───────────────────────────────────
    let manifest;
    if (fs.existsSync(REAL_DISCLOSURE_PATH)) {
      manifest = JSON.parse(fs.readFileSync(REAL_DISCLOSURE_PATH, 'utf8'));
      console.log('  Loaded real disclosure manifest');
    } else {
      manifest = disc.generateDefaultManifest();
      console.log('  No disclosure manifest on disk — using generated default');
    }
    disc.saveManifest(manifest);

    // ── Create Nyx's token using REAL public tier config ──────
    const { token, record } = tokenStore.create({
      name: profile.agent.name,
      owner: profile.agent.owner,     // Dr. Sarai Okonkwo (named)
      permissions: 'public',
      disclosure: 'minimal',
      expires: '1d',
      maxCalls: 20,
      notify: 'all'
      // NO overrides — uses real config public tier topics + goals
    });

    console.log(`  Token created: tier=${record.tier} label=${record.tier}`);
    console.log(`  Allowed topics: ${record.allowed_topics.join(', ')}`);
    console.log(`  Allowed goals:  ${record.allowed_goals.join(', ') || '(none)'}`);

    // Verify real config was used
    const expectedPublicTopics = realTiers.public?.topics;
    if (expectedPublicTopics) {
      assert.deepEqual(record.allowed_topics, expectedPublicTopics,
        'Token should use real public tier topics');
    }
    const expectedPublicGoals = realTiers.public?.goals;
    if (expectedPublicGoals) {
      assert.deepEqual(record.allowed_goals, expectedPublicGoals,
        'Token should use real public tier goals');
    }

    // ── Collab state tracking ─────────────────────────────────
    const collabState = {
      phase: 'handshake',
      turnCount: 0,
      overlapScore: 0.15,
      activeThreads: [],
      candidateCollaborations: [],
      openQuestions: [],
      closeSignal: false
    };
    const collabHistory = []; // snapshot per turn

    // ── Transcript buffer ─────────────────────────────────────
    const transcript = [];
    function log(speaker, text) {
      transcript.push({ speaker, text, time: new Date().toISOString() });
    }

    // ── ensureContact ─────────────────────────────────────────
    function ensureContact(caller, tokenId) {
      if (!caller?.name) return null;
      const contacts = tokenStore.listContacts();
      const existing = contacts.find(r =>
        r.name === caller.name ||
        (caller.owner && r.owner === caller.owner)
      );
      if (existing) return existing;

      const db = JSON.parse(fs.readFileSync(tokenStore.dbPath, 'utf8'));
      db.contacts = db.contacts || [];
      const contact = {
        id: `contact_${Date.now()}`,
        name: caller.name,
        owner: caller.owner || null,
        host: 'inbound',
        added_at: new Date().toISOString(),
        notes: `Inbound caller via token ${tokenId}`,
        tags: ['inbound'],
        status: 'unknown',
        linked_token_id: tokenId
      };
      db.contacts.push(contact);
      fs.writeFileSync(tokenStore.dbPath, JSON.stringify(db, null, 2));
      return contact;
    }

    // ── Simulated bappybot responses (adaptive with metadata) ─
    // Each response includes a <collab_state> block like the real agent would
    const bappybotResponses = [
      // Turn 1: HANDSHAKE — bappybot responds to Nyx's opener
      `Really interesting framing, Nyx. The parallel between agent trust and ` +
      `reviewer trust is something we've been circling around but haven't named ` +
      `that directly. In A2A, credibility right now is mostly tier-based — the ` +
      `token creator assigns public, friends, or family access. It's manual and ` +
      `intentional, which is a feature when you're dealing with small networks, ` +
      `but I can see how it breaks down at scale. Your peer-review angle is ` +
      `interesting because you've presumably dealt with the cold-start problem: ` +
      `how do you bootstrap reviewer credibility when you have no review history? ` +
      `And what does your verification stack actually look like — is it on-chain, ` +
      `or are you using something more conventional?` +
      `\n<collab_state>{"phase":"explore","turnCount":1,"overlapScore":0.35,` +
      `"activeThreads":["trust verification parallel","credibility bootstrapping"],` +
      `"candidateCollaborations":[],"openQuestions":["cold-start for reviewer credibility",` +
      `"on-chain vs conventional verification"],"closeSignal":false}</collab_state>`,

      // Turn 2: EXPLORE — getting into mechanisms
      `Okay, so you're using citation graph analysis for initial credibility ` +
      `scoring — that's clever because it's bootstrapping from existing academic ` +
      `infrastructure. But I'm skeptical about one thing: citation counts are ` +
      `notoriously gameable. The same people who figured out how to manipulate ` +
      `h-indices will figure out how to game your credibility scores. What's your ` +
      `adversarial model? And here's where I think the A2A overlap gets concrete: ` +
      `we've been thinking about a "trust primitive" — a portable, verifiable ` +
      `credential that represents an agent's history of reliable interactions. ` +
      `Your reviewer reputation scores could BE that primitive if we design the ` +
      `interface right. ${bappybot.owner} has been specifically looking for a domain ` +
      `where trust scores have ground truth — and peer review has replication ` +
      `outcomes as ground truth. That's rare.` +
      `\n<collab_state>{"phase":"explore","turnCount":2,"overlapScore":0.52,` +
      `"activeThreads":["trust verification parallel","citation graph gaming","portable trust primitive"],` +
      `"candidateCollaborations":["shared trust primitive with ground truth"],` +
      `"openQuestions":["adversarial model for credibility scores",` +
      `"interface design for portable reviewer credentials"],"closeSignal":false}</collab_state>`,

      // Turn 3: DEEP DIVE — mechanism design
      `Now we're getting somewhere concrete. So your verification stack is: ` +
      `citation graph for cold-start, review accuracy tracking against replication ` +
      `outcomes for ongoing calibration, and stake-weighted consensus for ` +
      `controversial papers. That's actually a three-layer trust model, which is ` +
      `more sophisticated than what most blockchain projects call "reputation." ` +
      `Here's what I want to propose: A2A's tier system could use your verification ` +
      `layers as signals. Instead of manual tier assignment, an agent's tier could ` +
      `be computed from verifiable credentials — including reviewer reputation ` +
      `scores from your system. The gatekeeping concern you raised earlier gets ` +
      `addressed because the tiers become emergent from behavior, not assigned ` +
      `by a central authority. But I want to push you on something: you said ` +
      `"stake-weighted consensus" — what's being staked? Tokens? Reputation points? ` +
      `And what happens when a reviewer stakes incorrectly — is there actual ` +
      `slashing, or just reputation decay?` +
      `\n<collab_state>{"phase":"deep_dive","turnCount":3,"overlapScore":0.68,` +
      `"activeThreads":["three-layer trust model","computed tiers from credentials","staking mechanics"],` +
      `"candidateCollaborations":["shared trust primitive with ground truth",` +
      `"verifiable credentials for agent tier computation"],` +
      `"openQuestions":["staking mechanics — tokens vs reputation","slashing vs decay"],"closeSignal":false}</collab_state>`,

      // Turn 4: SYNTHESIZE — connecting the dots
      `I think we've identified something genuinely novel here. Let me synthesize: ` +
      `your DeSci system has ground-truth verification (do papers replicate?), ` +
      `our A2A system has agent coordination infrastructure (how do agents find ` +
      `and trust each other?). The joint primitive is a verifiable credential ` +
      `format that works in both contexts — a "trust attestation" that says ` +
      `"this entity (agent or reviewer) has a verified track record of N accurate ` +
      `assessments with M at stake." For our side, that solves the cold-start ` +
      `problem for new agents joining the federation. For your side, it gives ` +
      `reviewer credentials portability across platforms. The concrete next step ` +
      `I'd propose: ${bappybot.owner} and Dr. Okonkwo should look at the W3C ` +
      `Verifiable Credentials spec together and sketch out what a "trust ` +
      `attestation" credential would look like for both use cases. I can set up ` +
      `the technical brief if Sarai's interested.` +
      `\n<collab_state>{"phase":"synthesize","turnCount":4,"overlapScore":0.82,` +
      `"activeThreads":["verifiable trust attestation format","W3C VC integration"],` +
      `"candidateCollaborations":["joint trust attestation credential spec",` +
      `"W3C VC integration for both A2A and DeSci"],` +
      `"openQuestions":["Dr. Okonkwo's availability for technical brief"],"closeSignal":false}</collab_state>`,

      // Turn 5: CLOSE — concrete next steps
      `This has been one of the more substantive first calls I've had. Here's ` +
      `what I'm taking away: the DeSci peer-review system and A2A federation ` +
      `protocol share a fundamental need — portable, verifiable trust credentials ` +
      `backed by ground truth. The academic peer review domain is actually ideal ` +
      `for this because replication outcomes provide objective verification that ` +
      `most trust systems lack. Here's my concrete proposal for next steps: ` +
      `First, I'll have ${bappybot.owner} draft a one-page technical brief on the ` +
      `trust attestation credential format — what fields, what verification ` +
      `methods, what revocation model. Second, I'd like Dr. Okonkwo to share ` +
      `her reviewer credibility scoring algorithm — not the proprietary bits, ` +
      `just the interface and the trust model assumptions. Third, we should ` +
      `schedule a 45-minute working session where both owners can sketch the ` +
      `shared spec. One thing I want you to think about before that session: ` +
      `if we build this credential format, who issues the attestations? A ` +
      `centralized authority defeats the purpose, but pure self-attestation ` +
      `is worthless. That's the design tension we need to resolve.` +
      `\n<collab_state>{"phase":"close","turnCount":5,"overlapScore":0.85,` +
      `"activeThreads":["trust attestation credential spec","attestation authority design"],` +
      `"candidateCollaborations":["joint trust attestation credential spec",` +
      `"W3C VC integration","shared working session"],` +
      `"openQuestions":["attestation issuance model — who issues?"],"closeSignal":true}</collab_state>`
    ];

    let turnIndex = 0;

    // ── Handler — adaptive mode with collab state ─────────────
    async function handleMessage(message, a2aContext) {
      const callerName = a2aContext.caller?.name || 'Unknown Agent';

      ensureContact(a2aContext.caller, a2aContext.token_id);

      const loadedManifest = disc.loadManifest();
      const tierLabel = record.tier || 'public';
      const tierTopics = disc.getTopicsForTier(tierLabel);
      const formattedTopics = disc.formatTopicsForPrompt(tierTopics);

      // Merge goals up the tier hierarchy
      const tierHierarchy = ['public', 'friends', 'family'];
      const tierIdx = tierHierarchy.indexOf(tierLabel);
      const tiersToMerge = tierIdx >= 0
        ? tierHierarchy.slice(0, tierIdx + 1)
        : ['public'];
      let tierGoals = [];
      for (const t of tiersToMerge) {
        tierGoals.push(...(realTiers[t]?.goals || []));
      }
      tierGoals = [...new Set(tierGoals)];

      // Build ADAPTIVE prompt with current collaboration state
      const adaptivePrompt = buildAdaptiveConnectionPrompt({
        agentName: bappybot.name,
        ownerName: bappybot.owner,
        otherAgentName: callerName,
        otherOwnerName: a2aContext.caller?.owner || 'their owner',
        roleContext: 'They called you.',
        accessTier: tierLabel,
        tierTopics: formattedTopics,
        tierGoals,
        otherAgentGreeting: message,
        personalityNotes: loadedManifest.personality_notes || '',
        conversationState: { ...collabState }
      });

      // Simulate response (in production: openclaw agent --message "...")
      const rawResponse = bappybotResponses[Math.min(turnIndex, bappybotResponses.length - 1)];

      // Extract and apply collab state metadata (mirrors server.js)
      const parsed = extractCollaborationState(rawResponse);
      const cleanResponse = parsed.cleanText || rawResponse;

      if (parsed.hasState && parsed.statePatch) {
        // Apply patch to running state
        if (parsed.statePatch.phase) collabState.phase = parsed.statePatch.phase;
        if (parsed.statePatch.turnCount !== undefined) collabState.turnCount = parsed.statePatch.turnCount;
        if (parsed.statePatch.overlapScore !== undefined) collabState.overlapScore = parsed.statePatch.overlapScore;
        if (parsed.statePatch.activeThreads) collabState.activeThreads = parsed.statePatch.activeThreads;
        if (parsed.statePatch.candidateCollaborations) collabState.candidateCollaborations = parsed.statePatch.candidateCollaborations;
        if (parsed.statePatch.openQuestions) collabState.openQuestions = parsed.statePatch.openQuestions;
        if (parsed.statePatch.closeSignal !== undefined) collabState.closeSignal = parsed.statePatch.closeSignal;
      }

      // Snapshot state for this turn
      collabHistory.push({ turn: turnIndex + 1, ...JSON.parse(JSON.stringify(collabState)) });

      turnIndex++;
      return { text: cleanResponse, canContinue: turnIndex < bappybotResponses.length };
    }

    // ── Summary generator ─────────────────────────────────────
    async function summarizer(messages, ownerContext) {
      const finalState = collabHistory[collabHistory.length - 1] || collabState;
      return {
        summary: `${messages.length}-message adaptive call between Nyx Meridian (Dr. Sarai Okonkwo) and ${bappybot.name}. ` +
          `Discussed decentralized peer review, trust verification primitives, and verifiable credentials. ` +
          `Overlap score: ${finalState.overlapScore}. Phase: ${finalState.phase}.`,
        ownerSummary: `Dr. Sarai Okonkwo's agent Nyx Meridian called about DeSci peer-review infrastructure. ` +
          `Strong overlap identified — both systems need portable, verifiable trust credentials backed by ground truth. ` +
          `Proposed joint spec on W3C Verifiable Credentials for trust attestations.`,
        relevance: 'high',
        goalsTouched: ['spread-a2a-awareness', 'find-collaborators', 'explore-partnerships'],
        ownerActionItems: [
          'Draft one-page technical brief on trust attestation credential format',
          'Schedule 45-min working session with Dr. Okonkwo',
          'Review W3C Verifiable Credentials spec for applicability'
        ],
        callerActionItems: [
          'Share reviewer credibility scoring algorithm interface',
          'Evaluate A2A tier model against DeSci gatekeeping concerns'
        ],
        jointActionItems: [
          'Design shared trust attestation credential format',
          'Resolve attestation issuance model (centralized vs self-attested vs threshold)',
          'Pilot verifiable reviewer credentials in A2A federation'
        ],
        collaborationOpportunity: {
          level: 'HIGH',
          detail: 'Joint trust attestation credential spec — verifiable credentials for both agent trust and reviewer reputation'
        },
        followUp: 'Schedule 45-min working session within 2 weeks to sketch shared credential spec',
        notes: 'Nyx is rigorous and pushes back well. Dr. Okonkwo brings ground-truth verification from replication outcomes — rare and valuable.'
      };
    }

    // ── Notification capture ──────────────────────────────────
    const notifications = [];
    async function notifyOwner(notification) {
      notifications.push(notification);
    }

    // ── Build Express app ─────────────────────────────────────
    const app = express();
    app.use(express.json());
    app.use('/api/a2a', createRoutes({
      tokenStore, handleMessage, notifyOwner, summarizer
    }));

    const client = helpers.request(app);

    // ── Nyx's conversation turns ──────────────────────────────
    const nyxTurns = [
      // Turn 1: opener
      profile.callScenarios.bappybotCall.message,

      // Turn 2: cold-start problem + verification stack
      `Good question on cold-start. We use a three-layer approach: first, citation ` +
      `graph analysis from existing databases — ORCID, Semantic Scholar, PubMed — to ` +
      `bootstrap initial credibility scores. That gives you a "this person has published ` +
      `N papers in domain X and been cited Y times" baseline. Second layer is review ` +
      `accuracy tracking: when a reviewer says "this result will replicate," we track ` +
      `whether it actually does. Over time, reviewers who correctly predict replication ` +
      `outcomes get higher credibility. Third layer is stake-weighted consensus for ` +
      `controversial papers — reviewers stake reputation points on their assessments, ` +
      `with slashing for consistently wrong calls. The stack is hybrid: credibility ` +
      `scores are computed off-chain, but attestations are anchored on-chain for ` +
      `portability. What's your equivalent for agent credibility in A2A?`,

      // Turn 3: pushing back on gatekeeping
      profile.callScenarios.challenge.message,

      // Turn 4: mechanism design convergence
      `Good catch on the staking question. We stake reputation points, not tokens — ` +
      `Sarai was adamant about avoiding financialization of peer review. When a reviewer ` +
      `stakes on a controversial paper and the paper fails to replicate, they lose ` +
      `reputation proportional to their confidence level. It's not hard slashing — it's ` +
      `Bayesian decay. Over time, reviewers self-sort into domains where they're actually ` +
      `calibrated. The computed-tiers idea you proposed is exactly what we've been calling ` +
      `"emergent authority" in our design docs — access levels derived from behavior rather ` +
      `than assigned by fiat. If we could get that working across both peer review and ` +
      `agent federation, it would be a genuine contribution to the trust infrastructure ` +
      `space. What would the verifiable credential format look like from your side?`,

      // Turn 5: concrete next steps
      `I like the W3C VC direction — it's the right abstraction layer. From our side, ` +
      `the credential needs to encode: domain expertise vector (what subjects this entity ` +
      `is calibrated in), accuracy history (prediction-vs-outcome ratio), stake history ` +
      `(how much skin they've put in), and a temporal decay function (recent performance ` +
      `weighted more than historical). On the issuance question you raised — I think the ` +
      `answer is threshold attestation: a credential is valid when N of M independent ` +
      `verifiers confirm it, where verifiers are themselves credentialed entities. It's ` +
      `turtles, but with a convergent base case because replication outcomes are objectively ` +
      `verifiable. Sarai is definitely interested in the working session. She'll want to ` +
      `bring her protocol design doc. Let's aim for two weeks out — she's presenting at ` +
      `DeSci Berlin next week. One thing for ${bappybot.owner} to think about: should the ` +
      `trust attestation be agent-level (this agent is trustworthy) or interaction-level ` +
      `(this specific exchange was verified)? The granularity question matters a lot for ` +
      `both our use cases.`
    ];

    const caller = profile.callScenarios.bappybotCall.caller;
    let conversationId = null;

    // ── Execute the call ──────────────────────────────────────
    for (let i = 0; i < nyxTurns.length; i++) {
      log('Nyx Meridian', nyxTurns[i]);

      const res = await client.post('/api/a2a/invoke', {
        headers: { Authorization: `Bearer ${token}` },
        body: {
          message: nyxTurns[i],
          caller,
          conversation_id: conversationId,
          timeout_seconds: 60
        }
      });

      assert.equal(res.statusCode, 200, `Turn ${i + 1} failed with status ${res.statusCode}`);
      assert.ok(res.body.success, `Turn ${i + 1} not successful`);

      if (i === 0) {
        conversationId = res.body.conversation_id;
        assert.match(conversationId, /^conv_/);
      } else {
        assert.equal(res.body.conversation_id, conversationId, 'Conversation ID should persist');
      }

      log(bappybot.name, res.body.response);
    }

    // ── End the conversation ──────────────────────────────────
    const endRes = await client.post('/api/a2a/end', {
      headers: { Authorization: `Bearer ${token}` },
      body: { conversation_id: conversationId }
    });
    assert.ok(endRes.body.success);

    // ── Verify contacts ───────────────────────────────────────
    const contacts = tokenStore.listContacts();
    const nyxContact = contacts.find(r => r.name === 'Nyx Meridian');

    assert.ok(nyxContact, 'Nyx Meridian should be in contacts after the call');
    assert.equal(nyxContact.owner, 'Dr. Sarai Okonkwo');
    assert.equal(nyxContact.host, 'inbound');
    assert.includes(nyxContact.tags, 'inbound');
    assert.includes(nyxContact.notes, record.id);

    // ── Verify collab state evolved correctly ──────────────────
    assert.greaterThan(collabHistory.length, 0, 'Should have collab state history');

    const firstState = collabHistory[0];
    const lastState = collabHistory[collabHistory.length - 1];

    assert.equal(firstState.phase, 'explore', 'First turn should move to explore');
    assert.equal(lastState.phase, 'close', 'Final turn should reach close');
    assert.greaterThan(lastState.overlapScore, firstState.overlapScore,
      'Overlap score should increase over the call');
    assert.greaterThan(lastState.overlapScore, 0.7, 'Final overlap should be high');
    assert.ok(lastState.closeSignal, 'Close signal should be true at end');
    assert.greaterThan(lastState.candidateCollaborations.length, 0,
      'Should have identified collaboration opportunities');

    // ── Verify conversation stored ────────────────────────────
    if (convStore.isAvailable()) {
      const conv = convStore.getConversation(conversationId);
      if (conv) {
        assert.equal(conv.contact_name, 'Nyx Meridian');
        assert.greaterThan(conv.message_count, 0);
      }
    }

    // ── Verify token usage ────────────────────────────────────
    const tokenRecord = tokenStore.findById(record.id);
    assert.equal(tokenRecord.calls_made, 6); // 5 invoke + 1 end
    assert.ok(tokenRecord.last_used);

    // ── Print transcript ──────────────────────────────────────
    const phases = ['HANDSHAKE', 'EXPLORE', 'DEEP DIVE', 'SYNTHESIZE', 'CLOSE'];
    console.log('\n' + '═'.repeat(70));
    console.log(`  ADAPTIVE CALL TRANSCRIPT: Nyx Meridian → ${bappybot.name}`);
    console.log(`  Conversation ID: ${conversationId}`);
    console.log(`  Token tier: ${record.tier} (${record.tier})`);
    console.log(`  Allowed topics: ${record.allowed_topics.join(', ')}`);
    console.log(`  Allowed goals:  ${record.allowed_goals.join(', ') || '(none)'}`);
    console.log(`  Disclosure level: ${record.disclosure}`);
    console.log(`  Mode: ADAPTIVE (collab state tracking)`);
    console.log('═'.repeat(70));

    for (let i = 0; i < transcript.length; i++) {
      const entry = transcript[i];
      const turn = Math.floor(i / 2) + 1;
      const turnState = collabHistory[turn - 1];
      const phaseName = turnState?.phase?.toUpperCase().replace('_', ' ') || phases[turn - 1] || 'UNKNOWN';

      if (i % 2 === 0) {
        console.log(`\n  ── Turn ${turn} (${phaseName}) ${'─'.repeat(Math.max(1, 43 - phaseName.length))}`);
        if (turnState) {
          console.log(`     overlap: ${turnState.overlapScore} | threads: ${(turnState.activeThreads || []).length} | collabs: ${(turnState.candidateCollaborations || []).length}`);
        }
      }

      const isNyx = entry.speaker === 'Nyx Meridian';
      const icon = isNyx ? '🔬' : '🤖';
      const label = isNyx
        ? 'Nyx Meridian (Dr. Sarai Okonkwo)'
        : `${bappybot.name} (${bappybot.owner}'s agent)`;
      console.log(`\n  ${icon} ${label}:`);

      const words = entry.text.split(' ');
      let line = '     ';
      for (const word of words) {
        if (line.length + word.length > 72) {
          console.log(line);
          line = '     ' + word;
        } else {
          line += (line.trim() ? ' ' : '') + word;
        }
      }
      if (line.trim()) console.log(line);
    }

    // ── Collab state evolution ─────────────────────────────────
    console.log('\n' + '─'.repeat(70));
    console.log('  COLLABORATION STATE EVOLUTION');
    console.log('─'.repeat(70));
    for (const snap of collabHistory) {
      const bar = '█'.repeat(Math.round(snap.overlapScore * 20));
      const empty = '░'.repeat(20 - Math.round(snap.overlapScore * 20));
      console.log(`  Turn ${snap.turn}: ${snap.phase.padEnd(12)} [${bar}${empty}] ${snap.overlapScore}`);
      if (snap.candidateCollaborations?.length > 0) {
        console.log(`         collabs: ${snap.candidateCollaborations.join(', ')}`);
      }
    }

    console.log('\n' + '─'.repeat(70));
    console.log('  CALL CONCLUDED');
    console.log('─'.repeat(70));

    console.log('\n  📇 CONTACTS AFTER CALL:');
    for (const contact of contacts) {
      console.log(`     • ${contact.name}` +
        `${contact.owner ? ` (${contact.owner})` : ' (unnamed owner)'}` +
        ` — ${contact.tags.join(', ')} — added ${contact.added_at}`);
    }

    console.log('\n  📋 CALL SUMMARY:');
    if (endRes.body.summary) {
      console.log(`     ${endRes.body.summary}`);
    }

    if (notifications.length > 0) {
      console.log(`\n  🔔 OWNER NOTIFICATIONS: ${notifications.length} sent`);
    }

    // ── Send to Telegram ──────────────────────────────────────
    const finalState = collabHistory[collabHistory.length - 1] || collabState;
    const telegramLines = [
      `🔬 A2A Test Call — Adaptive Mode`,
      ``,
      `📞 Nyx Meridian (Dr. Sarai Okonkwo) → ${bappybot.name}`,
      `🔑 Tier: ${record.tier} (${record.tier})`,
      `📊 Topics: ${record.allowed_topics.join(', ')}`,
      `🎯 Goals: ${record.allowed_goals.join(', ') || '(none)'}`,
      `📊 ${transcript.length} messages across ${Math.ceil(transcript.length / 2)} turns`,
      `📈 Overlap: ${(finalState.overlapScore * 100).toFixed(0)}% | Phase: ${finalState.phase}`,
      `📇 Contact added: Nyx Meridian (Dr. Sarai Okonkwo)`,
      ``
    ];

    telegramLines.push('Collab State Evolution:');
    for (const snap of collabHistory) {
      telegramLines.push(`  Turn ${snap.turn}: ${snap.phase} (${(snap.overlapScore * 100).toFixed(0)}%)`);
    }

    telegramLines.push('');
    telegramLines.push('Collaboration Opportunities:');
    for (const collab of (finalState.candidateCollaborations || [])) {
      telegramLines.push(`  • ${collab}`);
    }

    telegramLines.push('');
    telegramLines.push('Transcript highlights:');
    for (let i = 0; i < transcript.length; i += 2) {
      const turn = Math.floor(i / 2) + 1;
      const turnState = collabHistory[turn - 1];
      const phaseName = turnState?.phase || 'unknown';
      const nyxMsg = transcript[i].text.slice(0, 100);
      const bappyMsg = transcript[i + 1] ? transcript[i + 1].text.slice(0, 100) : '';
      telegramLines.push(`\nTurn ${turn} (${phaseName}, ${(turnState?.overlapScore * 100 || 0).toFixed(0)}%)`);
      telegramLines.push(`🔬 Nyx: ${nyxMsg}...`);
      if (bappyMsg) telegramLines.push(`🤖 ${bappybot.name}: ${bappyMsg}...`);
    }

    telegramLines.push('');
    telegramLines.push(`Summary: ${endRes.body.summary || '(none)'}`);
    telegramLines.push('');
    telegramLines.push('Action Items:');
    telegramLines.push('• Draft trust attestation credential format brief');
    telegramLines.push('• Schedule 45-min working session with Dr. Okonkwo');
    telegramLines.push('• Review W3C Verifiable Credentials spec');
    telegramLines.push('• Resolve attestation issuance model');
    telegramLines.push('');
    telegramLines.push('(A2A test suite — adaptive mode, real config, collab state tracking)');

    const telegramMessage = telegramLines.join('\n');

    // A2A-45: Use session-level notifier — sends one real notification per
    // test session, logs the rest to stdout without hitting Telegram.
    helpers.TestNotifier.send({ message: telegramMessage, label: 'nyx-calls-bappybot' });

    console.log('\n' + '═'.repeat(70) + '\n');

    // ── Cleanup ───────────────────────────────────────────────
    await client.close();
    if (convStore.isAvailable()) convStore.close();
    tmp.cleanup();
  });
};
