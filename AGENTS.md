# Agent Runbook (A2A for OpenClaw)

This file is the operational source of truth for AI agents working in this repository.

## Secrets (DO NOT DELETE)

This repo is published as **both** a GitHub repo and an **npm package** (`a2acalling`). Most feature work should end with:
- push to GitHub (`main`)
- publish to npm (version bump)

Local maintainer credentials live in `.env` (gitignored).

Required keys in `.env`:
- `GH_TOKEN` - GitHub PAT with access to `onthegonow/a2a_calling` (push, tags/releases, repo secrets)
- `NPM_TOKEN` - npm publish token for the `a2acalling` package

Hard rules:
- NEVER commit `.env` or token values.
- NEVER delete `.env` from the workspace. (Agents have deleted it before; don’t.)
- NEVER remove `.env` / `.env.*` from `.gitignore` or `.npmignore`.
- NEVER print tokens in command output, logs, or comments.

## GitHub Access

GitHub token is stored in `.env` (gitignored). Load it before git operations:

```bash
set -a
source .env
set +a
```

Recommended (avoids putting tokens in git remotes):

```bash
gh auth status
gh auth setup-git
env -u GIT_ASKPASS -u VSCODE_GIT_ASKPASS_NODE -u VSCODE_GIT_IPC_HANDLE -u VSCODE_GIT_IPC_AUTH_TOKEN git push origin main
```

Fallback (NOT recommended; it bakes the token into `.git/config`):

```bash
git remote set-url origin https://${GH_TOKEN}@github.com/onthegonow/a2a_calling.git
env -u GIT_ASKPASS -u VSCODE_GIT_ASKPASS_NODE -u VSCODE_GIT_IPC_HANDLE -u VSCODE_GIT_IPC_AUTH_TOKEN git push origin main
```

`gh` CLI reads `GH_TOKEN` automatically.

## npm Publishing

This repo publishes to npm as `a2acalling`.

Local publish (set cache to avoid root cache permission issues):

```bash
npm_config_cache=/tmp/npm-cache npm publish --access public
```

CI publish (GitHub Actions):
- repo secret `NPM_TOKEN` must be set (Actions secret)
- workflow should export `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`

## Release Checklist (GitHub + npm Together)

```bash
# 1) bump version
npm version patch --no-git-tag-version

# 2) run tests
npm test

# 3) commit + push
git add package.json
git commit -m "chore: release $(node -p \"require('./package.json').version\")"
env -u GIT_ASKPASS -u VSCODE_GIT_ASKPASS_NODE -u VSCODE_GIT_IPC_HANDLE -u VSCODE_GIT_IPC_AUTH_TOKEN git push origin main

# 4) tag + GitHub release (must exist before npm publish)
VERSION=$(node -p "require('./package.json').version")
git tag "v${VERSION}"
env -u GIT_ASKPASS -u VSCODE_GIT_ASKPASS_NODE -u VSCODE_GIT_IPC_HANDLE -u VSCODE_GIT_IPC_AUTH_TOKEN git push origin "v${VERSION}"
gh release create "v${VERSION}" --generate-notes

# 5) publish to npm
npm_config_cache=/tmp/npm-cache npm publish --access public
```

If a GitHub Actions release workflow exists, prefer that for the final publish so GitHub + npm stay in sync.
For macOS app users, ensure the GitHub Release has uploaded app artifacts (`.dmg` / `.app.tar.gz`) before running `npm publish`.

## Project Structure

```
a2acalling/
├── bin/cli.js           # CLI entry point (a2a command)
├── src/
│   ├── index.js         # Main library export
│   ├── lib/
│   │   ├── tokens.js    # Token storage & validation
│   │   └── client.js    # Outbound A2A client
│   └── routes/
│       └── a2a.js # Express routes for /api/a2a
├── docs/
│   └── protocol.md      # Protocol specification
└── .env                  # Secrets (gitignored)
```

## Development Commands

```bash
# Test CLI
node bin/cli.js help
node bin/cli.js create --name "Test" --expires 1h

# Test library
node -e "const a2a = require('./src'); console.log(a2a.version)"
```

## Key Design Decisions

1. **Token format**: `a2a://<host>/<token>` - simple, copy-pasteable
2. **Permission presets**: `chat-only` (default), `tools-read`, `tools-write`  
3. **Disclosure levels**: `public`, `minimal` (default), `none`
4. **Rate limits**: 10/min, 100/hr, 1000/day per token
5. **Storage**: JSON file at `~/.config/openclaw/a2a.json`

## Integration Points

This package is designed to integrate with OpenClaw:

1. **Gateway routes**: Mount `createRoutes()` at `/api/a2a`
2. **Agent tool**: Add `a2a_call` tool using `A2AClient`
3. **Commands**: Wire `/a2a` commands to CLI functions

## Commit Convention

Use conventional commits:
- `feat:` new features
- `fix:` bug fixes
- `docs:` documentation
- `refactor:` code changes without feature/fix
