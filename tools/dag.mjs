// DAG de subtarefas de uma task, com guardrails anexados do pool (guardrails/pool.json).
// Um nó só pode ser concluído com todos os guardrails resolvidos (pass ou aceito) — gate.
// Uso:
//   node tools/dag.mjs set <repo> <task>                    (lê o JSON completo da DAG da stdin)
//   node tools/dag.mjs node-status <repo> <task> <nodeId> <todo|executando|concluida|bloqueada> [--force]
//   node tools/dag.mjs guardrail <repo> <task> <nodeId> <guardrailId> <pass|falha|pendente> [--nota "..."]
//   node tools/dag.mjs guardrail <repo> <task> <nodeId> <guardrailId> aceito --aceitar "motivo"
//   node tools/dag.mjs show <repo> <task>
//   node tools/dag.mjs pool [--tag <tag>] [--categoria <cat>]
//   node tools/dag.mjs validate <repo> <task>
// <task> aceita o nome completo do diretório OU só o prefixo numérico ("01").
// Formato de dag.json (gravado em repos/<repo>/tasks/<task>/):
//   {"nodes":[{"id","titulo","status","agente"?,"depends_on":["<id>"],"tags":["k8s"],
//              "guardrails":[{"id":"<pool-id>","status":"pendente|pass|falha|aceito","nota"?}]}]}
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson, updateJson } from './jsonfile.mjs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
        if (i + 1 >= argv.length) die(`--${name} exige um valor`);
        flags[name] = argv[++i];
      } else {
        const aceitas = [...valueFlags, ...boolFlags].map((f) => `--${f}`).join(', ') || '(nenhuma)';
        die(`flag desconhecida: --${name} (aceitas: ${aceitas})`);
      }
    } else {
      pos.push(a);
    }
  }
  return { flags, pos };
}

// Resolve <repo> e <task> (nome completo ou prefixo "01") com erros que listam as opções.
function resolveTask(repoSlug, taskArg) {
  if (!repoSlug || !taskArg) die('faltam argumentos: <repo> <task>');
  const reposDir = path.join(ROOT, 'repos');
  const repoDir = path.join(reposDir, repoSlug);
  if (!fs.existsSync(path.join(repoDir, 'meta.json'))) {
    const existentes = fs.existsSync(reposDir) ? fs.readdirSync(reposDir).filter((d) => !d.startsWith('.')) : [];
    die(`repo não encontrado: ${repoSlug}${existentes.length ? ` — existentes: ${existentes.join(', ')}` : ' — nenhum repo criado ainda (use new-repo.mjs)'}`);
  }
  const tasksDir = path.join(repoDir, 'tasks');
  const tasks = fs.existsSync(tasksDir) ? fs.readdirSync(tasksDir).filter((d) => /^\d{2}-/.test(d)).sort() : [];
  const prefixo = /^\d+$/.test(taskArg) ? taskArg.padStart(2, '0') : null;
  const match = tasks.find((d) => d === taskArg) ?? (prefixo && tasks.find((d) => d.startsWith(`${prefixo}-`)));
  if (!match) {
    die(`task não encontrada: "${taskArg}" em repos/${repoSlug}/tasks${tasks.length ? ` — existentes: ${tasks.join(', ')}` : ' — nenhuma task criada ainda (use new-task.mjs)'}`);
  }
  return { taskDir: path.join(tasksDir, match), taskName: match, repoSlug };
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

function loadPool() {
  const file = path.join(ROOT, 'guardrails', 'pool.json');
  if (!fs.existsSync(file)) die('pool de guardrails não encontrado: guardrails/pool.json');
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    die(`guardrails/pool.json não é JSON válido: ${e.message}`);
  }
  if (!Array.isArray(data.guardrails)) die('guardrails/pool.json sem lista "guardrails"');
  return data.guardrails;
}

function loadDag(taskDir, taskName, repoSlug) {
  const file = path.join(taskDir, 'dag.json');
  if (!fs.existsSync(file)) die(`dag.json não existe em repos/${repoSlug}/tasks/${taskName} — crie com: node tools/dag.mjs set ${repoSlug} ${taskName} < dag.json`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    die(`dag.json não é JSON válido: ${e.message}`);
  }
}

function saveDag(taskDir, dag) {
  writeJson(path.join(taskDir, 'dag.json'), dag);
  touchMeta(taskDir);
}

