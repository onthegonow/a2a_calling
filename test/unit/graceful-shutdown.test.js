module.exports = function (test, assert, helpers) {
  const { DashboardEventStore } = require('../../src/lib/dashboard-events');
  const { CallbookStore } = require('../../src/lib/callbook');

  // A2A-57: Verify close() methods exist and are idempotent

  test('DashboardEventStore.close() closes DB and is idempotent', () => {
    const tmp = helpers.tmpConfigDir('a2a-shutdown-events');
    try {
      const store = new DashboardEventStore(tmp.dir);
      assert.ok(store.isAvailable(), 'store should initialize');

      // First close should succeed
      store.close();
      assert.equal(store.db, null, 'db should be null after close');

      // Second close should not throw (idempotent)
      store.close();
      assert.equal(store.db, null, 'db should still be null after second close');
    } finally {
      tmp.cleanup();
    }
  });

  test('DashboardEventStore.close() is a no-op when DB was never initialized', () => {
    const tmp = helpers.tmpConfigDir('a2a-shutdown-events-noop');
    try {
      const store = new DashboardEventStore(tmp.dir);
      // Do NOT call isAvailable() — DB is never initialized
      assert.equal(store.db, null, 'db should be null before init');

      // close() should not throw
      store.close();
      assert.equal(store.db, null, 'db should still be null');
    } finally {
      tmp.cleanup();
    }
  });

  test('CallbookStore.close() closes DB and is idempotent', () => {
    const tmp = helpers.tmpConfigDir('a2a-shutdown-callbook');
    try {
      const store = new CallbookStore(tmp.dir);
      assert.ok(store.isAvailable(), 'store should initialize');

      store.close();
      assert.equal(store.db, null, 'db should be null after close');

      // Idempotent
      store.close();
      assert.equal(store.db, null, 'db should still be null after second close');
    } finally {
      tmp.cleanup();
    }
  });

  test('CallbookStore.close() is a no-op when DB was never initialized', () => {
    const tmp = helpers.tmpConfigDir('a2a-shutdown-callbook-noop');
    try {
      const store = new CallbookStore(tmp.dir);
      assert.equal(store.db, null, 'db should be null before init');

      store.close();
      assert.equal(store.db, null, 'db should still be null');
    } finally {
      tmp.cleanup();
    }
  });
};
