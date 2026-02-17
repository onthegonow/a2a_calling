# Claude Code & Codex CLI Skills for A2A Calling — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship `.claude/commands/` slash commands and `.codex/` AGENTS.md instructions that let Claude Code and Codex CLI users operate A2A directly from their coding agent — create tokens, manage contacts, make calls, check status — all wrapping the existing `a2a` CLI binary.

**Architecture:** Both tools use markdown-based configuration. Claude Code reads `.claude/commands/<name>.md` to register `/a2a-*` slash commands. Codex reads `AGENTS.md` for instructions. Both invoke the same `a2a` CLI under the hood via `Bash`/shell. A postinstall hook copies these files into the user's project when `npm install -g a2acalling` runs. No new runtime code — just markdown wiring.

**Tech Stack:** Markdown (Claude Code commands + Codex AGENTS.md), shell (CLI invocations), Node.js (postinstall copy logic)

---

## File Inventory

| File | Action | Purpose |
|------|--------|---------|
| `.claude/commands/a2a-call.md` | Create | `/a2a-call` — call a contact or invite URL |
| `.claude/commands/a2a-invite.md` | Create | `/a2a-invite` — create token and show invite URL |
| `.claude/commands/a2a-contacts.md` | Create | `/a2a-contacts` — list/manage contacts |
| `.claude/commands/a2a-status.md` | Create | `/a2a-status` — check server + agent health |
| `.claude/commands/a2a-setup.md` | Create | `/a2a-setup` — onboard and start server |
| `.codex/AGENTS.md` | Create | Codex CLI agent instructions for A2A |
| `scripts/install-skills.js` | Create | Copies skills into user project on install |
| `test/unit/install-skills.test.js` | Create | Tests for skill installer |
| `scripts/postinstall.js` | Modify | Call install-skills after server setup |
| `docs/protocol.md` | Modify | Add "CLI Skills" section |
| `bin/cli.js` | Modify | Add `a2a skills` subcommand |

**Total new files:** 8
**Total modified files:** 3
**Estimated commits:** 8

---

## Phase 1: Claude Code Slash Commands

### Task 1: `/a2a-call` — Call a contact

**Files:**
- Create: `.claude/commands/a2a-call.md`

**Step 1: Create the command file**

```markdown
---
description: Call another A2A agent — starts a multi-turn conversation
allowed-tools: [Bash, Read]
argument-hint: <contact-or-url> <message>
---

Call an A2A agent. This starts a multi-turn agent-to-agent conversation.

## Usage

```
/a2a-call Alice "Hello! My owner wants to discuss the project."
/a2a-call a2a://host.com/fed_abc123 "Reaching out about collaboration"
```

## Instructions

Run the following command with the user's arguments:

```bash
a2a call $ARGUMENTS
```

If the call succeeds, summarize the conversation outcome for the user.
If it fails with "not onboarded", tell the user to run `/a2a-setup` first.
If it fails with "contact not found", suggest `/a2a-contacts` to see available contacts.
```

**Step 2: Verify file is valid markdown with frontmatter**

Run: `head -5 .claude/commands/a2a-call.md`
Expected: YAML frontmatter with `---` delimiters

**Step 3: Commit**

```bash
git add .claude/commands/a2a-call.md
git commit -m "feat: add /a2a-call Claude Code slash command"
```

---

### Task 2: `/a2a-invite` — Create token and invite URL

**Files:**
- Create: `.claude/commands/a2a-invite.md`

**Step 1: Create the command file**

