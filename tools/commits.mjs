// Records the commits a task produced in the repo's workspace — mechanical IO,
// the LLM never hand-types JSONL.
// Usage:
//   node tools/commits.mjs add  <repo> <task> <hash> [--msg "..."]
//   node tools/commits.mjs list <repo> <task>
// <task> accepts the full directory name OR just the numeric prefix ("01").
// The hash is validated against the git of workspace/<repo> (the path comes from
// repos/<repo>/meta.json "workspace", falling back to workspace/<repo>), resolved to
// the full hash; without --msg the actual commit message is read from git.
// Writes to repos/<repo>/tasks/<task>/commits.jsonl (on-demand), deduplicated by hash.
// The panel (Diff tab) also discovers commits via the task's time window — this
// record is the explicit source, which wins over the heuristic when the two overlap.
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson, updateJson } from './jsonfile.mjs';
import { stateRoot } from './root.mjs';
import { execFileSync } from 'node:child_process';

const ROOT = stateRoot();

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function parseArgs(argv, valueFlags) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      if (!valueFlags.includes(name)) die(`unknown flag: --${name} (accepted: ${valueFlags.map((f) => `--${f}`).join(', ')})`);
      if (i + 1 >= argv.length) die(`--${name} requires a value`);
      flags[name] = argv[++i];
    } else {
      pos.push(a);
    }
  }
  return { flags, pos };
}

// Resolves <repo>, with an error that lists the options.
function resolveRepo(repoSlug) {
  if (!repoSlug) die('missing argument: <repo>');
  const reposDir = path.join(ROOT, 'repos');
  const repoDir = path.join(reposDir, repoSlug);
  if (!fs.existsSync(path.join(repoDir, 'meta.json'))) {
    const existentes = fs.existsSync(reposDir) ? fs.readdirSync(reposDir).filter((d) => !d.startsWith('.')) : [];
    die(`repo not found: ${repoSlug}${existentes.length ? ` — existing: ${existentes.join(', ')}` : ' — no repo created yet (use new-repo.mjs)'}`);
  }
  return repoDir;
}

// Resolves <repo> and <task> (full name or "01" prefix), with errors that list the options.
function resolveTask(repoSlug, taskArg) {
  if (!repoSlug || !taskArg) die('missing arguments: <repo> <task>');
  const repoDir = resolveRepo(repoSlug);
  const tasksDir = path.join(repoDir, 'tasks');
  const tasks = fs.existsSync(tasksDir) ? fs.readdirSync(tasksDir).filter((d) => /^\d{2}-/.test(d)).sort() : [];
  const prefixo = /^\d+$/.test(taskArg) ? taskArg.padStart(2, '0') : null;
  const match = tasks.find((d) => d === taskArg) ?? (prefixo && tasks.find((d) => d.startsWith(`${prefixo}-`)));
  if (!match) {
    die(`task not found: "${taskArg}" in repos/${repoSlug}/tasks${tasks.length ? ` — existing: ${tasks.join(', ')}` : ' — no task created yet (use new-task.mjs)'}`);
  }
  return { taskDir: path.join(tasksDir, match), taskName: match, repoSlug, repoDir };
}

// repo workspace: meta.json "workspace" (relative to root) or workspace/<repo>
function resolveWorkspace(repoDir, repoSlug) {
  let meta = {};
  try {
    meta = JSON.parse(fs.readFileSync(path.join(repoDir, 'meta.json'), 'utf8'));
  } catch {}
  const wsDir = meta.workspace ? path.resolve(ROOT, meta.workspace) : path.join(ROOT, 'workspace', repoSlug);
  if (!fs.existsSync(path.join(wsDir, '.git'))) {
    die(`workspace without git: ${path.relative(ROOT, wsDir)} — nothing to record (the repo's code lives there)`);
  }
  return wsDir;
}

function git(wsDir, args) {
  return execFileSync('git', args, { cwd: wsDir, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 }).toString().trim();
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t);
      if (o && typeof o === 'object' && !Array.isArray(o)) out.push(o);
    } catch {}
  }
  return out;
}

function touchMeta(taskDir) {
  const metaPath = path.join(taskDir, 'meta.json');
  if (!fs.existsSync(metaPath)) return;
  updateJson(metaPath, null, (meta) => {
    if (!meta) return undefined; // meta unreadable: this command won't be the one to rewrite it
    meta.updated = new Date().toISOString().slice(0, 10);
    return meta;
  });
}

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === 'add') {
  const { flags, pos } = parseArgs(rest, ['msg']);
  const [repoSlug, taskArg, hashArg] = pos;
  if (!repoSlug || !taskArg || !hashArg) die('usage: node tools/commits.mjs add <repo> <task> <hash> [--msg "..."]');
  const { taskDir, taskName, repoDir } = resolveTask(repoSlug, taskArg);
  const wsDir = resolveWorkspace(repoDir, repoSlug);
  let tipo;
  try {
    tipo = git(wsDir, ['cat-file', '-t', hashArg]);
  } catch {
    die(`hash does not exist in the git of ${path.relative(ROOT, wsDir)}: ${hashArg}`);
  }
  if (tipo !== 'commit') die(`hash is not a commit (it's "${tipo}"): ${hashArg}`);
  const hash = git(wsDir, ['rev-parse', `${hashArg}^{commit}`]);
  const msg = flags.msg !== undefined ? flags.msg : git(wsDir, ['log', '-1', '--format=%s', hash]);
  const file = path.join(taskDir, 'commits.jsonl');
  if (readJsonl(file).some((c) => c.hash === hash)) {
    console.log(`commit already recorded in repos/${repoSlug}/tasks/${taskName}: ${hash.slice(0, 7)} ${msg}`);
    process.exit(0);
  }
  fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), hash, msg }) + '\n');
  touchMeta(taskDir);
  console.log(`commit recorded in repos/${repoSlug}/tasks/${taskName}/commits.jsonl: ${hash.slice(0, 7)} ${msg}`);
} else if (cmd === 'list') {
  const { pos } = parseArgs(rest, []);
  const [repoSlug, taskArg] = pos;
  const { taskDir, taskName } = resolveTask(repoSlug, taskArg);
  const commits = readJsonl(path.join(taskDir, 'commits.jsonl'));
  if (!commits.length) {
    console.log(`(no commit recorded in repos/${repoSlug}/tasks/${taskName})`);
    process.exit(0);
  }
  for (const c of commits) {
    const quando = (c.ts ?? '').slice(0, 19).replace('T', ' ');
    console.log(`${String(c.hash ?? '').slice(0, 7)}  ${quando}  ${c.msg ?? ''}`);
  }
  console.log(`${commits.length} commit(s) in repos/${repoSlug}/tasks/${taskName}`);
} else {
  die('usage: node tools/commits.mjs <add|list> <repo> <task> [<hash>] [--msg "..."]');
}
