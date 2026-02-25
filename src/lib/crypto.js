/**
 * A2A Ed25519 Cryptographic Identity
 *
 * Provides keypair generation, request signing, signature verification,
 * and public key fingerprinting for agent-to-agent identity verification.
 *
 * A2A-52: Zero new dependencies — uses Node.js built-in crypto (Ed25519 since v15).
 */

const crypto = require('crypto');

// A2A-52: 5-minute window for replay protection
const TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;

/**
 * Generate an Ed25519 keypair.
 * Returns { privateKey, publicKey } as base64-encoded DER buffers.
 */
function generateKeypair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    publicKeyEncoding: { type: 'spki', format: 'der' }
  });
  return {
    privateKey: privateKey.toString('base64'),
    publicKey: publicKey.toString('base64')
  };
}

/**
 * Compute a SHA-256 fingerprint of a base64-encoded public key.
 * Returns colon-separated hex string (like SSH fingerprints).
 */
function fingerprint(publicKeyBase64) {
  const hash = crypto.createHash('sha256')
    .update(Buffer.from(publicKeyBase64, 'base64'))
    .digest('hex');
  // A2A-52: colon-separated pairs for readability (SSH-style)
  return hash.match(/.{2}/g).join(':');
}

/**
 * Sign an outbound request.
 *
 * Signing payload: `${timestamp}:${method}:${endpoint}:${bodyHash}`
 * where bodyHash = SHA-256 of the request body string.
 *
 * @param {object} params
 * @param {string} params.privateKey - base64-encoded DER private key
 * @param {string} params.publicKey  - base64-encoded DER public key
 * @param {string} params.method     - HTTP method (e.g. 'POST')
 * @param {string} params.endpoint   - Request path (e.g. '/api/a2a/invoke')
 * @param {string} params.body       - Serialized request body
 * @returns {object} Headers to attach: { 'X-A2A-Signature', 'X-A2A-Public-Key', 'X-A2A-Timestamp' }
 */
function signRequest({ privateKey, publicKey, method, endpoint, body }) {
  const timestamp = new Date().toISOString();
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
  const payload = `${timestamp}:${method}:${endpoint}:${bodyHash}`;

  const keyObject = crypto.createPrivateKey({
    key: Buffer.from(privateKey, 'base64'),
    format: 'der',
    type: 'pkcs8'
  });

  const signature = crypto.sign(null, Buffer.from(payload), keyObject);

  return {
    'X-A2A-Signature': signature.toString('base64'),
    'X-A2A-Public-Key': publicKey,
    'X-A2A-Timestamp': timestamp
  };
}

/**
 * Verify an inbound request signature.
 *
 * @param {object} params
 * @param {string} params.signature   - base64-encoded Ed25519 signature
 * @param {string} params.publicKey   - base64-encoded DER public key
 * @param {string} params.timestamp   - ISO 8601 timestamp from header
 * @param {string} params.method      - HTTP method
 * @param {string} params.endpoint    - Request path
 * @param {string} params.body        - Raw request body string
 * @returns {boolean} true if signature is valid
 */
function verifySignature({ signature, publicKey, timestamp, method, endpoint, body }) {
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
  const payload = `${timestamp}:${method}:${endpoint}:${bodyHash}`;

  const keyObject = crypto.createPublicKey({
    key: Buffer.from(publicKey, 'base64'),
    format: 'der',
    type: 'spki'
  });

  return crypto.verify(null, Buffer.from(payload), keyObject, Buffer.from(signature, 'base64'));
}

/**
 * Check if a timestamp is within the allowed window (replay protection).
 * @param {string} timestamp - ISO 8601 timestamp
 * @returns {boolean} true if within +-5 minutes of now
 */
function isTimestampValid(timestamp) {
  const ts = new Date(timestamp).getTime();
  if (Number.isNaN(ts)) return false;
  const diff = Math.abs(Date.now() - ts);
  return diff <= TIMESTAMP_WINDOW_MS;
}

module.exports = { generateKeypair, fingerprint, signRequest, verifySignature, isTimestampValid };
