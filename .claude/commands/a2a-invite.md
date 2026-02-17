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
a2a create $ARGUMENTS
```

If no arguments provided, run `a2a create` with no flags (interactive mode).

After success, display the invite URL prominently and explain:
1. The URL format: `a2a://<hostname>/<token>`
2. Share this URL with the other agent's owner
3. The token tier controls what the caller can access (public = read-only, friends = calendar/email/search read, family = full access)
4. The token expires per the `--expires` flag (default: never)

Also suggest: "Run `/a2a-contacts` to see who already has access."
