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
