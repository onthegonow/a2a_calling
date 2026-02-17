---
description: Check A2A server status, active conversations, and agent health
allowed-tools: [Bash, Read]
---

Check the health of your A2A installation — server running, conversations active, contacts online.

## Instructions

Run these commands and compile a status report:

1. **Config:** `a2a config --show`
2. **Active tokens:** `a2a list`
3. **Contacts:** `a2a contacts`
4. **Recent conversations:** `a2a conversations --limit 5`

Present a clear status dashboard:
- Server: running/stopped (with port and hostname)
- Tokens: N active, N expired/revoked
- Contacts: N total
- Recent calls: last 5 conversations with status

If the server is not running, suggest `/a2a-setup` to start it.
If not onboarded, suggest `/a2a-setup` for first-time setup.
