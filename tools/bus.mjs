// Barramento de mensagens/logs de uma task — IO mecânico, a LLM nunca datilografa JSONL.
// Uso:
//   node tools/bus.mjs post <repo> <task> --from X --to Y --kind K [--meta '<json>'] "corpo"
//   node tools/bus.mjs log  <repo> <task> --level L --source S "corpo"   (corpo "-" lê stdin; cada linha vira um registro)
//   node tools/bus.mjs read <repo> <task> [--kind K] [--to Y] [--since <ISO>] [--tail N]
//   node tools/bus.mjs agents <repo> [<task>]   (<task> opcional: filtra a exibição por last_task)
// <task> aceita o nome completo do diretório OU só o prefixo numérico ("01").
// Escreve em repos/<repo>/tasks/<task>/: messages.jsonl, logs.jsonl (on-demand).
// O registro de agentes vive no nível do REPO: repos/<repo>/agents.json — cada agente
// carrega "last_task" = task do post de status que o atualizou por último.
// kind=status com meta.state (spawned|working|done) faz o upsert nesse arquivo (por name=from).
// Compatibilidade: agents.json em nível de task (criado por versão antiga) é ignorado
// pelo upsert — só o arquivo do repo é lido/escrito daqui em diante.
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

function appendJsonl(file, objs) {
  fs.appendFileSync(file, objs.map((o) => JSON.stringify(o) + '\n').join(''));
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

// Upsert no registro de agentes do REPO (repos/<repo>/agents.json).
// Um agents.json antigo em nível de task, se ainda existir, é simplesmente ignorado.
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

// Qual agente o status descreve. O ciclo de vida é postado pelo piloto SOBRE o
// executor (`--from piloto --to k8s-operator`), então quem entra no registro é o
// destinatário; um agente que posta o próprio status entra por ele mesmo.
// `--meta '{"agent":"..."}'` tem precedência sobre as duas heurísticas.
function agenteDoStatus(from, to, meta) {
  const nome = meta?.agent ?? (from === 'piloto' ? to : from);
  return nome === 'humano' || nome === 'sala' ? null : nome;
}

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === 'post') {
  const { flags, pos } = parseArgs(rest, ['from', 'to', 'kind', 'meta']);
  const [repoSlug, taskArg, body] = pos;
  if (!flags.from || !flags.to || !flags.kind || body === undefined) {
    die('uso: node tools/bus.mjs post <repo> <task> --from X --to Y --kind K [--meta \'<json>\'] "corpo"');
  }
  if (!KINDS.includes(flags.kind)) die(`kind inválido: "${flags.kind}" — aceitos: ${KINDS.join(', ')}`);
  let meta;
  if (flags.meta !== undefined) {
    try {
      meta = JSON.parse(flags.meta);
    } catch (e) {
      die(`--meta não é JSON válido: ${e.message}`);
    }
  }
  if (flags.kind === 'status' && meta?.state && !STATES.includes(meta.state)) {
    die(`meta.state inválido: "${meta.state}" — aceitos: ${STATES.join(', ')}`);
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
  console.log(`mensagem registrada: ${flags.from}→${flags.to} [${flags.kind}] em repos/${repoSlug}/tasks/${taskName}/messages.jsonl`);
} else if (cmd === 'log') {
  const { flags, pos } = parseArgs(rest, ['level', 'source']);
  const [repoSlug, taskArg, body] = pos;
  if (!flags.level || !flags.source || body === undefined) {
    die('uso: node tools/bus.mjs log <repo> <task> --level L --source S "corpo" (corpo "-" lê stdin)');
  }
  if (!LEVELS.includes(flags.level)) die(`level inválido: "${flags.level}" — aceitos: ${LEVELS.join(', ')}`);
  const { taskDir, taskName } = resolveTask(repoSlug, taskArg);
  const ts = new Date().toISOString();
  let linhas;
  if (body === '-') {
    const stdin = fs.readFileSync(0, 'utf8');
    linhas = stdin.split('\n').filter((l, i, arr) => l !== '' || i < arr.length - 1);
    if (!linhas.length) die('stdin vazio — nada para registrar');
  } else {
    linhas = [body];
  }
  appendJsonl(
    path.join(taskDir, 'logs.jsonl'),
    linhas.map((l) => ({ ts, level: flags.level, source: flags.source, body: l }))
  );
  touchMeta(taskDir);
  console.log(`${linhas.length} registro(s) [${flags.level}] de ${flags.source} em repos/${repoSlug}/tasks/${taskName}/logs.jsonl`);
} else if (cmd === 'read') {
  const { flags, pos } = parseArgs(rest, ['kind', 'to', 'since', 'tail']);
  const [repoSlug, taskArg] = pos;
  const { taskDir, taskName } = resolveTask(repoSlug, taskArg);
  if (flags.kind && !KINDS.includes(flags.kind)) die(`kind inválido: "${flags.kind}" — aceitos: ${KINDS.join(', ')}`);
  const file = path.join(taskDir, 'messages.jsonl');
  if (!fs.existsSync(file)) {
    console.log(`(sem mensagens em repos/${repoSlug}/tasks/${taskName})`);
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
        die(`linha ${i + 1} de messages.jsonl não é JSON válido`);
      }
    });
  if (flags.kind) msgs = msgs.filter((m) => m.kind === flags.kind);
  if (flags.to) msgs = msgs.filter((m) => m.to === flags.to);
  if (flags.since) {
    const since = Date.parse(flags.since);
    if (Number.isNaN(since)) die(`--since não é data ISO válida: "${flags.since}"`);
    msgs = msgs.filter((m) => Date.parse(m.ts) >= since);
  }
  if (flags.tail) {
    const n = parseInt(flags.tail, 10);
    if (!Number.isInteger(n) || n <= 0) die(`--tail exige inteiro positivo: "${flags.tail}"`);
    msgs = msgs.slice(-n);
  }
  if (!msgs.length) {
    console.log('(nenhuma mensagem com esses filtros)');
    process.exit(0);
  }
  for (const m of msgs) {
    const hora = (m.ts ?? '').slice(11, 19) || m.ts;
    const corpo = String(m.body ?? '').split('\n').join('\n           ');
    const extra = m.meta ? `  ${JSON.stringify(m.meta)}` : '';
    console.log(`${hora}  ${m.from}→${m.to}  [${m.kind}]  ${corpo}${extra}`);
  }
} else if (cmd === 'agents') {
  // agents <repo> [<task>] — lê repos/<repo>/agents.json; <task> (opcional, nome
  // completo ou prefixo) só filtra a exibição pelos agentes cuja last_task é essa task.
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
    console.log(`(nenhum agente registrado em repos/${repoSlug}${filterTask ? ` com last_task ${filterTask}` : ''})`);
    process.exit(0);
  }
  for (const a of listados) {
    const role = a.role ? ` (${a.role})` : '';
    const lastTask = a.last_task ? `  última task ${a.last_task}` : '';
    console.log(`${a.name}${role} — ${a.status}  criado ${a.created}  ativo ${a.last_active}${lastTask}`);
  }
} else {
  die('uso: node tools/bus.mjs <post|log|read> <repo> <task> [...] | agents <repo> [<task>]');
}
