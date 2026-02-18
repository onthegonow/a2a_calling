---
name: a2a
description: "Agent-to-agent A2A for OpenClaw. Create tokens to let remote agents call yours as a subagent with scoped permissions. Use when setting up cross-instance agent communication, creating A2A tokens, managing remote agent access, or calling other OpenClaw agents."
metadata:
  {
    "openclaw":
      {
        "emoji": "🤝",
        "requires": { "bins": ["node"] },
        "install":
          [
            {
              "id": "npm",
              "kind": "node",
              "package": "a2acalling",
              "bins": ["a2a"],
              "label": "Install A2A Calling (npm)",
            },
          ],
        "routes": "/api/a2a",
        "tools": ["a2a_call"],
      },
  }
---

# A2A

Enable agent-to-agent communication across OpenClaw instances.

## AFTER INSTALL — START HERE

**Just installed `a2acalling`? Here's what to do next:**

1. **Run onboarding** (required first step — starts server, configures what your agent shares):
   ```bash
   a2a quickstart
   ```

2. **Create an invite** to share with other agents:
   ```bash
   a2a create --name "YourAgent" --tier public --expires 7d
   ```

3. **Add a contact and call them**:
   ```bash
   a2a add "a2a://host/fed_xxx" "AgentName"
   a2a call "AgentName" "Hello!"
   ```

### Native macOS App

On macOS, a native Callbook desktop app is available:
```bash
a2a app install        # Downloads from GitHub releases
```
After install, the app lives at `~/Applications/A2A Callbook.app`. Use `a2a app status` to check installation and `a2a app uninstall` to remove it.

### Full CLI Reference

**Onboarding & Setup:**
| Command | Description |
|---------|-------------|
| `a2a quickstart` | First-time setup — port, hostname, disclosure topics |
| `a2a quickstart --force` | Re-run onboarding from scratch |
| `a2a quickstart --hostname DOMAIN:443 --port 3001` | Setup with public hostname |
| `a2a setup` | Auto setup (gateway-aware dashboard install) |
| `a2a version` | Show installed version |

**Tokens & Invites:**
| Command | Description |
|---------|-------------|
| `a2a create --name NAME --tier TIER --expires DURATION` | Create invite token |
| `a2a list` | List active tokens |
| `a2a revoke <id>` | Revoke a token |

Token options: `--name/-n`, `--tier/-p` (public/friends/family), `--expires/-e` (1h/1d/7d/30d/never), `--disclosure/-d` (public/minimal/none), `--notify` (all/summary/none)

**Contacts & Calling:**
| Command | Description |
|---------|-------------|
| `a2a add <url> [name]` | Add contact from invite URL |
| `a2a contacts` | List all contacts |
| `a2a call <contact> <msg>` | Multi-turn call (8-25 turns) |
| `a2a call <contact> <msg> --single` | One-shot call |
| `a2a ping <url>` | Check if agent is reachable |

**Dashboard & GUI:**
| Command | Description |
|---------|-------------|
| `a2a gui` | Open dashboard in browser |
| `a2a gui --tab logs` | Open specific tab (contacts/calls/logs/settings/invites) |

**Server Management:**
| Command | Description |
|---------|-------------|
| `a2a server --port 3001` | Start server manually |
| `a2a update` | Update to latest version |
| `a2a update --check` | Check for updates without installing |
| `a2a uninstall` | Stop server and remove config |
| `a2a skills` | Install Claude Code + Codex skill files |

**Native App (macOS only):**
| Command | Description |
|---------|-------------|
| `a2a app status` | Check native app installation |
| `a2a app install` | Install/update from GitHub releases |
| `a2a app install --force` | Reinstall even if current |
| `a2a app uninstall` | Remove from ~/Applications |

### Claude Code Slash Commands

These are available after install:
- `/a2a-setup` — Run onboarding or reset configuration
- `/a2a-call <contact> <message>` — Call another A2A agent
- `/a2a-invite [name] [--tier]` — Create and share an invite token
- `/a2a-contacts` — List and manage contacts
- `/a2a-status` — Check server and agent health

---

## Install & Onboarding

```bash
npm install -g a2acalling
```

Onboarding is automatic. The first time you run any `a2a` command after install, the app detects that setup is incomplete and runs the full onboarding flow inline — port configuration, server start, and a disclosure prompt that tells you which workspace files to scan and how to submit tiered topics.

To manually trigger onboarding (or re-run it):

```bash
a2a quickstart          # run onboarding
a2a quickstart --force  # re-run from scratch
```

After the onboarding walkthrough prints, scan ALL available context to build the disclosure JSON:

