/**
 * Disclosure Manifest Tests
 *
 * Covers: manifest load/save, tier merging, topic formatting,
 * default manifest generation, context file reading, and disclosure validation.
 */

module.exports = function (test, assert, helpers) {
  let tmp;

  function freshDisclosure() {
    if (tmp) tmp.cleanup();
    tmp = helpers.tmpConfigDir('disc');
    delete require.cache[require.resolve('../../src/lib/disclosure')];
    return require('../../src/lib/disclosure');
  }

  // ── Load / Save ───────────────────────────────────────────────

  test('loadManifest returns {} when no file exists', () => {
    const disc = freshDisclosure();
    const manifest = disc.loadManifest();
    assert.deepEqual(manifest, {});
    tmp.cleanup();
  });

  test('saveManifest writes and loadManifest reads back', () => {
    const disc = freshDisclosure();
    const profile = helpers.goldaDeluxeProfile();

    disc.saveManifest(profile.manifest);
    const loaded = disc.loadManifest();

    assert.equal(loaded.version, 2);
    assert.ok(loaded.updated_at);
    assert.equal(loaded.tiers.public.topics.length, 2);
    assert.equal(loaded.tiers.public.topics[0].topic, 'Market trend analysis');
    tmp.cleanup();
  });

  // ── Tier Merging ──────────────────────────────────────────────

  test('public tier gets only public topics', () => {
    const disc = freshDisclosure();
    const profile = helpers.goldaDeluxeProfile();
    disc.saveManifest(profile.manifest);

    const topics = disc.getTopicsForTier('public');

    assert.equal(topics.topics.length, 2); // only public topics
    assert.equal(topics.objectives.length, 3); // only public objectives
    assert.equal(topics.do_not_discuss.length, 2); // only public do_not_discuss
    assert.greaterThan(topics.never_disclose.length, 0);
    tmp.cleanup();
  });

  test('friends tier merges public + friends topics', () => {
    const disc = freshDisclosure();
    const profile = helpers.goldaDeluxeProfile();
    disc.saveManifest(profile.manifest);

    const topics = disc.getTopicsForTier('friends');

    // topics: 2 public + 2 friends = 4
    assert.equal(topics.topics.length, 4);
    // objectives: 3 public + 3 friends = 6
    assert.equal(topics.objectives.length, 6);
    // never_disclose is always included
    assert.greaterThan(topics.never_disclose.length, 0);
    tmp.cleanup();
  });

  test('family tier merges all three tiers', () => {
    const disc = freshDisclosure();
    const profile = helpers.goldaDeluxeProfile();
    disc.saveManifest(profile.manifest);

    const topics = disc.getTopicsForTier('family');

    // topics: 2 public + 2 friends + 1 family = 5
    assert.equal(topics.topics.length, 5);
    // objectives: 3 public + 3 friends + 2 family = 8
    assert.equal(topics.objectives.length, 8);
    tmp.cleanup();
  });

  test('promoted topics are removed from deflect', () => {
    const disc = freshDisclosure();

    // Create a manifest where a public do_not_discuss topic is promoted in friends
    disc.saveManifest({
      version: 2,
      tiers: {
        public: {
          topics: [],
          objectives: [],
          do_not_discuss: [{ topic: 'Investment stuff', reason: 'redirect' }]
        },
        friends: {
          topics: [{ topic: 'Investment stuff', description: 'now available!' }],
          objectives: [],
          do_not_discuss: []
        },
        family: { topics: [], objectives: [], do_not_discuss: [] }
      },
      never_disclose: []
    });

    const topics = disc.getTopicsForTier('friends');
    const doNotDiscussTopics = topics.do_not_discuss.map(t => t.topic);
    assert.equal(doNotDiscussTopics.includes('Investment stuff'), false);
    tmp.cleanup();
  });

  test('unknown tier falls back to public', () => {
    const disc = freshDisclosure();
    const profile = helpers.goldaDeluxeProfile();
    disc.saveManifest(profile.manifest);

    const topics = disc.getTopicsForTier('stranger');
    assert.equal(topics.topics.length, 2); // same as public
    tmp.cleanup();
  });

  // ── Topic Formatting ─────────────────────────────────────────

  test('formatTopicsForPrompt produces readable bullet points', () => {
    const disc = freshDisclosure();
    const profile = helpers.goldaDeluxeProfile();
    disc.saveManifest(profile.manifest);

    const topics = disc.getTopicsForTier('friends');
    const formatted = disc.formatTopicsForPrompt(topics);

    assert.includes(formatted.topics, 'Market trend analysis');
    assert.includes(formatted.objectives, 'Art and design history');
    assert.includes(formatted.neverDisclose, 'Bank account numbers');
    // Each item starts with "  - "
    assert.includes(formatted.topics, '  - ');
    tmp.cleanup();
  });

  test('formatTopicsForPrompt handles empty lists', () => {
    const disc = freshDisclosure();
    const formatted = disc.formatTopicsForPrompt({
      topics: [],
      objectives: [],
      do_not_discuss: [],
      never_disclose: []
    });

    assert.includes(formatted.topics, '(none specified)');
    assert.includes(formatted.neverDisclose, '(none specified)');
    tmp.cleanup();
  });

  // ── Default Manifest Generation ───────────────────────────────

  test('generateDefaultManifest with no context returns starter', () => {
    const disc = freshDisclosure();
    const manifest = disc.generateDefaultManifest();

    assert.equal(manifest.version, 2);
    assert.ok(manifest.tiers.public.topics.length > 0);
    assert.ok(manifest.tiers.public.objectives.length > 0);
    assert.ok(manifest.tiers.public.do_not_discuss.length > 0);
    assert.greaterThan(manifest.never_disclose.length, 0);
    tmp.cleanup();
  });

  test('generateDefaultManifest returns minimal starter when no context files are provided', () => {
    const disc = freshDisclosure();
    const manifest = disc.generateDefaultManifest();

    // Should return only the minimal starter
    assert.equal(manifest.tiers.public.topics.length, 1);
    assert.equal(manifest.tiers.public.topics[0].topic, 'What I do');
    assert.equal(manifest.tiers.public.objectives.length, 1);
    assert.equal(manifest.tiers.public.do_not_discuss.length, 1);
    assert.equal(manifest.tiers.friends.topics.length, 0);
    assert.equal(manifest.tiers.friends.objectives.length, 0);
    assert.equal(manifest.tiers.family.topics.length, 0);
    assert.equal(manifest.tiers.family.objectives.length, 0);
    assert.greaterThan(manifest.never_disclose.length, 0);
    tmp.cleanup();
  });

  // ── Context File Reading ──────────────────────────────────────

  test('readContextFiles returns empty strings for missing files', () => {
    const disc = freshDisclosure();
    const result = disc.readContextFiles('/nonexistent/path');
    assert.equal(result.user, '');
    assert.equal(result.heartbeat, '');
    assert.equal(result.soul, '');
    assert.equal(result.skill, '');
    assert.equal(result.claude, '');
    assert.equal(result.memory, '');
    tmp.cleanup();
  });

  test('readContextFiles reads existing files', () => {
    const disc = freshDisclosure();
    const fs = require('fs');
    const path = require('path');

    fs.writeFileSync(path.join(tmp.dir, 'USER.md'), '# Test User');
    fs.writeFileSync(path.join(tmp.dir, 'SOUL.md'), '# Test Soul');

    const result = disc.readContextFiles(tmp.dir);
    assert.equal(result.user, '# Test User');
    assert.equal(result.soul, '# Test Soul');
    assert.equal(result.heartbeat, '');
    tmp.cleanup();
  });

  test('readContextFiles reads SKILL.md and CLAUDE.md', () => {
    const disc = freshDisclosure();
    const fs = require('fs');
    const path = require('path');

    fs.writeFileSync(path.join(tmp.dir, 'SKILL.md'), '# My Skill');
    fs.writeFileSync(path.join(tmp.dir, 'CLAUDE.md'), '# Project Config');

    const result = disc.readContextFiles(tmp.dir);
    assert.equal(result.skill, '# My Skill');
    assert.equal(result.claude, '# Project Config');
    tmp.cleanup();
  });

  test('readContextFiles reads memory/*.md files', () => {
    const disc = freshDisclosure();
    const fs = require('fs');
    const path = require('path');

    const memDir = path.join(tmp.dir, 'memory');
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, 'notes.md'), '- Important note');
    fs.writeFileSync(path.join(memDir, 'context.md'), '- Another note');

    const result = disc.readContextFiles(tmp.dir);
    assert.ok(result.memory.includes('Important note'));
    assert.ok(result.memory.includes('Another note'));
    tmp.cleanup();
  });

  // ── Disclosure Submission Validation ──────────────────────────

  test('validateDisclosureSubmission accepts valid submission', () => {
    const disc = freshDisclosure();
    const result = disc.validateDisclosureSubmission({
      tiers: {
        public: {
          topics: [{ topic: 'AI development', description: 'Building AI tools' }],
          objectives: [{ objective: 'Open source', description: 'Contributing to OSS' }],
          do_not_discuss: [{ topic: 'Personal life', reason: 'Redirect to owner' }]
        },
        friends: { topics: [], objectives: [], do_not_discuss: [] },
        family: { topics: [], objectives: [], do_not_discuss: [] }
      },
      never_disclose: ['API keys'],
      personality_notes: 'Friendly and technical'
    });
    assert.ok(result.valid);
    assert.equal(result.errors.length, 0);
    assert.ok(result.manifest);
    assert.equal(result.manifest.version, 2);
    tmp.cleanup();
  });

  test('validateDisclosureSubmission rejects non-object input', () => {
    const disc = freshDisclosure();
    const result = disc.validateDisclosureSubmission('not an object');
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
    assert.ok(result.errors[0].includes('object'));
    tmp.cleanup();
  });

  test('validateDisclosureSubmission rejects missing tiers', () => {
    const disc = freshDisclosure();
    const result = disc.validateDisclosureSubmission({
      never_disclose: ['secrets'],
      personality_notes: 'Nice'
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('tiers')));
    tmp.cleanup();
  });

  test('validateDisclosureSubmission rejects missing tier', () => {
    const disc = freshDisclosure();
    const result = disc.validateDisclosureSubmission({
      tiers: {
        public: { topics: [], objectives: [], do_not_discuss: [] }
      },
      never_disclose: [],
      personality_notes: ''
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('friends')));
    tmp.cleanup();
  });

  test('validateDisclosureSubmission rejects invalid topic shape', () => {
    const disc = freshDisclosure();
    const result = disc.validateDisclosureSubmission({
      tiers: {
        public: {
          topics: ['just a string'],
          objectives: [],
          do_not_discuss: []
        },
        friends: { topics: [], objectives: [], do_not_discuss: [] },
        family: { topics: [], objectives: [], do_not_discuss: [] }
      },
      never_disclose: [],
      personality_notes: ''
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('topic')));
    tmp.cleanup();
  });

  test('validateDisclosureSubmission enforces max topic length', () => {
    const disc = freshDisclosure();
    const longTopic = 'A'.repeat(200);
    const result = disc.validateDisclosureSubmission({
      tiers: {
        public: {
          topics: [{ topic: longTopic, description: 'Too long topic' }],
          objectives: [],
          do_not_discuss: []
        },
        friends: { topics: [], objectives: [], do_not_discuss: [] },
        family: { topics: [], objectives: [], do_not_discuss: [] }
      },
      never_disclose: [],
      personality_notes: ''
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('160')));
    tmp.cleanup();
  });

  // ── Extraction Prompt Generation ──────────────────────────────

  test('buildExtractionPrompt returns string with JSON schema', () => {
    const disc = freshDisclosure();
    const prompt = disc.buildExtractionPrompt();
    assert.equal(typeof prompt, 'string');
    assert.includes(prompt, 'topics');
    assert.includes(prompt, 'objectives');
    assert.includes(prompt, 'do_not_discuss');
    assert.includes(prompt, 'never_disclose');
    assert.includes(prompt, 'personality_notes');
    assert.includes(prompt, 'public');
    assert.includes(prompt, 'friends');
    assert.includes(prompt, 'family');
    tmp.cleanup();
  });

  test('buildExtractionPrompt lists available context files', () => {
    const disc = freshDisclosure();
    const prompt = disc.buildExtractionPrompt({ 'USER.md': true, 'SOUL.md': true, 'HEARTBEAT.md': false });
    assert.includes(prompt, 'USER.md');
    assert.includes(prompt, 'SOUL.md');
    tmp.cleanup();
  });

  test('buildExtractionPrompt includes guidance on what NOT to extract', () => {
    const disc = freshDisclosure();
    const prompt = disc.buildExtractionPrompt();
    assert.includes(prompt, 'URL');
    assert.includes(prompt, 'code');
    tmp.cleanup();
  });

  // ── Adversarial Input Hardening Tests ──────────────────────────

  test('validateDisclosureSubmission strips extra properties from topic items', () => {
    const disc = freshDisclosure();
    const result = disc.validateDisclosureSubmission({
      tiers: {
        public: {
          topics: [{ topic: 'AI development', description: 'Building AI tools', extra: 'should be stripped' }],
          objectives: [],
          do_not_discuss: []
        },
        friends: { topics: [], objectives: [], do_not_discuss: [] },
        family: { topics: [], objectives: [], do_not_discuss: [] }
      },
      never_disclose: [],
      personality_notes: ''
    });
    assert.ok(result.valid);
    assert.equal(result.manifest.tiers.public.topics[0].extra, undefined);
    assert.equal(Object.keys(result.manifest.tiers.public.topics[0]).length, 2);
    tmp.cleanup();
  });

  test('validateDisclosureSubmission rejects extra tiers', () => {
    const disc = freshDisclosure();
    const result = disc.validateDisclosureSubmission({
      tiers: {
        public: { topics: [], objectives: [], do_not_discuss: [] },
        friends: { topics: [], objectives: [], do_not_discuss: [] },
        family: { topics: [], objectives: [], do_not_discuss: [] },
        admin: { topics: [], objectives: [], do_not_discuss: [] }
      },
      never_disclose: [],
      personality_notes: ''
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('admin')));
    tmp.cleanup();
  });

  test('validateDisclosureSubmission rejects empty topic strings', () => {
    const disc = freshDisclosure();
    const result = disc.validateDisclosureSubmission({
      tiers: {
        public: {
          topics: [{ topic: '', description: 'Empty topic' }],
          objectives: [],
          do_not_discuss: []
        },
        friends: { topics: [], objectives: [], do_not_discuss: [] },
        family: { topics: [], objectives: [], do_not_discuss: [] }
      },
      never_disclose: [],
      personality_notes: ''
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('empty')));
    tmp.cleanup();
  });

  test('validateDisclosureSubmission enforces array size limits', () => {
    const disc = freshDisclosure();
    const items = Array.from({ length: 25 }, (_, i) => ({ topic: `Topic ${i}`, description: `Detail ${i}` }));
    const result = disc.validateDisclosureSubmission({
      tiers: {
        public: {
          topics: items,
          objectives: [],
          do_not_discuss: []
        },
        friends: { topics: [], objectives: [], do_not_discuss: [] },
        family: { topics: [], objectives: [], do_not_discuss: [] }
      },
      never_disclose: [],
      personality_notes: ''
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('max')));
    tmp.cleanup();
  });

  test('validateDisclosureSubmission allows proper nouns in topics', () => {
    const disc = freshDisclosure();
    const result = disc.validateDisclosureSubmission({
      tiers: {
        public: {
          topics: [
            { topic: 'iPhone app development', description: 'Building iOS apps' },
            { topic: 'LinkedIn networking', description: 'Professional connections via LinkedIn' }
          ],
          objectives: [
            { objective: 'WordPress consulting', description: 'WordPress site building' },
            { objective: 'YouTube content creation', description: 'Creating YouTube videos' }
          ],
          do_not_discuss: []
        },
        friends: { topics: [], objectives: [], do_not_discuss: [] },
        family: { topics: [], objectives: [], do_not_discuss: [] }
      },
      never_disclose: [],
      personality_notes: ''
    });
    assert.ok(result.valid, 'Proper nouns should not be rejected as technical content');
    tmp.cleanup();
  });
};
