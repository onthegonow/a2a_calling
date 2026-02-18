---
description: Reinstall A2A skill files into current project
allowed-tools: [Bash]
argument-hint: [--check|--force]
---

Reinstall or check A2A slash-command skill files in the current project.

## Usage

```
/a2a-skills              # reinstall skill files (skips unchanged)
/a2a-skills --check      # check which files are installed vs missing
/a2a-skills --force      # force reinstall all files
```

## Instructions

Run the skills command with the user's arguments:

```bash
a2a skills $ARGUMENTS
```

Show the result: which files were installed, skipped (already up to date), or had errors.

If files were reinstalled, suggest reloading Claude Code to pick up the new slash commands.
