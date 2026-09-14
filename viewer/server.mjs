// Workspace for Agents viewer.
// Zero dependencies: serves the frontend, exposes repos/tasks as JSON (including
// messages, logs, costs of each task and the repo's agents), accepts human replies
// via POST /api/bus and notifies file changes via SSE so the panel
// updates itself.
// Listens only on loopback (127.0.0.1) by default — the panel and the POST /api/bus
// are not exposed to the local network. Optional override via env: HOST=0.0.0.0 (or
// another address) and PORT=<port>.
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

// This file is both server AND module: tools/share.mjs imports buildState() to
// build the shared page's state without spinning up a second server. Only direct
// use (`node viewer/server.mjs`) listens on a port, watches files and republishes.
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

// tolerant .jsonl: missing file => []; invalid lines are ignored.
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

// stub: file still identical to the template that generated it (no substance beyond
// the skeleton). Fallback (covers older template versions and out-of-pattern files):
// only headings + empty/placeholder lines ("_(not yet defined)_",
// "-", "|---|") = stub.
function isStub(name, content) {
  const tpl = TEMPLATE_BY_FILE[name];
  if (tpl != null && content.trim() === tpl.trim()) return true;
  for (const line of content.split('\n')) {
    const l = line.trim();
    if (!l || l === '-' || /^#{1,6}\s/.test(l)) continue;
    if (/^_?\(.*\)_?$/.test(l)) continue; // placeholder "(not yet defined)"
    if (/^\|[\s|:-]*\|$/.test(l)) continue; // empty table header/divider
    return false;
  }
  return true;
}

// question|decision kind messages addressed to the human still unanswered:
// simple heuristic — no LATER message with from="humano" in the task.
function awaitingMessages(messages) {
  let lastHuman = -1;
  messages.forEach((m, i) => {
    if (m.from === 'humano') lastHuman = i;
  });
  return messages.filter((m, i) => i > lastHuman && m.to === 'humano' && (m.kind === 'question' || m.kind === 'decision'));
}

// Accepted risks of the task (light parse of 30-review.md, best effort): bullets
// under a heading containing "accepted risks" or "general notes"/"general
// observations" — up to the next heading. Empty "-" lines (template placeholder)
// are ignored.
function readAcceptedRisks(dir) {
  const raw = readIfExists(path.join(dir, '30-review.md'));
  if (raw == null) return [];
  const out = [];
  let inSec = false;
  for (const line of raw.split('\n')) {
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) {
      inSec = /accepted risks|general (notes|observations)/i.test(h[1]);
      continue;
    }
    if (!inSec) continue;
    const li = /^\s*[-*]\s+(\S.*)$/.exec(line);
    if (li) out.push(li[1].trim());
  }
  return out;
}

// --- task timing ---
// Real task start = SMALLEST ts among messages/logs/costs; end = largest ts.
// meta.created/updated don't work as a stopwatch (day granularity), so a
// task with no events at all simply has no timing (start: null).
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

// Target time in minutes: meta.tempo_alvo_min takes precedence; otherwise, starting
// from the "Tempo-alvo" marker in 00-enunciado.md (heading "## Tempo-alvo" with the
// value on the next line, or inline "**Tempo-alvo: 20 minutos.**") takes the FIRST
// number followed by "min". The scan stops at the next heading — numbers from
// milestones living in another section don't contaminate the target.
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

// --- access health ping (acessos.json) ---
// In-memory cache with ~10s TTL, updated OUTSIDE the request cycle: /api/state
// returns the last known result (up: true|false|null) and schedules the
// background check when the cache is stale — the response never waits on
// the ping. A result change triggers an SSE broadcast so the panel updates the dot.
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
        up = true; // any HTTP response counts as alive (even 4xx/5xx)
        break;
      } catch {} // network/timeout error — try GET (servers that reject HEAD)
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

// attaches up (from cache) to each access entry and schedules a refresh for stale ones
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

// .claude/agents/<name>.md → { name: { description, resumo } }
// description comes from the plain YAML frontmatter; resumo = first paragraph of the body.
// Missing directory/file or no frontmatter: tolerated (entry disappears or stays partial).
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

