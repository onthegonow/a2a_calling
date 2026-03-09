#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SERENA_SOURCE = 'git+https://github.com/oraios/serena';
const GITIGNORE_BLOCK = '# Serena MCP local config (MAE-52)\n.serena/\n';

function main() {
  const args = process.argv.slice(2);
  const options = parseArgs(args);
  const targets = collectTargets(options);

  if (!targets.length) {
    console.error('No target repositories found.');
    process.exit(1);
  }

  let failed = false;
  const codexSerena = readCodexSerenaStatus();

  printHeader(options.check ? 'Serena check' : 'Serena bootstrap');
  logStatus(`Codex MCP serena: ${codexSerena.ok ? 'OK' : 'MISSING'}`);
  if (!codexSerena.ok) {
    failed = true;
    logStatus(`  Expected ${codexSerena.path} to contain [mcp_servers.serena] with --project-from-cwd`);
  }

  const uvxAvailable = commandExists('uvx');
  logStatus(`uvx: ${uvxAvailable ? 'OK' : 'MISSING'}`);
  if (!uvxAvailable) {
    failed = true;
  }

  for (const repoRoot of targets) {
    const repoResult = options.check
      ? checkRepo(repoRoot, { verify: options.verify && uvxAvailable })
      : bootstrapRepo(repoRoot, { force: options.force, verify: options.verify && uvxAvailable });

    failed = failed || !repoResult.ok;
  }

  process.exit(failed ? 1 : 0);
}

function parseArgs(args) {
  const options = {
    check: false,
    force: false,
    verify: true,
    allWorktrees: false,
    paths: []
  };

  for (const arg of args) {
    if (arg === '--check') {
      options.check = true;
      continue;
    }
    if (arg === '--force') {
      options.force = true;
      continue;
    }
    if (arg === '--no-verify') {
      options.verify = false;
      continue;
    }
    if (arg === '--all-worktrees') {
      options.allWorktrees = true;
      continue;
    }
    if (arg.startsWith('-')) {
      console.error(`Unknown option: ${arg}`);
      process.exit(1);
    }
    options.paths.push(arg);
  }

  return options;
}

function collectTargets(options) {
  const targets = new Set();
  const explicit = options.paths.length ? options.paths : [process.cwd()];

  for (const target of explicit) {
    const repoRoot = resolveRepoRoot(target);
    if (!repoRoot) continue;
    targets.add(repoRoot);

    if (options.allWorktrees) {
      for (const worktree of listWorktrees(repoRoot)) {
        targets.add(worktree);
      }
    }
  }

  return Array.from(targets).sort();
}

function resolveRepoRoot(target) {
  const resolved = path.resolve(target);
  const result = spawnSync('git', ['-C', resolved, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8'
  });

  if (result.status !== 0) {
    logStatus(`${resolved}: SKIP (not a git repo)`);
    return null;
  }

  return result.stdout.trim();
}

function listWorktrees(repoRoot) {
  const result = spawnSync('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain'], {
    encoding: 'utf8'
  });

  if (result.status !== 0) return [];

  const worktrees = [];
  let current = null;

  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = line.slice('worktree '.length).trim();
      continue;
    }
    if (line === 'bare') {
      current = null;
      continue;
    }
    if (line === '' && current) {
      worktrees.push(current);
      current = null;
    }
  }

  if (current) worktrees.push(current);
  return worktrees.filter(Boolean);
}

function bootstrapRepo(repoRoot, options) {
  const projectName = deriveProjectName(repoRoot);
  const serenaDir = path.join(repoRoot, '.serena');
  const projectFile = path.join(serenaDir, 'project.yml');
  const gitignorePath = path.join(repoRoot, '.gitignore');
  let ok = true;

  printRepo(repoRoot);

  try {
    ensureGitignore(gitignorePath);
    logStatus('.gitignore: OK (.serena/ ignored)');
  } catch (error) {
    ok = false;
    logStatus(`.gitignore: ERROR (${error.message})`);
  }

  try {
    fs.mkdirSync(serenaDir, { recursive: true });
    const writeMode = !fs.existsSync(projectFile) ? 'CREATED' : options.force ? 'UPDATED' : 'OK';
    if (writeMode !== 'OK') {
      fs.writeFileSync(projectFile, renderProjectConfig(projectName));
    }
    logStatus(`.serena/project.yml: ${writeMode} (${projectName})`);
  } catch (error) {
    ok = false;
    logStatus(`.serena/project.yml: ERROR (${error.message})`);
  }

  if (options.verify) {
    const verified = runHealthCheck(repoRoot);
    ok = ok && verified.ok;
  }

  return { ok };
}