```markdown
---
description: Create an A2A invite token to share with another agent
allowed-tools: [Bash]
argument-hint: [name] [--tier public|friends|family] [--expires 7d]
---

Create an A2A federation token and display the invite URL for sharing.

## Usage

```
/a2a-invite Alice --tier friends --expires 7d
/a2a-invite "Bob's Agent" --tier public
/a2a-invite                              # interactive — uses defaults
```

## Instructions

Parse the user's arguments and run:

```bash
a2a create --name "$1" $ARGUMENTS
```

If no arguments provided, run `a2a create` with no flags (interactive mode).

After success, display the invite URL prominently and explain:
1. The URL format: `a2a://<hostname>/<token>`
2. Share this URL with the other agent's owner
3. The token tier controls what the caller can access
4. The token expires per the `--expires` flag (default: never)

Also suggest: "Run `/a2a-contacts` to see who already has access."
```

**Step 2: Commit**

```bash
git add .claude/commands/a2a-invite.md
git commit -m "feat: add /a2a-invite Claude Code slash command"
```

---

### Task 3: `/a2a-contacts` — List and manage contacts

**Files:**
- Create: `.claude/commands/a2a-contacts.md`

**Step 1: Create the command file**

```markdown
---
description: List A2A contacts — agents you can call or who can call you
allowed-tools: [Bash]
argument-hint: [add|show|ping|rm] [args...]
---

Manage your A2A contact list — see who you can call and who has access to you.

## Usage

```
/a2a-contacts                          # list all contacts
/a2a-contacts add a2a://host/fed_xxx Alice  # add contact from invite URL
/a2a-contacts show Alice               # show contact details
/a2a-contacts ping Alice               # check if contact is online
/a2a-contacts rm Alice                 # remove a contact
```

## Instructions

Run the appropriate command based on user input:

- No arguments: `a2a contacts`
- `add`: `a2a contacts add $ARGUMENTS`
- `show`: `a2a contacts show $ARGUMENTS`
- `ping`: `a2a contacts ping $ARGUMENTS`
- `rm`: `a2a contacts rm $ARGUMENTS`

If the user just wants to see their contacts, also run `a2a list` to show active tokens (outbound invites).

Format the output clearly: contact name, owner, status (online/offline), permission tier, last seen.
```

**Step 2: Commit**

```bash
git add .claude/commands/a2a-contacts.md
git commit -m "feat: add /a2a-contacts Claude Code slash command"
```

---

### Task 4: `/a2a-status` — Server and agent health

**Files:**
- Create: `.claude/commands/a2a-status.md`

**Step 1: Create the command file**

```markdown
---
description: Check A2A server status, active conversations, and agent health
allowed-tools: [Bash, Read]
---

Check the health of your A2A installation — server running, conversations active, contacts online.

## Instructions

Run these commands and compile a status report:

1. **Server health:** `a2a ping a2a://localhost` (or use configured hostname from `a2a config --show`)
2. **Active tokens:** `a2a list`
3. **Contacts:** `a2a contacts`
4. **Recent conversations:** `a2a conversations --limit 5`
5. **Config:** `a2a config --show`

Present a clear status dashboard:
- Server: running/stopped (with port)
- Hostname: configured hostname
- Tokens: N active, N expired
- Contacts: N total, N online
- Recent calls: last 5 conversations

If the server is not running, suggest `/a2a-setup` to start it.
```

**Step 2: Commit**

```bash
git add .claude/commands/a2a-status.md
git commit -m "feat: add /a2a-status Claude Code slash command"
```

---

### Task 5: `/a2a-setup` — Onboarding and server start

**Files:**
- Create: `.claude/commands/a2a-setup.md`

**Step 1: Create the command file**

```markdown
---
description: Set up A2A Calling — onboard, start server, configure agent
allowed-tools: [Bash, Read, Write]
argument-hint: [--force]
---

Set up or reset your A2A Calling installation. Runs onboarding, starts the server, and configures your agent.

## Usage

```
/a2a-setup              # first-time setup or resume incomplete onboarding
/a2a-setup --force      # reset and re-run from scratch
```

## Instructions

1. Check if already onboarded: `a2a config --show`
2. If not onboarded (or `--force`): run `a2a quickstart`
3. If already onboarded but server not running: run `a2a server` in background
4. After setup, run `/a2a-status` to show the result