// tools/prices.json (optional): { "<model>": { "in": USD/1M in, "out": USD/1M out } | USD/1M total, "default": ... }
// No file (or no price for the line's model) => no estimate for that line.
function estimateUsd(costs, prices) {
  if (!prices || typeof prices !== 'object') return null;
  let usd = 0;
  let priced = false;
  for (const c of costs) {
    // Same criteria as costs.mjs: exact match, otherwise the longest key contained
    // in the model name, otherwise default; only known total => in/out average.
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

// branch + last commit of the repo's workspace (optional — null if no git)
function gitInfo(wsDir) {
  try {
    if (!wsDir || !fs.existsSync(path.join(wsDir, '.git'))) return null;
    const opts = { cwd: wsDir, stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 };
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], opts).toString().trim();
    let lastCommit = null;
    try {
      lastCommit = execFileSync('git', ['log', '-1', '--format=%h %s'], opts).toString().trim();
    } catch {} // repo with no commits yet
    return { branch, lastCommit };
  } catch {
    return null;
  }
}

// --- workspace commits per task (Diff tab) ---
// Two sources, in this precedence order:
//   (a) explicit record: repos/<repo>/tasks/<nn>/commits.jsonl (tools/commits.mjs);
//   (b) temporal fallback: workspace commits whose date (committer date) falls in the
//       task's window — backfills tasks that never registered anything.
// Task window: [created, status concluida ? updated : now]. meta.created/updated
// have day granularity ("YYYY-MM-DD"): created opens at the START of the day and updated
// closes at the END — otherwise a task created and completed on the same day would have a null window.
// A task with no created does not participate in the fallback (only shows what it registered).
//
// ATTRIBUTION RULE (same commit in the window of more than one task in the repo):
//   1. a commit registered in some task belongs ONLY to it — the explicit record wins over
//      the heuristic and the commit disappears from the other tasks' windows;
//   2. otherwise, it goes to the task with the NARROWEST window that contains it (the most specific);
//   3. tie in width (common case: two tasks opened on the same day) → the first in the
//      task order (numeric prefix), i.e. the oldest still open.
const DIFF_MAX_LINES = 1500;
const GIT_TIMEOUT = 2000;
const commitCache = new Map(); // `${wsDir}\0${hash}` -> { hash, shortHash, msg, date, stat, diff, ... }
const COMMIT_CACHE_MAX = 800; // hash is immutable: never invalidated, only bounds growth

function gitOut(wsDir, args) {
  return execFileSync('git', args, {
    cwd: wsDir,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: GIT_TIMEOUT,
    maxBuffer: 32 * 1024 * 1024,
    encoding: 'utf8',
  });
}

// "YYYY-MM-DD" (local day) or a full ISO timestamp; endOfDay only applies to the plain day
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

// commit detail (metadata + stat + diff), memoized by hash
function commitDetail(wsDir, hash) {
  const key = `${wsDir}\0${hash}`;
  if (commitCache.has(key)) return commitCache.get(key);
  let info = null;
  try {
    const meta = gitOut(wsDir, ['log', '-1', '--format=%H%x1f%ct%x1f%s', hash]).trim();
    const [full, ct, msg = ''] = meta.split('\x1f');
    if (!full) throw new Error('no metadata');
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
    info = null; // hash disappeared (rebase/shallow clone) or git took too long — task carries on without it
  }
  if (commitCache.size >= COMMIT_CACHE_MAX) commitCache.delete(commitCache.keys().next().value);
  commitCache.set(key, info);
  return info;
}

