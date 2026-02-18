---
description: Uninstall A2A Calling — stop server and remove config
allowed-tools: [Bash, Read]
argument-hint: [--keep-config]
---

Uninstall A2A Calling. Stops the server, removes skill files, and optionally removes configuration.

## Usage

```
/a2a-uninstall                # uninstall with confirmation
/a2a-uninstall --keep-config  # uninstall but preserve config files
```

## Instructions

**This is a destructive operation. Always confirm with the user before proceeding.**

1. Show the user what will be removed:
   - Running A2A server (will be stopped)
   - Skill files in `.claude/commands/a2a-*.md`
   - CLAUDE.md A2A section
   - `.codex/AGENTS.md`
   - Config at `~/.config/openclaw/a2a-config.json` (unless `--keep-config`)
   - Disclosure at `~/.config/openclaw/a2a-disclosure.json` (unless `--keep-config`)

2. Ask the user to confirm: "This will stop the A2A server and remove installed files. Proceed?"

3. If confirmed, run:

```bash
a2a uninstall --force
```

If `--keep-config` was specified, tell the user their config files were preserved and can be reused on reinstall.
