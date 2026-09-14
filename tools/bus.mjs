// Message/log bus for a task — mechanical IO, the LLM never hand-types JSONL.
// Usage:
//   node tools/bus.mjs post <repo> <task> --from X --to Y --kind K [--meta '<json>'] "body"
//   node tools/bus.mjs log  <repo> <task> --level L --source S "body"   (body "-" reads stdin; each line becomes a record)
//   node tools/bus.mjs read <repo> <task> [--kind K] [--to Y] [--since <ISO>] [--tail N]
//   node tools/bus.mjs agents <repo> [<task>]   (<task> optional: filters the display by last_task)
// <task> accepts the full directory name OR just the numeric prefix ("01").
// Writes to repos/<repo>/tasks/<task>/: messages.jsonl, logs.jsonl (on-demand).
// The agent registry lives at the REPO level: repos/<repo>/agents.json — each agent
// carries "last_task" = the task of the status post that last updated it.
// kind=status with meta.state (spawned|working|done) upserts that file (keyed by name=from).
// Compatibility: a task-level agents.json (created by an older version) is ignored
// by the upsert — from now on only the repo-level file is read/written.
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson, updateJson } from './jsonfile.mjs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KINDS = ['report', 'question', 'decision', 'approval', 'status'];
const LEVELS = ['debug', 'info', 'warn', 'error'];
const STATES = ['spawned', 'working', 'done'];

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

