/**
 * Google A2A Agent Card Builder
 *
 * Assembles a standards-compliant Agent Card from existing config,
 * disclosure manifest, and crypto identity. The card is served at
 * GET /.well-known/a2a-agent-card and mirrored at GET /api/a2a/agent-card.
 *
 * Reference: A2A-75 assessment, A2A-76 implementation ticket.
 */

const crypto = require('node:crypto');
const { fingerprint } = require('./crypto');

/**
 * Build a Google A2A-compliant Agent Card.
 *
 * @param {object} opts
 * @param {object} opts.config    - Result of A2AConfig.getAgent()
 * @param {object} opts.manifest  - Result of getTopicsForTier('public')
 * @param {string|null} opts.publicKey - Base64-encoded Ed25519 public key (or null)
 * @param {string} opts.serverUrl - Externally-reachable base URL (e.g. "https://host.com")
 * @param {string} opts.version   - Package version string
 * @returns {object} Agent Card JSON
 */
function buildAgentCard({ config, manifest, publicKey, serverUrl, version }) {
  const agentName = config?.name || 'a2a-agent';
  const agentDescription = config?.description || '';
  const ownerName = config?.owner || '';

  // Agent ID: Ed25519 fingerprint if available, else deterministic hash of name + hostname
  const id = publicKey
    ? fingerprint(publicKey)
    : crypto.createHash('sha256')
        .update(`${agentName}:${config?.hostname || 'localhost'}`)
        .digest('hex')
        .match(/.{2}/g)
        .join(':');

  // Map public-tier disclosure topics → Agent Card skills
  const topics = (manifest && Array.isArray(manifest.topics)) ? manifest.topics : [];
  const skills = topics
    .filter(t => t?.topic)
    .map(t => ({
      id: t.topic.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''),
      name: t.topic,
      description: t.description || ''
    }));

  // Normalize server URL (strip trailing slash)
  const baseUrl = (serverUrl || '').replace(/\/+$/, '');

  const card = {
    id,
    name: agentName,
    version: version || '0.0.0',
    provider: ownerName ? { name: ownerName } : undefined,
    description: agentDescription || undefined,
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: false
    },
    skills,
    interfaces: [
      {
        type: 'rest',
        url: `${baseUrl}/api/a2a/`,
        version: '0.3'
      }
    ],
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description: 'A2A federation token (fed_xxx)'
      }
    },
    security: [{ bearerAuth: [] }],
    extensions: [
      {
        uri: 'https://openclaw.dev/a2a/extensions/trust-tiers',
        version: '1.0.0',
        required: false,
        data: {
          tiers: ['public', 'friends', 'family'],
          default_tier: 'public',
          disclosure_levels: ['public', 'minimal', 'none'],
          default_disclosure: 'minimal',
          supports_topics: true,
          supports_goals: true,
          owner_notifications: true,
          max_calls_enforced: true
        }
      }
    ]
  };

  // Include signature identity only when a keypair exists
  if (publicKey) {
    card.signature = {
      algorithm: 'ed25519',
      publicKey,
      fingerprint: fingerprint(publicKey)
    };
  }

  // Strip undefined values for clean JSON
  return JSON.parse(JSON.stringify(card));
}

module.exports = { buildAgentCard };
