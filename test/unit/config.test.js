/**
 * Configuration Management Tests
 *
 * Covers: default config, onboarding lifecycle, tier management,
 * agent info, defaults, and persistence across instances.
 */

module.exports = function (test, assert, helpers) {
  let tmp;

  function freshConfig() {
    if (tmp) tmp.cleanup();
    tmp = helpers.tmpConfigDir('cfg');
    delete require.cache[require.resolve('../../src/lib/config')];
    const { A2AConfig } = require('../../src/lib/config');
    return new A2AConfig();
  }

  // ── Defaults ──────────────────────────────────────────────────

  test('fresh config has expected defaults', () => {
    const config = freshConfig();
    const all = config.getAll();

    assert.equal(all.onboarding.version, 2);
    assert.equal(all.onboarding.step, 'not_started');
    assert.ok(all.tiers.public);
    assert.ok(all.tiers.friends);
    assert.ok(all.tiers.family);
    assert.ok(all.tiers.custom);
    assert.equal(all.defaults.maxCalls, 100);
    assert.equal(all.defaults.rateLimit.perMinute, 10);
    tmp.cleanup();
  });

  // ── Onboarding ────────────────────────────────────────────────

  test('onboarding lifecycle: not started → complete → reset', () => {
    const config = freshConfig();

    assert.equal(config.isOnboarded(), false);

    config.completeOnboarding();
    assert.equal(config.isOnboarded(), true);

    config.resetOnboarding();
    assert.equal(config.isOnboarded(), false);
    tmp.cleanup();
  });

  // ── Tier Management ───────────────────────────────────────────

  test('getTiers returns all tier definitions', () => {
    const config = freshConfig();
    const tiers = config.getTiers();

    assert.equal(tiers.public.name, 'Public');
    assert.equal(tiers.friends.name, 'Friends');
    assert.equal(tiers.family.name, 'Family');
    tmp.cleanup();
  });

  test('setTier merges into existing tier config', () => {
    const config = freshConfig();
    config.setTier('public', {
      description: 'Updated description',
      capabilities: ['context-read', 'search']
    });

    const tiers = config.getTiers();
    assert.equal(tiers.public.description, 'Updated description');
    assert.deepEqual(tiers.public.capabilities, ['context-read', 'search']);
    assert.equal(tiers.public.name, 'Public'); // original field preserved
    tmp.cleanup();
  });

  test('default tiers include default capabilities', () => {
    const config = freshConfig();
    const tiers = config.getTiers();

    assert.deepEqual(tiers.public.capabilities, ['context-read']);
    assert.includes(tiers.friends.capabilities, 'context-read');
    assert.includes(tiers.friends.capabilities, 'calendar.read');
    assert.includes(tiers.family.capabilities, 'tools');
    assert.includes(tiers.family.capabilities, 'memory');
    assert.deepEqual(tiers.custom.capabilities, ['context-read']);
    tmp.cleanup();
  });

  test('default tiers include empty topics and goals arrays', () => {
    const config = freshConfig();
    const tiers = config.getTiers();

    assert.ok(Array.isArray(tiers.public.topics));
    assert.ok(tiers.public.topics.length > 0);
    assert.deepEqual(tiers.public.goals, []);
    assert.ok(Array.isArray(tiers.friends.topics));
    assert.ok(tiers.friends.topics.length > 0);
    assert.deepEqual(tiers.friends.goals, []);
    assert.ok(Array.isArray(tiers.family.topics));
    assert.ok(tiers.family.topics.length > 0);
    assert.deepEqual(tiers.family.goals, []);
    tmp.cleanup();
  });

  test('setTier can set goals independently of topics', () => {
    const config = freshConfig();
    config.setTier('friends', {
      topics: ['chat', 'calendar.read'],
      goals: ['find-collaborators', 'explore-partnerships']
    });

    const tiers = config.getTiers();
    assert.deepEqual(tiers.friends.topics, ['chat', 'calendar.read']);
    assert.deepEqual(tiers.friends.goals, ['find-collaborators', 'explore-partnerships']);
    assert.equal(tiers.friends.name, 'Friends'); // preserved
    tmp.cleanup();
  });

  test('setTier validates topics/goals schema', () => {
    const config = freshConfig();
    assert.throws(() => config.setTier('friends', { topics: 'chat' }));
    assert.throws(() => config.setTier('friends', { goals: { a: 1 } }));
    assert.throws(() => config.setTier('friends', { topics: ['ok', 123] }));
    tmp.cleanup();
  });

  // ── Agent Info ────────────────────────────────────────────────

  test('setAgent and getAgent round-trip', () => {
    const config = freshConfig();
    const profile = helpers.goldaDeluxeProfile();

    config.setAgent(profile.config.agent);
    const agent = config.getAgent();

    assert.equal(agent.name, 'Golda Deluxe');
    assert.includes(agent.description, 'luxury goods');
    assert.equal(agent.hostname, 'golda.test.local');
    tmp.cleanup();
  });

  // ── Defaults ──────────────────────────────────────────────────

  test('setDefaults merges into existing defaults', () => {
    const config = freshConfig();
    const profile = helpers.goldaDeluxeProfile();

    config.setDefaults(profile.config.defaults);
    const defaults = config.getDefaults();

    assert.equal(defaults.expiration, '7d');
    assert.equal(defaults.maxCalls, 50);
    assert.equal(defaults.rateLimit.perMinute, 5);
    assert.equal(defaults.maxPendingRequests, 5); // original default preserved
    tmp.cleanup();
  });

  // ── Persistence ───────────────────────────────────────────────

  test('config persists across instances', () => {
    const config1 = freshConfig();
    config1.setAgent({ name: 'Golda Deluxe' });
    config1.completeOnboarding();

    // Create new instance pointing at same dir
    delete require.cache[require.resolve('../../src/lib/config')];
    const { A2AConfig } = require('../../src/lib/config');
    const config2 = new A2AConfig();

    assert.equal(config2.getAgent().name, 'Golda Deluxe');
    assert.equal(config2.isOnboarded(), true);
    tmp.cleanup();
  });

  // ── Export ────────────────────────────────────────────────────

  test('export returns shareable subset', () => {
    const config = freshConfig();
    config.setAgent({ name: 'Test' });

    const exported = config.export();
    assert.ok(exported.tiers);
    assert.ok(exported.defaults);
    assert.ok(exported.agent);
    assert.equal(exported.onboarding, undefined); // private field excluded
    tmp.cleanup();
  });

  test('auto-update config round-trips', () => {
    const config = freshConfig();
    const initial = config.getAutoUpdate();
    assert.equal(initial.enabled, true);
    assert.equal(initial.allowMajor, false);

    config.setAutoUpdate({
      enabled: false,
      intervalMs: 120000,
      allowMajor: true,
      lastGoodVersion: '0.6.45'
    });
    const next = config.getAutoUpdate();
    assert.equal(next.enabled, false);
    assert.equal(next.intervalMs, 120000);
    assert.equal(next.allowMajor, true);
    assert.equal(next.lastGoodVersion, '0.6.45');
    tmp.cleanup();
  });
};
