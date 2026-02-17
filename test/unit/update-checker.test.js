/**
 * Update Checker Tests
 */

module.exports = function (test, assert) {
  function requireFresh() {
    delete require.cache[require.resolve('../../src/lib/update-checker')];
    return require('../../src/lib/update-checker');
  }

  test('compareVersions handles patch/minor/major', () => {
    const { compareVersions } = requireFresh();
    assert.equal(compareVersions('0.6.45', '0.6.46'), -1);
    assert.equal(compareVersions('0.6.45', '0.7.0'), -1);
    assert.equal(compareVersions('0.6.45', '1.0.0'), -1);
    assert.equal(compareVersions('0.6.45', '0.6.45'), 0);
    assert.equal(compareVersions('0.7.0', '0.6.45'), 1);
  });

  test('isSameMajor detects matching major numbers', () => {
    const { isSameMajor } = requireFresh();
    assert.ok(isSameMajor('0.6.45', '0.7.0'));
    assert.ok(!isSameMajor('0.6.45', '1.0.0'));
  });

  test('checkForUpdate surfaces registry errors', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
    try {
      const { checkForUpdate } = requireFresh();
      const result = await checkForUpdate('0.6.45');
      assert.equal(result.available, false);
      assert.ok(result.error);
    } finally {
      global.fetch = originalFetch;
    }
  });
};