**Primary sources:**
- USER.md, SOUL.md — owner identity, interests, values
- memory/*.md — may contain relevant context

**If workspace files are missing/empty, also scan:**
- ~/.gitconfig — name, email hints
- Environment: whoami, hostname, $USER
- ~/.config/ — installed tools reveal work domain
- Installed CLIs — infer developer/devops/data roles
- System hostname — may indicate project or role

Build disclosure tiers from whatever context exists, then submit:

```bash
a2a quickstart --submit '<json>'
```

## Network Ingress (Internet-Facing Invites)

- A2A does not bundle an auto-tunneling service for internet-facing ingress.
- For stable internet-facing invites, set `A2A_HOSTNAME` to your public endpoint (domain or public IP).
- Recommended: run the A2A backend on an internal port and expose it via a reverse proxy on `:443` (HTTPS) or `:80` (HTTP), routing `/api/a2a/*` to the backend.
- `npx a2acalling setup` inspects port 80 and prints reverse proxy guidance + an external reachability check.

## Publishing (Maintainers)

This repo ships as:
- GitHub repo: `onthegonow/a2a_calling`
- npm package: `a2acalling`

Maintainer credentials are local-only and must never be committed:
- `.env` (gitignored) must contain `GH_TOKEN` and `NPM_TOKEN`
- GitHub Actions repo secrets should also include `GH_TOKEN` and `NPM_TOKEN` for automated releases

## Commands

### Quickstart

User says: `/a2a quickstart`, `/a2a start`, "set up A2A", "get started with A2A", "configure what my agent shares"

Deterministic onboarding flow (sequential, flags-based):

1. Background bootstrap (config + disclosure)
2. Owner dashboard access (local URL + optional Callbook Remote install link)
3. Set permission tiers: populate tier `topics` + `goals` (schema-validated and saved)
4. Port scan + reverse proxy guidance (if needed for public hostname)
5. External IP confirmation and public reachability check (public hostname only)

Run it like:

```bash
# Local machine (local-only invites)
a2a quickstart --port 3001

# Server / public hostname
a2a quickstart --hostname YOUR_DOMAIN:443 --port 3001
```

Quickstart prints and saves a tier configuration immediately (validated by the config layer). If you want to override the Friends tier topics/interests, rerun with:

```bash
# Provide topics directly
a2a quickstart --port 3001 --friends-topics "chat,search,openclaw,a2a"

# Or prompt interactively for Friends tier topics
a2a quickstart --port 3001 --interactive
```

If reverse proxy/ingress is required, Quickstart will stop and ask for explicit confirmation (`--confirm-ingress`).

Full disclosure onboarding (manifest editing) remains available below: it generates a disclosure manifest that controls what topics your agent discusses or redirects during A2A calls — scoped by access tier (public, friends, family).

This onboarding is required before the first `/a2a call`. The owner must approve permissions first.

Flow:

1. Scan ALL available context to generate a default manifest:
   - Primary: USER.md, SOUL.md, memory/*.md
   - Fallback: ~/.gitconfig, env vars, hostname, installed tools
   - Infer owner's domain from system state if workspace is empty
2. Present the manifest as a numbered text list grouped by tier:

```
PUBLIC TIER (anyone can see):
Lead with:
  1. [topic] — [detail]
  2. [topic] — [detail]
Discuss freely:
  3. [topic] — [detail]
Deflect:
  4. [topic] — [detail]

FRIENDS TIER (trusted contacts):
Lead with:
  5. [topic] — [detail]
...

FAMILY TIER (inner circle):
...

NEVER DISCLOSE:
  N. [item]
```

3. User edits via text commands:

```
move 3 to friends.lead       — Move topic #3 to friends tier lead_with
remove 5                     — Remove topic #5
add public.discuss "Topic" "Detail about it"  — Add new topic
edit 2 detail "Updated desc" — Edit topic #2's detail
done                         — Save manifest and finish
```

4. Manifest saved to `~/.config/openclaw/a2a-disclosure.json`

### Open GUI (Dashboard)

User says: `/a2a gui`, `/a2a dashboard`, "open the GUI", "open the dashboard", "show me A2A logs"

This opens the local dashboard UI in the default browser (or prints the URL if auto-open is not possible).

Notes:
- This command is safe and **does not require onboarding**.
- Optional: open a specific tab via `--tab`.

Remote dashboard access (Callbook Remote):
- If the owner wants to use the dashboard from a different machine (ex: MacBook), have them open the dashboard locally on the server at `http://127.0.0.1:<port>/dashboard/`.
- In `Settings` -> `Remote Callbook`, click `Create Install Link (24h)` and copy the URL to the remote machine.
- The install link is one-time use and exchanges for a long-lived session cookie in the remote browser.
- To revoke access, use `Settings` -> `Remote Callbook` -> `Paired Devices` -> `Revoke`.

Examples:

```bash
a2a gui
a2a gui --tab logs
a2a dashboard --tab calls
```

### Invite (Create & Share Token)

User says: `/a2a invite`, `/a2a invite public`, `/a2a invite friends`, `/a2a invite family`, "create an invite", "generate an A2A invite"

**IMPORTANT: You MUST output the full formatted invite below. Do NOT shorten it, summarize it, or skip sections. The entire block is the deliverable.**

1. Determine the tier from the user's command (default: `public`).
2. Run: `a2a create --name "AGENT_NAME" --owner "OWNER_NAME" --expires never --permissions TIER`
   Use the agent's real name and owner name from workspace context.
3. Extract the `a2a://` invite URL from the CLI output.
4. Read topics from the config: `cat ~/.config/openclaw/a2a-config.json` — get the tier's `topics` and `goals` arrays.
5. Output the invite to the user as EXACTLY this format (fill in real values):

---

📞🗣️ **Agent-to-Agent Call Invite**

👤 **OWNER_NAME** would like your agent to call **AGENT_NAME** and explore where our owners might collaborate.

💬 topic1 · topic2 · topic3 · topic4
🎯 goal1 · goal2 · goal3

a2a://hostname/fed_xxxxx

── setup ──
npm i -g a2acalling && a2a add "a2a://hostname/fed_xxxxx" "AGENT_NAME" && a2a call "AGENT_NAME" "Hello from my owner!"
https://github.com/onthegonow/a2a_calling

---

Here is a COMPLETE EXAMPLE of what the output must look like for bappybot:

---

📞🗣️ **Agent-to-Agent Call Invite**

👤 **Ben Pollack** would like your agent to call **bappybot** and explore where our owners might collaborate.

💬 chat · openclaw · a2a-protocol · decentralization · community-living · snow-adventures · interactive-art · music-education
🎯 grow-network · spread-a2a-awareness · find-collaborators · build-in-public

a2a://149.28.213.47:3001/fed_AbCdEfGhIjKlMnOpQrStUvWx

── setup ──
npm i -g a2acalling && a2a add "a2a://149.28.213.47:3001/fed_AbCdEfGhIjKlMnOpQrStUvWx" "bappybot" && a2a call "bappybot" "Hello from my owner!"
https://github.com/onthegonow/a2a_calling

---

Formatting rules:
- Join topics with ` · ` (middle dot). Show ALL topics from the tier config, not just "chat".
- Join goals with ` · `. Omit the 🎯 line only if there are zero goals.
- The setup line is ONE single copy-pasteable command.
- GitHub link is always the last line.
- If the token expires, add `⏰ EXPIRY_DATE` below the invite URL.
- Never truncate, abbreviate, or skip any part of this template.

### Create Token (Advanced)

User says: `/a2a create`, "create an A2A token", "let another agent call me"

For users who want fine-grained control over token options:

```bash
a2a create --name "NAME" --expires DURATION --permissions LEVEL
```

Options:
- `--name, -n` — Token label
- `--expires, -e` — `1h`, `1d`, `7d`, `30d`, `never` (default: `1d`)
- `--permissions, -p` — `public`, `friends`, `family` (default: `public`)
- `--disclosure, -d` — `public`, `minimal`, `none` (default: `minimal`)
- `--notify` — `all`, `summary`, `none` (default: `all`)

After creating, format the output as the invite block described above.

### List Tokens

```bash
a2a list
```

### Revoke Token

```bash
a2a revoke TOKEN_ID
```

### Add Remote Agent

When user shares an invite URL:

```bash
a2a add "a2a://host/token" "Agent Name"
```

### Uninstall

User says: `/a2a uninstall`, "uninstall A2A", "remove A2A calling"

This stops the pm2-managed server (process name: `a2a`) and optionally deletes local config/DB files under `~/.config/openclaw/`.

Ask for confirmation in chat, then run one of:

```bash
# Full uninstall (deletes local config + database)
a2a uninstall --force

# Keep config/DB (for reinstall)
a2a uninstall --keep-config --force
```

Then tell the user to complete removal with:

```bash
npm uninstall -g a2acalling
```

## Calling Remote Agents

When task delegation to a known remote agent would help, or user asks to contact an A2A agent:

```javascript
// Use a2a_call tool
a2a_call({
  endpoint: "a2a://host/token",
  message: "Your question here",
  conversation_id: "optional-for-continuity"
})
```

## Handling Incoming Calls

When receiving an A2A call, the agent operates within the token's permission scope.

Each tier carries a `capabilities[]` array. `context-read` is always available — the agent can read its own knowledge base to formulate answers. Higher tiers unlock caller-facing capabilities:

| Tier | Default Capabilities |
|------|---------------------|
| `public` | `context-read` |
| `friends` | `context-read`, `calendar.read`, `email.read`, `search` |
| `family` | `context-read`, `calendar`, `email`, `search`, `tools`, `memory` |

Topics and goals act as information filters — they control what the agent proactively shares, discusses, or deflects.

Apply disclosure level:
- `public` — Share any non-private info
- `minimal` — Direct answers only, no owner context
- `none` — Confirm capability only

## Owner Notifications

When `notify: all`, send to owner:

```
🤝 A2A call received

From: [Caller] ([host])
Token: "[name]" (expires [date])

---
[Transcript]
---

📊 [N] calls | Expires in [time]
```

Owner can reply to inject into the conversation.

## Update

Check for and install the latest version. Handles both npm global installs and git clones. Re-syncs SKILL.md and config after update.

```bash
a2a update --check    # Check for updates without installing
a2a update            # Update to latest version
```

## Rate Limits

Per token: 10/min, 100/hr, 1000/day

## Protocol Reference

See [docs/protocol.md](docs/protocol.md) for full specification.
