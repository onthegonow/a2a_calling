# A2A Test Suite

Zero-dependency test framework for the A2A Calling system.

## Running Tests

```bash
# Run everything
npm test

# Unit tests only
node test/run.js --unit

# Integration tests only
node test/run.js --integration

# Filter by name
node test/run.js --filter tokens
node test/run.js --filter golda
node test/run.js --filter disclosure

# Verbose (show passing tests too)
node test/run.js --verbose
```

## Test Structure

```
test/
├── run.js                           # Test runner (discovers *.test.js files)
├── helpers.js                       # Shared utilities: tmp dirs, request helper, fixtures
├── README.md                        # This file
├── profiles/
│   └── golda-deluxe.js              # Canonical test agent profile
├── unit/
│   ├── tokens.test.js               # Token CRUD, validation, revocation, contacts
│   ├── config.test.js               # Config lifecycle, tiers, persistence
│   ├── disclosure.test.js           # Manifest load/save, tier merging, formatting
│   ├── prompt-template.test.js      # Prompt construction, phases, boundaries
│   ├── conversations.test.js        # SQLite storage, messages, summarization
│   ├── client.test.js               # URL parsing, error types, client construction
│   ├── summarizer.test.js           # Default + LLM summarizer, edge cases
│   └── call-monitor.test.js         # Activity tracking, idle detection
└── integration/
    ├── onboarding.test.js           # Full agent onboarding: config → disclosure → token → prompt
    ├── call-flow.test.js            # HTTP invoke lifecycle: Golda → claudebot
    └── rate-limiting.test.js        # Rate limit enforcement via HTTP
```

## How to Build a Test Agent Profile

Test profiles live in `test/profiles/` and define a complete agent identity that exercises the full data architecture.

### Step-by-Step

1. **Copy the template**: `cp test/profiles/golda-deluxe.js test/profiles/your-agent.js`

2. **Define the four sections**:

   ```javascript
   module.exports = {
     agent: { ... },         // Identity
     token: { ... },         // Permissions
     manifest: { ... },      // Disclosure topics
     callScenarios: { ... }  // Test messages
   };
   ```

3. **Agent identity** — name, owner, personality blurb:
   ```javascript
   agent: {
     name: 'Your Agent Name',
     owner: 'Owner Name',     // or null for unnamed
     personality: 'Description of communication style...'
   }
   ```

4. **Token permissions** — maps directly to `TokenStore.create()`:
   ```javascript
   token: {
     tier: 'public',          // 'public' | 'friends' | 'family'
     disclosure: 'minimal',   // 'public' | 'minimal' | 'none'
     expires: '1d',           // '1h' | '1d' | '7d' | '30d' | 'never'
     maxCalls: 100,
     notify: 'all',           // 'all' | 'summary' | 'none'
     allowedTopics: ['chat'], // capability strings
     tierSettings: {}         // per-tier overrides
   }
   ```

5. **Disclosure manifest** — maps to `a2a-disclosure.json`:
   ```javascript
   manifest: {
     version: 2,
     personality_notes: '...',
     tiers: {
       public: {
         topics: [{ topic: '...', description: '...' }],
         objectives: [{ objective: '...', description: '...' }],
         do_not_discuss: [{ topic: '...', reason: '...' }]
       },
       friends: { ... },  // Merged with public when accessed at friends tier
       family: { ... }    // Merged with public + friends at family tier
     },
     never_disclose: ['Secret 1', 'Secret 2']
   }
   ```

6. **Call scenarios** — test messages for integration tests:
   ```javascript
   callScenarios: {
     introduction: {
       message: 'Hello...',
       caller: { name: 'Your Agent', owner: 'Owner', context: '...' }
     },
     claudebotCall: { ... },  // For testing calls to claudebot
     challenge: { ... },       // For testing deeper engagement
     followUp: { ... }         // For multi-turn testing
   }
   ```

### How Interests Map to Data Architecture

