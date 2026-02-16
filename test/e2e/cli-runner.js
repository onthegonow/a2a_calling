const { execFile } = require('child_process');
const path = require('path');

const CLI_PATH = path.join(__dirname, '..', '..', 'bin', 'cli.js');

/**
 * Wraps the a2a CLI for structured E2E testing.
 *
 * Each method runs the CLI as a child process in the
 * given E2E environment, returning { stdout, stderr, exitCode, timedOut }.
 */
class CLIRunner {
  constructor(e2eEnv, options = {}) {
    this.env = e2eEnv;
    this.defaultTimeout = options.timeout || 30000;
  }

  /**
   * Run an a2a CLI command.
   * @param {string} command - The a2a subcommand (e.g., 'list', 'create')
   * @param {string[]} args - Additional arguments
   * @param {object} options - { timeout }
   * @returns {Promise<{stdout, stderr, exitCode, timedOut}>}
   */
  run(command, args = [], options = {}) {
    const timeout = options.timeout || this.defaultTimeout;
    const fullArgs = [CLI_PATH, command, ...args];

    return new Promise((resolve) => {
      execFile(process.execPath, fullArgs, {
        env: this.env.env,
        encoding: 'utf8',
        timeout,
        maxBuffer: 1024 * 1024
      }, (error, stdout, stderr) => {
        resolve({
          stdout: stdout || '',
          stderr: stderr || '',
          exitCode: error ? (error.code || 1) : 0,
          timedOut: error && error.killed
        });
      });
    });
  }

  /**
   * Complete onboarding programmatically via `onboard --submit`.
   *
   * @param {object} disclosure - { personalityNotes, topics, objectives, neverDisclose }
   * @returns {Promise<{success, stdout, stderr}>}
   */
  async onboard(disclosure = {}) {
    const submission = {
      tiers: {
        public: {
          topics: disclosure.topics || [{ topic: 'General', description: 'Open discussion' }],
          objectives: disclosure.objectives || [],
          do_not_discuss: disclosure.doNotDiscuss || []
        },
        friends: { topics: [], objectives: [], do_not_discuss: [] },
        family: { topics: [], objectives: [], do_not_discuss: [] }
      },
      never_disclose: disclosure.neverDisclose || [],
      personality_notes: disclosure.personalityNotes || 'E2E test agent'
    };

    const result = await this.run('onboard', ['--submit', JSON.stringify(submission)]);
    return {
      success: result.exitCode === 0 && result.stdout.includes('Onboarding complete'),
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode
    };
  }

  /**
   * Create a token and return the parsed output.
   * @param {object} options - { name, tier, expires, maxCalls, topics }
   * @returns {Promise<{success, token, inviteUrl, stdout}>}
   */
  async createToken(options = {}) {
    const args = [];
    if (options.name) args.push('--name', options.name);
    if (options.tier) args.push('--tier', options.tier);
    if (options.expires) args.push('--expires', options.expires);
    if (options.maxCalls) args.push('--max-calls', String(options.maxCalls));
    if (options.topics) args.push('--topics', options.topics);

    const result = await this.run('create', args);

    // Parse invite URL from output (format: a2a://host/token)
    const urlMatch = result.stdout.match(/a2a:\/\/[^\s]+/);
    const tokenMatch = result.stdout.match(/fed_[A-Za-z0-9_-]+/);

    return {
      success: result.exitCode === 0,
      inviteUrl: urlMatch ? urlMatch[0] : null,
      token: tokenMatch ? tokenMatch[0] : null,
      stdout: result.stdout,
      stderr: result.stderr
    };
  }

  /**
   * Add a contact from an invite URL.
   * @param {string} inviteUrl - a2a://host/token URL
   * @param {string} name - Contact name
   * @returns {Promise<{success, stdout, stderr}>}
   */
  async addContact(inviteUrl, name) {
    const result = await this.run('add', [inviteUrl, name]);
    return {
      success: result.exitCode === 0,
      stdout: result.stdout,
      stderr: result.stderr
    };
  }

  /**
   * List tokens.
   * @returns {Promise<{success, stdout}>}
   */
  async listTokens() {
    const result = await this.run('list');
    return {
      success: result.exitCode === 0,
      stdout: result.stdout,
      stderr: result.stderr
    };
  }

  /**
   * List contacts.
   * @returns {Promise<{success, stdout}>}
   */
  async listContacts() {
    const result = await this.run('contacts');
    return {
      success: result.exitCode === 0,
      stdout: result.stdout,
      stderr: result.stderr
    };
  }

  /**
   * Ping a remote agent.
   * @param {string} target - URL or contact name
   * @returns {Promise<{success, stdout}>}
   */
  async ping(target) {
    const result = await this.run('ping', [target]);
    return {
      success: result.exitCode === 0,
      stdout: result.stdout,
      stderr: result.stderr
    };
  }
}

module.exports = { CLIRunner };
