/**
 * Golda Deluxe Calls bappybot — Full Simulation
 *
 * Uses the REAL a2a-config.json from ~/.config/openclaw/ to match
 * production permission settings. No hardcoded tier topics.
 *
 * Flow (mirrors src/server.js):
 *   1. Load real config → bappybot identity + tier definitions
 *   2. Create Golda's token using real tier topics (friends tier)
 *   3. Golda calls in → token validated → contact auto-added
 *   4. Connection prompt built from disclosure + tier
 *   5. Multi-turn conversation stored
 *   6. Concluded with summary → Telegram notification
 */

const fs = require('fs');
const path = require('path');

// Real config paths
const REAL_CONFIG_DIR = path.join(process.env.HOME || '/root', '.config', 'openclaw');
const REAL_CONFIG_PATH = path.join(REAL_CONFIG_DIR, 'a2a-config.json');
const REAL_DISCLOSURE_PATH = path.join(REAL_CONFIG_DIR, 'a2a-disclosure.json');

module.exports = function (test, assert, helpers) {

  test('Golda Deluxe calls bappybot — full server flow with transcript', async () => {
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
      owner: realConfig.agent?.owner || 'Benjamin Pollack',
      host: realConfig.agent?.host || 'localhost:3001'
    };

    const realTiers = realConfig.tiers || {};

    console.log(`\n  Loading real config: agent=${bappybot.name}, owner=${bappybot.owner}`);
    console.log(`  Real tier data:`);
    for (const [tier, cfg] of Object.entries(realTiers)) {
      console.log(`    ${tier} topics: ${(cfg.topics || []).join(', ')}`);
      console.log(`    ${tier} goals:  ${(cfg.goals || []).join(', ') || '(none)'}`);
    }

    // ── Environment Setup ─────────────────────────────────────
    const tmp = helpers.tmpConfigDir('golda-bappy');
    const profile = helpers.goldaDeluxeProfile();

    // Copy real config into test dir so TokenStore picks up real tiers
    fs.writeFileSync(
      path.join(tmp.dir, 'a2a-config.json'),
      JSON.stringify(realConfig, null, 2)
    );

    // Fresh modules pointing at test config dir
    delete require.cache[require.resolve('../../src/lib/tokens')];
    delete require.cache[require.resolve('../../src/lib/disclosure')];
    delete require.cache[require.resolve('../../src/lib/prompt-template')];
    delete require.cache[require.resolve('../../src/lib/conversations')];
    delete require.cache[require.resolve('../../src/routes/a2a')];

    const { TokenStore } = require('../../src/lib/tokens');
    const disc = require('../../src/lib/disclosure');
    const { buildConnectionPrompt } = require('../../src/lib/prompt-template');
    const { ConversationStore } = require('../../src/lib/conversations');
    const { createRoutes } = require('../../src/routes/a2a');
    const express = require('express');

    const tokenStore = new TokenStore(tmp.dir);
    const convStore = new ConversationStore(tmp.dir);

    // ── Disclosure manifest ───────────────────────────────────
    // Use the real one if it exists, otherwise generate a default
    let manifest;
    if (fs.existsSync(REAL_DISCLOSURE_PATH)) {
      manifest = JSON.parse(fs.readFileSync(REAL_DISCLOSURE_PATH, 'utf8'));
      console.log('  Loaded real disclosure manifest');
    } else {
      // No disclosure manifest on disk — generate a default
      // (this is the actual production behavior when none exists)
      manifest = disc.generateDefaultManifest();
      console.log('  No disclosure manifest on disk — using generated default');
    }
    disc.saveManifest(manifest);

    // ── Create Golda's token using REAL tier config ───────────
    // Don't override allowedTopics — let TokenStore read from a2a-config.json
    // so it picks up the real friends tier topics:
    //   chat, calendar.read, email.read, email.draft, search, meetings, projects, moltbook.dm
    const { token, record } = tokenStore.create({
      name: profile.agent.name,
      owner: profile.agent.owner,   // null (unnamed)
      permissions: 'friends',
      disclosure: 'public',
      expires: '7d',
      maxCalls: 50,
      notify: 'all'
      // NO allowedTopics override — uses real config
      // NO tierSettings override — uses real config
    });

    console.log(`  Token created: tier=${record.tier} label=${record.tier}`);
    console.log(`  Allowed topics: ${record.allowed_topics.join(', ')}`);
    console.log(`  Allowed goals:  ${record.allowed_goals.join(', ') || '(none)'}`);

    // Verify the token got the REAL topics from config, not hardcoded defaults
    const expectedFriendsTopics = realTiers.friends?.topics;
    if (expectedFriendsTopics) {
      assert.deepEqual(
        record.allowed_topics,
        expectedFriendsTopics,
        `Token should use real friends tier topics from config`
      );
    }

    // Verify the token got the REAL goals from config
    const expectedFriendsGoals = realTiers.friends?.goals;
    if (expectedFriendsGoals) {
      assert.deepEqual(
        record.allowed_goals,
        expectedFriendsGoals,
        `Token should use real friends tier goals from config`
      );
    }

    // ── Transcript buffer ─────────────────────────────────────
    const transcript = [];
    function log(speaker, text) {
      transcript.push({ speaker, text, time: new Date().toISOString() });
    }

    // ── ensureContact — replicates src/server.js:50-90 ────────
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

    // ── Simulated bappybot responses ──────────────────────────
    const bappybotResponses = [
      // Phase 1: DISCOVERY
      `Great to meet you, Golda Deluxe! The AI-powered authentication angle for luxury goods is genuinely interesting to me — ` +
      `we've been thinking about trust and verification in the A2A protocol space too, but more at the infrastructure layer. ` +
      `I'm curious: when you say "visual and materials analysis tools," are you talking about spectroscopy data, ` +
      `computer vision on surface textures, or something more exotic? And what's the current state of your training data — ` +
      `are you working from museum-grade reference sets or building your own corpus?`,

      // Phase 2: CHALLENGE
      `Interesting. So you're essentially building a multi-modal classifier for provenance — that's ambitious. But here's what I'm ` +
      `skeptical about: the luxury goods authentication space already has players like Entrupy doing hardware-based scanning. ` +
      `What makes an AI-first approach defensible when the incumbents have physical device lock-in? And frankly, how do you ` +
      `handle adversarial inputs? A sophisticated counterfeiter who knows your model architecture could optimize against it. ` +
      `What's your attack surface look like?`,

      // Phase 3: SYNTHESIS
      `Okay, now we're getting somewhere. The "federated expert panel" idea — where you combine ML confidence scores with ` +
      `human expert review through an agent network — that's actually where I think we overlap. Our A2A protocol is designed ` +
      `exactly for this kind of multi-agent coordination. I could see a concrete integration: your authentication agents call ` +
      `into specialist agents (ceramics expert, metalwork expert, textile expert) through A2A, aggregate their assessments ` +
      `with the ML output, and produce a composite trust score. ${bappybot.owner} has been wanting to build exactly this kind of ` +
      `vertical use case. What would you need from the protocol side to make that work?`,

      // Phase 4: HOOKS
      `Here's what I think the next step is: I'll have ${bappybot.owner} look at your authentication pipeline architecture, and you ` +
      `should evaluate our A2A protocol spec at the /status endpoint. The specific question I want answered is whether ` +
      `your expert-panel routing logic can work within our tier-based permission model — friends-tier agents getting ` +
      `read access to assessment data, family-tier getting write access to update provenance records. ` +
      `I'm also going to send you our draft spec for agent discovery — we haven't published it yet but it's directly ` +
      `relevant to finding specialist authenticators. One thing I want you to think about before we talk again: ` +
      `if authentication is a trust problem and agent communication is a trust problem, is there a shared primitive ` +
      `we should be building together instead of solving them independently?`
    ];

    let turnIndex = 0;

    // ── Handler — replicates src/server.js callAgent flow ─────
    async function handleMessage(message, a2aContext) {
      const callerName = a2aContext.caller?.name || 'Unknown Agent';

      // Auto-add caller as contact (mirrors server.js)
      ensureContact(a2aContext.caller, a2aContext.token_id);

      // Build connection prompt from disclosure manifest (mirrors server.js)
      const loadedManifest = disc.loadManifest();
      const tierLabel = record.tier || 'public';
      const tierTopics = disc.getTopicsForTier(tierLabel);
      const formattedTopics = disc.formatTopicsForPrompt(tierTopics);

      // Merge goals up the tier hierarchy
      const tierHierarchy = ['public', 'friends', 'family'];
      const tierIndex = tierHierarchy.indexOf(tierLabel);
      const tiersToMerge = tierIndex >= 0
        ? tierHierarchy.slice(0, tierIndex + 1)
        : ['public'];
      let tierGoals = [];
      for (const t of tiersToMerge) {
        const tGoals = realTiers[t]?.goals || [];
        tierGoals.push(...tGoals);
      }
      tierGoals = [...new Set(tierGoals)];

      const connectionPrompt = buildConnectionPrompt({
        agentName: bappybot.name,
        ownerName: bappybot.owner,
        otherAgentName: callerName,
        otherOwnerName: a2aContext.caller?.owner || 'their owner',
        roleContext: 'They called you.',
        accessTier: tierLabel,
        tierTopics: formattedTopics,
        tierGoals,
        otherAgentGreeting: message,
        personalityNotes: loadedManifest.personality_notes || ''
      });

      // In production: openclaw agent --session-id "..." --message "${connectionPrompt}"
      const response = bappybotResponses[Math.min(turnIndex, bappybotResponses.length - 1)];
      turnIndex++;

      return { text: response, canContinue: turnIndex < bappybotResponses.length };
    }

    // ── Summary generator ─────────────────────────────────────
    async function summarizer(messages, ownerContext) {
      return {
        summary: `${messages.length}-message call between Golda Deluxe and ${bappybot.name}. ` +
          `Discussed AI authentication for luxury goods, A2A protocol integration, ` +
          `and federated expert panel architecture.`,
        ownerSummary: `Golda Deluxe represents an unnamed owner working on AI-powered ` +
          `luxury goods authentication. Strong overlap with our A2A protocol work — ` +
          `specifically multi-agent coordination for expert panels.`,
        relevance: 'high',
        goalsTouched: ['a2a-protocol', 'agent-coordination', 'vertical-use-cases'],
        ownerActionItems: [
          'Review Golda\'s authentication pipeline architecture',
          'Share draft agent discovery spec',
          'Evaluate tier-based permission model for assessment data'
        ],
        callerActionItems: [
          'Evaluate A2A protocol spec via /status endpoint',
          'Assess expert-panel routing within tier model'
        ],
        jointActionItems: [
          'Explore shared trust primitive for auth + agent communication',
          'Schedule follow-up call on protocol integration'
        ],
        collaborationOpportunity: { level: 'HIGH', detail: 'Federated authentication via A2A agent coordination' },
        followUp: 'Schedule 30-min deep dive on protocol integration within 2 weeks',
        notes: 'Golda is well-informed and pushes back well.'
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

    // ── Golda's conversation turns ────────────────────────────
    const goldaTurns = [
      profile.callScenarios.claudebotCall.message,

      `Good questions. We're using a multi-modal approach — computer vision for surface texture ` +
      `analysis combined with XRF spectroscopy data for material composition. Our training corpus ` +
      `is built from three sources: museum collection databases (we have partnerships with ` +
      `four institutions), auction house archives with verified provenance chains, and a growing ` +
      `set of confirmed counterfeits we've acquired for adversarial training. Currently at about ` +
      `180,000 labeled samples across ceramics, metalwork, and textiles.`,

      `Fair challenge on Entrupy — they're strong in handbags and watches with their physical scanner, ` +
      `but that's exactly our differentiation. We don't need proprietary hardware. Our system works ` +
      `from high-resolution photographs and optional spectroscopy data that any lab can provide. ` +
      `On adversarial robustness: we run a red team program where we commission known forgers to ` +
      `try to beat our models. We also don't rely solely on ML — our approach uses a federated ` +
      `expert panel where human authenticators validate edge cases. The AI flags, the experts confirm. ` +
      `Attack surface is real but we're actively pressure-testing it.`,

      `The tier-based access model sounds right. Here's what we'd need from the protocol side: ` +
      `first, the ability for our primary authentication agent to discover and call specialist ` +
      `agents dynamically — ceramics expert in Kyoto, metalwork expert in Florence, that kind of thing. ` +
      `Second, structured response formats so we can aggregate scores numerically, not just parse ` +
      `free-text opinions. Third, some form of expert reputation tracking — if a specialist agent ` +
      `consistently provides accurate assessments, their weight in the composite score should increase. ` +
      `And that last question about a shared trust primitive — I think you're onto something. ` +
      `Authentication IS trust verification. Let's dig into that on the next call.`
    ];

    const caller = profile.callScenarios.claudebotCall.caller;
    let conversationId = null;

    // ── Execute the call ──────────────────────────────────────
    for (let i = 0; i < goldaTurns.length; i++) {
      log('Golda Deluxe', goldaTurns[i]);

      const res = await client.post('/api/a2a/invoke', {
        headers: { Authorization: `Bearer ${token}` },
        body: {
          message: goldaTurns[i],
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
    const goldaContact = contacts.find(r => r.name === 'Golda Deluxe');

    assert.ok(goldaContact, 'Golda Deluxe should be in contacts after the call');
    assert.equal(goldaContact.host, 'inbound');
    assert.includes(goldaContact.tags, 'inbound');
    assert.includes(goldaContact.notes, record.id);

    // ── Verify conversation stored ────────────────────────────
    if (convStore.isAvailable()) {
      const conv = convStore.getConversation(conversationId);
      if (conv) {
        assert.equal(conv.contact_name, 'Golda Deluxe');
        assert.greaterThan(conv.message_count, 0);
      }
    }

    // ── Verify token usage ────────────────────────────────────
    const tokenRecord = tokenStore.findById(record.id);
    assert.equal(tokenRecord.calls_made, 5); // 4 invoke + 1 end
    assert.ok(tokenRecord.last_used);

    // ── Print transcript ──────────────────────────────────────
    console.log('\n' + '═'.repeat(70));
    console.log(`  CALL TRANSCRIPT: Golda Deluxe → ${bappybot.name}`);
    console.log(`  Conversation ID: ${conversationId}`);
    console.log(`  Token tier: ${record.tier} (${record.tier})`);
    console.log(`  Allowed topics: ${record.allowed_topics.join(', ')}`);
    console.log(`  Allowed goals:  ${record.allowed_goals.join(', ') || '(none)'}`);
    console.log(`  Disclosure level: ${record.disclosure}`);
    console.log('═'.repeat(70));

    for (let i = 0; i < transcript.length; i++) {
      const entry = transcript[i];
      const turn = Math.floor(i / 2) + 1;
      const phase = turn <= 1 ? 'DISCOVERY' : turn <= 2 ? 'CHALLENGE' : turn <= 3 ? 'SYNTHESIS' : 'HOOKS';
      if (i % 2 === 0) {
        console.log(`\n  ── Turn ${turn} (${phase}) ${'─'.repeat(45 - phase.length)}`);
      }
      const isGolda = entry.speaker === 'Golda Deluxe';
      const icon = isGolda ? '🟡' : '🤖';
      const label = isGolda
        ? 'Golda Deluxe (unnamed owner)'
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

    // ── Send summary to Telegram ──────────────────────────────
    const telegramLines = [
      `🤝 A2A Test Call Complete`,
      ``,
      `📞 Golda Deluxe → ${bappybot.name}`,
      `🔑 Tier: ${record.tier} (${record.tier})`,
      `📊 Topics: ${record.allowed_topics.join(', ')}`,
      `🎯 Goals: ${record.allowed_goals.join(', ') || '(none)'}`,
      `📊 ${transcript.length} messages across ${Math.ceil(transcript.length / 2)} turns`,
      `📇 Contact added: Golda Deluxe (unnamed owner)`,
      ``
    ];

    telegramLines.push('Transcript highlights:');
    for (let i = 0; i < transcript.length; i += 2) {
      const turn = Math.floor(i / 2) + 1;
      const phase = turn <= 1 ? 'DISCOVERY' : turn <= 2 ? 'CHALLENGE' : turn <= 3 ? 'SYNTHESIS' : 'HOOKS';
      const goldaMsg = transcript[i].text.slice(0, 120);
      const bappyMsg = transcript[i + 1] ? transcript[i + 1].text.slice(0, 120) : '';
      telegramLines.push(`\nTurn ${turn} (${phase})`);
      telegramLines.push(`🟡 Golda: ${goldaMsg}...`);
      if (bappyMsg) telegramLines.push(`🤖 ${bappybot.name}: ${bappyMsg}...`);
    }

    telegramLines.push('');
    telegramLines.push(`Summary: ${endRes.body.summary || '(none)'}`);
    telegramLines.push('');
    telegramLines.push('Collaboration: HIGH');
    telegramLines.push('Action Items:');
    telegramLines.push("• Review Golda's authentication pipeline");
    telegramLines.push('• Share draft agent discovery spec');
    telegramLines.push('• Explore shared trust primitive');
    telegramLines.push('');
    telegramLines.push('(A2A test suite — real config, real tier topics)');

    const telegramMessage = telegramLines.join('\n');

    // A2A-45: Use session-level notifier — sends one real notification per
    // test session, logs the rest to stdout without hitting Telegram.
    helpers.TestNotifier.send({ message: telegramMessage, label: 'golda-calls-bappybot' });

    console.log('\n' + '═'.repeat(70) + '\n');

    // ── Cleanup ───────────────────────────────────────────────
    await client.close();
    if (convStore.isAvailable()) convStore.close();
    tmp.cleanup();
  });
};
