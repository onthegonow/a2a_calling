module.exports = function (test, assert, helpers) {
  const { CallbookStore } = require('../../src/lib/callbook');

  // A2A-58: Unit tests for CallbookStore — provisioning, sessions, revocation

  // --- isAvailable / getDbError ---

  test('CallbookStore.isAvailable() returns true with valid config dir', () => {
    const tmp = helpers.tmpConfigDir('a2a-cbk-avail');
    try {
      const store = new CallbookStore(tmp.dir);
      assert.ok(store.isAvailable(), 'store should be available');
      assert.equal(store.getDbError(), null, 'no DB error expected');
      store.close();
    } finally {
      tmp.cleanup();
    }
  });

  test('CallbookStore.isAvailable() returns false when DB init fails', () => {
    const tmp = helpers.tmpConfigDir('a2a-cbk-unavail');
    try {
      // Point at a file (not directory) to force SQLite init failure
      const fs = require('fs');
      const badPath = require('path').join(tmp.dir, 'not-a-dir');
      fs.writeFileSync(badPath, 'block');
      const store = new CallbookStore(tmp.dir, { dbPath: badPath });
      assert.ok(!store.isAvailable(), 'store should not be available');
      assert.ok(store.getDbError(), 'DB error should be set');
    } finally {
      tmp.cleanup();
    }
  });

  // --- createProvisionCode ---

  test('createProvisionCode() returns code and record with defaults', () => {
    const tmp = helpers.tmpConfigDir('a2a-cbk-create');
    try {
      const store = new CallbookStore(tmp.dir);
      const result = store.createProvisionCode();
      assert.ok(result.success, 'should succeed');
      assert.ok(result.code, 'code should be non-empty');
      assert.ok(result.code.startsWith('cbk_'), 'code should have cbk_ prefix');
      assert.ok(result.record.id.startsWith('cbkprov_'), 'record id should have prefix');
      assert.ok(result.record.created_at, 'created_at should be set');
      assert.ok(result.record.expires_at, 'expires_at should be set');
      assert.equal(result.record.used_at, null, 'used_at should be null');
      assert.equal(result.record.label, null, 'label should be null by default');
      store.close();
    } finally {
      tmp.cleanup();
    }
  });

  test('createProvisionCode() accepts custom label', () => {
    const tmp = helpers.tmpConfigDir('a2a-cbk-label');
    try {
      const store = new CallbookStore(tmp.dir);
      const result = store.createProvisionCode({ label: 'My Device' });
      assert.ok(result.success, 'should succeed');
      assert.equal(result.record.label, 'My Device', 'label should match');
      store.close();
    } finally {
      tmp.cleanup();
    }
  });

  test('createProvisionCode() accepts custom TTL', () => {
    const tmp = helpers.tmpConfigDir('a2a-cbk-ttl');
    try {
      const store = new CallbookStore(tmp.dir);
      const result = store.createProvisionCode({ ttlMs: 60000 });
      assert.ok(result.success, 'should succeed');
      const expiresMs = Date.parse(result.record.expires_at);
      const nowMs = Date.now();
      // Expiry should be within ~60s of now (allowing 5s tolerance)
      assert.ok(expiresMs > nowMs, 'expires_at should be in the future');
      assert.ok(expiresMs - nowMs <= 65000, 'expiry should be roughly 60s from now');
      store.close();
    } finally {
      tmp.cleanup();
    }
  });

  test('createProvisionCode() returns error when DB unavailable', () => {
    const tmp = helpers.tmpConfigDir('a2a-cbk-create-fail');
    try {
      const fs = require('fs');
      const badPath = require('path').join(tmp.dir, 'not-a-dir');
      fs.writeFileSync(badPath, 'block');
      const store = new CallbookStore(tmp.dir, { dbPath: badPath });
      const result = store.createProvisionCode();
      assert.ok(!result.success, 'should fail');
      assert.equal(result.error, 'callbook_storage_unavailable');
    } finally {
      tmp.cleanup();
    }
  });

  // --- exchangeProvisionCode ---

  test('exchangeProvisionCode() returns session token and device on valid code', () => {
    const tmp = helpers.tmpConfigDir('a2a-cbk-exchange');
    try {
      const store = new CallbookStore(tmp.dir);
      const { code } = store.createProvisionCode({ label: 'TestDev' });
      const result = store.exchangeProvisionCode(code);
      assert.ok(result.success, 'exchange should succeed');
      assert.ok(result.sessionToken, 'sessionToken should be non-empty');
      assert.ok(result.sessionToken.startsWith('cbksess_'), 'session token should have prefix');
      assert.ok(result.device, 'device should be returned');
      assert.ok(result.device.id.startsWith('cbkdev_'), 'device id should have prefix');
      assert.equal(result.device.label, 'TestDev', 'device label should match provision label');
      assert.equal(result.device.revoked_at, null, 'device should not be revoked');
      store.close();
    } finally {
      tmp.cleanup();
    }
  });

  test('exchangeProvisionCode() returns missing_code for empty input', () => {
    const tmp = helpers.tmpConfigDir('a2a-cbk-exchange-empty');
    try {
      const store = new CallbookStore(tmp.dir);
      assert.ok(store.isAvailable());
      const result = store.exchangeProvisionCode('');
      assert.ok(!result.success);
      assert.equal(result.error, 'missing_code');
      store.close();
    } finally {
      tmp.cleanup();
    }
  });

  test('exchangeProvisionCode() returns invalid_code for unknown code', () => {
    const tmp = helpers.tmpConfigDir('a2a-cbk-exchange-invalid');
    try {
      const store = new CallbookStore(tmp.dir);
      assert.ok(store.isAvailable());
      const result = store.exchangeProvisionCode('cbk_nonexistent');
      assert.ok(!result.success);
      assert.equal(result.error, 'invalid_code');
      store.close();
    } finally {
      tmp.cleanup();
    }
  });

  test('exchangeProvisionCode() returns code_expired for expired code', async () => {
    const tmp = helpers.tmpConfigDir('a2a-cbk-exchange-expired');
    try {
      const store = new CallbookStore(tmp.dir);
      const { code } = store.createProvisionCode({ ttlMs: 1 });
      // Wait for code to expire
      await new Promise(resolve => setTimeout(resolve, 50));
      const result = store.exchangeProvisionCode(code);
      assert.ok(!result.success);
      assert.equal(result.error, 'code_expired');
      store.close();
    } finally {
      tmp.cleanup();
    }
  });

  test('exchangeProvisionCode() returns code_already_used on double exchange', () => {
    const tmp = helpers.tmpConfigDir('a2a-cbk-exchange-double');
    try {
      const store = new CallbookStore(tmp.dir);
      const { code } = store.createProvisionCode();
      const first = store.exchangeProvisionCode(code);
      assert.ok(first.success, 'first exchange should succeed');
      const second = store.exchangeProvisionCode(code);
      assert.ok(!second.success, 'second exchange should fail');
      assert.equal(second.error, 'code_already_used');
      store.close();
    } finally {
      tmp.cleanup();
    }
  });

  // --- validateSession ---

  test('validateSession() returns valid:true for active session', () => {
    const tmp = helpers.tmpConfigDir('a2a-cbk-validate');
    try {
      const store = new CallbookStore(tmp.dir);
      const { code } = store.createProvisionCode();
      const { sessionToken, device } = store.exchangeProvisionCode(code);
      const result = store.validateSession(sessionToken);
      assert.ok(result.valid, 'session should be valid');
      assert.ok(result.session, 'session info should be returned');
      assert.equal(result.session.device_id, device.id, 'device_id should match');
      assert.ok(result.device, 'device should be returned');
      store.close();
    } finally {
      tmp.cleanup();
    }
  });

  test('validateSession() returns missing_session for empty input', () => {
    const tmp = helpers.tmpConfigDir('a2a-cbk-validate-empty');
    try {
      const store = new CallbookStore(tmp.dir);
      assert.ok(store.isAvailable());
      const result = store.validateSession('');
      assert.ok(!result.valid);
      assert.equal(result.error, 'missing_session');
      store.close();
    } finally {
      tmp.cleanup();
    }
  });

  test('validateSession() returns invalid_session for unknown token', () => {
    const tmp = helpers.tmpConfigDir('a2a-cbk-validate-unknown');
    try {
      const store = new CallbookStore(tmp.dir);
      assert.ok(store.isAvailable());
      const result = store.validateSession('cbksess_bogus');
      assert.ok(!result.valid);
      assert.equal(result.error, 'invalid_session');
      store.close();
    } finally {
      tmp.cleanup();
    }
  });

  test('validateSession() returns session_revoked after device revocation (cascade)', () => {
    const tmp = helpers.tmpConfigDir('a2a-cbk-validate-devrevoked');
    try {
      const store = new CallbookStore(tmp.dir);
      const { code } = store.createProvisionCode();
      const { sessionToken, device } = store.exchangeProvisionCode(code);
      store.revokeDevice(device.id);
      const result = store.validateSession(sessionToken);
      assert.ok(!result.valid, 'session should be invalid after device revocation');
      // A2A-58: revokeDevice cascades to sessions, so session is revoked first
      assert.equal(result.error, 'session_revoked');
      store.close();
    } finally {
      tmp.cleanup();
    }
  });

  // --- listDevices ---

  test('listDevices() returns active devices', () => {
    const tmp = helpers.tmpConfigDir('a2a-cbk-listdev');
    try {
      const store = new CallbookStore(tmp.dir);
      const { code: c1 } = store.createProvisionCode({ label: 'Dev1' });
      const { code: c2 } = store.createProvisionCode({ label: 'Dev2' });
      store.exchangeProvisionCode(c1);
      store.exchangeProvisionCode(c2);
      const result = store.listDevices();
      assert.ok(result.success);
      assert.equal(result.devices.length, 2, 'should have 2 active devices');
      store.close();
    } finally {
      tmp.cleanup();
    }
  });

  test('listDevices() respects includeRevoked filter', () => {
    const tmp = helpers.tmpConfigDir('a2a-cbk-listdev-revoked');
    try {
      const store = new CallbookStore(tmp.dir);
      const { code: c1 } = store.createProvisionCode({ label: 'Keep' });
      const { code: c2 } = store.createProvisionCode({ label: 'Revoke' });
      store.exchangeProvisionCode(c1);
      const { device } = store.exchangeProvisionCode(c2);
      store.revokeDevice(device.id);

      const withoutRevoked = store.listDevices();
      assert.equal(withoutRevoked.devices.length, 1, 'should hide revoked by default');
      assert.equal(withoutRevoked.devices[0].label, 'Keep');

      const withRevoked = store.listDevices({ includeRevoked: true });
      assert.equal(withRevoked.devices.length, 2, 'should include revoked when asked');
      store.close();
    } finally {
      tmp.cleanup();
    }
  });

  test('listDevices() respects limit parameter', () => {
    const tmp = helpers.tmpConfigDir('a2a-cbk-listdev-limit');
    try {
      const store = new CallbookStore(tmp.dir);
      for (let i = 0; i < 5; i++) {
        const { code } = store.createProvisionCode({ label: `Dev${i}` });
        store.exchangeProvisionCode(code);
      }
      const result = store.listDevices({ limit: 3 });
      assert.ok(result.success);
      assert.equal(result.devices.length, 3, 'should respect limit');
      store.close();
    } finally {
      tmp.cleanup();
    }
  });

  // --- revokeDevice ---

  test('revokeDevice() revokes device and cascades to sessions', () => {
    const tmp = helpers.tmpConfigDir('a2a-cbk-revoke');
    try {
      const store = new CallbookStore(tmp.dir);
      const { code } = store.createProvisionCode();
      const { sessionToken, device } = store.exchangeProvisionCode(code);

      const revokeResult = store.revokeDevice(device.id);
      assert.ok(revokeResult.success, 'revoke should succeed');
      assert.ok(revokeResult.device.revoked_at, 'device should have revoked_at');

      // Session should now be invalid
      const validateResult = store.validateSession(sessionToken);
      assert.ok(!validateResult.valid, 'session should be invalid after device revocation');
      store.close();
    } finally {
      tmp.cleanup();
    }
  });

  test('revokeDevice() returns device_not_found for unknown device', () => {
    const tmp = helpers.tmpConfigDir('a2a-cbk-revoke-unknown');
    try {
      const store = new CallbookStore(tmp.dir);
      assert.ok(store.isAvailable());
      const result = store.revokeDevice('cbkdev_nonexistent');
      assert.ok(!result.success);
      assert.equal(result.error, 'device_not_found');
      store.close();
    } finally {
      tmp.cleanup();
    }
  });

  test('revokeDevice() returns device_id_required for empty ID', () => {
    const tmp = helpers.tmpConfigDir('a2a-cbk-revoke-empty');
    try {
      const store = new CallbookStore(tmp.dir);
      assert.ok(store.isAvailable());
      const result = store.revokeDevice('');
      assert.ok(!result.success);
      assert.equal(result.error, 'device_id_required');
      store.close();
    } finally {
      tmp.cleanup();
    }
  });

  // --- Cross-cutting: session token from exchange accepted by validateSession ---

  test('session token from exchange is accepted by validateSession (round-trip)', () => {
    const tmp = helpers.tmpConfigDir('a2a-cbk-roundtrip');
    try {
      const store = new CallbookStore(tmp.dir);
      const { code } = store.createProvisionCode({ label: 'Roundtrip' });
      const exchange = store.exchangeProvisionCode(code);
      assert.ok(exchange.success);
      const validate = store.validateSession(exchange.sessionToken);
      assert.ok(validate.valid, 'exchanged token should validate');
      assert.equal(validate.device.id, exchange.device.id, 'device should match');
      store.close();
    } finally {
      tmp.cleanup();
    }
  });
};
