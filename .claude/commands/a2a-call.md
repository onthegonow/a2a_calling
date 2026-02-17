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
