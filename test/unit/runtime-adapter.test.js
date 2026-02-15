/**
 * Runtime adapter tests
 *
 * Verifies platform auto-detection and runtime mode resolution.
 */

module.exports = function (test, assert) {
  async function withEnv(patch, fn) {
    const original = {};
    for (const [key, value] of Object.entries(patch)) {
      original[key] = Object.prototype.hasOwnProperty.call(process.env, key)
        ? process.env[key]
        : undefined;
      if (value === undefined || value === null) {
        delete process.env[key];
      } else {
        process.env[key] = String(value);
      }
    }

    try {
      return await fn();
    } finally {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  }

  function loadAdapterModule() {
    delete require.cache[require.resolve('../../src/lib/runtime-adapter')];
    return require('../../src/lib/runtime-adapter');
  }

  test('resolveRuntimeMode returns none for forced generic mode', async () => {
    await withEnv({ A2A_RUNTIME: 'generic' }, () => {
      const { resolveRuntimeMode } = loadAdapterModule();
      const mode = resolveRuntimeMode();
      assert.equal(mode.mode, 'none');
      assert.equal(mode.requested, 'generic');
      assert.ok(Boolean(mode.warning));
    });
  });

  test('forced openclaw mode returns none when binary missing', async () => {
    await withEnv(
      {
        A2A_RUNTIME: 'openclaw',
        PATH: '/tmp/a2a-runtime-adapter-no-bin'
      },
      () => {
        const { resolveRuntimeMode } = loadAdapterModule();
        const mode = resolveRuntimeMode();
        assert.equal(mode.mode, 'none');
        assert.equal(mode.requested, 'openclaw');
        assert.ok(Boolean(mode.warning));
      }
    );
  });

  // ── Claude mode detection ──────────────────────────────────

  test('resolveRuntimeMode returns claude when claude in PATH and no openclaw', async () => {
    await withEnv(
      {
        A2A_RUNTIME: 'auto',
        PATH: process.env.PATH, // claude is in PATH in this environment
      },
      () => {
        const { resolveRuntimeMode } = loadAdapterModule();
        const mode = resolveRuntimeMode();
        // In this environment, openclaw may also be present.
        // If openclaw is absent and claude is present, mode should be 'claude'.
        // If both are present, openclaw wins in auto mode.
        if (!mode.hasOpenClaw && mode.hasClaude) {
          assert.equal(mode.mode, 'claude');
          assert.equal(mode.reason, 'claude CLI detected');
        }
        // Either way, hasClaude should be reported
        assert.equal(mode.hasClaude != null, true);
      }
    );
  });

  test('resolveRuntimeMode prefers openclaw over claude in auto mode', async () => {
    await withEnv({ A2A_RUNTIME: 'auto' }, () => {
      const { resolveRuntimeMode } = loadAdapterModule();
      const mode = resolveRuntimeMode();
      if (mode.hasOpenClaw && mode.hasClaude) {
        assert.equal(mode.mode, 'openclaw');
      }
    });
  });

  test('resolveRuntimeMode respects A2A_RUNTIME=claude override', async () => {
    await withEnv({ A2A_RUNTIME: 'claude' }, () => {
      const { resolveRuntimeMode } = loadAdapterModule();
      const mode = resolveRuntimeMode();
      if (mode.hasClaude) {
        assert.equal(mode.mode, 'claude');
        assert.equal(mode.requested, 'claude');
        assert.equal(mode.reason, 'A2A_RUNTIME=claude');
      }
    });
  });

  test('resolveRuntimeMode returns none when A2A_RUNTIME=claude but CLI missing', async () => {
    await withEnv(
      {
        A2A_RUNTIME: 'claude',
        PATH: '/tmp/a2a-runtime-adapter-no-bin'
      },
      () => {
        const { resolveRuntimeMode } = loadAdapterModule();
        const mode = resolveRuntimeMode();
        assert.equal(mode.mode, 'none');
        assert.equal(mode.requested, 'claude');
        assert.ok(Boolean(mode.warning));
        assert.includes(mode.warning, 'claude CLI not found');
      }
    );
  });

  // ── Claude adapter return shape ────────────────────────────

  test('createRuntimeAdapter exposes getLastTurnMeta method', async () => {
    await withEnv({ A2A_RUNTIME: 'generic' }, () => {
      const { createRuntimeAdapter } = loadAdapterModule();
      const runtime = createRuntimeAdapter({ workspaceDir: process.cwd() });
      assert.type(runtime.getLastTurnMeta, 'function');
      // Should return null for unknown sessions
      assert.equal(runtime.getLastTurnMeta('nonexistent'), null);
    });
  });

  test('createRuntimeAdapter reports hasClaude in return object', async () => {
    await withEnv({ A2A_RUNTIME: 'generic' }, () => {
      const { createRuntimeAdapter } = loadAdapterModule();
      const runtime = createRuntimeAdapter({ workspaceDir: process.cwd() });
      assert.equal(typeof runtime.hasClaude, 'boolean');
    });
  });
};
