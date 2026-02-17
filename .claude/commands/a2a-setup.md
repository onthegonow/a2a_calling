---
description: Set up A2A Calling — onboard, start server, configure agent
allowed-tools: [Bash, Read, Write]
argument-hint: [--force]
---

Set up or reset your A2A Calling installation. Runs onboarding, starts the server, and configures your agent.

## Usage

```
/a2a-setup              # first-time setup or resume incomplete onboarding
/a2a-setup --force      # reset and re-run from scratch
```

## Instructions

1. Check if already onboarded: `a2a config --show`
2. If not onboarded (or `--force`): run `a2a quickstart $ARGUMENTS`
3. If already onboarded but server not running: run `a2a server` in background
4. After setup, show the status with `a2a config --show` and `a2a list`

The quickstart flow will:
- Detect an available port
- Start the A2A server
- Detect the hostname
- Prompt for disclosure topics (what your agent discusses)
- Save the configuration

If running non-interactively, quickstart auto-accepts defaults.