function checkRepo(repoRoot, options) {
  const projectFile = path.join(repoRoot, '.serena', 'project.yml');
  let ok = true;

  printRepo(repoRoot);

  const gitignoreIgnored = gitignoreContainsSerena(path.join(repoRoot, '.gitignore'));
  logStatus(`.gitignore: ${gitignoreIgnored ? 'OK' : 'MISSING'} (.serena/)`);
  ok = ok && gitignoreIgnored;

  const hasProject = fs.existsSync(projectFile);
  logStatus(`.serena/project.yml: ${hasProject ? 'OK' : 'MISSING'}`);
  ok = ok && hasProject;

  if (options.verify && hasProject) {
    const verified = runHealthCheck(repoRoot);
    ok = ok && verified.ok;
  }

  return { ok };
}

function ensureGitignore(gitignorePath) {
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, GITIGNORE_BLOCK);
    return;
  }

  if (!gitignoreContainsSerena(gitignorePath)) {
    const prefix = fs.readFileSync(gitignorePath, 'utf8').endsWith('\n') ? '' : '\n';
    fs.appendFileSync(gitignorePath, `${prefix}\n${GITIGNORE_BLOCK}`);
  }
}

function gitignoreContainsSerena(gitignorePath) {
  if (!fs.existsSync(gitignorePath)) return false;
  return fs.readFileSync(gitignorePath, 'utf8').split('\n').some((line) => line.trim() === '.serena/');
}

function renderProjectConfig(projectName) {
  return [
    '# Serena project config for this local worktree.',
    '# Safe to regenerate with scripts/bootstrap-serena.js.',
    `project_name: "${projectName}"`,
    '',
    'languages:',
    '- typescript',
    '',
    'encoding: "utf-8"',
    'ignore_all_files_in_gitignore: true',
    'ignored_paths: []',
    'read_only: false',
    'excluded_tools: []',
    'included_optional_tools: []',
    'fixed_tools: []',
    'base_modes:',
    'default_modes:',
    'initial_prompt: ""',
    'symbol_info_budget:',
    'read_only_memory_patterns: []',
    ''
  ].join('\n');
}

function deriveProjectName(repoRoot) {
  const packageName = readPackageName(repoRoot) || path.basename(repoRoot);
  const parts = repoRoot.split(path.sep).filter(Boolean);
  const gtIndex = parts.indexOf('gt');

  if (gtIndex !== -1 && parts.length > gtIndex + 2) {
    const rigName = parts[gtIndex + 1];
    if (sanitize(rigName) === sanitize(packageName)) {
      let suffixParts = parts.slice(gtIndex + 2);
      const repoLeaf = path.basename(repoRoot);
      if (suffixParts[suffixParts.length - 1] === repoLeaf) {
        suffixParts = suffixParts.slice(0, -1);
      }
      if (suffixParts.length) {
        return sanitize([packageName, 'gt', ...suffixParts].join('-'));
      }
    }
  }

  return sanitize(packageName);
}

function readPackageName(repoRoot) {
  const packagePath = path.join(repoRoot, 'package.json');
  if (!fs.existsSync(packagePath)) return null;

  try {
    const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    return typeof pkg.name === 'string' && pkg.name.trim() ? pkg.name.trim() : null;
  } catch {
    return null;
  }
}

function sanitize(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function readCodexSerenaStatus() {
  const codexPath = path.join(os.homedir(), '.codex', 'config.toml');
  if (!fs.existsSync(codexPath)) {
    return { ok: false, path: codexPath };
  }

  const content = fs.readFileSync(codexPath, 'utf8');
  const ok = content.includes('[mcp_servers.serena]') && content.includes('--project-from-cwd');
  return { ok, path: codexPath };
}

function commandExists(command) {
  const result = spawnSync('bash', ['-lc', `command -v ${shellEscape(command)}`], {
    stdio: 'ignore'
  });
  return result.status === 0;
}

function runHealthCheck(repoRoot) {
  const result = spawnSync(
    'uvx',
    ['--from', SERENA_SOURCE, 'serena', 'project', 'health-check'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 8
    }
  );

  const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  const logMatch = output.match(/Log saved to:\s*(.+)$/m);

  if (result.status === 0) {
    logStatus('health-check: OK');
    if (logMatch) {
      logStatus(`  ${logMatch[1].trim()}`);
    }
    return { ok: true };
  }

  logStatus(`health-check: FAILED (exit ${result.status ?? 'unknown'})`);
  for (const line of tailLines(output, 12)) {
    logStatus(`  ${line}`);
  }
  return { ok: false };
}

function tailLines(value, count) {
  return value
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-count);
}

function printHeader(title) {
  console.log(`== ${title} ==`);
}

function printRepo(repoRoot) {
  console.log(`\n[repo] ${repoRoot}`);
}

function logStatus(message) {
  console.log(`[serena] ${message}`);
}

function shellEscape(value) {
  return String(value).replace(/'/g, "'\\''");
}

main();
