/**
 * Structured Logger Tests
 *
 * Covers: SQLite persistence, query filters, trace retrieval, and stats.
 */

module.exports = function (test, assert, helpers) {
  let tmp = null;

  function loadLoggerModule() {
    delete require.cache[require.resolve('../../src/lib/logger')];
    return require('../../src/lib/logger');
  }

  function setup() {
    tmp = helpers.tmpConfigDir('log');
  }

  function teardown(loggerModule) {
    if (loggerModule && typeof loggerModule.closeAllLoggerStores === 'function') {
      loggerModule.closeAllLoggerStores();
    }
    if (tmp) tmp.cleanup();
    tmp = null;
  }

  test('writes structured logs and reads them back from SQLite', () => {
    setup();
    const loggerModule = loadLoggerModule();
    const logger = loggerModule.createLogger({
      component: 'unit.logger',
      configDir: tmp.dir,
      stdout: false,
      minLevel: 'trace'
    });

    logger.info('hello world', {
      event: 'unit_test_entry',
      traceId: 'trace_test_001',
      conversationId: 'conv_test_001',
      tokenId: 'tok_test_001',
      requestId: 'req_test_001',
      data: { alpha: 1, beta: 'two' }
    });

    const logs = logger.list({ limit: 10 });
    assert.equal(logs.length, 1);
    assert.equal(logs[0].component, 'unit.logger');
    assert.equal(logs[0].event, 'unit_test_entry');
    assert.equal(logs[0].trace_id, 'trace_test_001');
    assert.equal(logs[0].conversation_id, 'conv_test_001');
    assert.equal(logs[0].token_id, 'tok_test_001');
    assert.equal(logs[0].request_id, 'req_test_001');
    assert.equal(logs[0].data.alpha, 1);
    assert.equal(logs[0].data.beta, 'two');

    teardown(loggerModule);
  });

  test('supports level/component filters and trace-specific retrieval', () => {
    setup();
    const loggerModule = loadLoggerModule();
    const logger = loggerModule.createLogger({
      component: 'unit.logger',
      configDir: tmp.dir,
      stdout: false,
      minLevel: 'trace'
    });

    logger.info('first', {
      event: 'sample',
      traceId: 'trace_filter_1',
      data: { source: 'a' }
    });
    logger.warn('second', {
      event: 'sample',
      traceId: 'trace_filter_1',
      data: { source: 'b' }
    });
    logger.error('third', {
      event: 'other',
      traceId: 'trace_filter_2',
      data: { source: 'c' }
    });

    const warnLogs = logger.list({ level: 'warn', limit: 10 });
    assert.equal(warnLogs.length, 1);
    assert.equal(warnLogs[0].level, 'warn');

    const eventLogs = logger.list({ event: 'sample', limit: 10 });
    assert.equal(eventLogs.length, 2);

    const traceLogs = logger.getTrace('trace_filter_1', { limit: 10 });
    assert.equal(traceLogs.length, 2);
    assert.equal(traceLogs[0].trace_id, 'trace_filter_1');
    assert.equal(traceLogs[1].trace_id, 'trace_filter_1');

    teardown(loggerModule);
  });

  test('produces aggregate stats by level and component', () => {
    setup();
    const loggerModule = loadLoggerModule();
    const logger = loggerModule.createLogger({
      component: 'unit.logger',
      configDir: tmp.dir,
      stdout: false,
      minLevel: 'trace'
    });
    const secondary = logger.child({ component: 'unit.logger.secondary' });

    logger.info('one');
    logger.warn('two');
    secondary.error('three');

    const stats = logger.stats();
    assert.equal(stats.total, 3);
    assert.equal(stats.by_level.info, 1);
    assert.equal(stats.by_level.warn, 1);
    assert.equal(stats.by_level.error, 1);
    assert.equal(stats.by_component['unit.logger'], 2);
    assert.equal(stats.by_component['unit.logger.secondary'], 1);

    teardown(loggerModule);
  });

  test('captures error_code, hint, status_code, and optional stack traces', () => {
    setup();
    const loggerModule = loadLoggerModule();
    const logger = loggerModule.createLogger({
      component: 'unit.logger',
      configDir: tmp.dir,
      stdout: false,
      minLevel: 'trace',
      includeStacks: true
    });

    const err = new Error('boom');
    err.code = 'E_BANG';
    logger.error('exploded', {
      event: 'error_case',
      error_code: 'UNIT_EXPLODED',
      status_code: 500,
      hint: 'Check unit test explosion path.',
      error: err
    });

    const logs = logger.list({ errorCode: 'UNIT_EXPLODED', statusCode: 500, limit: 10 });
    assert.equal(logs.length, 1);
    assert.equal(logs[0].error_code, 'UNIT_EXPLODED');
    assert.equal(logs[0].status_code, 500);
    assert.equal(logs[0].hint, 'Check unit test explosion path.');
    assert.equal(logs[0].data.error.code, 'E_BANG');
    assert.ok(typeof logs[0].data.error.stack === 'string');
    assert.includes(logs[0].data.error.stack, 'Error: boom');

    teardown(loggerModule);
  });

  // ── A2A-71: WAL mode ──────────────────────────────────────

  test('LoggerStore enables WAL journal mode on init', () => {
    setup();
    const loggerModule = loadLoggerModule();
    const logger = loggerModule.createLogger({
      component: 'wal-test',
      configDir: tmp.dir,
      stdout: false
    });

    // Trigger lazy DB initialization
    logger.info('wal test', { event: 'wal_check' });

    const store = logger.store;
    const row = store.db.prepare('PRAGMA journal_mode').get();
    assert.equal(row.journal_mode, 'wal');

    teardown(loggerModule);
  });
};
