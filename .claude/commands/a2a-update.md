---
description: Check for and install A2A updates
allowed-tools: [Bash]
argument-hint: [--check]
---

Check for available A2A updates and optionally install them.

## Usage

```
/a2a-update              # check for updates and install if available
/a2a-update --check      # check only, don't install
```

## Instructions

1. First, check for updates:

```bash
a2a update --check
```

2. Show the user the current version vs available version.

3. If an update is available and `--check` was NOT specified:
   - Tell the user what version is available
   - Ask for confirmation before updating
   - If confirmed, run:

```bash
a2a update
```

4. After updating, show the new version:

```bash
a2a version
```

If the user is already on the latest version, tell them so.
