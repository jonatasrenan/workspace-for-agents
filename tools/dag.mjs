// DAG of a task's subtasks, with guardrails attached from the pool (guardrails/pool.json).
// A node can only be marked done once all its guardrails are resolved (pass or aceito) — the gate.
// Usage:
//   node tools/dag.mjs set <repo> <task>                    (reads the full DAG JSON from stdin)
//   node tools/dag.mjs node-status <repo> <task> <nodeId> <todo|executando|concluida|bloqueada> [--force]
//   node tools/dag.mjs guardrail <repo> <task> <nodeId> <guardrailId> <pass|falha|pendente> [--nota "..."]
//   node tools/dag.mjs guardrail <repo> <task> <nodeId> <guardrailId> aceito --aceitar "reason"
//   node tools/dag.mjs show <repo> <task>
//   node tools/dag.mjs pool [--tag <tag>] [--categoria <cat>]
//   node tools/dag.mjs validate <repo> <task>
// <task> accepts the full directory name OR just the numeric prefix ("01").
// Format of dag.json (written to repos/<repo>/tasks/<task>/):
//   {"nodes":[{"id","titulo","status","agente"?,"depends_on":["<id>"],"tags":["k8s"],
//              "guardrails":[{"id":"<pool-id>","status":"pendente|pass|falha|aceito","nota"?}]}]}
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson, updateJson } from './jsonfile.mjs';
import { INSTALL_ROOT, stateRoot } from './root.mjs';

const ROOT = stateRoot();
const NODE_STATUS = ['todo', 'executando', 'concluida', 'bloqueada'];
const GR_STATUS = ['pendente', 'pass', 'falha', 'aceito'];

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function parseArgs(argv, valueFlags, boolFlags = []) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      if (boolFlags.includes(name)) {
        flags[name] = true;
      } else if (valueFlags.includes(name)) {
        if (i + 1 >= argv.length) die(`--${name} requires a value`);
        flags[name] = argv[++i];
      } else {
        const aceitas = [...valueFlags, ...boolFlags].map((f) => `--${f}`).join(', ') || '(none)';
        die(`unknown flag: --${name} (accepted: ${aceitas})`);
      }
    } else {
      pos.push(a);
    }
  }
  return { flags, pos };
}

// Resolves <repo> and <task> (full name or "01" prefix), with errors that list the options.
function resolveTask(repoSlug, taskArg) {
  if (!repoSlug || !taskArg) die('missing arguments: <repo> <task>');
  const reposDir = path.join(ROOT, 'repos');
  const repoDir = path.join(reposDir, repoSlug);
  if (!fs.existsSync(path.join(repoDir, 'meta.json'))) {
    const existentes = fs.existsSync(reposDir) ? fs.readdirSync(reposDir).filter((d) => !d.startsWith('.')) : [];
    die(`repo not found: ${repoSlug}${existentes.length ? ` — existing: ${existentes.join(', ')}` : ' — no repo created yet (use new-repo.mjs)'}`);
  }
  const tasksDir = path.join(repoDir, 'tasks');
  const tasks = fs.existsSync(tasksDir) ? fs.readdirSync(tasksDir).filter((d) => /^\d{2}-/.test(d)).sort() : [];
  const prefixo = /^\d+$/.test(taskArg) ? taskArg.padStart(2, '0') : null;
  const match = tasks.find((d) => d === taskArg) ?? (prefixo && tasks.find((d) => d.startsWith(`${prefixo}-`)));
  if (!match) {
    die(`task not found: "${taskArg}" in repos/${repoSlug}/tasks${tasks.length ? ` — existing: ${tasks.join(', ')}` : ' — no task created yet (use new-task.mjs)'}`);
  }
  return { taskDir: path.join(tasksDir, match), taskName: match, repoSlug };
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

// The guardrail catalog ships with the program (versioned, not per-repo state),
// same reasoning as costs.mjs's price table: read it from INSTALL_ROOT so a DAG
// validated against an external WFA_ROOT still checks against the real pool.
function loadPool() {
  const file = path.join(INSTALL_ROOT, 'guardrails', 'pool.json');
  if (!fs.existsSync(file)) die('guardrail pool not found: guardrails/pool.json');
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    die(`guardrails/pool.json is not valid JSON: ${e.message}`);
  }
  if (!Array.isArray(data.guardrails)) die('guardrails/pool.json missing "guardrails" list');
  return data.guardrails;
}

