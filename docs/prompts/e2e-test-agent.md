# E2E Test Agent Prompt Sequence

Run a full end-to-end validation of `a2acalling` in an isolated environment. Execute each step sequentially. If a step fails, log the failure and continue to the next step unless the failure is blocking (steps 1-3 block all subsequent steps).

## Prerequisites

Before starting, verify:

- **Node.js** >= 18.0.0 (`node --version`)
- **npm** available (`npm --version`)
- **Ports** 3100-3199 range available (used by test servers)
- **Disk** at least 200MB free in system temp directory
- **Network** localhost connections allowed (no firewall blocking loopback)

If any prerequisite is missing, report it as a step-0 failure and abort.

## Output Format

Report each step as a JSON object:

```json
{
  "step": 1,
  "name": "install",
  "status": "pass",
  "duration_ms": 4230,
  "error": null
}
```

On completion, return a JSON array of all step results:

```json
{
  "run_id": "e2e_<timestamp>",
  "started_at": "<ISO-8601>",
  "finished_at": "<ISO-8601>",
  "total_steps": 9,
  "passed": 8,
  "failed": 1,
  "results": [ ... ]
}
```

---

## Step 1: Install from npm

**What to do:**

```bash
WORKDIR=$(mktemp -d -t a2a-e2e-XXXXXX)
cd "$WORKDIR"
npm init -y --silent
npm install a2acalling
```

**Expected outcome:**
- Exit code 0 from `npm install`
- `node_modules/a2acalling/bin/cli.js` exists
- `node_modules/a2acalling/src/server.js` exists

**Failure:**
- If npm install fails, record the stderr and abort all remaining steps (blocking).

**Variables to carry forward:**
- `WORKDIR` -- root temp directory
- `CLI` = `$WORKDIR/node_modules/.bin/a2a`
- `A2A_CONFIG_DIR` = `$WORKDIR/config` (create this directory)

---

## Step 2: Run Quickstart Onboarding

**What to do:**

```bash
export A2A_CONFIG_DIR="$WORKDIR/config"
export CI=true
mkdir -p "$A2A_CONFIG_DIR"
```

First, write a minimal config to simulate port detection completing:

```bash
cat > "$A2A_CONFIG_DIR/a2a-config.json" << 'CONF'
{
  "onboarding": { "version": 2, "step": "awaiting_disclosure", "server_port": 3100 },
  "agent": { "hostname": "localhost:3100", "name": "e2e-test-agent" },
  "tiers": {}
}
CONF
```

Then submit the disclosure manifest:

```bash
node "$CLI" onboard --submit '{
  "tiers": {
    "public": {
      "topics": [{"topic": "General", "description": "Open discussion"}],
      "objectives": [],
      "do_not_discuss": []
    },
    "friends": {
      "topics": [{"topic": "Projects", "description": "Current work"}],
      "objectives": [],
      "do_not_discuss": []
    },
    "family": {
      "topics": [{"topic": "Everything", "description": "Full access"}],
      "objectives": [],
      "do_not_discuss": []
    }
  },
  "never_disclose": ["passwords", "api-keys"],
  "personality_notes": "E2E test agent. Direct and minimal responses."
}'
```

**Expected outcome:**
- Exit code 0
- stdout contains "Onboarding complete"
- `$A2A_CONFIG_DIR/a2a-config.json` has `onboarding.step` set to `"complete"`

**Failure:**
- If onboarding fails, record stdout/stderr and abort (blocking).

---

## Step 3: Verify Server Health

**What to do:**

Start the server, then check health endpoints:

```bash
node "$WORKDIR/node_modules/a2acalling/src/server.js" &
SERVER_PID=$!
sleep 2
```

Check ping:

```bash
curl -s http://localhost:3100/api/a2a/ping
```

Check status:

```bash
curl -s http://localhost:3100/api/a2a/status
```

**Expected outcome:**
- Ping returns `{"pong": true, "timestamp": "..."}` with HTTP 200
- Status returns JSON with `"a2a": true` and a `"version"` field
- Server process is running (PID exists)

**Failure:**
- If server does not start or endpoints do not respond within 10 seconds, abort (blocking).

**Variables to carry forward:**
- `SERVER_PID`
- `BASE_URL` = `http://localhost:3100`

---

## Step 4: Create Invite Token

**What to do:**

```bash
node "$CLI" create --name "E2E-Caller" --tier public --expires 1h
```

