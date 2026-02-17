module.exports = function (test, assert, helpers) {
  const path = require('path');
  const { DashboardEventStore } = require('../../src/lib/dashboard-events');

  let cleanup = null;

  test('DashboardEventStore persists and replays events by id', () => {
    const tmp = helpers.tmpConfigDir('a2a-events');
    cleanup = tmp.cleanup;

    const store = new DashboardEventStore(tmp.dir);
    assert.ok(store.isAvailable(), 'event store should initialize');

    const first = store.emitEvent('call.inbound', { caller_name: 'Alice' }, { conversationId: 'conv_1' });
    const second = store.emitEvent('summary.completed', { contact_name: 'Alice' }, { conversationId: 'conv_1' });

    assert.ok(first.success, 'first emit should succeed');
    assert.ok(second.success, 'second emit should succeed');
    assert.greaterThan(second.event.id, first.event.id, 'ids should be monotonic');

    const replay = store.listSince(first.event.id, { limit: 10 });
    assert.equal(replay.length, 1, 'replay should include only later events');
    assert.equal(replay[0].type, 'summary.completed');
    assert.equal(replay[0].conversation_id, 'conv_1');
    assert.equal(replay[0].payload.contact_name, 'Alice');
  });

  test('DashboardEventStore supports live subscriptions', async () => {
    const tmp = helpers.tmpConfigDir('a2a-events-sub');
    cleanup = tmp.cleanup;

    const store = new DashboardEventStore(tmp.dir);
    assert.ok(store.isAvailable(), 'event store should initialize');

    const received = [];
    const unsubscribe = store.subscribe((event) => {
      received.push(event);
    });

    store.emitEvent('invite.used', { source: 'callbook_exchange' });
    unsubscribe();
    store.emitEvent('invite.used', { source: 'post-unsubscribe' });

    assert.equal(received.length, 1, 'listener should stop after unsubscribe');
    assert.equal(received[0].type, 'invite.used');
    assert.equal(received[0].payload.source, 'callbook_exchange');
  });

  test('DashboardEventStore writes DB file in configured directory', () => {
    const tmp = helpers.tmpConfigDir('a2a-events-path');
    cleanup = tmp.cleanup;
    const store = new DashboardEventStore(tmp.dir);
    assert.ok(store.isAvailable(), 'event store should initialize');
    const expected = path.join(tmp.dir, 'a2a-events.db');
    assert.ok(require('fs').existsSync(expected), 'db file should exist');
  });
};
