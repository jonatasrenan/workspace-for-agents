// Viewer do Workspace for Agents.
// Zero dependências: serve o frontend, expõe repos/tasks como JSON (incluindo
// mensagens, logs, custos de cada task e os agentes do repo), aceita respostas do humano
// via POST /api/bus e notifica mudanças de arquivo via SSE para o painel
// atualizar sozinho.
// Escuta só em loopback (127.0.0.1) por padrão — o painel e o POST /api/bus não
// ficam expostos à rede local. Override opcional via env: HOST=0.0.0.0 (ou outro
// endereço) e PORT=<porta>.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { TEMPLATE_BY_FILE } from '../tools/templates.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const REPOS_DIR = path.join(ROOT, 'repos');
const WORKSPACE_DIR = path.join(ROOT, 'workspace');
const GUARDRAILS_DIR = path.join(ROOT, 'guardrails');
const AGENTS_DIR = path.join(ROOT, '.claude', 'agents');
const PUBLIC_DIR = path.join(__dirname, 'public');
const PRICES_FILE = path.join(ROOT, 'tools', 'prices.json');
const SHARES_FILE = path.join(ROOT, '.shares.json');
const PORT = Number(process.env.PORT || 4500);
const HOST = process.env.HOST || '127.0.0.1';

// Este arquivo é servidor E módulo: o tools/share.mjs importa buildState() para
// montar o state da página compartilhada sem subir um segundo servidor. Só o uso
// direto (`node viewer/server.mjs`) escuta porta, observa arquivos e republica.
const IS_SERVER = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const MSG_KINDS = ['report', 'question', 'decision', 'approval', 'status'];

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readMeta(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  } catch {
    return {};
  }
}

function readIfExists(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

// .jsonl tolerante: arquivo ausente => []; linhas inválidas são ignoradas.
function readJsonl(p) {
  const raw = readIfExists(p);
  if (raw == null) return [];
  const out = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t);
      if (o && typeof o === 'object' && !Array.isArray(o)) out.push(o);
    } catch {}
  }
  return out;
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// stub: arquivo ainda igual ao template que o gerou (sem substância além do
// esqueleto). Fallback (cobre versões antigas de template e arquivos fora do
// padrão): só headings + linhas vazias/placeholder ("_(ainda não definido)_",
// "-", "|---|") = stub.
function isStub(name, content) {
  const tpl = TEMPLATE_BY_FILE[name];
  if (tpl != null && content.trim() === tpl.trim()) return true;
  for (const line of content.split('\n')) {
    const l = line.trim();
    if (!l || l === '-' || /^#{1,6}\s/.test(l)) continue;
    if (/^_?\(.*\)_?$/.test(l)) continue; // placeholder "(ainda não definido)"
    if (/^\|[\s|:-]*\|$/.test(l)) continue; // cabeçalho/divisor de tabela vazio
    return false;
  }
  return true;
}

// Mensagens kind question|decision endereçadas ao humano ainda sem resposta:
// heurística simples — nenhuma mensagem POSTERIOR com from="humano" na task.
function awaitingMessages(messages) {
  let lastHuman = -1;
  messages.forEach((m, i) => {
    if (m.from === 'humano') lastHuman = i;
  });
  return messages.filter((m, i) => i > lastHuman && m.to === 'humano' && (m.kind === 'question' || m.kind === 'decision'));
}

// Riscos aceitos da task (parse leve de 30-review.md, melhor esforço): bullets
// sob um heading contendo "Riscos aceitos" ou "Observações gerais" — até o
// próximo heading. Linhas "-" vazias (placeholder de template) são ignoradas.
function readAcceptedRisks(dir) {
  const raw = readIfExists(path.join(dir, '30-review.md'));
  if (raw == null) return [];
  const out = [];
  let inSec = false;
  for (const line of raw.split('\n')) {
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) {
      inSec = /riscos aceitos|observa[cç][oõ]es gerais/i.test(h[1]);
      continue;
    }
    if (!inSec) continue;
    const li = /^\s*[-*]\s+(\S.*)$/.exec(line);
    if (li) out.push(li[1].trim());
  }
  return out;
}

