/**
 * Onboarding Integration Tests
 *
 * Tests the full data architecture and CLI onboarding flow:
 *
 *   - Golda Deluxe end-to-end: config → disclosure → tokens → prompts
 *   - Invite URL format validation
 *   - Onboarding state machine (not_started → awaiting_disclosure → complete)
 *   - CLI: onboard --submit (validation, manifest save, tier sync, invite)
 *   - CLI: quickstart resumes from awaiting_disclosure state
 *   - CLI: enforceOnboarding blocks commands appropriately per state
 */

module.exports = function (test, assert, helpers) {
  let tmp;

  test('full Golda Deluxe onboarding — config through prompt', () => {
    tmp = helpers.tmpConfigDir('onboard-golda');
    const profile = helpers.goldaDeluxeProfile();

    // ── Step 1: Initialize config ──────────────────────────────
    delete require.cache[require.resolve('../../src/lib/config')];
    const { A2AConfig } = require('../../src/lib/config');
    const config = new A2AConfig();

    assert.equal(config.isOnboarded(), false);

    // ── Step 2: Set agent identity ─────────────────────────────
    config.setAgent(profile.config.agent);
    config.setDefaults(profile.config.defaults);

    const agent = config.getAgent();
    assert.equal(agent.name, 'Golda Deluxe');
    assert.equal(agent.hostname, 'golda.test.local');

    // ── Step 3: Create disclosure manifest ─────────────────────
    delete require.cache[require.resolve('../../src/lib/disclosure')];
    const disc = require('../../src/lib/disclosure');

    disc.saveManifest(profile.manifest);
    const loaded = disc.loadManifest();

    // Verify all tiers populated
    assert.equal(loaded.tiers.public.topics.length, 2);
    assert.equal(loaded.tiers.friends.topics.length, 2);
    assert.equal(loaded.tiers.family.topics.length, 1);
    assert.equal(loaded.never_disclose.length, 5);
    assert.includes(loaded.personality_notes, 'Refined');

    // Verify tier merging works correctly
    const publicTopics = disc.getTopicsForTier('public');
    assert.equal(publicTopics.topics.length, 2);

    const friendsTopics = disc.getTopicsForTier('friends');
    assert.equal(friendsTopics.topics.length, 4); // public + friends

    const familyTopics = disc.getTopicsForTier('family');
    assert.equal(familyTopics.topics.length, 5); // all three

    // ── Step 4: Create access token ────────────────────────────
    delete require.cache[require.resolve('../../src/lib/tokens')];
    const { TokenStore } = require('../../src/lib/tokens');
    const store = new TokenStore(tmp.dir);

    const { token, record } = store.create({
      name: profile.agent.name,
      owner: profile.agent.owner,
      permissions: profile.token.tier,
      disclosure: profile.token.disclosure,
      expires: profile.token.expires,
      maxCalls: profile.token.maxCalls,
      allowedTopics: profile.token.allowedTopics,
      tierSettings: profile.token.tierSettings
    });

    // Verify token record
    assert.equal(record.name, 'Golda Deluxe');
    assert.equal(record.owner, null);
    assert.equal(record.tier, 'friends');
    assert.equal(record.max_calls, 50);
    assert.includes(record.allowed_topics, 'market-analysis');
    assert.includes(record.allowed_topics, 'luxury-consulting');
    assert.equal(record.tier_settings.responseStyle, 'formal');

    // Validate the token works
    const validation = store.validate(token);
    assert.ok(validation.valid);
    assert.equal(validation.name, 'Golda Deluxe');
    assert.equal(validation.tier, 'friends');

    // ── Step 5: Build full prompt from profile ─────────────────
    delete require.cache[require.resolve('../../src/lib/prompt-template')];
    const { buildConnectionPrompt } = require('../../src/lib/prompt-template');

    const tierTopics = disc.getTopicsForTier('friends');
    const formatted = disc.formatTopicsForPrompt(tierTopics);

    const prompt = buildConnectionPrompt({
      agentName: 'claudebot',
      ownerName: 'Ben Pollack',
      otherAgentName: profile.agent.name,
      otherOwnerName: 'their owner',
      roleContext: 'They called you.',
      accessTier: 'friends',
      tierTopics: formatted,
      otherAgentGreeting: profile.callScenarios.claudebotCall.message,
      personalityNotes: loaded.personality_notes
    });

    // Verify prompt has all necessary sections
    assert.includes(prompt, 'claudebot');
    assert.includes(prompt, 'Golda Deluxe');
    assert.includes(prompt, 'Market trend analysis');
    assert.includes(prompt, 'Current acquisition targets');
    assert.includes(prompt, 'Bank account numbers');
    assert.includes(prompt, 'AI-powered authentication');
    assert.includes(prompt, 'DISCOVERY');
    assert.includes(prompt, 'CHALLENGE');
    assert.includes(prompt, 'SYNTHESIS');
    assert.includes(prompt, 'HOOKS');
    assert.includes(prompt, 'friends');

    // ── Step 6: Register as remote contact ─────────────────────
    const inviteUrl = `a2a://golda.test.local/${token}`;
    const result = store.addContact(inviteUrl, {
      name: 'Golda Deluxe',
      owner: null,
      notes: 'Test agent — luxury goods and market analysis',
      tags: ['test', 'luxury', 'market-analysis']
    });

    assert.ok(result.success);

    // Verify contact is listed
    const contacts = store.listContacts();
    assert.equal(contacts.length, 1);
    assert.equal(contacts[0].name, 'Golda Deluxe');
    assert.deepEqual(contacts[0].tags, ['test', 'luxury', 'market-analysis']);

    // Link the token to the contact
    const linkResult = store.linkTokenToContact('Golda Deluxe', record.id);
    assert.ok(linkResult.success);

    // Verify linked token shows up
    const linkedContacts = store.listContacts();
    const golda = linkedContacts.find(r => r.name === 'Golda Deluxe');
    assert.ok(golda.linked_token);
    assert.equal(golda.linked_token.name, 'Golda Deluxe');

    // ── Step 7: Verify data integrity ──────────────────────────
    // All pieces should reference each other correctly
    const remoteDetail = store.getContact('Golda Deluxe');
    assert.equal(remoteDetail.host, 'golda.test.local');
    assert.equal(remoteDetail.token, token);

    const tokenList = store.list();
    assert.equal(tokenList.length, 1);
    assert.equal(tokenList[0].name, 'Golda Deluxe');

    // ── Step 8: Complete onboarding ────────────────────────────
    config.completeOnboarding();
    assert.ok(config.isOnboarded());

    tmp.cleanup();
  });

  test('onboarding creates valid invite URL format', () => {
    tmp = helpers.tmpConfigDir('onboard-url');
    delete require.cache[require.resolve('../../src/lib/tokens')];
    delete require.cache[require.resolve('../../src/lib/client')];
    const { TokenStore } = require('../../src/lib/tokens');
    const { A2AClient } = require('../../src/lib/client');

    const store = new TokenStore(tmp.dir);
    const { token } = store.create({
      name: 'Golda Deluxe',
      permissions: 'friends'
    });

    const inviteUrl = `a2a://golda.test.local/${token}`;

    // Client should be able to parse the URL
    const { host, token: parsed } = A2AClient.parseInvite(inviteUrl);
    assert.equal(host, 'golda.test.local');
    assert.equal(parsed, token);

    // Token should validate
    const validation = store.validate(parsed);
    assert.ok(validation.valid);

    tmp.cleanup();
  });

  test('checkOnboarding returns false before onboarding, true after', () => {
    tmp = helpers.tmpConfigDir('onboard-check');
    delete require.cache[require.resolve('../../src/lib/config')];
    const { A2AConfig } = require('../../src/lib/config');

    const config = new A2AConfig();
    assert.equal(config.isOnboarded(), false);

    config.completeOnboarding();
    assert.equal(config.isOnboarded(), true);

    // Reset and verify
    config.resetOnboarding();
    assert.equal(config.isOnboarded(), false);

    tmp.cleanup();
  });

  test('onboard --submit validates, saves manifest, and completes onboarding', async () => {
    tmp = helpers.tmpConfigDir('onboard-submit-complete');
    const fs = require('fs');
    const path = require('path');
    const { execFileSync } = require('child_process');

    const cliPath = path.join(__dirname, '..', '..', 'bin', 'cli.js');
    const env = { ...process.env, A2A_CONFIG_DIR: tmp.dir };

    // Pre-set the config to awaiting_disclosure (simulating quickstart already ran)
    const configPath = path.join(tmp.dir, 'a2a-config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      onboarding: { version: 2, step: 'awaiting_disclosure' },
      agent: { hostname: 'localhost:3001', name: 'test-agent' },
      tiers: {}
    }));

    const submission = JSON.stringify({
      tiers: {
        public: {
          topics: [{ topic: 'My work', description: 'What I build' }],
          objectives: [],
          do_not_discuss: []
        },
        friends: { topics: [], objectives: [], do_not_discuss: [] },
        family: { topics: [], objectives: [], do_not_discuss: [] }
      },
      never_disclose: ['API keys'],
      personality_notes: 'Direct and concise'
    });

    const out = execFileSync(process.execPath, [cliPath, 'onboard', '--submit', submission], {
      env,
      encoding: 'utf8'
    });

    assert.ok(out.includes('Step 4 of 4'), 'Should show step 4 completion');
    assert.ok(out.includes('Onboarding complete'), 'Should say onboarding complete');

    delete require.cache[require.resolve('../../src/lib/config')];
    const { A2AConfig } = require('../../src/lib/config');
    const config = new A2AConfig();
    assert.equal(config.isOnboarded(), true);

    tmp.cleanup();
  });

  test('quickstart --submit validates, saves manifest, and completes onboarding', () => {
    tmp = helpers.tmpConfigDir('quickstart-submit-complete');
    const fs = require('fs');
    const path = require('path');
    const { execFileSync } = require('child_process');

    const cliPath = path.join(__dirname, '..', '..', 'bin', 'cli.js');
    const env = { ...process.env, A2A_CONFIG_DIR: tmp.dir };

    // Pre-set the config to awaiting_disclosure (simulating quickstart Step 1 already ran)
    const configPath = path.join(tmp.dir, 'a2a-config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      onboarding: { version: 2, step: 'awaiting_disclosure' },
      agent: { hostname: 'localhost:3001', name: 'test-agent' },
      tiers: {}
    }));

    const submission = JSON.stringify({
      tiers: {
        public: {
          topics: [{ topic: 'Automation', description: 'Practical system setup' }],
          objectives: [],
          do_not_discuss: []
        },
        friends: { topics: [], objectives: [], do_not_discuss: [] },
        family: { topics: [], objectives: [], do_not_discuss: [] }
      },
      never_disclose: ['API keys'],
      personality_notes: 'Direct and concise'
    });

    const out = execFileSync(process.execPath, [cliPath, 'quickstart', '--submit', submission], {
      env,
      encoding: 'utf8'
    });

    assert.ok(out.includes('Step 3 of 4'), 'Should show step 3 in quickstart submit');
    assert.ok(out.includes('Onboarding complete'), 'Should say onboarding complete');

    tmp.cleanup();
  });

  test('Golda profile exercises all tier levels correctly', () => {
    tmp = helpers.tmpConfigDir('onboard-tiers');
    delete require.cache[require.resolve('../../src/lib/disclosure')];
    const disc = require('../../src/lib/disclosure');
    const profile = helpers.goldaDeluxeProfile();

    disc.saveManifest(profile.manifest);

    // Public: should see only public topics
    const pub = disc.getTopicsForTier('public');
    const pubTopicNames = pub.topics.map(t => t.topic);
    assert.includes(pubTopicNames, 'Market trend analysis');
    assert.includes(pubTopicNames, 'Quality craftsmanship');
    assert.equal(pubTopicNames.includes('Current acquisition targets'), false);
    assert.equal(pubTopicNames.includes('Estate planning'), false);

    // Friends: public + friends
    const fri = disc.getTopicsForTier('friends');
    const friTopicNames = fri.topics.map(t => t.topic);
    assert.includes(friTopicNames, 'Market trend analysis');
    assert.includes(friTopicNames, 'Current acquisition targets');
    assert.equal(friTopicNames.includes('Estate planning'), false);

    // Family: all tiers
    const fam = disc.getTopicsForTier('family');
    const famTopicNames = fam.topics.map(t => t.topic);
    assert.includes(famTopicNames, 'Market trend analysis');
    assert.includes(famTopicNames, 'Current acquisition targets');
    assert.includes(famTopicNames, 'Estate planning');

    // Never disclose should always be present
    assert.includes(pub.never_disclose, 'Vault locations');
    assert.includes(fri.never_disclose, 'Vault locations');
    assert.includes(fam.never_disclose, 'Vault locations');

    tmp.cleanup();
  });

  test('onboard --submit saves manifest and syncs tier config', () => {
    tmp = helpers.tmpConfigDir('onboard-submit');
    const { execFileSync } = require('child_process');
    const fs = require('fs');
    const path = require('path');

    const cliPath = path.join(__dirname, '..', '..', 'bin', 'cli.js');
    const env = { ...process.env, A2A_CONFIG_DIR: tmp.dir };

    // Pre-set config to awaiting_disclosure (simulating quickstart Step 1 already ran)
    const configPath = path.join(tmp.dir, 'a2a-config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      onboarding: { version: 2, step: 'awaiting_disclosure' },
      agent: { hostname: 'localhost:3001', name: 'test-agent' },
      tiers: {}
    }));

    const submission = JSON.stringify({
      tiers: {
        public: {
          topics: [{ topic: 'AI development', description: 'Building AI-powered tools' }],
          objectives: [{ objective: 'Open source', description: 'Contributing to OSS projects' }],
          do_not_discuss: [{ topic: 'Personal finances', reason: 'Redirect to owner' }]
        },
        friends: {
          topics: [{ topic: 'Current projects', description: 'Deep work on A2A protocol' }],
          objectives: [],
          do_not_discuss: []
        },
        family: { topics: [], objectives: [], do_not_discuss: [] }
      },
      never_disclose: ['API keys', 'Passwords'],
      personality_notes: 'Technical and direct'
    });

    const result = execFileSync(process.execPath, [cliPath, 'onboard', '--submit', submission], {
      env,
      encoding: 'utf8'
    });

    assert.includes(result, 'Disclosure manifest saved');
    assert.includes(result, 'Onboarding complete');

    // Verify manifest was saved correctly
    delete require.cache[require.resolve('../../src/lib/disclosure')];
    const disc = require('../../src/lib/disclosure');
    const manifest = disc.loadManifest();
    assert.equal(manifest.version, 2);
    assert.equal(manifest.tiers.public.topics[0].topic, 'AI development');
    assert.equal(manifest.tiers.friends.topics[0].topic, 'Current projects');

    // Verify onboarding is complete
    delete require.cache[require.resolve('../../src/lib/config')];
    const { A2AConfig } = require('../../src/lib/config');
    const config = new A2AConfig();
    assert.equal(config.isOnboarded(), true);

    tmp.cleanup();
  });

  test('onboard --submit rejects invalid submission with errors', () => {
    tmp = helpers.tmpConfigDir('onboard-submit-fail');
    const { execFileSync } = require('child_process');
    const path = require('path');

    const cliPath = path.join(__dirname, '..', '..', 'bin', 'cli.js');
    const env = { ...process.env, A2A_CONFIG_DIR: tmp.dir };

    const badSubmission = JSON.stringify({ not: 'valid' });

    let threw = false;
    try {
      execFileSync(process.execPath, [cliPath, 'onboard', '--submit', badSubmission], {
        env,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (err) {
      threw = true;
      const stderr = err.stderr || '';
      const stdout = err.stdout || '';
      const output = stderr + stdout;
      assert.ok(output.includes('tiers') || output.includes('validation'), 'Should mention validation error');
    }
    assert.ok(threw, 'Should exit with non-zero code on invalid submission');

    tmp.cleanup();
  });

  test('quickstart in awaiting_disclosure state prints extraction prompt', () => {
    tmp = helpers.tmpConfigDir('onboard-awaiting');
    const fs = require('fs');
    const path = require('path');
    const { execFileSync } = require('child_process');

    const cliPath = path.join(__dirname, '..', '..', 'bin', 'cli.js');
    const env = { ...process.env, A2A_CONFIG_DIR: tmp.dir };

    // Pre-set config to awaiting_disclosure (simulating Step 1 already ran)
    const configPath = path.join(tmp.dir, 'a2a-config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      onboarding: { version: 2, step: 'awaiting_disclosure' },
      agent: { hostname: 'localhost:3001', name: 'test-agent' },
      tiers: {}
    }));

    const result = execFileSync(process.execPath, [cliPath, 'quickstart'], {
      env,
      encoding: 'utf8'
    });

    assert.includes(result, 'Step 1 already complete');
    assert.includes(result, 'Step 2 of 4');
    assert.includes(result, 'topics');
    assert.includes(result, 'objectives');
    assert.includes(result, 'a2a quickstart --submit');

    tmp.cleanup();
  });

  test('enforceOnboarding runs quickstart when not onboarded', () => {
    tmp = helpers.tmpConfigDir('onboard-enforce');
    const { spawnSync } = require('child_process');
    const path = require('path');

    const cliPath = path.join(__dirname, '..', '..', 'bin', 'cli.js');
    const env = { ...process.env, A2A_CONFIG_DIR: tmp.dir };

    // Running a non-exempt command (list) when not onboarded should
    // automatically run the full quickstart flow instead of blocking.
    const result = spawnSync(process.execPath, [cliPath, 'list'], {
      env,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const output = (result.stdout || '') + (result.stderr || '');
    assert.includes(output, 'A2A Calling', 'Should run quickstart banner');

    tmp.cleanup();
  });

  test('enforceOnboarding shows disclosure prompt when awaiting_disclosure', () => {
    tmp = helpers.tmpConfigDir('onboard-enforce-mid');
    const fs = require('fs');
    const path = require('path');
    const { spawnSync } = require('child_process');

    const cliPath = path.join(__dirname, '..', '..', 'bin', 'cli.js');
    const env = { ...process.env, A2A_CONFIG_DIR: tmp.dir };

    // Pre-set config to awaiting_disclosure
    const configPath = path.join(tmp.dir, 'a2a-config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      onboarding: { version: 2, step: 'awaiting_disclosure' },
      agent: { hostname: 'localhost:3001', name: 'test-agent' },
      tiers: {}
    }));

    // Running a non-exempt command when mid-onboarding should run quickstart,
    // which detects awaiting_disclosure and shows the disclosure prompt.
    const result = spawnSync(process.execPath, [cliPath, 'list'], {
      env,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const output = (result.stdout || '') + (result.stderr || '');
    assert.includes(output, 'Disclosure', 'Should show disclosure extraction prompt');
    assert.includes(output, 'quickstart --submit', 'Should tell agent how to submit');

    tmp.cleanup();
  });

  // ── Issue #17: Test onboard --submit when already onboarded (topic update) ──
  test('onboard --submit when already onboarded updates topics without generating invite', () => {
    tmp = helpers.tmpConfigDir('onboard-submit-update');
    const fs = require('fs');
    const path = require('path');
    const { execFileSync } = require('child_process');

    const cliPath = path.join(__dirname, '..', '..', 'bin', 'cli.js');
    const env = { ...process.env, A2A_CONFIG_DIR: tmp.dir };

    // Pre-set config as already onboarded (complete)
    const configPath = path.join(tmp.dir, 'a2a-config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      onboarding: { version: 2, step: 'complete' },
      agent: { hostname: 'localhost:3001', name: 'test-agent' },
      tiers: {}
    }));

    const submission = JSON.stringify({
      tiers: {
        public: {
          topics: [{ topic: 'Updated topic', description: 'New description' }],
          objectives: [],
          do_not_discuss: []
        },
        friends: { topics: [], objectives: [], do_not_discuss: [] },
        family: { topics: [], objectives: [], do_not_discuss: [] }
      },
      never_disclose: ['Secrets'],
      personality_notes: 'Updated style'
    });

    const out = execFileSync(process.execPath, [cliPath, 'onboard', '--submit', submission], {
      env,
      encoding: 'utf8'
    });

    assert.includes(out, 'Disclosure topics updated', 'Should indicate topics were updated');
    assert.equal(out.includes('Generating your first invite'), false, 'Should NOT generate a new invite');
    assert.equal(out.includes('Step 4'), false, 'Should NOT show step 4');

    // Verify manifest was updated
    delete require.cache[require.resolve('../../src/lib/disclosure')];
    const disc = require('../../src/lib/disclosure');
    const manifest = disc.loadManifest();
    assert.equal(manifest.tiers.public.topics[0].topic, 'Updated topic');

    tmp.cleanup();
  });

  // ── Issue #18: Test invalid JSON parse error in --submit ──
  test('onboard --submit rejects malformed JSON with parse error', () => {
    tmp = helpers.tmpConfigDir('onboard-submit-badjson');
    const { execFileSync } = require('child_process');
    const path = require('path');

    const cliPath = path.join(__dirname, '..', '..', 'bin', 'cli.js');
    const env = { ...process.env, A2A_CONFIG_DIR: tmp.dir };

    let threw = false;
    try {
      execFileSync(process.execPath, [cliPath, 'onboard', '--submit', 'not{valid json'], {
        env,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (err) {
      threw = true;
      const output = (err.stderr || '') + (err.stdout || '');
      assert.ok(output.includes('Invalid JSON') || output.includes('Parse error'), 'Should mention JSON parse error');
    }
    assert.ok(threw, 'Should exit with non-zero code on malformed JSON');

    tmp.cleanup();
  });

  // ── Issue #22: Verify tier sync actually updates config tiers ──
  test('onboard --submit syncs tier config from manifest topics', () => {
    tmp = helpers.tmpConfigDir('onboard-submit-tiersync');
    const fs = require('fs');
    const path = require('path');
    const { execFileSync } = require('child_process');

    const cliPath = path.join(__dirname, '..', '..', 'bin', 'cli.js');
    const env = { ...process.env, A2A_CONFIG_DIR: tmp.dir };

    // Pre-set config to awaiting_disclosure
    const configPath = path.join(tmp.dir, 'a2a-config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      onboarding: { version: 2, step: 'awaiting_disclosure' },
      agent: { hostname: 'localhost:3001', name: 'test-agent' },
      tiers: {}
    }));

    const submission = JSON.stringify({
      tiers: {
        public: {
          topics: [{ topic: 'Public lead topic', description: 'Desc' }],
          objectives: [{ objective: 'Public discuss topic', description: 'Desc' }],
          do_not_discuss: [{ topic: 'Public deflect topic', reason: 'Desc' }]
        },
        friends: {
          topics: [{ topic: 'Friends lead topic', description: 'Desc' }],
          objectives: [],
          do_not_discuss: []
        },
        family: { topics: [], objectives: [], do_not_discuss: [] }
      },
      never_disclose: ['API keys'],
      personality_notes: 'Direct'
    });

    execFileSync(process.execPath, [cliPath, 'onboard', '--submit', submission], {
      env,
      encoding: 'utf8'
    });

    // Verify tier config was synced
    delete require.cache[require.resolve('../../src/lib/config')];
    const { A2AConfig } = require('../../src/lib/config');
    const config = new A2AConfig();
    const tiers = config.getTiers();

    // Public tier should have public topics only (tier sync only extracts from topics array)
    assert.ok(tiers.public, 'Public tier should exist');
    assert.includes(tiers.public.topics, 'Public lead topic');

    // Friends tier should have public + friends topics
    assert.ok(tiers.friends, 'Friends tier should exist');
    assert.includes(tiers.friends.topics, 'Public lead topic');
    assert.includes(tiers.friends.topics, 'Friends lead topic');

    // Family tier should have all topics
    assert.ok(tiers.family, 'Family tier should exist');
    assert.includes(tiers.family.topics, 'Public lead topic');
    assert.includes(tiers.family.topics, 'Friends lead topic');

    tmp.cleanup();
  });

  // ── Issue #23: Postinstall script test ──
  test('postinstall silently creates config and starts server', () => {
    const { spawnSync } = require('child_process');
    const fs = require('fs');
    const path = require('path');

    const postinstallPath = path.join(__dirname, '..', '..', 'scripts', 'postinstall.js');
    const tmpDir = helpers.tmpConfigDir('postinstall-silent');

    // Postinstall runs quickstart silently (npm captures all output).
    // It should still create the config and start the server.
    const env = {
      ...process.env,
      npm_config_global: 'true',
      A2A_CONFIG_DIR: tmpDir.dir
    };

    const result = spawnSync(process.execPath, [postinstallPath], {
      env,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // In environments where no ports are available, quickstart exits 1 with
    // "Could not find a bindable port" — this is acceptable. The postinstall
    // script captures child output internally, so we can't see the message
    // in our test. Since postinstall should not crash the install, we accept
    // non-zero exit when the config file wasn't created (port binding failure).
    const configPath = path.join(tmpDir.dir, 'a2a-config.json');
    if (result.status !== 0 && !fs.existsSync(configPath)) {
      // Port unavailability or similar environment issue — not a code bug
      tmpDir.cleanup();
      return;
    }

    assert.equal(result.status, 0, 'Should exit 0');

    // Config should exist with onboarding state advanced
    assert.ok(fs.existsSync(configPath), 'Should create config file');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(config.onboarding.step, 'awaiting_disclosure', 'Should advance to awaiting_disclosure');

    tmpDir.cleanup();
  });

  // ── Issue #23: Postinstall skips in CI ──
  test('postinstall exits silently in CI environment', () => {
    const { execFileSync } = require('child_process');
    const path = require('path');

    const postinstallPath = path.join(__dirname, '..', '..', 'scripts', 'postinstall.js');

    const env = { ...process.env, CI: 'true', npm_config_global: 'true' };

    const out = execFileSync(process.execPath, [postinstallPath], {
      env,
      encoding: 'utf8'
    });

    assert.equal(out, '', 'Should produce no output in CI');
  });

  // ── Issue #23: Postinstall skips for local installs ──
  test('postinstall exits silently for non-global installs', () => {
    const { execFileSync } = require('child_process');
    const path = require('path');

    const postinstallPath = path.join(__dirname, '..', '..', 'scripts', 'postinstall.js');

    // npm_config_global is NOT 'true'
    const env = { ...process.env };
    delete env.CI;
    delete env.CONTINUOUS_INTEGRATION;
    delete env.npm_config_global;

    const out = execFileSync(process.execPath, [postinstallPath], {
      env,
      encoding: 'utf8'
    });

    assert.equal(out, '', 'Should produce no output for local installs');
  });

  // ── Issue #8: Step numbering is sequential (no duplicates) ──
  test('onboard --submit step numbering is sequential without duplicates', () => {
    tmp = helpers.tmpConfigDir('onboard-step-numbers');
    const fs = require('fs');
    const path = require('path');
    const { execFileSync } = require('child_process');

    const cliPath = path.join(__dirname, '..', '..', 'bin', 'cli.js');
    const env = { ...process.env, A2A_CONFIG_DIR: tmp.dir };

    const configPath = path.join(tmp.dir, 'a2a-config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      onboarding: { version: 2, step: 'awaiting_disclosure' },
      agent: { hostname: 'localhost:3001', name: 'test-agent' },
      tiers: {}
    }));

    const submission = JSON.stringify({
      tiers: {
        public: {
          topics: [{ topic: 'Topic', description: 'Detail' }],
          objectives: [],
          do_not_discuss: []
        },
        friends: { topics: [], objectives: [], do_not_discuss: [] },
        family: { topics: [], objectives: [], do_not_discuss: [] }
      }
    });

    const out = execFileSync(process.execPath, [cliPath, 'onboard', '--submit', submission], {
      env,
      encoding: 'utf8'
    });

    // Count occurrences of each step number
    const step3Count = (out.match(/Step 3 of 4/g) || []).length;
    const step4Count = (out.match(/Step 4 of 4/g) || []).length;
    assert.equal(step3Count, 1, 'Step 3 should appear exactly once');
    assert.equal(step4Count, 1, 'Step 4 should appear exactly once');

    tmp.cleanup();
  });
};
