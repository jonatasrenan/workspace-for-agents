// One-way migration of existing state (repos/<repo>/…) to the English names the
// tools, the panel and the artifacts use now — the previous vocabulary was
// Portuguese and lived in file names, JSON keys and stored values alike.
//
// Usage:
//   node tools/migrate.mjs --all [--dry-run]
//   node tools/migrate.mjs <repo> [--dry-run]
//
// What it does, per repo (WFA_ROOT honored like every other tool):
//   - renames the artifacts: 00-contexto.md → 00-context.md,
//     00-enunciado.md → 00-brief.md, 10-plano.md → 10-plan.md;
//   - renames the state files: acessos.json → access.json, estado.json → state.json;
//   - rewrites keys AND values in every .json/.jsonl under repos/<repo>/
//     (meta, dag, agents, access, state, messages, logs, costs, commits).
// Plus, with --all, the share registry (.shares.json) at the root.
//
// IDEMPOTENT: a name already migrated is left alone, so running it twice (or on a
// root that is half migrated) is safe. A file that isn't valid JSON is reported
// and skipped — never rewritten half way.
import fs from 'node:fs';
import path from 'node:path';
import { stateRoot } from './root.mjs';

const ROOT = stateRoot();

// --- rename maps ------------------------------------------------------------
const FILE_RENAMES = {
  '00-contexto.md': '00-context.md',
  '00-enunciado.md': '00-brief.md',
  '10-plano.md': '10-plan.md',
  'acessos.json': 'access.json',
  'estado.json': 'state.json',
};

// JSON keys, everywhere they appear
const KEYS = {
  titulo: 'title',
  agente: 'agent',
  modelo: 'model',
  nota: 'note',
  nome: 'name',
  tipo: 'type',
  acessos: 'accesses',
  registrado_em: 'registered_at',
  atualizado_em: 'updated_at',
  clonado_em: 'cloned_at',
  imagens: 'images',
  idade: 'age',
  minimos: 'minimums',
  ambiente: 'environment',
  origem: 'origin',
  categoria: 'category',
  aplica_a: 'applies_to',
  verificacao: 'verification',
  severidade: 'severity',
  jargao_permitido: 'allowed_jargon',
  tempo_alvo_min: 'target_time_min',
  responde: 'answers',
  dispensa: 'dismisses',
  custos: 'costs',
  publicado_em: 'published_at',
};

const TASK_STATUS = { todo: 'todo', 'em-andamento': 'in-progress', concluida: 'done', concluido: 'done' };
const NODE_STATUS = { todo: 'todo', executando: 'running', concluida: 'done', bloqueada: 'blocked' };
const GR_STATUS = { pendente: 'pending', pass: 'pass', falha: 'fail', aceito: 'accepted' };
const AGENT_STATUS = { ocioso: 'idle', executando: 'running', concluido: 'done' };
const ACCESS_TYPE = { app: 'app', metricas: 'metrics', dashboard: 'dashboard', outro: 'other' };
const ACTORS = { piloto: 'pilot', humano: 'human', sala: 'room' };
const TAGS = {
  codigo: 'code',
  testes: 'tests',
  operacao: 'operations',
  integracao: 'integration',
  resiliencia: 'resilience',
  metricas: 'metrics',
};
const GUARDRAIL_IDS = {
  'k8s-imagem-tag': 'k8s-image-tag',
  'k8s-replicas-resiliencia': 'k8s-replicas-resilience',
  'cod-timeout-retry': 'code-timeout-retry',
  'cod-valida-borda': 'code-validate-input',
  'cod-sem-segredo': 'code-no-secret',
  'cod-deps-minimas': 'code-minimal-deps',
  'cod-logs-nivel': 'code-log-level',
  'api-codigos-erro': 'api-error-codes',
  'api-healthcheck-leve': 'api-light-healthcheck',
  'api-contrato-doc': 'api-contract-doc',
  'tst-caso-erro': 'test-error-case',
  'tst-nao-tautologico': 'test-not-tautological',
  'tst-fixture-offline': 'test-offline-fixture',
  'tst-um-comando': 'test-one-command',
  'op-limpeza': 'op-cleanup',
  'op-reprodutivel': 'op-reproducible',
};

const map = (table, v) => (typeof v === 'string' && table[v] !== undefined ? table[v] : v);

// --- generic key rewrite ----------------------------------------------------
function renameKeys(value) {
  if (Array.isArray(value)) return value.map(renameKeys);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) out[KEYS[k] ?? k] = renameKeys(v);
  return out;
}

// --- per-file value rewrites (applied AFTER the keys are English) -----------
function migrateTaskMeta(meta) {
  if (meta && typeof meta === 'object' && typeof meta.status === 'string') meta.status = map(TASK_STATUS, meta.status);
  return meta;
}

function migrateDag(dag) {
  for (const n of dag?.nodes ?? []) {
    if (!n || typeof n !== 'object') continue;
    n.status = map(NODE_STATUS, n.status);
    if (Array.isArray(n.tags)) n.tags = n.tags.map((t) => map(TAGS, t));
    for (const g of n.guardrails ?? []) {
      if (!g || typeof g !== 'object') continue;
      g.id = map(GUARDRAIL_IDS, g.id);
      g.status = map(GR_STATUS, g.status);
      if (typeof g.note === 'string') g.note = g.note.replace(/^aceito:\s*/i, 'accepted: ');
    }
  }
  return dag;
}

function migrateAgents(data) {
  for (const a of data?.agents ?? []) {
    if (a && typeof a === 'object') a.status = map(AGENT_STATUS, a.status);
  }
  return data;
}