// --- tempo da task ---
// Início real da task = MENOR ts entre messages/logs/costs; fim = maior ts.
// meta.created/updated não servem de cronômetro (granularidade de dia), então
// task sem nenhum evento simplesmente não tem tempo (start: null).
function eventBounds(streams) {
  let first = null;
  let last = null;
  for (const s of streams) {
    for (const r of s) {
      const t = Date.parse(r?.ts);
      if (Number.isNaN(t)) continue;
      if (first === null || t < first) first = t;
      if (last === null || t > last) last = t;
    }
  }
  return { first, last };
}

// Tempo-alvo em minutos: meta.tempo_alvo_min tem precedência; senão, a partir da
// marca "Tempo-alvo" no 00-enunciado.md (heading "## Tempo-alvo" com o valor na
// linha seguinte, ou inline "**Tempo-alvo: 20 minutos.**") pega o PRIMEIRO número
// seguido de "min". A varredura para no próximo heading — números de marcos
// que vivem em outra seção não contaminam o alvo.
function readTargetMin(dir, meta) {
  const fromMeta = Number(meta?.tempo_alvo_min);
  if (Number.isFinite(fromMeta) && fromMeta > 0) return fromMeta;
  const raw = readIfExists(path.join(dir, '00-enunciado.md'));
  if (raw == null) return null;
  const lines = raw.split('\n');
  const i = lines.findIndex((l) => /tempo[\s-]*alvo/i.test(l));
  if (i < 0) return null;
  for (let j = i; j < Math.min(lines.length, i + 12); j++) {
    if (j > i && /^#{1,6}\s/.test(lines[j])) break;
    const m = /(\d+)\s*min/i.exec(lines[j]);
    if (m && Number(m[1]) > 0) return Number(m[1]);
  }
  return null;
}

// --- ping de saúde dos acessos (acessos.json) ---
// Cache em memória com TTL ~10s, atualizado FORA do ciclo da request: /api/state
// devolve o último resultado conhecido (up: true|false|null) e agenda a
// verificação em background quando o cache está velho — a resposta nunca espera
// o ping. Mudança de resultado dispara broadcast SSE para o painel atualizar o dot.
const PING_TTL = 10_000;
const PING_TIMEOUT = 1500;
const pingCache = new Map(); // url -> { up, at, inflight }

function schedulePing(url) {
  const c = pingCache.get(url) || {};
  if (c.inflight) return;
  c.inflight = true;
  pingCache.set(url, c);
  (async () => {
    let up = false;
    for (const method of ['HEAD', 'GET']) {
      try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), PING_TIMEOUT);
        const r = await fetch(url, { method, signal: ac.signal, redirect: 'manual' });
        clearTimeout(timer);
        r.body?.cancel?.().catch(() => {});
        up = true; // qualquer resposta HTTP conta como vivo (mesmo 4xx/5xx)
        break;
      } catch {} // erro de rede/timeout — tenta GET (servidores que rejeitam HEAD)
    }
    const cc = pingCache.get(url) || {};
    const changed = cc.at === undefined || cc.up !== up;
    cc.up = up;
    cc.at = Date.now();
    cc.inflight = false;
    pingCache.set(url, cc);
    if (changed) broadcastChange();
  })();
}

// anexa up (do cache) a cada acesso e agenda refresh dos vencidos
function withPing(acessos) {
  return acessos.map((a) => {
    const url = typeof a.url === 'string' && /^https?:\/\//i.test(a.url) ? a.url : null;
    let up = null;
    if (url) {
      const c = pingCache.get(url);
      if (c && c.at !== undefined) up = c.up;
      if (!c || c.at === undefined || Date.now() - c.at > PING_TTL) schedulePing(url);
    }
    return { ...a, up };
  });
}

// .claude/agents/<nome>.md → { nome: { description, resumo } }
// description vem do frontmatter YAML plano; resumo = primeiro parágrafo do corpo.
// Diretório/arquivo ausente ou sem frontmatter: tolerado (entrada some ou fica parcial).
function readAgentDefs() {
  const defs = {};
  let files = [];
  try {
    files = fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md'));
  } catch {
    return defs;
  }
  for (const f of files) {
    const raw = readIfExists(path.join(AGENTS_DIR, f));
    if (raw == null) continue;
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
    const fm = {};
    let body = raw;
    if (m) {
      body = m[2];
      for (const line of m[1].split('\n')) {
        const kv = /^([\w-]+):\s*(.*)$/.exec(line);
        if (kv) fm[kv[1]] = kv[2].trim();
      }
    }
    const name = fm.name || f.replace(/\.md$/, '');
    const resumo = body
      .split(/\n\s*\n/)
      .map((s) => s.trim())
      .find((s) => s && !s.startsWith('#'));
    defs[name] = { description: fm.description || '', resumo: resumo || '' };
  }
  return defs;
}