function loadDag(taskDir, taskName, repoSlug) {
  const file = path.join(taskDir, 'dag.json');
  if (!fs.existsSync(file)) die(`dag.json does not exist in repos/${repoSlug}/tasks/${taskName} — create it with: node tools/dag.mjs set ${repoSlug} ${taskName} < dag.json`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    die(`dag.json is not valid JSON: ${e.message}`);
  }
}

function saveDag(taskDir, dag) {
  writeJson(path.join(taskDir, 'dag.json'), dag);
  touchMeta(taskDir);
}

// Mutation of an already-existing dag.json: the read→modify→write cycle happens inside
// a lock, so that two agents marking nodes/guardrails in parallel don't
// overwrite each other's verdict.
function mutateDag(taskDir, taskName, repoSlug, fn) {
  const file = path.join(taskDir, 'dag.json');
  if (!fs.existsSync(file)) die(`dag.json does not exist in repos/${repoSlug}/tasks/${taskName} — create it with: node tools/dag.mjs set ${repoSlug} ${taskName} < dag.json`);
  return updateJson(file, null, (dag) => {
    if (!dag) die(`dag.json of repos/${repoSlug}/tasks/${taskName} is not valid JSON`);
    fn(dag);
    return dag;
  });
}

// Topological order (Kahn) stable by input order; returns null if there is a cycle.
function topoOrder(nodes) {
  const ids = nodes.map((n) => n.id);
  const restantes = new Map(nodes.map((n) => [n.id, new Set((n.depends_on ?? []).filter((d) => ids.includes(d)))]));
  const ordem = [];
  while (ordem.length < nodes.length) {
    const prontos = nodes.filter((n) => restantes.has(n.id) && restantes.get(n.id).size === 0);
    if (!prontos.length) return null; // cycle
    for (const n of prontos) {
      ordem.push(n);
      restantes.delete(n.id);
      for (const deps of restantes.values()) deps.delete(n.id);
    }
  }
  return ordem;
}

// Validates the DAG against the pool. Normalizes defaults (guardrail status "pendente") in place.
// Returns the list of ALL errors found (empty if ok).
function validateDag(dag, pool) {
  const erros = [];
  if (!dag || typeof dag !== 'object' || Array.isArray(dag)) return ['root must be an object {"nodes":[...]}'];
  if (!Array.isArray(dag.nodes)) return ['"nodes" field missing or not a list'];
  if (!dag.nodes.length) erros.push('empty DAG: "nodes" has no node');
  const poolIds = new Set(pool.map((g) => g.id));
  const vistos = new Set();
  for (const [i, n] of dag.nodes.entries()) {
    const ref = typeof n?.id === 'string' && n.id ? `node "${n.id}"` : `node #${i + 1}`;
    if (!n || typeof n !== 'object') {
      erros.push(`${ref}: not an object`);
      continue;
    }
    if (typeof n.id !== 'string' || !n.id) erros.push(`${ref}: "id" missing or empty`);
    else if (vistos.has(n.id)) erros.push(`${ref}: duplicate id`);
    else vistos.add(n.id);
    if (typeof n.titulo !== 'string' || !n.titulo) erros.push(`${ref}: "titulo" missing or empty`);
    if (n.status === undefined) n.status = 'todo';
    if (!NODE_STATUS.includes(n.status)) erros.push(`${ref}: invalid status "${n.status}" — accepted: ${NODE_STATUS.join(', ')}`);
    if (n.agente !== undefined && typeof n.agente !== 'string') erros.push(`${ref}: "agente" must be a string`);
    if (n.depends_on === undefined) n.depends_on = [];
    if (!Array.isArray(n.depends_on)) erros.push(`${ref}: "depends_on" must be a list of ids`);
    if (n.tags === undefined) n.tags = [];
    if (!Array.isArray(n.tags) || n.tags.some((t) => typeof t !== 'string')) erros.push(`${ref}: "tags" must be a list of strings`);
    if (n.guardrails === undefined) n.guardrails = [];
    if (!Array.isArray(n.guardrails)) {
      erros.push(`${ref}: "guardrails" must be a list`);
      n.guardrails = [];
    }
    for (const g of n.guardrails) {
      if (!g || typeof g !== 'object' || typeof g.id !== 'string' || !g.id) {
        erros.push(`${ref}: guardrail without "id"`);
        continue;
      }
      if (!poolIds.has(g.id)) erros.push(`${ref}: guardrail "${g.id}" does not exist in the pool (see: node tools/dag.mjs pool)`);
      if (g.status === undefined) g.status = 'pendente';
      if (!GR_STATUS.includes(g.status)) erros.push(`${ref}: guardrail "${g.id}" has invalid status "${g.status}" — accepted: ${GR_STATUS.join(', ')}`);
    }
  }
  const ids = new Set(dag.nodes.map((n) => n.id).filter((id) => typeof id === 'string' && id));
  for (const n of dag.nodes) {
    if (!Array.isArray(n.depends_on)) continue;
    for (const d of n.depends_on) {
      if (!ids.has(d)) erros.push(`node "${n.id}": depends_on "${d}" does not exist in the DAG`);
      if (d === n.id) erros.push(`node "${n.id}": depends on itself`);
    }
  }
  if (!erros.length && topoOrder(dag.nodes) === null) {
    erros.push(`cycle detected in depends_on — no topological order possible (nodes: ${dag.nodes.map((n) => n.id).join(', ')})`);
  }
  return erros;
}