function appendJsonl(file, objs) {
  fs.appendFileSync(file, objs.map((o) => JSON.stringify(o) + '\n').join(''));
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

// Upsert into the REPO's agent registry (repos/<repo>/agents.json).
// An old task-level agents.json, if it still exists, is simply ignored.
function upsertAgent(repoDir, taskName, name, state, ts, meta) {
  const file = path.join(repoDir, 'agents.json');
  updateJson(file, { agents: [] }, (data) => {
    if (!data || !Array.isArray(data.agents)) data = { agents: [] };
    let agent = data.agents.find((a) => a.name === name);
    if (!agent) {
      agent = { name, role: meta?.role ?? '', created: ts, last_active: ts, status: 'executando' };
      data.agents.push(agent);
    }
    agent.last_active = ts;
    if (meta?.role) agent.role = meta.role;
    agent.status = state === 'done' ? 'ocioso' : 'executando';
    agent.last_task = taskName;
    return data;
  });
}

// Which agent the status describes. The lifecycle is posted by piloto ABOUT the
// executor (`--from piloto --to k8s-operator`), so the one that enters the registry is the
// recipient; an agent that posts its own status enters by itself.
// `--meta '{"agent":"..."}'` takes precedence over both heuristics.
function agenteDoStatus(from, to, meta) {
  const nome = meta?.agent ?? (from === 'piloto' ? to : from);
  return nome === 'humano' || nome === 'sala' ? null : nome;
}

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === 'post') {
  const { flags, pos } = parseArgs(rest, ['from', 'to', 'kind', 'meta']);
  const [repoSlug, taskArg, body] = pos;
  if (!flags.from || !flags.to || !flags.kind || body === undefined) {
    die('usage: node tools/bus.mjs post <repo> <task> --from X --to Y --kind K [--meta \'<json>\'] "body"');
  }
  if (!KINDS.includes(flags.kind)) die(`invalid kind: "${flags.kind}" — accepted: ${KINDS.join(', ')}`);
  let meta;
  if (flags.meta !== undefined) {
    try {
      meta = JSON.parse(flags.meta);
    } catch (e) {
      die(`--meta is not valid JSON: ${e.message}`);
    }
  }
  if (flags.kind === 'status' && meta?.state && !STATES.includes(meta.state)) {
    die(`invalid meta.state: "${meta.state}" — accepted: ${STATES.join(', ')}`);
  }
  const { taskDir, taskName, repoDir } = resolveTask(repoSlug, taskArg);
  const ts = new Date().toISOString();
  const msg = { ts, from: flags.from, to: flags.to, kind: flags.kind, body };
  if (meta !== undefined) msg.meta = meta;
  appendJsonl(path.join(taskDir, 'messages.jsonl'), [msg]);
  if (flags.kind === 'status' && meta?.state) {
    const alvo = agenteDoStatus(flags.from, flags.to, meta);
    if (alvo) upsertAgent(repoDir, taskName, alvo, meta.state, ts, meta);
  }
  touchMeta(taskDir);
  console.log(`message recorded: ${flags.from}→${flags.to} [${flags.kind}] in repos/${repoSlug}/tasks/${taskName}/messages.jsonl`);
} else if (cmd === 'log') {
  const { flags, pos } = parseArgs(rest, ['level', 'source']);
  const [repoSlug, taskArg, body] = pos;
  if (!flags.level || !flags.source || body === undefined) {
    die('usage: node tools/bus.mjs log <repo> <task> --level L --source S "body" (body "-" reads stdin)');
  }
  if (!LEVELS.includes(flags.level)) die(`invalid level: "${flags.level}" — accepted: ${LEVELS.join(', ')}`);
  const { taskDir, taskName } = resolveTask(repoSlug, taskArg);
  const ts = new Date().toISOString();
  let linhas;
  if (body === '-') {
    const stdin = fs.readFileSync(0, 'utf8');
    linhas = stdin.split('\n').filter((l, i, arr) => l !== '' || i < arr.length - 1);
    if (!linhas.length) die('stdin empty — nothing to record');
  } else {
    linhas = [body];
  }
  appendJsonl(
    path.join(taskDir, 'logs.jsonl'),
    linhas.map((l) => ({ ts, level: flags.level, source: flags.source, body: l }))
  );
  touchMeta(taskDir);
  console.log(`${linhas.length} record(s) [${flags.level}] from ${flags.source} in repos/${repoSlug}/tasks/${taskName}/logs.jsonl`);
} else if (cmd === 'read') {
  const { flags, pos } = parseArgs(rest, ['kind', 'to', 'since', 'tail']);
  const [repoSlug, taskArg] = pos;
  const { taskDir, taskName } = resolveTask(repoSlug, taskArg);
  if (flags.kind && !KINDS.includes(flags.kind)) die(`invalid kind: "${flags.kind}" — accepted: ${KINDS.join(', ')}`);
  const file = path.join(taskDir, 'messages.jsonl');
  if (!fs.existsSync(file)) {
    console.log(`(no messages in repos/${repoSlug}/tasks/${taskName})`);
    process.exit(0);
  }
  let msgs = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l, i) => {
      try {
        return JSON.parse(l);
      } catch {
        die(`line ${i + 1} of messages.jsonl is not valid JSON`);
      }
    });
  if (flags.kind) msgs = msgs.filter((m) => m.kind === flags.kind);
  if (flags.to) msgs = msgs.filter((m) => m.to === flags.to);
  if (flags.since) {
    const since = Date.parse(flags.since);
    if (Number.isNaN(since)) die(`--since is not a valid ISO date: "${flags.since}"`);
    msgs = msgs.filter((m) => Date.parse(m.ts) >= since);
  }
  if (flags.tail) {
    const n = parseInt(flags.tail, 10);
    if (!Number.isInteger(n) || n <= 0) die(`--tail requires a positive integer: "${flags.tail}"`);
    msgs = msgs.slice(-n);
  }
  if (!msgs.length) {
    console.log('(no messages match these filters)');
    process.exit(0);
  }
  for (const m of msgs) {
    const hora = (m.ts ?? '').slice(11, 19) || m.ts;
    const corpo = String(m.body ?? '').split('\n').join('\n           ');
    const extra = m.meta ? `  ${JSON.stringify(m.meta)}` : '';
    console.log(`${hora}  ${m.from}→${m.to}  [${m.kind}]  ${corpo}${extra}`);
  }
} else if (cmd === 'agents') {
  // agents <repo> [<task>] — reads repos/<repo>/agents.json; <task> (optional, full
  // name or prefix) only filters the display to agents whose last_task is that task.
  const { pos } = parseArgs(rest, []);
  const [repoSlug, taskArg] = pos;
  let repoDir;
  let filterTask = null;
  if (taskArg) {
    ({ repoDir, taskName: filterTask } = resolveTask(repoSlug, taskArg));
  } else {
    repoDir = resolveRepo(repoSlug);
  }
  const file = path.join(repoDir, 'agents.json');
  const agents = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).agents ?? [] : [];
  const listados = filterTask ? agents.filter((a) => a.last_task === filterTask) : agents;
  if (!listados.length) {
    console.log(`(no agent registered in repos/${repoSlug}${filterTask ? ` with last_task ${filterTask}` : ''})`);
    process.exit(0);
  }
  for (const a of listados) {
    const role = a.role ? ` (${a.role})` : '';
    const lastTask = a.last_task ? `  last task ${a.last_task}` : '';
    console.log(`${a.name}${role} — ${a.status}  created ${a.created}  active ${a.last_active}${lastTask}`);
  }
} else {
  die('usage: node tools/bus.mjs <post|log|read> <repo> <task> [...] | agents <repo> [<task>]');
}