// fills task.commits (most recent first) in all tasks of the repo
function attachCommits(tasks, wsDir) {
  for (const t of tasks) t.commits = [];
  if (!tasks.length || !wsDir || !fs.existsSync(path.join(wsDir, '.git'))) return;

  // (a) registered — explicit hash wins over any window
  const registered = new Map(); // hash -> [slug]
  for (const t of tasks) {
    for (const c of t._commitsJsonl || []) {
      if (typeof c.hash !== 'string' || !c.hash) continue;
      const list = registered.get(c.hash) || [];
      if (!list.includes(t.slug)) list.push(t.slug);
      registered.set(c.hash, list);
    }
  }

  // (b) temporal windows
  const now = Date.now();
  const windows = new Map(); // slug -> { start, end }
  for (const t of tasks) {
    const start = parseStamp(t.meta?.created, false);
    if (start == null) continue; // no created: doesn't participate in the fallback
    // a completed task closes at the end of the updated day, but never after now — otherwise
    // a task completed today would have a WIDER window than its still-open sibling and steal
    // its commits under rule 2.
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
    } catch {} // workspace with no commits / no valid git — fallback ends up empty
    for (const line of log.split('\n')) {
      if (!line.trim()) continue;
      const i = line.indexOf('|');
      const j = line.indexOf('|', i + 1);
      if (i < 0 || j < 0) continue;
      const hash = line.slice(0, i);
      const at = Number(line.slice(i + 1, j)) * 1000;
      if (registered.has(hash)) continue; // rule 1: explicit record wins
      let best = null;
      for (const t of tasks) {
        const w = windows.get(t.slug);
        if (!w || at < w.start || at > w.end) continue;
        // rule 2/3: narrowest window; tie goes to the first task (numeric order)
        if (!best || w.end - w.start < best.w.end - best.w.start) best = { slug: t.slug, w };
      }
      if (best) byTask.get(best.slug).push(hash);
    }
  }
  for (const [hash, slugs] of registered) for (const s of slugs) byTask.get(s)?.push(hash);

  for (const t of tasks) {
    const seen = new Set();
    t.commits = (byTask.get(t.slug) || [])
      .filter((h) => (seen.has(h) ? false : seen.add(h))) // dedupe by hash
      .map((h) => commitDetail(wsDir, h))
      .filter(Boolean)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)); // most recent first
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
    .sort() // order = numeric prefix <nn>-<slug>
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
      // live panels: all on-demand — absence becomes an empty collection
      const messages = readJsonl(path.join(dir, 'messages.jsonl'));
      const logs = readJsonl(path.join(dir, 'logs.jsonl'));
      const costs = readJsonl(path.join(dir, 'costs.jsonl'));
      // agents.json at the task level is legacy (the current source is repos/<repo>/agents.json);
      // kept as a fallback for old data and /api/state backward compatibility
      const agentsJson = readJson(path.join(dir, 'agents.json'));
      const agents = Array.isArray(agentsJson?.agents) ? agentsJson.agents : [];
      // dag.json (optional): null if missing or invalid (no nodes[])
      const dagJson = readJson(path.join(dir, 'dag.json'));
      const dag =
        dagJson && Array.isArray(dagJson.nodes)
          ? { nodes: dagJson.nodes.filter((n) => n && typeof n === 'object' && !Array.isArray(n)) }
          : null;
      const tokens = sumTokens(costs);
      const usd = estimateUsd(costs, prices);
      const awaitingMsgs = awaitingMessages(messages).map((m) => ({ from: m.from, kind: m.kind, body: m.body }));
      // task timing: real event window + target time from the statement. running =
      // task not yet completed with at least one event (the panel counts the elapsed time).
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
        // commits.jsonl (tools/commits.mjs) — input for attachCommits, dropped from the payload
        _commitsJsonl: readJsonl(path.join(dir, 'commits.jsonl')),
      };
    });
  // depends_on from meta.json: refs by task directory name or prefix ("01"),
  // resolved against this repo's tasks. An unfinished dep => blocked task;
  // an unresolved ref doesn't block (shows up marked as missing).
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
  attachCommits(tasks, wsDir); // Diff tab: registered + temporal fallback, attributed among tasks
  return tasks;
}