Parse the output to extract the token and invite URL.

**Expected outcome:**
- Exit code 0
- Output contains an invite URL matching `a2a://localhost:3100/fed_...`
- Output contains a token matching `fed_[A-Za-z0-9_-]+`

**Variables to carry forward:**
- `TOKEN` -- the `fed_...` string
- `INVITE_URL` -- the full `a2a://...` URL

---

## Step 5: Test Inbound Call

**What to do:**

```bash
curl -s -X POST "$BASE_URL/api/a2a/invoke" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Hello from E2E test",
    "caller": {
      "name": "E2E Test Runner",
      "instance": "localhost",
      "context": "Automated E2E validation"
    }
  }'
```

**Expected outcome:**
- HTTP 200
- Response JSON has `"success": true`
- Response JSON has a `"conversation_id"` starting with `conv_`
- Response JSON has a non-empty `"response"` field
- Response JSON has `"can_continue": true`

---

## Step 6: Test Multi-turn Conversation

**What to do:**

Use the `conversation_id` from step 5. Make two follow-up calls:

Call 1:
```bash
curl -s -X POST "$BASE_URL/api/a2a/invoke" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"message\": \"Follow-up question 1\",
    \"conversation_id\": \"$CONVERSATION_ID\"
  }"
```

Call 2:
```bash
curl -s -X POST "$BASE_URL/api/a2a/invoke" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"message\": \"Follow-up question 2\",
    \"conversation_id\": \"$CONVERSATION_ID\"
  }"
```

**Expected outcome:**
- Both calls return HTTP 200 with `"success": true`
- Both return the same `conversation_id` as the original
- Both have non-empty `"response"` fields

---

## Step 7: Test Error Cases

Run three negative tests:

### 7a: No auth header

```bash
curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/api/a2a/invoke" \
  -H "Content-Type: application/json" \
  -d '{"message": "no auth"}'
```

**Expected:** HTTP 401, response body has `"error": "missing_token"`

### 7b: Bad token

```bash
curl -s -X POST "$BASE_URL/api/a2a/invoke" \
  -H "Authorization: Bearer fed_invalid_token_value" \
  -H "Content-Type: application/json" \
  -d '{"message": "bad token"}'
```

**Expected:** HTTP 401 or 403, response body has `"success": false`

### 7c: Missing message body

```bash
curl -s -X POST "$BASE_URL/api/a2a/invoke" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
```

**Expected:** HTTP 400, response body has `"error": "missing_message"`

**Step passes only if all three sub-tests pass.** Report sub-test details in the error field if any fail.

---

## Step 8: Test Token Revocation

**What to do:**

First, find the token ID:

```bash
node "$CLI" list
```

Parse the token ID (`tok_...`) from the output, then revoke it:

```bash
node "$CLI" revoke "$TOKEN_ID"
```

Then attempt a call with the revoked token:

```bash
curl -s -X POST "$BASE_URL/api/a2a/invoke" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message": "should fail"}'
```

**Expected outcome:**
- Revoke command exits 0
- Post-revocation call returns `"success": false`
- Error field is `"token_revoked"` or similar auth error

---

## Step 9: Cleanup

**What to do:**

```bash
kill $SERVER_PID 2>/dev/null
wait $SERVER_PID 2>/dev/null

rm -rf "$WORKDIR"
```

Verify:
```bash
! kill -0 $SERVER_PID 2>/dev/null  # process is gone
[ ! -d "$WORKDIR" ]               # directory is gone
```

**Expected outcome:**
- Server process is terminated
- Temp directory is removed
- No orphaned processes on port 3100

**This step always passes unless cleanup throws an unexpected error.**

---

## Failure Reporting

When a step fails, generate a Linear bug report payload:

```json
{
  "title": "E2E: Step <N> (<name>) failed",
  "description": "## Failure\n\n<error message>\n\n## Reproduction\n\nRun `node test/e2e/orchestrate.js --verbose`\n\n## Environment\n\n- Node: <version>\n- npm: <version>\n- OS: <platform>\n- a2acalling: <version>",
  "priority": 2,
  "labels": ["bug", "e2e"],
  "team": "ENG"
}
```

Priority mapping:
- Steps 1-3 (blocking): priority 1 (Urgent)
- Steps 4-6 (core flow): priority 2 (High)
- Steps 7-8 (error handling): priority 3 (Normal)
- Step 9 (cleanup): priority 4 (Low)
