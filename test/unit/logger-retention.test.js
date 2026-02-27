/**
 * Logger Retention Tests (A2A-64)
 *
 * Covers: pruneOld() explicit cleanup, auto-prune on Nth write,
 * getDatabaseStats() monitoring, VACUUM threshold, and recursion safety.
 */

module.exports = function (test, assert, helpers) {
  let tmp = null;

  function loadLoggerModule() {
    delete require.cache[require.resolve('../../src/lib/logger')];
    return require('../../src/lib/logger');
  }

  function setup() {
    tmp = helpers.tmpConfigDir('log-retention');
  }

  function teardown(loggerModule) {
    if (loggerModule && typeof loggerModule.closeAllLoggerStores === 'function') {
      loggerModule.closeAllLoggerStores();
    }
    if (tmp) tmp.cleanup();
    tmp = null;
  }

  // --- pruneOld() tests ---

  test('pruneOld deletes entries older than the retention period', () => {
    setup();
    const loggerModule = loadLoggerModule();
    const { LogStore } = loggerModule;
    const store = new LogStore(tmp.dir);

    // Insert entries with old timestamps (60 days ago) directly via SQL
    const db = store._initDb();
    const oldTimestamp = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    const recentTimestamp = new Date().toISOString();

    for (let i = 0; i < 5; i++) {
      store.insertStmt.run(
        oldTimestamp, 'info', 'test', null, `old entry ${i}`,
        null, null, null, null, null, null, null, null
      );
    }
    for (let i = 0; i < 3; i++) {
      store.insertStmt.run(
        recentTimestamp, 'info', 'test', null, `recent entry ${i}`,
        null, null, null, null, null, null, null, null
      );
    }

    const statsBefore = store.getDatabaseStats();
    assert.equal(statsBefore.total, 8, 'should have 8 entries before prune');

    const result = store.pruneOld({ days: 30 });
    assert.equal(result.deleted, 5, 'should delete 5 old entries');

    // A2A-64: After prune, we have 3 recent entries + 1 cleanup log entry = 4
    const statsAfter = store.getDatabaseStats();
    assert.equal(statsAfter.total, 4, 'should have 3 recent + 1 cleanup log entry after prune');

    store.close();
    teardown(loggerModule);
  });

  test('pruneOld uses default 30-day retention when no options given', () => {
    setup();
    const loggerModule = loadLoggerModule();
    const { LogStore } = loggerModule;
    const store = new LogStore(tmp.dir);

    const db = store._initDb();
    const oldTimestamp = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    const recentTimestamp = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString();

    store.insertStmt.run(
      oldTimestamp, 'info', 'test', null, 'too old',
      null, null, null, null, null, null, null, null
    );
    store.insertStmt.run(
      recentTimestamp, 'info', 'test', null, 'still within retention',
      null, null, null, null, null, null, null, null
    );

    const result = store.pruneOld(); // No options — should default to 30 days
    assert.equal(result.deleted, 1, 'should delete 1 entry older than 30 days');

    // A2A-64: 1 recent entry + 1 cleanup log entry = 2
    const statsAfter = store.getDatabaseStats();
    assert.equal(statsAfter.total, 2, 'should keep 1 recent entry + 1 prune log entry');

    store.close();
    teardown(loggerModule);
  });

  test('pruneOld returns { deleted: 0 } on empty database', () => {
    setup();
    const loggerModule = loadLoggerModule();
    const { LogStore } = loggerModule;
    const store = new LogStore(tmp.dir);
    store._initDb();

    const result = store.pruneOld({ days: 30 });
    assert.equal(result.deleted, 0, 'should report 0 deletions on empty DB');

    store.close();
    teardown(loggerModule);
  });

  test('pruneOld runs VACUUM only when > 100 rows deleted', () => {
    setup();
    const loggerModule = loadLoggerModule();
    const { LogStore } = loggerModule;
    const store = new LogStore(tmp.dir);

    const db = store._initDb();
    const oldTimestamp = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();

    // Insert 150 old entries — should trigger VACUUM
    for (let i = 0; i < 150; i++) {
      store.insertStmt.run(
        oldTimestamp, 'info', 'test', null, `bulk entry ${i}`,
        null, null, null, null, null, null, null, null
      );
    }

    // Track whether VACUUM was called by wrapping db.exec
    let vacuumCalled = false;
    const originalExec = db.exec.bind(db);
    db.exec = function (sql) {
      if (sql === 'VACUUM') vacuumCalled = true;
      return originalExec(sql);
    };

    const result = store.pruneOld({ days: 30 });
    assert.equal(result.deleted, 150, 'should delete all 150 old entries');
    assert.ok(vacuumCalled, 'VACUUM should run when > 100 rows deleted');

    // Restore original exec
    db.exec = originalExec;
    store.close();
    teardown(loggerModule);
  });

  test('pruneOld does NOT run VACUUM when <= 100 rows deleted', () => {
    setup();
    const loggerModule = loadLoggerModule();
    const { LogStore } = loggerModule;
    const store = new LogStore(tmp.dir);

    const db = store._initDb();
    const oldTimestamp = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();

    // Insert exactly 50 old entries — should NOT trigger VACUUM
    for (let i = 0; i < 50; i++) {
      store.insertStmt.run(
        oldTimestamp, 'info', 'test', null, `small batch ${i}`,
        null, null, null, null, null, null, null, null
      );
    }

    let vacuumCalled = false;
    const originalExec = db.exec.bind(db);
    db.exec = function (sql) {
      if (sql === 'VACUUM') vacuumCalled = true;
      return originalExec(sql);
    };

    const result = store.pruneOld({ days: 30 });
    assert.equal(result.deleted, 50, 'should delete 50 old entries');
    assert.ok(!vacuumCalled, 'VACUUM should NOT run when <= 100 rows deleted');

    db.exec = originalExec;
    store.close();
    teardown(loggerModule);
  });

  test('pruneOld logs results with component a2a.cleanup', () => {
    setup();
    const loggerModule = loadLoggerModule();
    const { LogStore } = loggerModule;
    const store = new LogStore(tmp.dir);

    const db = store._initDb();
    const oldTimestamp = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();

    store.insertStmt.run(
      oldTimestamp, 'info', 'test', null, 'old entry',
      null, null, null, null, null, null, null, null
    );

    store.pruneOld({ days: 30 });

    // The pruneOld method should have logged an info entry with component a2a.cleanup
    const cleanupLogs = store.list({ component: 'a2a.cleanup', limit: 10 });
    assert.equal(cleanupLogs.length, 1, 'should have 1 cleanup log entry');
    assert.equal(cleanupLogs[0].component, 'a2a.cleanup');
    assert.equal(cleanupLogs[0].event, 'logs_pruned');
    assert.equal(cleanupLogs[0].level, 'info');
    assert.ok(cleanupLogs[0].data.deleted !== undefined, 'cleanup log should contain deleted count');

    store.close();
    teardown(loggerModule);
  });

  // --- Auto-prune tests ---

  test('auto-prune triggers on every 1000th write call', () => {
    setup();
    const loggerModule = loadLoggerModule();
    const { LogStore } = loggerModule;
    const store = new LogStore(tmp.dir);

    const db = store._initDb();

    // Insert one old entry that should be pruned
    const oldTimestamp = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    store.insertStmt.run(
      oldTimestamp, 'info', 'test', null, 'ancient entry',
      null, null, null, null, null, null, null, null
    );

    // Track pruneStmt calls
    let pruneCalled = false;
    const originalRun = store.pruneStmt.run.bind(store.pruneStmt);
    store.pruneStmt.run = function (...args) {
      pruneCalled = true;
      return originalRun(...args);
    };

    // Write 999 entries — should NOT trigger auto-prune
    const recentTimestamp = new Date().toISOString();
    for (let i = 0; i < 999; i++) {
      store.write({
        timestamp: recentTimestamp,
        level: 'debug',
        component: 'test.auto',
        event: null,
        message: `entry ${i}`,
        trace_id: null,
        conversation_id: null,
        token_id: null,
        request_id: null,
        error_code: null,
        status_code: null,
        hint: null,
        data: null
      });
    }
    assert.ok(!pruneCalled, 'prune should not be called before 1000th write');

    // The 1000th write should trigger auto-prune
    store.write({
      timestamp: recentTimestamp,
      level: 'debug',
      component: 'test.auto',
      event: null,
      message: 'the 1000th entry',
      trace_id: null,
      conversation_id: null,
      token_id: null,
      request_id: null,
      error_code: null,
      status_code: null,
      hint: null,
      data: null
    });
    assert.ok(pruneCalled, 'prune should be called on the 1000th write');

    // Verify the old entry was actually deleted by auto-prune
    const remaining = db.prepare("SELECT COUNT(*) AS cnt FROM logs WHERE message = 'ancient entry'").get();
    assert.equal(remaining.cnt, 0, 'old entry should be removed by auto-prune');

    store.close();
    teardown(loggerModule);
  });

  test('auto-prune failure does not affect write result', () => {
    setup();
    const loggerModule = loadLoggerModule();
    const { LogStore } = loggerModule;
    const store = new LogStore(tmp.dir);
    store._initDb();

    // Force pruneStmt.run to throw
    store.pruneStmt.run = function () {
      throw new Error('simulated prune failure');
    };

    // Set writeCount to 999 so next write triggers auto-prune
    store._writeCount = 999;

    const result = store.write({
      timestamp: new Date().toISOString(),
      level: 'info',
      component: 'test.fail',
      event: null,
      message: 'this write should still succeed',
      trace_id: null,
      conversation_id: null,
      token_id: null,
      request_id: null,
      error_code: null,
      status_code: null,
      hint: null,
      data: null
    });

    assert.ok(result, 'write() should return true even when auto-prune fails');

    store.close();
    teardown(loggerModule);
  });

  // --- getDatabaseStats() tests ---

  test('getDatabaseStats returns correct total, oldest, and newest entries', () => {
    setup();
    const loggerModule = loadLoggerModule();
    const { LogStore } = loggerModule;
    const store = new LogStore(tmp.dir);
    store._initDb();

    const ts1 = '2025-01-15T10:00:00.000Z';
    const ts2 = '2025-06-15T12:00:00.000Z';
    const ts3 = '2025-12-25T18:30:00.000Z';

    store.insertStmt.run(ts1, 'info', 'test', null, 'first', null, null, null, null, null, null, null, null);
    store.insertStmt.run(ts2, 'warn', 'test', null, 'middle', null, null, null, null, null, null, null, null);
    store.insertStmt.run(ts3, 'error', 'test', null, 'last', null, null, null, null, null, null, null, null);

    const dbStats = store.getDatabaseStats();
    assert.equal(dbStats.total, 3, 'total should be 3');
    assert.equal(dbStats.oldest_entry, ts1, 'oldest_entry should be the first timestamp');
    assert.equal(dbStats.newest_entry, ts3, 'newest_entry should be the last timestamp');

    store.close();
    teardown(loggerModule);
  });

  test('getDatabaseStats returns nulls on empty database', () => {
    setup();
    const loggerModule = loadLoggerModule();
    const { LogStore } = loggerModule;
    const store = new LogStore(tmp.dir);
    store._initDb();

    const dbStats = store.getDatabaseStats();
    assert.equal(dbStats.total, 0, 'total should be 0');
    assert.equal(dbStats.oldest_entry, null, 'oldest_entry should be null');
    assert.equal(dbStats.newest_entry, null, 'newest_entry should be null');

    store.close();
    teardown(loggerModule);
  });

  test('LogStore is exported from the logger module', () => {
    setup();
    const loggerModule = loadLoggerModule();
    assert.ok(loggerModule.LogStore, 'LogStore should be exported');
    assert.equal(typeof loggerModule.LogStore, 'function', 'LogStore should be a constructor');
    teardown(loggerModule);
  });
};