function sumTokens(costs) {
  const t = { in: 0, out: 0, total: 0 };
  for (const c of costs) {
    t.in += num(c.tokens_in);
    t.out += num(c.tokens_out);
    t.total += num(c.tokens_total) || num(c.tokens_in) + num(c.tokens_out);
  }
  return t;
}

// tools/prices.json (opcional): { "<modelo>": { "in": USD/1M in, "out": USD/1M out } | USD/1M total, "default": ... }
// Sem arquivo (ou sem preço para o modelo da linha) => sem estimativa para aquela linha.
function estimateUsd(costs, prices) {
  if (!prices || typeof prices !== 'object') return null;
  let usd = 0;
  let priced = false;
  for (const c of costs) {
    // Mesmo critério do costs.mjs: match exato, senão a chave mais longa contida
    // no nome do modelo, senão default; só total conhecido => média in/out.
    let p = c.modelo != null ? prices[c.modelo] : undefined;
    if (p == null && c.modelo != null) {
      const key = Object.keys(prices)
        .filter((k) => k !== 'default' && c.modelo.includes(k))
        .sort((a, b) => b.length - a.length)[0];
      if (key) p = prices[key];
    }
    p = p ?? prices.default;
    if (p == null) continue;
    priced = true;
    if (typeof p === 'number') {
      usd += ((num(c.tokens_total) || num(c.tokens_in) + num(c.tokens_out)) / 1e6) * p;
    } else {
      const tin = num(c.tokens_in);
      const tout = num(c.tokens_out);
      if (tin || tout) usd += (tin / 1e6) * num(p.in) + (tout / 1e6) * num(p.out);
      else usd += (num(c.tokens_total) / 1e6) * ((num(p.in) + num(p.out)) / 2 || num(p.out) || num(p.in));
    }
  }
  return priced ? usd : null;
}

// branch + último commit do workspace do repo (opcional — null se não houver git)
function gitInfo(wsDir) {
  try {
    if (!wsDir || !fs.existsSync(path.join(wsDir, '.git'))) return null;
    const opts = { cwd: wsDir, stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 };
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], opts).toString().trim();
    let lastCommit = null;
    try {
      lastCommit = execFileSync('git', ['log', '-1', '--format=%h %s'], opts).toString().trim();
    } catch {} // repo sem commits ainda
    return { branch, lastCommit };
  } catch {
    return null;
  }
}

// --- commits do workspace por task (aba Diff) ---
// Duas fontes, nesta ordem de precedência:
//   (a) registro explícito: repos/<repo>/tasks/<nn>/commits.jsonl (tools/commits.mjs);
//   (b) fallback temporal: commits do workspace cuja data (committer date) cai na
//       janela da task — retrocobre tasks que nunca registraram nada.
// Janela da task: [created, status concluida ? updated : agora]. meta.created/updated
// têm granularidade de dia ("YYYY-MM-DD"): created abre no INÍCIO do dia e updated
// fecha no FIM — senão uma task criada e concluída no mesmo dia teria janela nula.
// Task sem created não participa do fallback (só mostra o que registrou).
//
// REGRA DE ATRIBUIÇÃO (mesmo commit na janela de mais de uma task do repo):
//   1. commit registrado em alguma task pertence SÓ a ela — o registro explícito vence
//      a heurística e o commit some das janelas das demais;
//   2. senão, fica com a task de janela mais ESTREITA que o contém (a mais específica);
//   3. empate de largura (caso comum: duas tasks abertas no mesmo dia) → a primeira na
//      ordem das tasks (prefixo numérico), isto é, a mais antiga ainda em aberto.
const DIFF_MAX_LINES = 1500;
const GIT_TIMEOUT = 2000;
const commitCache = new Map(); // `${wsDir}\0${hash}` -> { hash, shortHash, msg, date, stat, diff, ... }
const COMMIT_CACHE_MAX = 800; // hash é imutável: nunca invalida, só limita o crescimento