function readRepos() {
  if (!fs.existsSync(REPOS_DIR)) return [];
  const prices = readJson(PRICES_FILE); // optional — null if missing/invalid
  return fs
    .readdirSync(REPOS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const dir = path.join(REPOS_DIR, d.name);
      const meta = readMeta(dir);
      const wsDir = meta.workspace ? path.resolve(ROOT, meta.workspace) : path.join(WORKSPACE_DIR, d.name);
      const tasks = readTasks(dir, prices, wsDir);
      // agents.json at the repo level (format { agents: [...] }, each agent can
      // carry last_task = task it last worked on) — optional, absence becomes []
      const agentsJson = readJson(path.join(dir, 'agents.json'));
      const agents = Array.isArray(agentsJson?.agents) ? agentsJson.agents : [];
      // estado.json / acessos.json (push model, written by agents) — optional,
      // missing/invalid becomes null / []. Each access gets up: true|false|null from the ping.
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
      // repo's aggregated progress: completed tasks, DAG nodes and checks (guardrails)
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
      // repo's token/cost/awaiting-human aggregates = sum of the tasks
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
      // repo's most recent mtime (direct files + tasks) — used to sort by activity
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
  // guardrails/pool.json (optional): resolves title/check for the DAG's guardrails
  const pool = readJson(path.join(GUARDRAILS_DIR, 'pool.json'));
  const guardrailPool = Array.isArray(pool?.guardrails) ? pool.guardrails : [];
  return { repos, totals, guardrailPool, agentDefs: readAgentDefs() };
}

// --- bus: human reply becomes a line in the task's messages.jsonl ---
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
      return json(res, 400, { error: 'body is not valid JSON' });
    }
    const { repo, task, from, to, kind, body } = b || {};
    if (typeof repo !== 'string' || !repo || /[/\\]|\.\./.test(repo)) return json(res, 400, { error: 'invalid repo' });
    if (typeof task !== 'string' || !task || /[/\\]|\.\./.test(task)) return json(res, 400, { error: 'invalid task' });
    if (from !== 'humano') return json(res, 400, { error: 'from must be "humano"' });
    if (typeof to !== 'string' || !to) return json(res, 400, { error: 'to is required' });
    if (!MSG_KINDS.includes(kind)) return json(res, 400, { error: `kind must be one of: ${MSG_KINDS.join(', ')}` });
    if (typeof body !== 'string' || !body.trim()) return json(res, 400, { error: 'body is required' });
    const dir = path.join(REPOS_DIR, repo, 'tasks', task);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return json(res, 400, { error: 'task does not exist' });
    const msg = { ts: new Date().toISOString(), from: 'humano', to, kind, body };
    if (b.meta && typeof b.meta === 'object') msg.meta = b.meta;
    try {
      fs.appendFileSync(path.join(dir, 'messages.jsonl'), JSON.stringify(msg) + '\n');
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
    broadcastChange(); // extra nudge — the repos/ watcher also fires on the append
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
      clients.delete(res); // socket already dead — remove without taking down the server
    }
  }
}
function broadcastChange() {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    sseWrite(`data: ${JSON.stringify({ at: Date.now() })}\n\n`);
    scheduleRepublish(); // repos with an active share leave updated on their own
  }, 150);
}

// --- auto-republish of shared repos (tools/share.mjs) ---
// Registry in .shares.json (root): { "shares": { "<repo>": { uuid, url, auto, custos } } }.
// A repo with auto !== false is re-published by the server itself when it changes — the
// agent never deploys manually. `share.mjs <repo> --off` pauses; `--delete` removes.
const publishState = new Map(); // slug -> { publishedAt, running, timer }

function activeShares() {
  const reg = readJson(SHARES_FILE);
  const shares = reg && typeof reg.shares === 'object' && !Array.isArray(reg.shares) ? reg.shares : {};
  return Object.keys(shares).filter((slug) => shares[slug] && shares[slug].auto !== false);
}

// mtime of what the shared page shows: repo metadata (repos/<slug>) +
// the workspace's .git (new commits change the Diff tab). Cheap enough to
// run on every burst of change.
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
  if (!IS_SERVER) return; // imported as a module (share.mjs): never republishes on its own
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
          console.log(`↻ share republished: ${slug}`);
        } else console.log(`⚠ share failed (${code}): ${slug} — ${errBuf.trim().split('\n').pop() ?? 'no stderr'}`);
        scheduleRepublish(); // picks up changes that happened during the publish
      });
    }, 5000); // debounce: waits for the agent's write burst to settle
  }
}
// Heartbeat: SSE comment every 15s. With no traffic, a dead socket (machine sleep,
// server swap) stays "open" indefinitely on both sides — the browser never fires
// onerror and misses broadcasts forever. With the heartbeat, TCP detects the death,
// EventSource reconnects and the frontend's onopen re-syncs the state.
if (IS_SERVER) setInterval(() => sseWrite(':hb\n\n'), 15000).unref();

// repos/ and workspace/ are created by other processes — the viewer creates nothing.
// While the directory doesn't exist, it retries attaching the watcher every 2s.
function watchWhenReady(dir) {
  const attach = () => {
    if (!fs.existsSync(dir)) return false;
    try {
      fs.watch(dir, { recursive: true }, broadcastChange);
      broadcastChange(); // directory just appeared — panel reloads
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

  // static files
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.join(PUBLIC_DIR, path.normalize(file));
  if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    return res.end('404');
  }
  // no-cache: the browser revalidates on every load — a change in app.js/style.css
  // takes effect on the next refresh, without a hard-refresh
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(filePath).pipe(res);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`port ${PORT} already in use — the viewer is probably already running at http://localhost:${PORT}`);
    process.exit(0);
  }
  throw err;
});

if (IS_SERVER) {
  server.listen(PORT, HOST, () => {
    console.log(`viewer at http://localhost:${PORT} (bind: ${HOST})`);
    scheduleRepublish(); // a shared repo comes up already updated when the viewer starts
  });
}