| What you want                  | Where it goes                                |
|-------------------------------|----------------------------------------------|
| Discussion topics              | `manifest.tiers.<tier>.topics`               |
| Conversation objectives        | `manifest.tiers.<tier>.objectives`           |
| Topics to redirect             | `manifest.tiers.<tier>.do_not_discuss`       |
| Absolute information blocks    | `manifest.never_disclose`                    |
| API/tool access level          | `token.tier` + `token.allowedTopics`         |
| Response style preferences     | `token.tierSettings`                         |

### Tier Hierarchy

```
public  →  friends  →  family

Each higher tier INCLUDES all topics from lower tiers.
Friends sees public + friends topics.
Family sees public + friends + family topics.
```

### Permission Capabilities

| Tier        | Default Topics                                    |
|-------------|---------------------------------------------------|
| `public`    | `['chat']`                                        |
| `friends`   | `['chat', 'calendar.read', 'email.read', 'search']` |
| `family`    | `['chat', 'calendar', 'email', 'search', 'tools']`  |

You can add custom topics (e.g., `'market-analysis'`) to `allowedTopics`.

### Using Your Profile in Tests

```javascript
// In a test file
module.exports = function (test, assert, helpers) {
  test('my test', () => {
    const profile = require('../profiles/your-agent');

    // Create token
    const { store, token, cleanup } = helpers.tokenStoreWithGolda();
    // Or manually:
    const store = new TokenStore(tmpDir);
    const { token, record } = store.create({
      name: profile.agent.name,
      owner: profile.agent.owner,
      permissions: profile.token.tier,
      allowedTopics: profile.token.allowedTopics,
      // ...
    });
  });
};
```

## Writing Test Files

Each test file exports a function that receives `(test, assert, helpers)`:

```javascript
module.exports = function (test, assert, helpers) {
  test('my test name', async () => {
    // Use assert.* for assertions
    assert.ok(true);
    assert.equal(1, 1);
    assert.deepEqual([1], [1]);
    assert.includes('hello world', 'hello');
    assert.match('fed_abc', /^fed_/);
    assert.throws(() => { throw new Error(); });
    await assert.rejects(async () => { throw new Error(); });
    assert.notEqual(1, 2);
    assert.type('hello', 'string');
    assert.greaterThan(2, 1);
  });
};
```

### Assertions Reference

| Method                      | Description                          |
|-----------------------------|--------------------------------------|
| `assert.ok(val)`            | Truthy check                         |
| `assert.equal(a, b)`       | Strict equality (`===`)              |
| `assert.notEqual(a, b)`    | Strict inequality                    |
| `assert.deepEqual(a, b)`   | JSON deep equality                   |
| `assert.includes(str, sub)`| String/array contains                |
| `assert.match(str, regex)` | Regex match                          |
| `assert.throws(fn)`        | Sync function throws                 |
| `assert.rejects(fn)`       | Async function rejects               |
| `assert.type(val, type)`   | `typeof` check                       |
| `assert.greaterThan(a, b)` | `a > b`                              |

### Helpers Reference

| Helper                      | Description                                          |
|-----------------------------|------------------------------------------------------|
| `tmpConfigDir(prefix)`      | Isolated temp dir, sets `A2A_CONFIG_DIR`             |
| `goldaDeluxeProfile()`      | Returns the Golda Deluxe profile object              |
| `tokenStoreWithGolda()`     | Pre-populated TokenStore with Golda's token          |
| `writeDisclosureManifest()` | Write manifest JSON to config dir                    |
| `writeA2AConfig()`          | Write config JSON to config dir                      |
| `createTestApp()`           | Express app with A2A routes for HTTP testing         |
| `request(app)`              | HTTP client: `.get()`, `.post()`, `.close()`         |

## Stack Reference

- **Runtime**: Node.js >= 18.0.0
- **HTTP**: Express.js 4.21.0
- **Database**: better-sqlite3 11.10.0 (SQLite for conversations)
- **Storage**: JSON files for tokens, config, disclosure manifests
- **Test runner**: Custom (`test/run.js`), zero dependencies