function gitOut(wsDir, args) {
  return execFileSync('git', args, {
    cwd: wsDir,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: GIT_TIMEOUT,
    maxBuffer: 32 * 1024 * 1024,
    encoding: 'utf8',
  });
}

// "YYYY-MM-DD" (dia local) ou timestamp ISO completo; endOfDay só vale para o dia puro
function parseStamp(v, endOfDay) {
  if (typeof v !== 'string' || !v.trim()) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim());
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (endOfDay) d.setHours(23, 59, 59, 999);
    return d.getTime();
  }
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

// detalhe de um commit (metadados + stat + diff), memoizado por hash
function commitDetail(wsDir, hash) {
  const key = `${wsDir}\0${hash}`;
  if (commitCache.has(key)) return commitCache.get(key);
  let info = null;
  try {
    const meta = gitOut(wsDir, ['log', '-1', '--format=%H%x1f%ct%x1f%s', hash]).trim();
    const [full, ct, msg = ''] = meta.split('\x1f');
    if (!full) throw new Error('sem metadados');
    const stat = gitOut(wsDir, ['show', '--stat', '--format=', '--no-color', full]).replace(/\s+$/, '');
    const raw = gitOut(wsDir, ['show', '--format=', '--no-color', full]).replace(/\n$/, '');
    const lines = raw ? raw.split('\n') : [];
    const truncated = lines.length > DIFF_MAX_LINES;
    info = {
      hash: full,
      shortHash: full.slice(0, 7),
      msg,
      date: new Date(Number(ct) * 1000).toISOString(),
      stat,
      diff: truncated ? lines.slice(0, DIFF_MAX_LINES).join('\n') : raw,
      truncated,
      totalLines: lines.length,
    };
  } catch {
    info = null; // hash sumiu (rebase/clone raso) ou git demorou demais — task segue sem ele
  }
  if (commitCache.size >= COMMIT_CACHE_MAX) commitCache.delete(commitCache.keys().next().value);
  commitCache.set(key, info);
  return info;
}

// preenche task.commits (mais recente primeiro) em todas as tasks do repo
function attachCommits(tasks, wsDir) {
  for (const t of tasks) t.commits = [];
  if (!tasks.length || !wsDir || !fs.existsSync(path.join(wsDir, '.git'))) return;

  // (a) registrados — hash explícito vence qualquer janela
  const registered = new Map(); // hash -> [slug]
  for (const t of tasks) {
    for (const c of t._commitsJsonl || []) {
      if (typeof c.hash !== 'string' || !c.hash) continue;
      const list = registered.get(c.hash) || [];
      if (!list.includes(t.slug)) list.push(t.slug);
      registered.set(c.hash, list);
    }
  }

  // (b) janelas temporais
  const now = Date.now();
  const windows = new Map(); // slug -> { start, end }
  for (const t of tasks) {
    const start = parseStamp(t.meta?.created, false);
    if (start == null) continue; // sem created: não participa do fallback
    // task concluída fecha no fim do dia do updated, mas nunca depois de agora — senão
    // uma task concluída hoje teria janela mais LARGA que a irmã ainda aberta e roubaria
    // os commits dela na regra 2.
    const fim = t.status === 'concluida' ? parseStamp(t.meta?.updated, true) : null;
    const end = fim == null ? now : Math.min(fim, now);
    if (end < start) continue;
    windows.set(t.slug, { start, end });
  }
  const byTask = new Map(tasks.map((t) => [t.slug, []])); // slug -> [hash]
  if (windows.size) {
    const minStart = Math.min(...[...windows.values()].map((w) => w.start));
    const maxEnd = Math.max(...[...windows.values()].map((w) => w.end));
    let log = '';
    try {
      log = gitOut(wsDir, [
        'log',
        `--since=${new Date(minStart).toISOString()}`,
        `--until=${new Date(maxEnd).toISOString()}`,
        '--format=%H|%ct|%s',
      ]);
    } catch {} // workspace sem commits / sem git válido — fallback vira vazio
    for (const line of log.split('\n')) {
      if (!line.trim()) continue;
      const i = line.indexOf('|');
      const j = line.indexOf('|', i + 1);
      if (i < 0 || j < 0) continue;
      const hash = line.slice(0, i);
      const at = Number(line.slice(i + 1, j)) * 1000;
      if (registered.has(hash)) continue; // regra 1: registro explícito manda
      let best = null;
      for (const t of tasks) {
        const w = windows.get(t.slug);
        if (!w || at < w.start || at > w.end) continue;
        // regra 2/3: janela mais estreita; empate fica com a primeira task (ordem numérica)
        if (!best || w.end - w.start < best.w.end - best.w.start) best = { slug: t.slug, w };
      }
      if (best) byTask.get(best.slug).push(hash);
    }
  }
  for (const [hash, slugs] of registered) for (const s of slugs) byTask.get(s)?.push(hash);

  for (const t of tasks) {
    const seen = new Set();
    t.commits = (byTask.get(t.slug) || [])
      .filter((h) => (seen.has(h) ? false : seen.add(h))) // dedupe por hash
      .map((h) => commitDetail(wsDir, h))
      .filter(Boolean)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)); // mais recente primeiro
    delete t._commitsJsonl;
  }
}

