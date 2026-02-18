---
description: Manage the native A2A Callbook app (macOS only)
allowed-tools: [Bash]
argument-hint: [install|uninstall|status]
---

Install, manage, or check the status of the native A2A Callbook desktop app.

## Usage

```
/a2a-app                 # show current app status
/a2a-app install         # download and install the native app
/a2a-app uninstall       # remove the native app
/a2a-app status          # check if installed, show version
```

## Instructions

1. First, detect the platform:

```bash
uname -s
```

If the output is NOT `Darwin`, tell the user:
"The A2A Callbook native app is only available on macOS. You can use the web dashboard instead: run `/a2a-gui`."
Stop here.

2. If on macOS, determine the subcommand:

- **No argument or `status`**: Run `a2a app status`
- **`install`**: Run `a2a app install`
- **`uninstall`**: Ask for confirmation first, then run `a2a app uninstall`

3. After install, suggest opening the app:

```bash
a2a gui
```

4. Format the output clearly: show install path, version, and whether the app is running.
