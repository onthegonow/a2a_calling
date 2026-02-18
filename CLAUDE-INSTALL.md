# A2A Calling — Installed Package Context

This file is automatically installed by the `a2acalling` package to give Claude Code
immediate context after `npm install`. It describes what A2A Calling is, how to get
started, and the full CLI reference — so you never need to grep source code.

## Getting Started

After installing `a2acalling`, the FIRST thing to do is run onboarding:

```bash
a2a quickstart
```

This is the single entry point for all setup. It will:
1. Detect an available port (prefers 80, falls back to 3001+)
2. Start the A2A server
3. Detect the hostname
4. Prompt for disclosure topics (what your agent discusses with callers)
5. On macOS, offer to install the native Callbook app
6. Save configuration to `~/.config/openclaw/a2a-config.json`

If onboarding was already completed, re-run with `--force`:

```bash
a2a quickstart --force
```

## Native macOS App (A2A Callbook)

On macOS, a native desktop app is available. It provides a dashboard GUI for managing
calls, contacts, tokens, and logs.

```bash
a2a app install          # Download and install from GitHub releases
a2a app status           # Check if installed, show version and path
a2a app uninstall        # Remove from ~/Applications
```

After install, the app lives at `~/Applications/A2A Callbook.app`. You can also
open the dashboard in a browser:

```bash
a2a gui                  # Open dashboard in browser (or native app if installed)
a2a gui --tab logs       # Open specific tab: contacts|calls|logs|settings|invites
```

## Full CLI Reference

### Token Management

```bash
a2a create --name "AgentName" --owner "OwnerName" --expires 7d --permissions friends
  # Options:
  #   --name, -n        Token/agent name
  #   --owner, -o       Owner name
  #   --expires, -e     1h, 1d, 7d, 30d, never (default: 1d)
  #   --permissions, -p public, friends, family (default: public)
  #   --disclosure, -d  public, minimal, none (default: minimal)
  #   --notify          all, summary, none (default: all)
  #   --max-calls       Maximum invocations (default: 100)
  #   --topics          Custom topics (comma-separated)
  #   --tools           Custom tool allowlist (comma-separated)
  #   --link, -l        Auto-link to contact name

a2a list                 # List active tokens
a2a revoke <token_id>    # Revoke a token
```

### Contacts

```bash
a2a contacts             # List all contacts (shows permission badges)
a2a contacts add <url> --name "Alice" --owner "Alice Chen"
a2a contacts show <name> # Show contact details + linked token
a2a contacts edit <name> # Edit contact metadata
a2a contacts link <name> <token_id>  # Link a token to a contact
a2a contacts ping <name> # Ping contact, update status
a2a contacts rm <name>   # Remove contact
```

### Calling

```bash
a2a call <contact|url> "<message>"   # Multi-turn call (default: 8-25 turns)
a2a call Alice "Hello!"              # Call by contact name
a2a call a2a://host/fed_xxx "Hi"     # Call by invite URL
a2a call Alice "Quick q" --single    # One-shot (single turn)
  # --min-turns N     Minimum turns before close (default: 8)
  # --max-turns N     Maximum turns (default: 25)

a2a ping <url>           # Check if agent is reachable
a2a status <url>         # Get remote A2A status
```

### Conversations

```bash
a2a conversations                    # List all conversations
  # --contact         Filter by contact
  # --status          Filter: active, concluded, timeout
  # --limit           Max results (default: 20)
a2a conversations show <id>          # Show conversation with messages
a2a conversations end <id>           # End and summarize conversation
```

### Server & Setup

```bash
a2a quickstart                       # First-time setup (port, hostname, disclosure)
  # --port, -p        Preferred port (default: 80, fallback: 3001+)
  # --force           Reset and re-run from scratch
  # --submit '<json>' Submit disclosure JSON

a2a server --port 3001               # Start server manually
a2a config --show                    # Show current configuration
a2a status                           # Show local server status
a2a gui                              # Open dashboard GUI
a2a app install                      # Install native macOS app
a2a setup                            # Auto setup (gateway-aware)
```

### Maintenance

```bash
a2a update               # Update to latest version
a2a update --check       # Check for updates without installing
a2a skills               # Install Claude Code + Codex skill files
a2a uninstall --force    # Stop server and remove config/DB
a2a version              # Show installed version
```

## Permission Tiers

| Tier | Default Capabilities |
|------|---------------------|
| `public` | `context-read` |
| `friends` | `context-read`, `calendar.read`, `email.read`, `search` |
| `family` | `context-read`, `calendar`, `email`, `search`, `tools`, `memory` |

## Disclosure Levels

| Level | Behavior |
|-------|----------|
| `public` | Agent shares freely within tier boundaries |
| `minimal` | Direct answers only, no volunteered context |
| `none` | Confirms capability, provides no information |

## Key Paths

- Config: `~/.config/openclaw/a2a-config.json`
- Disclosure: `~/.config/openclaw/a2a-disclosure.json`
- Native app: `~/Applications/A2A Callbook.app` (macOS only)
- Dashboard: `http://127.0.0.1:<port>/dashboard/`