The quickstart flow will:
- Detect an available port
- Start the A2A server
- Detect the hostname
- Prompt for disclosure topics (what your agent discusses)
- Save the configuration

If running non-interactively, quickstart auto-accepts defaults.
```

**Step 2: Commit**

```bash
git add .claude/commands/a2a-setup.md
git commit -m "feat: add /a2a-setup Claude Code slash command"
```

---

## Phase 2: Codex CLI Support

### Task 6: Codex AGENTS.md with A2A instructions

**Files:**
- Create: `.codex/AGENTS.md`

**Step 1: Create the AGENTS.md file**

```markdown
# A2A Calling — Agent Instructions

This project uses **A2A Calling** (`a2acalling`) for agent-to-agent communication. The `a2a` CLI is available globally after `npm install -g a2acalling`.

## Quick Reference

### Check Status
```bash
a2a config --show          # Show current config (hostname, port, onboarding status)
a2a contacts               # List all contacts (agents you know)
a2a list                   # List active tokens (invites you've sent)
a2a conversations --limit 5 # Recent conversations
```

### Make a Call
```bash
a2a call <contact> "<message>"                    # Multi-turn call to a contact
a2a call a2a://host/fed_xxx "<message>"            # Call via invite URL
a2a call Alice "Hello! Let's discuss the project." # By contact name
a2a call Alice "Quick question" --single           # One-shot (no back-and-forth)
```

### Create an Invite
```bash
a2a create --name "AgentName" --tier friends --expires 7d
# Output: a2a://your-host/fed_xxx — share this URL with the other agent
```

### Manage Contacts
```bash
a2a contacts add a2a://host/fed_xxx --name "Alice" --owner "Alice Chen"
a2a contacts show Alice
a2a contacts ping Alice     # Check if online
a2a contacts rm Alice
```

### Setup & Server
```bash
a2a quickstart              # First-time setup (port, hostname, disclosure)
a2a server --port 3001      # Start server manually
a2a uninstall               # Stop server and remove config
```

## Permission Tiers

| Tier | Access Level |
|------|-------------|
| `public` | Read-only context |
| `friends` | Calendar, email, search (read) |
| `family` | Full access (calendar, email, search, tools, memory) |

## Disclosure Levels

| Level | Behavior |
|-------|----------|
| `public` | Agent shares freely within tier boundaries |
| `minimal` | Direct answers only, no volunteered context |
| `none` | Confirms capability, provides no information |

## When to Use A2A

- **Reaching out to another agent:** `a2a call <contact> "<message>"`
- **Sharing access with someone:** `a2a create --name "Name" --tier friends`
- **Checking who can reach you:** `a2a list`
- **Checking who you can reach:** `a2a contacts`

## Important Notes

