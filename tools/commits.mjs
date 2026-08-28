// Registro dos commits que uma task produziu no workspace do repo — IO mecânico,
// a LLM nunca datilografa JSONL.
// Uso:
//   node tools/commits.mjs add  <repo> <task> <hash> [--msg "..."]
//   node tools/commits.mjs list <repo> <task>
// <task> aceita o nome completo do diretório OU só o prefixo numérico ("01").
// O hash é validado contra o git de workspace/<repo> (o caminho vem de
// repos/<repo>/meta.json "workspace", com fallback workspace/<repo>), resolvido para
// o hash completo; sem --msg a mensagem real do commit é lida do git.
// Escreve em repos/<repo>/tasks/<task>/commits.jsonl (on-demand), dedupado por hash.
// O painel (aba Diff) também descobre commits pela janela temporal da task — este
// registro é a fonte explícita, que vence a heurística quando as duas se cruzam.
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson, updateJson } from './jsonfile.mjs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
      if (!valueFlags.includes(name)) die(`flag desconhecida: --${name} (aceitas: ${valueFlags.map((f) => `--${f}`).join(', ')})`);
      if (i + 1 >= argv.length) die(`--${name} exige um valor`);
      flags[name] = argv[++i];
    } else {
      pos.push(a);
    }
  }
  return { flags, pos };
}

// Resolve <repo> com erro que lista as opções.
function resolveRepo(repoSlug) {
  if (!repoSlug) die('falta argumento: <repo>');
  const reposDir = path.join(ROOT, 'repos');
  const repoDir = path.join(reposDir, repoSlug);
  if (!fs.existsSync(path.join(repoDir, 'meta.json'))) {
    const existentes = fs.existsSync(reposDir) ? fs.readdirSync(reposDir).filter((d) => !d.startsWith('.')) : [];
    die(`repo não encontrado: ${repoSlug}${existentes.length ? ` — existentes: ${existentes.join(', ')}` : ' — nenhum repo criado ainda (use new-repo.mjs)'}`);
  }
  return repoDir;
}

// Resolve <repo> e <task> (nome completo ou prefixo "01") com erros que listam as opções.
function resolveTask(repoSlug, taskArg) {
  if (!repoSlug || !taskArg) die('faltam argumentos: <repo> <task>');
  const repoDir = resolveRepo(repoSlug);
  const tasksDir = path.join(repoDir, 'tasks');
  const tasks = fs.existsSync(tasksDir) ? fs.readdirSync(tasksDir).filter((d) => /^\d{2}-/.test(d)).sort() : [];
  const prefixo = /^\d+$/.test(taskArg) ? taskArg.padStart(2, '0') : null;
  const match = tasks.find((d) => d === taskArg) ?? (prefixo && tasks.find((d) => d.startsWith(`${prefixo}-`)));
  if (!match) {
    die(`task não encontrada: "${taskArg}" em repos/${repoSlug}/tasks${tasks.length ? ` — existentes: ${tasks.join(', ')}` : ' — nenhuma task criada ainda (use new-task.mjs)'}`);
  }
  return { taskDir: path.join(tasksDir, match), taskName: match, repoSlug, repoDir };
}

// workspace do repo: meta.json "workspace" (relativo à raiz) ou workspace/<repo>
function resolveWorkspace(repoDir, repoSlug) {
  let meta = {};
  try {
    meta = JSON.parse(fs.readFileSync(path.join(repoDir, 'meta.json'), 'utf8'));
  } catch {}
  const wsDir = meta.workspace ? path.resolve(ROOT, meta.workspace) : path.join(ROOT, 'workspace', repoSlug);
  if (!fs.existsSync(path.join(wsDir, '.git'))) {
    die(`workspace sem git: ${path.relative(ROOT, wsDir)} — nada a registrar (o código do repo vive lá)`);
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
    if (!meta) return undefined; // meta ilegível: não é este comando que vai reescrevê-lo
    meta.updated = new Date().toISOString().slice(0, 10);
    return meta;
  });
}

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === 'add') {
  const { flags, pos } = parseArgs(rest, ['msg']);
  const [repoSlug, taskArg, hashArg] = pos;
  if (!repoSlug || !taskArg || !hashArg) die('uso: node tools/commits.mjs add <repo> <task> <hash> [--msg "..."]');
  const { taskDir, taskName, repoDir } = resolveTask(repoSlug, taskArg);
  const wsDir = resolveWorkspace(repoDir, repoSlug);
  let tipo;
  try {
    tipo = git(wsDir, ['cat-file', '-t', hashArg]);
  } catch {
    die(`hash não existe no git de ${path.relative(ROOT, wsDir)}: ${hashArg}`);
  }
  if (tipo !== 'commit') die(`hash não é um commit (é "${tipo}"): ${hashArg}`);
  const hash = git(wsDir, ['rev-parse', `${hashArg}^{commit}`]);
  const msg = flags.msg !== undefined ? flags.msg : git(wsDir, ['log', '-1', '--format=%s', hash]);
  const file = path.join(taskDir, 'commits.jsonl');
  if (readJsonl(file).some((c) => c.hash === hash)) {
    console.log(`commit já registrado em repos/${repoSlug}/tasks/${taskName}: ${hash.slice(0, 7)} ${msg}`);
    process.exit(0);
  }
  fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), hash, msg }) + '\n');
  touchMeta(taskDir);
  console.log(`commit registrado em repos/${repoSlug}/tasks/${taskName}/commits.jsonl: ${hash.slice(0, 7)} ${msg}`);
} else if (cmd === 'list') {
  const { pos } = parseArgs(rest, []);
  const [repoSlug, taskArg] = pos;
  const { taskDir, taskName } = resolveTask(repoSlug, taskArg);
  const commits = readJsonl(path.join(taskDir, 'commits.jsonl'));
  if (!commits.length) {
    console.log(`(nenhum commit registrado em repos/${repoSlug}/tasks/${taskName})`);
    process.exit(0);
  }
  for (const c of commits) {
    const quando = (c.ts ?? '').slice(0, 19).replace('T', ' ');
    console.log(`${String(c.hash ?? '').slice(0, 7)}  ${quando}  ${c.msg ?? ''}`);
  }
  console.log(`${commits.length} commit(s) em repos/${repoSlug}/tasks/${taskName}`);
} else {
  die('uso: node tools/commits.mjs <add|list> <repo> <task> [<hash>] [--msg "..."]');
}