function readTasks(repoDir, prices, wsDir) {
  const tasksDir = path.join(repoDir, 'tasks');
  if (!fs.existsSync(tasksDir)) return [];
  const tasks = fs
    .readdirSync(tasksDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort() // ordem = prefixo numérico <nn>-<slug>
    .map((name) => {
      const dir = path.join(tasksDir, name);
      const meta = readMeta(dir);
      let files = [];
      try {
        files = fs
          .readdirSync(dir)
          .filter((f) => f.endsWith('.md'))
          .sort()
          .map((f) => {
            const content = fs.readFileSync(path.join(dir, f), 'utf8');
            return { name: f, content, stub: isStub(f, content) };
          });
      } catch {}
      // painéis vivos: todos on-demand — ausência vira coleção vazia
      const messages = readJsonl(path.join(dir, 'messages.jsonl'));
      const logs = readJsonl(path.join(dir, 'logs.jsonl'));
      const costs = readJsonl(path.join(dir, 'costs.jsonl'));
      // agents.json no nível da task é legado (a fonte atual é repos/<repo>/agents.json);
      // mantido como fallback para dados antigos e retrocompatibilidade do /api/state
      const agentsJson = readJson(path.join(dir, 'agents.json'));
      const agents = Array.isArray(agentsJson?.agents) ? agentsJson.agents : [];
      // dag.json (opcional): null se ausente ou inválido (sem nodes[])
      const dagJson = readJson(path.join(dir, 'dag.json'));
      const dag =
        dagJson && Array.isArray(dagJson.nodes)
          ? { nodes: dagJson.nodes.filter((n) => n && typeof n === 'object' && !Array.isArray(n)) }
          : null;
      const tokens = sumTokens(costs);
      const usd = estimateUsd(costs, prices);
      const awaitingMsgs = awaitingMessages(messages).map((m) => ({ from: m.from, kind: m.kind, body: m.body }));
      // tempo da task: janela real dos eventos + tempo-alvo do enunciado. running =
      // task ainda não concluída com pelo menos um evento (o painel conta o decorrido).
      const status = meta.status || 'todo';
      const { first, last } = eventBounds([messages, logs, costs]);
      const timing = {
        start: first == null ? null : new Date(first).toISOString(),
        last: last == null ? null : new Date(last).toISOString(),
        targetMin: readTargetMin(dir, meta),
        running: first != null && status !== 'concluida',
      };
      return {
        slug: name,
        title: meta.title || name.replace(/^\d+-/, ''),
        status,
        meta,
        files,
        messages,
        logs,
        costs,
        agents,
        dag,
        timing,
        tokens,
        usd,
        awaiting: awaitingMsgs.length,
        awaitingMsgs,
        risks: readAcceptedRisks(dir),
        // commits.jsonl (tools/commits.mjs) — insumo do attachCommits, some do payload
        _commitsJsonl: readJsonl(path.join(dir, 'commits.jsonl')),
      };
    });
  // depends_on do meta.json: refs por nome de diretório da task ou prefixo ("01"),
  // resolvidas contra as tasks deste repo. Dep não-concluída => task bloqueada;
  // ref não resolvida não bloqueia (aparece marcada como missing).
  const resolveRef = (ref, self) =>
    [
      tasks.find((t) => t.slug === ref),
      tasks.find((t) => t.slug.startsWith(ref + '-')),
      tasks.find((t) => t.slug.startsWith(ref)),
    ].find((t) => t && t !== self);
  for (const t of tasks) {
    const raw = Array.isArray(t.meta.depends_on)
      ? t.meta.depends_on.filter((r) => typeof r === 'string' && r.trim())
      : [];
    t.depends_on = raw.map((ref) => {
      const dep = resolveRef(ref.trim(), t);
      return dep
        ? { slug: dep.slug, title: dep.title, status: dep.status }
        : { slug: ref, title: ref, status: null, missing: true };
    });
    t.blocked = t.depends_on.some((d) => !d.missing && d.status !== 'concluida');
  }
  attachCommits(tasks, wsDir); // aba Diff: registrados + fallback temporal, atribuídos entre as tasks
  return tasks;
}

function readRepos() {
  if (!fs.existsSync(REPOS_DIR)) return [];
  const prices = readJson(PRICES_FILE); // opcional — null se não existir/inválido
  return fs
    .readdirSync(REPOS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const dir = path.join(REPOS_DIR, d.name);
      const meta = readMeta(dir);
      const wsDir = meta.workspace ? path.resolve(ROOT, meta.workspace) : path.join(WORKSPACE_DIR, d.name);
      const tasks = readTasks(dir, prices, wsDir);
      // agents.json no nível do repo (formato { agents: [...] }, cada agente pode
      // trazer last_task = task em que trabalhou por último) — opcional, ausência vira []
      const agentsJson = readJson(path.join(dir, 'agents.json'));
      const agents = Array.isArray(agentsJson?.agents) ? agentsJson.agents : [];
      // estado.json / acessos.json (modelo push, escritos pelos agentes) — opcionais,
      // ausência/inválido vira null / []. Cada acesso ganha up: true|false|null do ping.
      const estadoJson = readJson(path.join(dir, 'estado.json'));
      const estado = estadoJson && typeof estadoJson === 'object' && !Array.isArray(estadoJson) ? estadoJson : null;
      const acessosJson = readJson(path.join(dir, 'acessos.json'));
      const acessos = withPing(
        (Array.isArray(acessosJson?.acessos) ? acessosJson.acessos : []).filter(
          (a) => a && typeof a === 'object' && !Array.isArray(a)
        )
      );
      const counts = { todo: 0, 'em-andamento': 0, concluida: 0 };
      for (const t of tasks) if (t.status in counts) counts[t.status]++;
      // progresso agregado do repo: tasks concluídas, nós de DAG e verificações (guardrails)
      const progress = {
        tasks: { done: counts.concluida, total: tasks.length },
        dag: { done: 0, total: 0 },
        gr: { pass: 0, falha: 0, aceito: 0, pendente: 0 },
      };
      for (const t of tasks) {
        for (const n of t.dag?.nodes || []) {
          progress.dag.total++;
          if (n.status === 'concluida') progress.dag.done++;
          for (const g of n.guardrails || []) {
            if (!g || typeof g !== 'object') continue;
            progress.gr[g.status in progress.gr ? g.status : 'pendente']++;
          }
        }
      }
      // agregados de tokens/custo/aguardando-humano do repo = soma das tasks
      const tokens = { in: 0, out: 0, total: 0 };
      let usd = null;
      let awaiting = 0;
      for (const t of tasks) {
        tokens.in += t.tokens.in;
        tokens.out += t.tokens.out;
        tokens.total += t.tokens.total;
        awaiting += t.awaiting;
        if (t.usd != null) usd = (usd ?? 0) + t.usd;
      }
      // mtime mais recente do repo (arquivos diretos + tasks) — para ordenar por atividade
      let mtime = 0;
      const scan = (p) => {
        try {
          for (const f of fs.readdirSync(p, { withFileTypes: true })) {
            const fp = path.join(p, f.name);
            if (f.isDirectory()) scan(fp);
            else mtime = Math.max(mtime, fs.statSync(fp).mtimeMs);
          }
        } catch {}
      };
      scan(dir);
      return {
        slug: d.name,
        title: meta.title || d.name,
        stack: meta.stack || [],
        status: meta.status,
        created: meta.created,
        updated: meta.updated,
        workspace: meta.workspace || `workspace/${d.name}`,
        git: gitInfo(wsDir),
        context: readIfExists(path.join(dir, '00-contexto.md')),
        agents,
        estado,
        acessos,
        progress,
        tasks,
        counts,
        tokens,
        usd,
        awaiting,
        mtime,
      };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

export function buildState() {
  const repos = readRepos();
  const totals = { tokens: { in: 0, out: 0, total: 0 }, usd: null, awaiting: 0 };
  for (const r of repos) {
    totals.tokens.in += r.tokens.in;
    totals.tokens.out += r.tokens.out;
    totals.tokens.total += r.tokens.total;
    totals.awaiting += r.awaiting;
    if (r.usd != null) totals.usd = (totals.usd ?? 0) + r.usd;
  }
  // guardrails/pool.json (opcional): resolve título/verificação dos guardrails da DAG
  const pool = readJson(path.join(GUARDRAILS_DIR, 'pool.json'));
  const guardrailPool = Array.isArray(pool?.guardrails) ? pool.guardrails : [];
  return { repos, totals, guardrailPool, agentDefs: readAgentDefs() };
}

// --- bus: resposta do humano vira linha em messages.jsonl da task ---
function handleBus(req, res) {
  let raw = '';
  req.on('data', (c) => {
    raw += c;
    if (raw.length > 1e6) req.destroy();
  });
  req.on('end', () => {
    let b;
    try {
      b = JSON.parse(raw);
    } catch {
      return json(res, 400, { error: 'body não é JSON válido' });
    }
    const { repo, task, from, to, kind, body } = b || {};
    if (typeof repo !== 'string' || !repo || /[/\\]|\.\./.test(repo)) return json(res, 400, { error: 'repo inválido' });
    if (typeof task !== 'string' || !task || /[/\\]|\.\./.test(task)) return json(res, 400, { error: 'task inválida' });
    if (from !== 'humano') return json(res, 400, { error: 'from deve ser "humano"' });
    if (typeof to !== 'string' || !to) return json(res, 400, { error: 'to é obrigatório' });
    if (!MSG_KINDS.includes(kind)) return json(res, 400, { error: `kind deve ser um de: ${MSG_KINDS.join(', ')}` });
    if (typeof body !== 'string' || !body.trim()) return json(res, 400, { error: 'body é obrigatório' });
    const dir = path.join(REPOS_DIR, repo, 'tasks', task);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return json(res, 400, { error: 'task não existe' });
    const msg = { ts: new Date().toISOString(), from: 'humano', to, kind, body };
    if (b.meta && typeof b.meta === 'object') msg.meta = b.meta;
    try {
      fs.appendFileSync(path.join(dir, 'messages.jsonl'), JSON.stringify(msg) + '\n');
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
    broadcastChange(); // reforço — o watcher de repos/ também dispara no append
    return json(res, 200, { ok: true });
  });
}

// --- SSE ---
const clients = new Set();
let debounce = null;
function sseWrite(payload) {
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res); // socket já morto — remove sem derrubar o server
    }
  }
}
function broadcastChange() {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    sseWrite(`data: ${JSON.stringify({ at: Date.now() })}\n\n`);
    scheduleRepublish(); // repos com share ativo saem atualizados sozinhos
  }, 150);
}