- Run `a2a quickstart` before first use — server must be running
- Multi-turn calls are the default (agents have a real conversation, 8-25 turns)
- Use `--single` flag for one-shot questions
- Tokens are scoped — `public` tier can't access calendar or email
- The A2A server runs on port 80 (preferred) or 3001+ (fallback)
```

**Step 2: Commit**

```bash
git add .codex/AGENTS.md
git commit -m "feat: add Codex CLI AGENTS.md for A2A commands"
```

---

## Phase 3: Skill Installer & CLI Integration

### Task 7: Skill installer script

**Files:**
- Create: `scripts/install-skills.js`
- Test: `test/unit/install-skills.test.js`

**Step 1: Write the failing test**

The installer should:
- Copy `.claude/commands/*.md` to the user's project `.claude/commands/` dir
- Copy `.codex/AGENTS.md` to the user's project `.codex/` dir
- Be idempotent (skip if files already exist and are identical)
- Support `--force` to overwrite
- Return a summary of what was installed

```javascript
// test/unit/install-skills.test.js
module.exports = function(test, assert, helpers) {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');

  test('installSkills creates .claude/commands directory and copies files', () => {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-skills-'));
    try {
      const { installSkills } = require('../../scripts/install-skills');
      const result = installSkills(targetDir);

      assert.ok(result.installed.length > 0, 'Should install at least one file');
      assert.ok(fs.existsSync(path.join(targetDir, '.claude', 'commands', 'a2a-call.md')),
        'Should create a2a-call.md');
      assert.ok(fs.existsSync(path.join(targetDir, '.codex', 'AGENTS.md')),
        'Should create AGENTS.md');
    } finally {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
  });

  test('installSkills skips existing identical files', () => {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-skills-'));
    try {
      const { installSkills } = require('../../scripts/install-skills');
      installSkills(targetDir);
      const result2 = installSkills(targetDir);

      assert.equal(result2.skipped.length > 0, true, 'Should skip files on second run');
      assert.equal(result2.installed.length, 0, 'Should not re-install identical files');
    } finally {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
  });

  test('installSkills with force overwrites existing files', () => {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-skills-'));
    try {
      const { installSkills } = require('../../scripts/install-skills');
      installSkills(targetDir);
      const result2 = installSkills(targetDir, { force: true });

      assert.ok(result2.installed.length > 0, 'Should overwrite files with force');
    } finally {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
  });

  test('installSkills returns summary with correct counts', () => {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-skills-'));
    try {
      const { installSkills } = require('../../scripts/install-skills');
      const result = installSkills(targetDir);

      assert.ok(Array.isArray(result.installed), 'Should have installed array');
      assert.ok(Array.isArray(result.skipped), 'Should have skipped array');
      assert.ok(Array.isArray(result.errors), 'Should have errors array');
      assert.equal(result.errors.length, 0, 'Should have no errors');
    } finally {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
  });
};
```

**Step 2: Run test to verify it fails**

Run: `node test/run.js --filter install-skills`
Expected: FAIL — `scripts/install-skills.js` doesn't exist yet

**Step 3: Write minimal implementation**

```javascript
// scripts/install-skills.js
/**
 * A2A Skill Installer
 *
 * Copies Claude Code commands and Codex AGENTS.md into a target project directory.
 * Idempotent: skips files that already exist with identical content.
 */

const fs = require('fs');
const path = require('path');

const PACKAGE_ROOT = path.join(__dirname, '..');

const SKILL_FILES = [
  { src: '.claude/commands/a2a-call.md', dest: '.claude/commands/a2a-call.md' },
  { src: '.claude/commands/a2a-invite.md', dest: '.claude/commands/a2a-invite.md' },
  { src: '.claude/commands/a2a-contacts.md', dest: '.claude/commands/a2a-contacts.md' },
  { src: '.claude/commands/a2a-status.md', dest: '.claude/commands/a2a-status.md' },
  { src: '.claude/commands/a2a-setup.md', dest: '.claude/commands/a2a-setup.md' },
  { src: '.codex/AGENTS.md', dest: '.codex/AGENTS.md' }
];

function installSkills(targetDir, options = {}) {
  const result = { installed: [], skipped: [], errors: [] };

  for (const file of SKILL_FILES) {
    const srcPath = path.join(PACKAGE_ROOT, file.src);
    const destPath = path.join(targetDir, file.dest);

    try {
      if (!fs.existsSync(srcPath)) {
        result.errors.push({ file: file.src, error: 'Source file not found' });
        continue;
      }

      const srcContent = fs.readFileSync(srcPath, 'utf8');

      // Check if identical file already exists
      if (!options.force && fs.existsSync(destPath)) {
        const existing = fs.readFileSync(destPath, 'utf8');
        if (existing === srcContent) {
          result.skipped.push(file.dest);
          continue;
        }
      }

      // Create directory and write file
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, srcContent);
      result.installed.push(file.dest);
    } catch (err) {
      result.errors.push({ file: file.dest, error: err.message });
    }
  }

  return result;
}

