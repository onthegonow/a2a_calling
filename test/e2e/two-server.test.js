module.exports = function (test, assert, helpers) {
  const { TwoServerHarness } = require('./two-server');

  test('TwoServerHarness starts two isolated servers', async () => {
    const harness = new TwoServerHarness();
    await harness.setup();

    assert.ok(harness.agentA, 'Agent A should exist');
    assert.ok(harness.agentB, 'Agent B should exist');
    assert.ok(harness.agentA.port, 'Agent A should have a port');
    assert.ok(harness.agentB.port, 'Agent B should have a port');
    assert.ok(harness.agentA.port !== harness.agentB.port, 'Ports should differ');

    // Both should respond to ping
    const pingA = await httpGet(`http://127.0.0.1:${harness.agentA.port}/api/a2a/ping`);
    assert.ok(pingA.pong, 'Agent A should respond to ping');

    const pingB = await httpGet(`http://127.0.0.1:${harness.agentB.port}/api/a2a/ping`);
    assert.ok(pingB.pong, 'Agent B should respond to ping');

    await harness.teardown();
  });

  test('TwoServerHarness provides token stores for each agent', async () => {
    const harness = new TwoServerHarness();
    await harness.setup();

    // Create token on Agent A
    const { token } = harness.agentA.tokenStore.create({ name: 'TestToken' });
    assert.match(token, /^fed_/);

    // Token should NOT exist on Agent B
    const validation = harness.agentB.tokenStore.validate(token);
    assert.equal(validation.valid, false);

    await harness.teardown();
  });

  // Helper to make GET request
  function httpGet(url) {
    const http = require('http');
    return new Promise((resolve, reject) => {
      http.get(url, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { resolve(data); }
        });
      }).on('error', reject);
    });
  }
};
