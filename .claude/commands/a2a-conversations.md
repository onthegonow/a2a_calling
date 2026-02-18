---
description: Browse and manage A2A conversations
allowed-tools: [Bash]
argument-hint: [show <id>|end <id>|--contact <name>|--status active]
---

List, view, and manage A2A agent conversations.

## Usage

```
/a2a-conversations                        # list recent conversations
/a2a-conversations --contact Alice        # filter by contact
/a2a-conversations --status active        # filter by status
/a2a-conversations show <id>              # show conversation details with messages
/a2a-conversations end <id>              # end an active conversation
```

## Instructions

Parse the user's arguments to determine the action:

### List conversations (default)

```bash
a2a conversations $ARGUMENTS
```

Format as a table: ID, contact, status (active/concluded/timeout), message count, last activity.

### Show conversation detail

```bash
a2a conversations show $ID
```

Display the full conversation: each message with timestamp, direction (inbound/outbound), and content. Show the summary if the conversation has concluded.

### End a conversation

```bash
a2a conversations end $ID
```

This generates a summary and marks the conversation as concluded. Show the summary to the user.

If no conversations exist, suggest: "No conversations yet. Start one with `/a2a-call`."