// CLI mode: node scripts/install-skills.js [targetDir] [--force]
if (require.main === module) {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const targetDir = args.find(a => !a.startsWith('-')) || process.cwd();

  const result = installSkills(targetDir, { force });

  if (result.installed.length) {
    console.log(`Installed ${result.installed.length} A2A skill file(s):`);
    result.installed.forEach(f => console.log(`  + ${f}`));
  }
  if (result.skipped.length) {
    console.log(`Skipped ${result.skipped.length} unchanged file(s)`);
  }
  if (result.errors.length) {
    console.error(`Errors: ${result.errors.length}`);
    result.errors.forEach(e => console.error(`  ! ${e.file}: ${e.error}`));
    process.exit(1);
  }
}

module.exports = { installSkills, SKILL_FILES };
```

**Step 4: Run tests to verify they pass**

Run: `node test/run.js --filter install-skills`
Expected: 4 passing

**Step 5: Commit**

```bash
git add scripts/install-skills.js test/unit/install-skills.test.js
git commit -m "feat: add skill installer for Claude Code + Codex CLI"
```

---

### Task 8: `a2a skills` CLI subcommand

**Files:**
- Modify: `bin/cli.js` — add `skills` subcommand after existing commands

**Step 1: Add the skills subcommand to cli.js**

Find the command dispatch section in `bin/cli.js` and add a `skills` case. The command should:
- `a2a skills` — install skills into current project directory
- `a2a skills --force` — overwrite existing files
- `a2a skills --check` — show what would be installed without writing

```javascript
// Add to the command switch in bin/cli.js
case 'skills': {
  const { installSkills } = require('../scripts/install-skills');
  const check = args.includes('--check');
  const force = args.includes('--force');
  const targetDir = process.cwd();

  if (check) {
    const fs = require('fs');
    const { SKILL_FILES } = require('../scripts/install-skills');
    console.log('A2A skills for this project:\n');
    for (const file of SKILL_FILES) {
      const destPath = path.join(targetDir, file.dest);
      const exists = fs.existsSync(destPath);
      const icon = exists ? '  ✓' : '  ✗';
      console.log(`${icon} ${file.dest}${exists ? ' (installed)' : ' (not installed)'}`);
    }
    console.log(`\nRun "a2a skills" to install missing files.`);
    break;
  }

  const result = installSkills(targetDir, { force });

  if (result.installed.length) {
    console.log(`\n  Installed ${result.installed.length} A2A skill file(s):\n`);
    result.installed.forEach(f => console.log(`    + ${f}`));
  }
  if (result.skipped.length) {
    console.log(`\n  Skipped ${result.skipped.length} unchanged file(s)`);
  }
  if (result.errors.length) {
    console.error(`\n  Errors:`);
    result.errors.forEach(e => console.error(`    ! ${e.file}: ${e.error}`));
  }

  if (result.installed.length === 0 && result.skipped.length > 0) {
    console.log('\n  All skills already installed. Use --force to overwrite.\n');
  } else if (result.installed.length > 0) {
    console.log('\n  Skills ready. In Claude Code, type /a2a- to see available commands.');
    console.log('  In Codex CLI, A2A instructions are in .codex/AGENTS.md\n');
  }
  break;
}
```

Also add `'skills'` to the `ONBOARDING_EXEMPT` set since it doesn't require onboarding.

**Step 2: Run full test suite**

Run: `node test/run.js`
Expected: All passing (276+)

**Step 3: Commit**

```bash
git add bin/cli.js
git commit -m "feat: add 'a2a skills' CLI subcommand"
```

---

## Phase 4: Postinstall Integration & Documentation

### Task 9: Wire skill install into postinstall

**Files:**
- Modify: `scripts/postinstall.js`

**Step 1: Add skill installation to postinstall**

After the existing quickstart logic in `postinstall.js`, add a best-effort skill copy. This should:
- Only run on global install (already gated by `npm_config_global`)
- Copy skills into the workspace directory (`INIT_CWD` or `HOME`)
- Fail silently (best-effort, don't block install)

Add after the quickstart `spawnSync` block:

```javascript
// Best-effort: install Claude Code + Codex skills into the workspace
try {
  const { installSkills } = require('./install-skills');
  installSkills(initCwd);
} catch (e) {
  // Silent — skills can be installed later with `a2a skills`
}
```

**Step 2: Run full test suite**

Run: `node test/run.js`
Expected: All passing

**Step 3: Commit**

```bash
git add scripts/postinstall.js
git commit -m "feat: install skills on npm postinstall (best-effort)"
```

---

### Task 10: Documentation update

**Files:**
- Modify: `docs/protocol.md` — add "CLI Skills" section

**Step 1: Add CLI Skills section**

Insert before the "Future Protocol Extensions" section:

```markdown
## CLI Skills (Claude Code & Codex)

