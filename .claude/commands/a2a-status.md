---
description: Check A2A server status, active conversations, version, and agent health
allowed-tools: [Bash, Read]
argument-hint: [--version]
---

Check the health of your A2A installation — server running, conversations active, contacts online, version info.

## Usage

```
/a2a-status              # full status dashboard
/a2a-status --version    # show version only
```

## Instructions

### Version only

If `--version` is specified:

```bash
a2a version
```

Show the version and exit.

### Full status (default)

Run these commands and compile a status report:

1. **Version:** `a2a version`
2. **Config:** `a2a config --show`
3. **Active tokens:** `a2a list`
4. **Contacts:** `a2a contacts`
5. **Recent conversations:** `a2a conversations --limit 5`

Present a clear status dashboard:
- Version: current version number
- Server: running/stopped (with port and hostname)
- Tokens: N active, N expired/revoked
- Contacts: N total
- Recent calls: last 5 conversations with status

If the server is not running, suggest `/a2a-setup` to start it.
If not onboarded, suggest `/a2a-setup` for first-time setup.