// --- auto-republish dos repos compartilhados (tools/share.mjs) ---
// Registro em .shares.json (raiz): { "shares": { "<repo>": { uuid, url, auto, custos } } }.
// Repo com auto !== false é re-publicado pelo próprio servidor quando muda — o
// agente nunca faz deploy manualmente. `share.mjs <repo> --off` pausa; `--delete` remove.
const publishState = new Map(); // slug -> { publishedAt, running, timer }

function activeShares() {
  const reg = readJson(SHARES_FILE);
  const shares = reg && typeof reg.shares === 'object' && !Array.isArray(reg.shares) ? reg.shares : {};
  return Object.keys(shares).filter((slug) => shares[slug] && shares[slug].auto !== false);
}

// mtime do que a página compartilhada mostra: metadados do repo (repos/<slug>) +
// o .git do workspace (commits novos mudam a aba Diff). Barato o bastante para
// rodar a cada rajada de mudança.
function shareMtime(slug) {
  let m = 0;
  const scan = (p) => {
    try {
      for (const f of fs.readdirSync(p, { withFileTypes: true })) {
        const fp = path.join(p, f.name);
        if (f.isDirectory()) scan(fp);
        else m = Math.max(m, fs.statSync(fp).mtimeMs);
      }
    } catch {}
  };
  scan(path.join(REPOS_DIR, slug));
  const meta = readMeta(path.join(REPOS_DIR, slug));
  const wsDir = meta.workspace ? path.resolve(ROOT, meta.workspace) : path.join(WORKSPACE_DIR, slug);
  try {
    m = Math.max(m, fs.statSync(path.join(wsDir, '.git')).mtimeMs);
  } catch {}
  return m;
}