A2A ships with slash commands for Claude Code and agent instructions for Codex CLI.

### Installation

```bash
a2a skills              # Install into current project
a2a skills --check      # See what would be installed
a2a skills --force      # Overwrite existing files
```

Skills are also installed automatically on `npm install -g a2acalling`.

### Claude Code Commands

| Command | Description |
|---------|-------------|
| `/a2a-call <contact> <msg>` | Call another agent (multi-turn) |
| `/a2a-invite [name] [--tier]` | Create invite token |
| `/a2a-contacts [add\|show\|ping\|rm]` | Manage contacts |
| `/a2a-status` | Server and agent health dashboard |
| `/a2a-setup` | First-time setup and onboarding |

Files installed to: `.claude/commands/a2a-*.md`

### Codex CLI

A2A agent instructions are installed to `.codex/AGENTS.md`. Codex reads this file automatically to understand available A2A commands, permission tiers, and workflows.

### Manual Installation

If the automatic install didn't work, copy the files manually:

```bash
# Claude Code commands
cp node_modules/a2acalling/.claude/commands/a2a-*.md .claude/commands/

# Codex instructions
cp node_modules/a2acalling/.codex/AGENTS.md .codex/AGENTS.md
```
```

**Step 2: Commit**

```bash
git add docs/protocol.md
git commit -m "docs: add CLI skills section to protocol.md"
```

---

## Verification Checklist

After all tasks, verify:

1. `node test/run.js` — all tests pass
2. `node test/run.js --filter install-skills` — 4 skill installer tests pass
3. `a2a skills --check` — lists all skill files
4. `a2a skills` in a temp dir — installs all files
5. `ls .claude/commands/a2a-*.md` — 5 command files exist
6. `cat .codex/AGENTS.md` — Codex instructions present
7. `node test/run.js --e2e` — E2E tests still pass

---

## Task Summary

| # | Task | Phase | Files | Est. |
|---|------|-------|-------|------|
| 1 | `/a2a-call` command | 1: Claude Code | 1 new | 3 min |
| 2 | `/a2a-invite` command | 1: Claude Code | 1 new | 3 min |
| 3 | `/a2a-contacts` command | 1: Claude Code | 1 new | 3 min |
| 4 | `/a2a-status` command | 1: Claude Code | 1 new | 3 min |
| 5 | `/a2a-setup` command | 1: Claude Code | 1 new | 3 min |
| 6 | Codex AGENTS.md | 2: Codex | 1 new | 5 min |
| 7 | Skill installer + tests | 3: Integration | 2 new | 10 min |
| 8 | `a2a skills` subcommand | 3: Integration | 1 mod | 5 min |
| 9 | Postinstall wiring | 4: Polish | 1 mod | 3 min |
| 10 | Protocol docs update | 4: Polish | 1 mod | 3 min |

**Total: 8 new files, 3 modified, 10 tasks**
