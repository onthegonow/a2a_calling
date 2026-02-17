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
