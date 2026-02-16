/**
 * PID File Management
 *
 * Writes/reads/removes a PID file for the A2A server process.
 * Used by server.js on startup and cli.js for pre-start cleanup.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const CONFIG_DIR = process.env.A2A_CONFIG_DIR ||
  process.env.OPENCLAW_CONFIG_DIR ||
  path.join(process.env.HOME || '/tmp', '.config', 'openclaw');

const PID_FILE = path.join(CONFIG_DIR, 'a2a-server.pid');

function writePidFile(pid) {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    fs.writeFileSync(PID_FILE, String(pid) + '\n', { mode: 0o600 });
  } catch (e) {
    // Best effort — don't crash the server if PID file write fails
  }
}

function readPidFile() {
  try {
    const content = fs.readFileSync(PID_FILE, 'utf8').trim();
    const pid = parseInt(content, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch (e) {
    return null;
  }
}

function removePidFile() {
  try {
    fs.rmSync(PID_FILE, { force: true });
  } catch (e) {
    // Best effort
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Kill the server process recorded in the PID file.
 * Returns { killed: boolean, pid: number|null }.
 */
function killExistingServer() {
  const pid = readPidFile();
  if (!pid) return { killed: false, pid: null };

  if (!isProcessAlive(pid)) {
    // Stale PID file — clean up
    removePidFile();
    return { killed: false, pid };
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch (e) {
    removePidFile();
    return { killed: false, pid };
  }

  // Wait up to 3s for graceful exit
  const start = Date.now();
  while (Date.now() - start < 3000) {
    if (!isProcessAlive(pid)) {
      removePidFile();
      return { killed: true, pid };
    }
    spawnSync('sleep', ['0.1'], { timeout: 500 });
  }

  // Force kill
  try {
    process.kill(pid, 'SIGKILL');
  } catch (e) {}

  removePidFile();
  return { killed: true, pid };
}

module.exports = {
  writePidFile,
  readPidFile,
  removePidFile,
  isProcessAlive,
  killExistingServer,
  PID_FILE
};
