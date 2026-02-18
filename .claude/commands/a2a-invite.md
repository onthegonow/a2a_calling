---
description: Create or revoke A2A invite tokens for sharing with other agents
allowed-tools: [Bash]
argument-hint: [name] [--tier public|friends|family] [--expires 7d] | revoke <id>
---

Create an A2A federation token and display the invite URL, or revoke an existing token.

## Usage

### Create invite

```
/a2a-invite Alice --tier friends --expires 7d
/a2a-invite "Bob's Agent" --tier public
/a2a-invite                              # interactive — uses defaults
```

### Revoke invite

```
/a2a-invite revoke <token_id>            # revoke a specific token
/a2a-invite list                         # list active tokens to find IDs
```

## Instructions

### Create flow

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

### Revoke flow

If the first argument is `revoke`:

1. If a token ID is provided: `a2a revoke <id>`
2. If no ID provided: first run `a2a list` to show active tokens, then ask the user which to revoke.

**Always confirm before revoking:** "This will permanently invalidate token <id>. The holder will no longer be able to call you. Proceed?"

### List flow

If the first argument is `list`:

```bash
a2a list
```

Show active tokens with their IDs, names, tiers, and expiry dates.