function scheduleRepublish() {
  if (!IS_SERVER) return; // importado como módulo (share.mjs): nunca republica sozinho
  for (const slug of activeShares()) {
    const st = publishState.get(slug) ?? { publishedAt: 0, running: false, timer: null };
    publishState.set(slug, st);
    if (st.running || shareMtime(slug) <= st.publishedAt) continue;
    clearTimeout(st.timer);
    st.timer = setTimeout(() => {
      st.running = true;
      const at = shareMtime(slug);
      const child = spawn('node', [path.join(ROOT, 'tools', 'share.mjs'), slug, '--quiet'], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let errBuf = '';
      child.stderr.on('data', (d) => (errBuf += d));
      child.on('exit', (code) => {
        st.running = false;
        if (code === 0) {
          st.publishedAt = at;
          console.log(`↻ share republicado: ${slug}`);
        } else console.log(`⚠ share falhou (${code}): ${slug} — ${errBuf.trim().split('\n').pop() ?? 'sem stderr'}`);
        scheduleRepublish(); // pega mudanças ocorridas durante o publish
      });
    }, 5000); // debounce: espera a rajada de writes do agente assentar
  }
}
// Heartbeat: comentário SSE a cada 15s. Sem tráfego, um socket morto (sleep da
// máquina, server trocado) fica "aberto" indefinidamente dos dois lados — o
// navegador nunca dispara onerror e perde broadcasts para sempre. Com o
// heartbeat o TCP detecta a morte, o EventSource reconecta e o onopen do
// frontend re-sincroniza o estado.
if (IS_SERVER) setInterval(() => sseWrite(':hb\n\n'), 15000).unref();

// repos/ e workspace/ são criados por outros processos — o viewer não cria nada.
// Enquanto o diretório não existir, tenta anexar o watcher a cada 2s.
function watchWhenReady(dir) {
  const attach = () => {
    if (!fs.existsSync(dir)) return false;
    try {
      fs.watch(dir, { recursive: true }, broadcastChange);
      broadcastChange(); // diretório acabou de aparecer — painel recarrega
      return true;
    } catch {
      return false;
    }
  };
  if (attach()) return;
  const timer = setInterval(() => {
    if (attach()) clearInterval(timer);
  }, 2000);
}
if (IS_SERVER) {
  watchWhenReady(REPOS_DIR);
  watchWhenReady(WORKSPACE_DIR);
  watchWhenReady(GUARDRAILS_DIR);
  watchWhenReady(AGENTS_DIR);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/api/health') return json(res, 200, { ok: true });
  if (url.pathname === '/api/state') return json(res, 200, buildState());
  if (url.pathname === '/api/bus' && req.method === 'POST') return handleBus(req, res);
  if (url.pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 1000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  // estáticos
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.join(PUBLIC_DIR, path.normalize(file));
  if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    return res.end('404');
  }
  // no-cache: o navegador revalida a cada load — mudança em app.js/style.css
  // vale no próximo refresh, sem hard-refresh
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(filePath).pipe(res);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`porta ${PORT} já em uso — o viewer provavelmente já está rodando em http://localhost:${PORT}`);
    process.exit(0);
  }
  throw err;
});

if (IS_SERVER) {
  server.listen(PORT, HOST, () => {
    console.log(`viewer em http://localhost:${PORT} (bind: ${HOST})`);
    scheduleRepublish(); // repo compartilhado nasce atualizado quando o viewer sobe
  });
}