// Mutação de um dag.json já existente: o ciclo ler→alterar→gravar acontece dentro
// de um lock, para que dois agentes marcando nós/guardrails em paralelo não
// sobrescrevam o veredito um do outro.
function mutateDag(taskDir, taskName, repoSlug, fn) {
  const file = path.join(taskDir, 'dag.json');
  if (!fs.existsSync(file)) die(`dag.json não existe em repos/${repoSlug}/tasks/${taskName} — crie com: node tools/dag.mjs set ${repoSlug} ${taskName} < dag.json`);
  return updateJson(file, null, (dag) => {
    if (!dag) die(`dag.json de repos/${repoSlug}/tasks/${taskName} não é JSON válido`);
    fn(dag);
    return dag;
  });
}

// Ordem topológica (Kahn) estável pela ordem de entrada; retorna null se houver ciclo.
function topoOrder(nodes) {
  const ids = nodes.map((n) => n.id);
  const restantes = new Map(nodes.map((n) => [n.id, new Set((n.depends_on ?? []).filter((d) => ids.includes(d)))]));
  const ordem = [];
  while (ordem.length < nodes.length) {
    const prontos = nodes.filter((n) => restantes.has(n.id) && restantes.get(n.id).size === 0);
    if (!prontos.length) return null; // ciclo
    for (const n of prontos) {
      ordem.push(n);
      restantes.delete(n.id);
      for (const deps of restantes.values()) deps.delete(n.id);
    }
  }
  return ordem;
}

// Valida a DAG contra o pool. Normaliza defaults (status de guardrail "pendente") in place.
// Retorna a lista de TODOS os erros encontrados (vazia se ok).
function validateDag(dag, pool) {
  const erros = [];
  if (!dag || typeof dag !== 'object' || Array.isArray(dag)) return ['raiz deve ser um objeto {"nodes":[...]}'];
  if (!Array.isArray(dag.nodes)) return ['campo "nodes" ausente ou não é lista'];
  if (!dag.nodes.length) erros.push('DAG vazia: "nodes" sem nenhum nó');
  const poolIds = new Set(pool.map((g) => g.id));
  const vistos = new Set();
  for (const [i, n] of dag.nodes.entries()) {
    const ref = typeof n?.id === 'string' && n.id ? `nó "${n.id}"` : `nó #${i + 1}`;
    if (!n || typeof n !== 'object') {
      erros.push(`${ref}: não é um objeto`);
      continue;
    }
    if (typeof n.id !== 'string' || !n.id) erros.push(`${ref}: "id" ausente ou vazio`);
    else if (vistos.has(n.id)) erros.push(`${ref}: id duplicado`);
    else vistos.add(n.id);
    if (typeof n.titulo !== 'string' || !n.titulo) erros.push(`${ref}: "titulo" ausente ou vazio`);
    if (n.status === undefined) n.status = 'todo';
    if (!NODE_STATUS.includes(n.status)) erros.push(`${ref}: status inválido "${n.status}" — aceitos: ${NODE_STATUS.join(', ')}`);
    if (n.agente !== undefined && typeof n.agente !== 'string') erros.push(`${ref}: "agente" deve ser string`);
    if (n.depends_on === undefined) n.depends_on = [];
    if (!Array.isArray(n.depends_on)) erros.push(`${ref}: "depends_on" deve ser lista de ids`);
    if (n.tags === undefined) n.tags = [];
    if (!Array.isArray(n.tags) || n.tags.some((t) => typeof t !== 'string')) erros.push(`${ref}: "tags" deve ser lista de strings`);
    if (n.guardrails === undefined) n.guardrails = [];
    if (!Array.isArray(n.guardrails)) {
      erros.push(`${ref}: "guardrails" deve ser lista`);
      n.guardrails = [];
    }
    for (const g of n.guardrails) {
      if (!g || typeof g !== 'object' || typeof g.id !== 'string' || !g.id) {
        erros.push(`${ref}: guardrail sem "id"`);
        continue;
      }
      if (!poolIds.has(g.id)) erros.push(`${ref}: guardrail "${g.id}" não existe no pool (veja: node tools/dag.mjs pool)`);
      if (g.status === undefined) g.status = 'pendente';
      if (!GR_STATUS.includes(g.status)) erros.push(`${ref}: guardrail "${g.id}" com status inválido "${g.status}" — aceitos: ${GR_STATUS.join(', ')}`);
    }
  }
  const ids = new Set(dag.nodes.map((n) => n.id).filter((id) => typeof id === 'string' && id));
  for (const n of dag.nodes) {
    if (!Array.isArray(n.depends_on)) continue;
    for (const d of n.depends_on) {
      if (!ids.has(d)) erros.push(`nó "${n.id}": depends_on "${d}" não existe na DAG`);
      if (d === n.id) erros.push(`nó "${n.id}": depende de si mesmo`);
    }
  }
  if (!erros.length && topoOrder(dag.nodes) === null) {
    erros.push(`ciclo detectado em depends_on — nenhuma ordem topológica possível (nós: ${dag.nodes.map((n) => n.id).join(', ')})`);
  }
  return erros;
}

