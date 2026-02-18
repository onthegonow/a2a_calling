---
description: Open the A2A dashboard in browser or native app
allowed-tools: [Bash]
argument-hint: [--tab contacts|calls|logs|settings|invites]
---

Open the A2A Calling dashboard. Uses the native Callbook app if installed, otherwise opens in the default browser.

## Usage

```
/a2a-gui                   # open dashboard
/a2a-gui --tab contacts    # open specific tab
/a2a-gui --tab calls       # open calls tab
/a2a-gui --tab logs        # open logs tab
/a2a-gui --tab settings    # open settings tab
/a2a-gui --tab invites     # open invites tab
```

## Instructions

Run the dashboard command with any arguments:

```bash
a2a gui $ARGUMENTS
```

If it fails because the server is not running, suggest `/a2a-setup` to start it.

Tell the user the dashboard URL (typically `http://127.0.0.1:<port>/dashboard/`) so they can also bookmark it.
