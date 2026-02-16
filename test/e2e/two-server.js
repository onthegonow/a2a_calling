const { createE2EEnv } = require('./env');
const path = require('path');

/**
 * Starts two independent A2A servers on ephemeral ports,
 * each with their own config directory and token store.
 *
 * This simulates two separate agents that can exchange
 * invites and call each other over HTTP.
 */
class TwoServerHarness {
  constructor(options = {}) {
    this.agentA = null;
    this.agentB = null;
    this.handleMessageA = options.handleMessageA || defaultHandler('AgentA');
    this.handleMessageB = options.handleMessageB || defaultHandler('AgentB');
  }

  async setup() {
    this.agentA = await this._startAgent('agent-a', this.handleMessageA);
    this.agentB = await this._startAgent('agent-b', this.handleMessageB);
  }

  async _startAgent(name, handleMessage) {
    const env = createE2EEnv(`e2e-${name}`);
    const port = await env.findAvailablePort();

    // Fresh requires to get isolated instances
    delete require.cache[require.resolve('../../src/lib/tokens')];
    delete require.cache[require.resolve('../../src/routes/a2a')];

    const express = require('express');
    const { TokenStore } = require('../../src/lib/tokens');
    const { createRoutes } = require('../../src/routes/a2a');

    const tokenStore = new TokenStore(env.configDir);
    const app = express();
    app.use(express.json({ limit: '100kb' }));

    app.use('/api/a2a', createRoutes({
      tokenStore,
      handleMessage,
      notifyOwner: () => Promise.resolve()
    }));

    const server = await new Promise((resolve) => {
      const s = app.listen(port, '127.0.0.1', () => resolve(s));
    });

    return {
      name,
      port,
      env,
      tokenStore,
      app,
      server,
      hostname: `127.0.0.1:${port}`,
      inviteBase: `a2a://127.0.0.1:${port}`
    };
  }

  async teardown() {
    if (this.agentA) {
      await closeServer(this.agentA.server);
      this.agentA.env.cleanup();
    }
    if (this.agentB) {
      await closeServer(this.agentB.server);
      this.agentB.env.cleanup();
    }
  }
}

function defaultHandler(name) {
  return async function (message, context) {
    return {
      text: `${name} received: ${message.slice(0, 100)}`,
      canContinue: true
    };
  };
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (server) server.close(resolve);
    else resolve();
  });
}

module.exports = { TwoServerHarness };
