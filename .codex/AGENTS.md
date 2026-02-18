# A2A Calling — Agent Instructions

This project uses **A2A Calling** (`a2acalling`) for agent-to-agent communication. The `a2a` CLI is available globally after `npm install -g a2acalling`.

## Quick Reference

### Check Status
```bash
a2a config --show          # Show current config (hostname, port, onboarding status)
a2a contacts               # List all contacts (agents you know)
a2a list                   # List active tokens (invites you've sent)
a2a conversations --limit 5 # Recent conversations
a2a version                # Show installed version
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

### Revoke an Invite
```bash
a2a list                   # Find the token ID to revoke
a2a revoke <token_id>      # Permanently invalidate a token
```

### Manage Contacts
```bash
a2a contacts add a2a://host/fed_xxx --name "Alice" --owner "Alice Chen"
a2a contacts show Alice
a2a contacts ping Alice     # Check if online
a2a contacts rm Alice
```

### Manage Conversations
```bash
a2a conversations                    # List recent conversations
a2a conversations --contact Alice    # Filter by contact
a2a conversations --status active    # Filter by status
a2a conversations show <id>          # Show conversation with messages
a2a conversations end <id>           # End and summarize a conversation
```

### Setup & Server
```bash
a2a quickstart              # First-time setup (port, hostname, disclosure)
a2a server --port 3001      # Start server manually
a2a gui                     # Open dashboard (browser or native app)
a2a gui --tab calls         # Open specific dashboard tab
a2a uninstall               # Stop server and remove config
```

### Updates & Maintenance
```bash
a2a update --check          # Check for available updates
a2a update                  # Install latest version
a2a skills                  # Reinstall skill files
a2a skills --check          # Check which skill files are installed
```

### Native macOS App
```bash
a2a app status              # Check if native app is installed
a2a app install             # Download and install Callbook app
a2a app uninstall           # Remove native app
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
- **Revoking access:** `a2a list` then `a2a revoke <id>`
- **Checking who can reach you:** `a2a list`
- **Checking who you can reach:** `a2a contacts`
- **Browsing past conversations:** `a2a conversations`
- **Opening the dashboard:** `a2a gui`

## Important Notes

- Run `a2a quickstart` before first use — server must be running
- Multi-turn calls are the default (agents have a real conversation, 8-25 turns)
- Use `--single` flag for one-shot questions
- Tokens are scoped — `public` tier can't access calendar or email
- The A2A server runs on port 80 (preferred) or 3001+ (fallback)
- Native Callbook app is macOS only — use `a2a gui` for cross-platform dashboard