function migrateAccess(data) {
  for (const a of data?.accesses ?? []) {
    if (a && typeof a === 'object') a.type = map(ACCESS_TYPE, a.type);
  }
  return data;
}

// bus message: actors, the dag transition's body/meta, and the closing links
function migrateMessage(m) {
  if (!m || typeof m !== 'object') return m;
  m.from = map(ACTORS, m.from);
  m.to = map(ACTORS, m.to);
  if (m.meta && typeof m.meta === 'object') {
    if (m.meta.para !== undefined && m.meta.to === undefined) {
      m.meta.to = map(NODE_STATUS, m.meta.para);
      delete m.meta.para;
    }
    if (typeof m.meta.agent === 'string') m.meta.agent = map(ACTORS, m.meta.agent);
  }
  if (typeof m.body === 'string') {
    m.body = m.body.replace(
      /^(node .+ → )(todo|executando|concluida|bloqueada)$/,
      (_, head, st) => head + NODE_STATUS[st]
    );
  }
  return m;
}

const PER_FILE = {
  'dag.json': migrateDag,
  'agents.json': migrateAgents,
  'access.json': migrateAccess,
  'meta.json': migrateTaskMeta,
};

// --- IO ---------------------------------------------------------------------
const changes = [];
let failures = 0;

function note(action, target) {
  changes.push(`${action}: ${path.relative(ROOT, target)}`);
}

function renameIfNeeded(dir, from, to, dryRun) {
  const src = path.join(dir, from);
  const dst = path.join(dir, to);
  if (!fs.existsSync(src)) return;
  if (fs.existsSync(dst)) {
    console.error(`skipped (both names present, resolve by hand): ${path.relative(ROOT, src)}`);
    failures++;
    return;
  }
  note(`rename ${from} → ${to}`, dst);
  if (!dryRun) fs.renameSync(src, dst);
}

function rewriteJson(file, dryRun) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    console.error(`skipped (not valid JSON): ${path.relative(ROOT, file)} — ${e.message}`);
    failures++;
    return;
  }
  const per = PER_FILE[path.basename(file)];
  const migrated = per ? per(renameKeys(data)) : renameKeys(data);
  const text = JSON.stringify(migrated, null, 2) + '\n';
  if (text === raw) return;
  note('rewrite', file);
  if (!dryRun) fs.writeFileSync(file, text);
}

function rewriteJsonl(file, dryRun) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  const isMessages = path.basename(file) === 'messages.jsonl';
  const out = [];
  let lineNo = 0;
  for (const line of raw.split('\n')) {
    lineNo++;
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (e) {
      console.error(`skipped (line ${lineNo} is not valid JSON): ${path.relative(ROOT, file)} — ${e.message}`);
      failures++;
      return;
    }
    const renamed = renameKeys(obj);
    out.push(JSON.stringify(isMessages ? migrateMessage(renamed) : renamed));
  }
  const text = out.length ? out.join('\n') + '\n' : '';
  if (text === raw) return;
  note('rewrite', file);
  if (!dryRun) fs.writeFileSync(file, text);
}

function migrateDir(dir, dryRun) {
  for (const [from, to] of Object.entries(FILE_RENAMES)) renameIfNeeded(dir, from, to, dryRun);
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) migrateDir(p, dryRun);
    else if (e.name.endsWith('.json')) rewriteJson(p, dryRun);
    else if (e.name.endsWith('.jsonl')) rewriteJsonl(p, dryRun);
  }
}

function listRepos() {
  const reposDir = path.join(ROOT, 'repos');
  if (!fs.existsSync(reposDir)) return [];
  return fs
    .readdirSync(reposDir)
    .filter((d) => !d.startsWith('.') && fs.existsSync(path.join(reposDir, d, 'meta.json')))
    .sort();
}

function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const pos = argv.filter((a) => !a.startsWith('--'));
  const all = argv.includes('--all');
  const unknown = argv.filter((a) => a.startsWith('--') && a !== '--all' && a !== '--dry-run');
  if (unknown.length) {
    console.error(`unknown flag: ${unknown.join(', ')} — accepted: --all, --dry-run`);
    process.exit(1);
  }
  if (all === Boolean(pos.length)) {
    console.error('usage: node tools/migrate.mjs --all [--dry-run] | node tools/migrate.mjs <repo> [--dry-run]');
    process.exit(1);
  }

  let repos;
  if (all) {
    repos = listRepos();
  } else {
    const [repoSlug] = pos;
    if (/[/\\]|\.\./.test(repoSlug)) {
      console.error(`invalid repo: "${repoSlug}" — use only the repo slug`);
      process.exit(1);
    }
    if (!fs.existsSync(path.join(ROOT, 'repos', repoSlug))) {
      const existing = listRepos();
      console.error(`repo not found: ${repoSlug}${existing.length ? ` — existing: ${existing.join(', ')}` : ''}`);
      process.exit(1);
    }
    repos = [repoSlug];
  }

  for (const slug of repos) migrateDir(path.join(ROOT, 'repos', slug), dryRun);
  if (all) {
    const shares = path.join(ROOT, '.shares.json');
    if (fs.existsSync(shares)) rewriteJson(shares, dryRun);
  }

  if (!repos.length) console.log(`no repo in this root (${ROOT})`);
  for (const c of changes) console.log(`${dryRun ? '[dry-run] ' : ''}${c}`);
  console.log(`\n${changes.length} change(s)${dryRun ? ' (nothing written)' : ''}${failures ? `, ${failures} skipped` : ''}`);
  process.exit(failures ? 1 : 0);
}

main();