function findNode(dag, nodeId) {
  const node = dag.nodes.find((n) => n.id === nodeId);
  if (!node) die(`node not found: "${nodeId}" — existing: ${dag.nodes.map((n) => n.id).join(', ')}`);
  return node;
}

function grCounts(nodes) {
  const c = { pass: 0, falha: 0, pendente: 0, aceito: 0 };
  for (const n of nodes) for (const g of n.guardrails ?? []) c[g.status] = (c[g.status] ?? 0) + 1;
  return c;
}

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === 'set') {
  const { pos } = parseArgs(rest, []);
  const [repoSlug, taskArg] = pos;
  const { taskDir, taskName } = resolveTask(repoSlug, taskArg);
  const stdin = fs.readFileSync(0, 'utf8');
  if (!stdin.trim()) die('stdin empty — send the full DAG JSON (e.g.: node tools/dag.mjs set <repo> <task> < dag.json)');
  let dag;
  try {
    dag = JSON.parse(stdin);
  } catch (e) {
    die(`stdin is not valid JSON: ${e.message}`);
  }
  const pool = loadPool();
  const erros = validateDag(dag, pool);
  if (erros.length) die(`invalid DAG (${erros.length} error${erros.length > 1 ? 's' : ''}):\n${erros.map((e) => `  - ${e}`).join('\n')}`);
  // `set` replaces the entire DAG. If there was progress, say what got discarded:
  // replanning mid-task is legitimate, silently losing verdicts is not.
  const anterior = fs.existsSync(path.join(taskDir, 'dag.json')) ? readJson(path.join(taskDir, 'dag.json'), null) : null;
  if (anterior?.nodes?.length) {
    const c = grCounts(anterior.nodes);
    const concluidos = anterior.nodes.filter((n) => n.status === 'concluida').length;
    const resolvidos = c.pass + c.falha + c.aceito;
    if (concluidos || resolvidos) {
      console.error(`warning: the previous DAG had ${concluidos} node(s) done and ${resolvidos} guardrail(s) with a verdict — status and verdicts were replaced by the submitted JSON.`);
    }
  }
  saveDag(taskDir, dag);
  const c = grCounts(dag.nodes);
  console.log(`DAG written: ${dag.nodes.length} nodes, ${c.pass + c.falha + c.pendente + c.aceito} guardrails in repos/${repoSlug}/tasks/${taskName}/dag.json`);
} else if (cmd === 'node-status') {
  const { flags, pos } = parseArgs(rest, [], ['force']);
  const [repoSlug, taskArg, nodeId, status] = pos;
  if (!nodeId || !status) die('usage: node tools/dag.mjs node-status <repo> <task> <nodeId> <todo|executando|concluida|bloqueada> [--force]');
  if (!NODE_STATUS.includes(status)) die(`invalid status: "${status}" — accepted: ${NODE_STATUS.join(', ')}`);
  const { taskDir, taskName } = resolveTask(repoSlug, taskArg);
  mutateDag(taskDir, taskName, repoSlug, (dag) => {
  const node = findNode(dag, nodeId);
  if (status === 'executando' || status === 'concluida') {
    const pendentes = (node.depends_on ?? []).filter((d) => dag.nodes.find((n) => n.id === d)?.status !== 'concluida');
    if (pendentes.length && !flags.force) {
      die(`refused: unfinished dependencies of "${nodeId}": ${pendentes.join(', ')} — finish them first or use --force for a deliberate exception`);
    }
  }
  if (status === 'concluida') {
    const abertos = (node.guardrails ?? []).filter((g) => g.status === 'pendente' || g.status === 'falha');
    if (abertos.length) {
      die(
        `refused: node "${nodeId}" has ${abertos.length} unresolved guardrail(s):\n` +
          abertos.map((g) => `  - ${g.id} [${g.status}]`).join('\n') +
          `\nresolve with: node tools/dag.mjs guardrail ${repoSlug} ${taskName} ${nodeId} <id> pass | aceito --aceitar "reason"`
      );
    }
  }
  node.status = status;
  });
  touchMeta(taskDir);
  // Records the transition on the task's bus (the same messages.jsonl line that
  // tools/bus.mjs writes): the panel's timeline builds the DAG history from
  // these messages — dag.json alone only holds the current state.
  fs.appendFileSync(
    path.join(taskDir, 'messages.jsonl'),
    JSON.stringify({
      ts: new Date().toISOString(),
      from: 'dag',
      to: 'sala',
      kind: 'status',
      body: `node ${nodeId} → ${status}`,
      meta: { node: nodeId, para: status },
    }) + '\n'
  );
  console.log(`node "${nodeId}" → ${status}${flags.force ? ' (--force)' : ''} in repos/${repoSlug}/tasks/${taskName}/dag.json`);
} else if (cmd === 'guardrail') {
  const { flags, pos } = parseArgs(rest, ['nota', 'aceitar']);
  const [repoSlug, taskArg, nodeId, guardrailId, status] = pos;
  if (!nodeId || !guardrailId || !status) {
    die('usage: node tools/dag.mjs guardrail <repo> <task> <nodeId> <guardrailId> <pass|falha|pendente> [--nota "..."]\n     node tools/dag.mjs guardrail <repo> <task> <nodeId> <guardrailId> aceito --aceitar "reason"');
  }
  if (!GR_STATUS.includes(status)) die(`invalid status: "${status}" — accepted: ${GR_STATUS.join(', ')}`);
  if (status === 'aceito' && !flags.aceitar) die('status "aceito" requires --aceitar "reason" — the reason is recorded in the guardrail\'s note');
  if (status !== 'aceito' && flags.aceitar) die('--aceitar is only valid with status "aceito"');
  const { taskDir, taskName } = resolveTask(repoSlug, taskArg);
  let nota = '';
  mutateDag(taskDir, taskName, repoSlug, (dag) => {
  const node = findNode(dag, nodeId);
  const gr = (node.guardrails ?? []).find((g) => g.id === guardrailId);
  if (!gr) {
    const ids = (node.guardrails ?? []).map((g) => g.id);
    die(`guardrail "${guardrailId}" is not attached to node "${nodeId}"${ids.length ? ` — attached: ${ids.join(', ')}` : ' — node has no guardrails'}`);
  }
  gr.status = status;
  // The note belongs to the current verdict: a new verdict without a note must not inherit
  // the previous one's justification (a "pass" showing "aceito: no time" would lie).
  if (status === 'aceito') gr.nota = `aceito: ${flags.aceitar}`;
  else if (flags.nota !== undefined) gr.nota = flags.nota;
  else delete gr.nota;
  nota = gr.nota ?? '';
  });
  touchMeta(taskDir);
  console.log(`guardrail "${guardrailId}" of node "${nodeId}" → ${status}${nota ? ` (${nota})` : ''}`);
} else if (cmd === 'show') {
  const { pos } = parseArgs(rest, []);
  const [repoSlug, taskArg] = pos;
  const { taskDir, taskName } = resolveTask(repoSlug, taskArg);
  const dag = loadDag(taskDir, taskName, repoSlug);
  if (!Array.isArray(dag.nodes) || !dag.nodes.length) {
    console.log(`(empty DAG in repos/${repoSlug}/tasks/${taskName})`);
    process.exit(0);
  }
  const ordem = topoOrder(dag.nodes);
  if (ordem === null) console.log('WARNING: cycle in depends_on — showing in file order (run validate)');
  console.log(`DAG of repos/${repoSlug}/tasks/${taskName} (topological order):\n`);
  for (const n of ordem ?? dag.nodes) {
    const deps = n.depends_on?.length ? `  deps: ${n.depends_on.join(', ')}` : '';
    const agente = n.agente ? `  agente: ${n.agente}` : '';
    const tags = n.tags?.length ? `  tags: ${n.tags.join(', ')}` : '';
    console.log(`[${n.status}] ${n.id} — ${n.titulo}${deps}${agente}${tags}`);
    for (const g of n.guardrails ?? []) {
      console.log(`    · ${g.id} [${g.status}]${g.nota ? ` — ${g.nota}` : ''}`);
    }
  }
  const concluidos = dag.nodes.filter((n) => n.status === 'concluida').length;
  const c = grCounts(dag.nodes);
  console.log(`\n${concluidos}/${dag.nodes.length} nodes done — guardrails: ${c.pass} pass / ${c.falha} failed / ${c.pendente} pending / ${c.aceito} accepted`);
} else if (cmd === 'pool') {
  const { flags } = parseArgs(rest, ['tag', 'categoria']);
  let pool = loadPool();
  if (flags.categoria) pool = pool.filter((g) => g.categoria === flags.categoria);
  if (flags.tag) pool = pool.filter((g) => (g.aplica_a ?? []).includes(flags.tag));
  if (!pool.length) {
    const filtro = [flags.categoria && `categoria=${flags.categoria}`, flags.tag && `tag=${flags.tag}`].filter(Boolean).join(', ');
    console.log(`(no guardrail in the pool${filtro ? ` with ${filtro}` : ''})`);
    process.exit(0);
  }
  const wId = Math.max(...pool.map((g) => g.id.length));
  const wCat = Math.max(...pool.map((g) => g.categoria.length));
  for (const g of pool) {
    console.log(`${g.id.padEnd(wId)}  ${g.categoria.padEnd(wCat)}  [${g.severidade}]  ${g.titulo}`);
  }
  console.log(`\n${pool.length} guardrail(s)`);
} else if (cmd === 'validate') {
  const { pos } = parseArgs(rest, []);
  const [repoSlug, taskArg] = pos;
  const { taskDir, taskName } = resolveTask(repoSlug, taskArg);
  const dag = loadDag(taskDir, taskName, repoSlug);
  const erros = validateDag(dag, loadPool());
  if (erros.length) die(`invalid dag.json (${erros.length} error${erros.length > 1 ? 's' : ''}):\n${erros.map((e) => `  - ${e}`).join('\n')}`);
  const c = grCounts(dag.nodes);
  console.log(`ok: valid DAG — ${dag.nodes.length} nodes, guardrails: ${c.pass} pass / ${c.falha} failed / ${c.pendente} pending / ${c.aceito} accepted`);
} else {
  die('usage: node tools/dag.mjs <set|node-status|guardrail|show|pool|validate> [...]  (the file header documents each subcommand)');
}