function findNode(dag, nodeId) {
  const node = dag.nodes.find((n) => n.id === nodeId);
  if (!node) die(`nó não encontrado: "${nodeId}" — existentes: ${dag.nodes.map((n) => n.id).join(', ')}`);
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
  if (!stdin.trim()) die('stdin vazio — envie o JSON completo da DAG (ex.: node tools/dag.mjs set <repo> <task> < dag.json)');
  let dag;
  try {
    dag = JSON.parse(stdin);
  } catch (e) {
    die(`stdin não é JSON válido: ${e.message}`);
  }
  const pool = loadPool();
  const erros = validateDag(dag, pool);
  if (erros.length) die(`DAG inválida (${erros.length} erro${erros.length > 1 ? 's' : ''}):\n${erros.map((e) => `  - ${e}`).join('\n')}`);
  // `set` substitui a DAG inteira. Se havia progresso, diga o que foi descartado:
  // replanejar no meio da task é legítimo, perder vereditos em silêncio não.
  const anterior = fs.existsSync(path.join(taskDir, 'dag.json')) ? readJson(path.join(taskDir, 'dag.json'), null) : null;
  if (anterior?.nodes?.length) {
    const c = grCounts(anterior.nodes);
    const concluidos = anterior.nodes.filter((n) => n.status === 'concluida').length;
    const resolvidos = c.pass + c.falha + c.aceito;
    if (concluidos || resolvidos) {
      console.error(`aviso: a DAG anterior tinha ${concluidos} nó(s) concluído(s) e ${resolvidos} guardrail(s) com veredito — status e vereditos foram substituídos pelo JSON enviado.`);
    }
  }
  saveDag(taskDir, dag);
  const c = grCounts(dag.nodes);
  console.log(`DAG gravada: ${dag.nodes.length} nós, ${c.pass + c.falha + c.pendente + c.aceito} guardrails em repos/${repoSlug}/tasks/${taskName}/dag.json`);
} else if (cmd === 'node-status') {
  const { flags, pos } = parseArgs(rest, [], ['force']);
  const [repoSlug, taskArg, nodeId, status] = pos;
  if (!nodeId || !status) die('uso: node tools/dag.mjs node-status <repo> <task> <nodeId> <todo|executando|concluida|bloqueada> [--force]');
  if (!NODE_STATUS.includes(status)) die(`status inválido: "${status}" — aceitos: ${NODE_STATUS.join(', ')}`);
  const { taskDir, taskName } = resolveTask(repoSlug, taskArg);
  mutateDag(taskDir, taskName, repoSlug, (dag) => {
  const node = findNode(dag, nodeId);
  if (status === 'executando' || status === 'concluida') {
    const pendentes = (node.depends_on ?? []).filter((d) => dag.nodes.find((n) => n.id === d)?.status !== 'concluida');
    if (pendentes.length && !flags.force) {
      die(`recusado: dependências não concluídas de "${nodeId}": ${pendentes.join(', ')} — conclua-as primeiro ou use --force para exceção consciente`);
    }
  }
  if (status === 'concluida') {
    const abertos = (node.guardrails ?? []).filter((g) => g.status === 'pendente' || g.status === 'falha');
    if (abertos.length) {
      die(
        `recusado: nó "${nodeId}" tem ${abertos.length} guardrail(s) não resolvido(s):\n` +
          abertos.map((g) => `  - ${g.id} [${g.status}]`).join('\n') +
          `\nresolva com: node tools/dag.mjs guardrail ${repoSlug} ${taskName} ${nodeId} <id> pass | aceito --aceitar "motivo"`
      );
    }
  }
  node.status = status;
  });
  touchMeta(taskDir);
  // Historiza a transição no bus da task (mesma linha de messages.jsonl que o
  // tools/bus.mjs escreve): a linha do tempo do painel monta o histórico da DAG a
  // partir dessas mensagens — dag.json sozinho só guarda o estado atual.
  fs.appendFileSync(
    path.join(taskDir, 'messages.jsonl'),
    JSON.stringify({
      ts: new Date().toISOString(),
      from: 'dag',
      to: 'sala',
      kind: 'status',
      body: `nó ${nodeId} → ${status}`,
      meta: { node: nodeId, para: status },
    }) + '\n'
  );
  console.log(`nó "${nodeId}" → ${status}${flags.force ? ' (--force)' : ''} em repos/${repoSlug}/tasks/${taskName}/dag.json`);
} else if (cmd === 'guardrail') {
  const { flags, pos } = parseArgs(rest, ['nota', 'aceitar']);
  const [repoSlug, taskArg, nodeId, guardrailId, status] = pos;
  if (!nodeId || !guardrailId || !status) {
    die('uso: node tools/dag.mjs guardrail <repo> <task> <nodeId> <guardrailId> <pass|falha|pendente> [--nota "..."]\n     node tools/dag.mjs guardrail <repo> <task> <nodeId> <guardrailId> aceito --aceitar "motivo"');
  }
  if (!GR_STATUS.includes(status)) die(`status inválido: "${status}" — aceitos: ${GR_STATUS.join(', ')}`);
  if (status === 'aceito' && !flags.aceitar) die('status "aceito" exige --aceitar "motivo" — o motivo fica registrado na nota do guardrail');
  if (status !== 'aceito' && flags.aceitar) die('--aceitar só vale com status "aceito"');
  const { taskDir, taskName } = resolveTask(repoSlug, taskArg);
  let nota = '';
  mutateDag(taskDir, taskName, repoSlug, (dag) => {
  const node = findNode(dag, nodeId);
  const gr = (node.guardrails ?? []).find((g) => g.id === guardrailId);
  if (!gr) {
    const ids = (node.guardrails ?? []).map((g) => g.id);
    die(`guardrail "${guardrailId}" não está anexado ao nó "${nodeId}"${ids.length ? ` — anexados: ${ids.join(', ')}` : ' — nó sem guardrails'}`);
  }
  gr.status = status;
  // A nota pertence ao veredito atual: um novo veredito sem nota não pode herdar
  // a justificativa do anterior (um "pass" exibindo "aceito: sem tempo" mente).
  if (status === 'aceito') gr.nota = `aceito: ${flags.aceitar}`;
  else if (flags.nota !== undefined) gr.nota = flags.nota;
  else delete gr.nota;
  nota = gr.nota ?? '';
  });
  touchMeta(taskDir);
  console.log(`guardrail "${guardrailId}" do nó "${nodeId}" → ${status}${nota ? ` (${nota})` : ''}`);
} else if (cmd === 'show') {
  const { pos } = parseArgs(rest, []);
  const [repoSlug, taskArg] = pos;
  const { taskDir, taskName } = resolveTask(repoSlug, taskArg);
  const dag = loadDag(taskDir, taskName, repoSlug);
  if (!Array.isArray(dag.nodes) || !dag.nodes.length) {
    console.log(`(DAG vazia em repos/${repoSlug}/tasks/${taskName})`);
    process.exit(0);
  }
  const ordem = topoOrder(dag.nodes);
  if (ordem === null) console.log('AVISO: ciclo em depends_on — exibindo na ordem do arquivo (rode validate)');
  console.log(`DAG de repos/${repoSlug}/tasks/${taskName} (ordem topológica):\n`);
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
  console.log(`\n${concluidos}/${dag.nodes.length} nós concluídos — guardrails: ${c.pass} pass / ${c.falha} falha / ${c.pendente} pendentes / ${c.aceito} aceitos`);
} else if (cmd === 'pool') {
  const { flags } = parseArgs(rest, ['tag', 'categoria']);
  let pool = loadPool();
  if (flags.categoria) pool = pool.filter((g) => g.categoria === flags.categoria);
  if (flags.tag) pool = pool.filter((g) => (g.aplica_a ?? []).includes(flags.tag));
  if (!pool.length) {
    const filtro = [flags.categoria && `categoria=${flags.categoria}`, flags.tag && `tag=${flags.tag}`].filter(Boolean).join(', ');
    console.log(`(nenhum guardrail no pool${filtro ? ` com ${filtro}` : ''})`);
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
  if (erros.length) die(`dag.json inválido (${erros.length} erro${erros.length > 1 ? 's' : ''}):\n${erros.map((e) => `  - ${e}`).join('\n')}`);
  const c = grCounts(dag.nodes);
  console.log(`ok: DAG válida — ${dag.nodes.length} nós, guardrails: ${c.pass} pass / ${c.falha} falha / ${c.pendente} pendentes / ${c.aceito} aceitos`);
} else {
  die('uso: node tools/dag.mjs <set|node-status|guardrail|show|pool|validate> [...]  (cabeçalho do arquivo documenta cada subcomando)');
}
