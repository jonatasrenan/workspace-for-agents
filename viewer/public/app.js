/* global marked, mermaid */
// Workspace for Agents panel: two levels of selection (repo → task), data via
// /api/state + SSE (/api/events). Besides the .md tabs, each task has the
// live panels Room / Agents / Logs / Costs. Selection and filters persist
// in localStorage.
mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'loose' });

// Strikethrough only with ~~double~~: marked/GFM's default accepts ~single~, which
// turns approximations ("~0.5M ... ~30 B") into struck-through text and breaks the ** in the middle.
marked.use({
  tokenizer: {
    del(src) {
      if (!src.startsWith('~')) return false;
      const cap = /^~~(?=[^\s~])([\s\S]*?[^\s~])~~(?!~)/.exec(src);
      if (cap) return { type: 'del', raw: cap[0], text: cap[1], tokens: this.lexer.inlineTokens(cap[1]) };
      return { type: 'text', raw: '~', text: '~' }; // stray ~ = "approximately", never strikethrough
    },
  },
});

const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let mermaidSeq = 0;

// --- static mode (shared page for ONE repo) ---
// tools/share.mjs publishes THIS SAME app with the repo's state embedded in
// window.__DATA__: no SSE and no POST /api/bus (the Room becomes read-only,
// questions to the human appear as a record), page updates via the page's own ETag.
// __NO_COSTS__ = published with --sem-custos (Costs panel left out).
const STATIC = !!window.__STATIC__;
const NO_COSTS = !!window.__NO_COSTS__;

const LS_KEY = 'wfa:sel';
const LS_LOGS = 'wfa:logfilter';
const state = {
  repos: [],
  totals: null, // project aggregates (tokens + usd + awaiting human) coming from the server
  pool: [], // guardrails/pool.json — resolves title/check for the DAG's guardrails
  agentDefs: {}, // .claude/agents/<name>.md → { description, resumo } (via server)
  repo: null, // slug of the selected repo
  task: null, // slug of the selected task; null = repo overview
  tab: null, // active .md name OR panel id ("panel:sala", ...)
};

// live panels — tabs alongside the .md tabs, always present in the task
// (the Agents roster lives in the repo overview; the task shows only the "active" strip)
const PANELS = [
  { id: 'panel:dag', label: 'DAG' },
  { id: 'panel:diff', label: 'Diff' },
  { id: 'panel:timeline', label: 'Timeline' },
  { id: 'panel:sala', label: 'Room' },
  { id: 'panel:logs', label: 'Logs' },
  { id: 'panel:custos', label: 'Costs' },
].filter((p) => !(NO_COSTS && p.id === 'panel:custos'));
const isPanel = (tab) => PANELS.some((p) => p.id === tab);

// Timeline: by default logs only come in with warn/error (the rest is noise
// next to the messages); the "all levels" toggle persists.
const LS_TL = 'wfa:timeline';
const tlFilter = { allLevels: false };
try {
  tlFilter.allLevels = localStorage.getItem(LS_TL) === '1';
} catch {}

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];
const logFilter = { levels: [...LOG_LEVELS], source: '' }; // default: everything visible
try {
  const s = JSON.parse(localStorage.getItem(LS_LOGS));
  if (Array.isArray(s?.levels)) logFilter.levels = s.levels.filter((l) => LOG_LEVELS.includes(l));
} catch {}
function saveLogFilter() {
  try {
    localStorage.setItem(LS_LOGS, JSON.stringify({ levels: logFilter.levels }));
  } catch {}
}

// Room: auto-scroll sticks to the bottom unless the user has scrolled up;
// drafts and the reply box's focus survive SSE re-renders.
let salaStick = true;
const salaDrafts = {};
let salaFocusKey = null;

const STATUS = {
  todo: { icon: '○', label: 'to do', cls: 'todo' },
  'em-andamento': { icon: '▶', label: 'in progress', cls: 'andamento' },
  concluida: { icon: '✓', label: 'done', cls: 'concluida' },
};
const st = (s) => STATUS[s] || STATUS.todo;

const AGENT_STATUS = { ocioso: 'idle', executando: 'run', concluido: 'done' };
// display label for the raw agent status value (the CSS class above stays untranslated)
const AGENT_STATUS_LABEL = { ocioso: 'idle', executando: 'running', concluido: 'done' };
const agentStatusLabel = (s) => AGENT_STATUS_LABEL[s] || s;

const ACCESS_TYPE_LABEL = { app: 'app', metricas: 'metrics', dashboard: 'dashboard', outro: 'other' };
const accessTypeLabel = (s) => ACCESS_TYPE_LABEL[s] || s;

// collapse of the Repos/Tasks columns — persists under separate keys
const COL_KEYS = { repos: 'wfa:col:repos', tasks: 'wfa:col:tasks' };
const collapsed = { repos: false, tasks: false };
try {
  collapsed.repos = localStorage.getItem(COL_KEYS.repos) === '1';
  collapsed.tasks = localStorage.getItem(COL_KEYS.tasks) === '1';
} catch {}
function applyCollapse() {
  for (const k of ['repos', 'tasks']) {
    $(`#${k}-col`).classList.toggle('collapsed', collapsed[k]);
    const btn = $(`#${k}-toggle`);
    btn.textContent = collapsed[k] ? '⟩' : '⟨';
    btn.title = collapsed[k] ? 'expand column' : 'collapse column';
  }
}
function wireToggles() {
  for (const k of ['repos', 'tasks']) {
    $(`#${k}-toggle`).onclick = () => {
      collapsed[k] = !collapsed[k];
      try {
        localStorage.setItem(COL_KEYS[k], collapsed[k] ? '1' : '0');
      } catch {}
      applyCollapse();
      renderAll();
    };
  }
}

// initials for the collapsed rail: 2 letters from the first 2 words (or 2 chars)
function repoInitials(title) {
  const words = String(title || '?').split(/[^a-zA-Z0-9]+/).filter(Boolean);
  const s = words.length >= 2 ? words[0][0] + words[1][0] : (words[0] || '?').slice(0, 2);
  return s.toUpperCase();
}

function saveSel() {
  if (STATIC) return; // shared page doesn't keep the selection in the reader's browser
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ repo: state.repo, task: state.task, tab: state.tab }));
  } catch {}
}
function restoreSel() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY));
    if (s && typeof s === 'object') {
      state.repo = s.repo ?? null;
      state.task = s.task ?? null;
      state.tab = s.tab ?? null;
    }
  } catch {}
}

const currentRepo = () => state.repos.find((r) => r.slug === state.repo) || null;
const currentTask = () => currentRepo()?.tasks.find((t) => t.slug === state.task) || null;

// cuts at a word boundary (~n chars) with an ellipsis
function truncWord(s, n = 24) {
  if (s.length <= n) return s;
  const cut = s.slice(0, n + 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > 8 ? cut.slice(0, sp) : s.slice(0, n)).trimEnd() + '…';
}

function fileH1(file) {
  return (file.content.match(/^#\s+(.+)$/m) || [])[1]?.trim() || '';
}

// short tab label: H1 cut at the first "—" ("Plano", "Journal"...);
// 00-enunciado.md (H1 = task title) becomes "Statement"; outside that pattern,
// first segment truncated to ~24 chars at a word boundary. The full H1 stays in the content.
function tabLabel(file) {
  if (file.name === '00-enunciado.md') return 'Statement';
  const h1 = fileH1(file);
  if (!h1) return file.name.replace(/^\d+-/, '').replace(/\.md$/, '');
  return truncWord(h1.split('—')[0].trim() || h1);
}

const fmtTok = (n) => {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k';
  return String(n);
};
const fmtUsd = (v) => (v == null ? null : `$${v.toFixed(2)}`);

function shortTs(ts) {
  const d = new Date(ts);
  return isNaN(d) ? '' : d.toTimeString().slice(0, 8);
}
function relTime(ts) {
  const d = new Date(ts);
  if (isNaN(d)) return '—';
  const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// --- timing (task, repo, project) ---
// The server sends timing = { start, last, targetMin, running } per task: start is the
// first real event (message/log/cost). The elapsed time of a live task is
// recalculated on the client (30s tick), without depending on a new SSE event.
const MIN = 60000;
function fmtDur(ms) {
  const total = Math.max(0, Math.round(ms / MIN));
  const h = Math.floor(total / 60);
  return h ? `${h}h${String(total % 60).padStart(2, '0')}m` : `${total}min`;
}
function taskElapsed(task) {
  const start = Date.parse(task?.timing?.start ?? '');
  if (isNaN(start)) return 0;
  if (task.timing.running) return Math.max(0, Date.now() - start);
  const end = Date.parse(task.timing.last ?? '');
  return isNaN(end) ? 0 : Math.max(0, end - start);
}
const sumElapsed = (tasks) => (tasks || []).reduce((a, t) => a + taskElapsed(t), 0);
const sumTarget = (tasks) => (tasks || []).reduce((a, t) => a + (t?.timing?.targetMin || 0) * MIN, 0);

// green up to 75% of the target · amber above · red overrun (no target: neutral)
function timeClass(ms, targetMs) {
  if (!targetMs) return 'tt-none';
  const p = ms / targetMs;
  return p > 1 ? 'tt-over' : p > 0.75 ? 'tt-warn' : 'tt-ok';
}

// task timer (top, next to the breadcrumb): elapsed vs target + bar with
// milestones at 25/50/75%. A completed task shows the total, static duration.
function taskTimerHtml(task) {
  const t = task?.timing;
  if (!t?.start) return '<span class="task-timer" id="task-timer"></span>';
  const ms = taskElapsed(task);
  const targetMs = (t.targetMin || 0) * MIN;
  const cls = timeClass(ms, targetMs);
  const over = targetMs && ms > targetMs ? `<span class="tt-over-by">+${fmtDur(ms - targetMs)}</span>` : '';
  const alvo = targetMs ? `<span class="tt-sep">/</span><span class="tt-target">${fmtDur(targetMs)}</span>${over}` : '';
  const pct = targetMs ? Math.min(100, (ms / targetMs) * 100) : 0;
  const bar = targetMs
    ? `<span class="tt-bar"><i style="width:${pct.toFixed(1)}%"></i>${[25, 50, 75]
        .map((m) => `<u style="left:${m}%" title="${fmtDur((targetMs * m) / 100)} (${m}% of the target time)"></u>`)
        .join('')}</span>`
    : '';
  const tip = [
    `start ${shortTs(t.start).slice(0, 5)}`,
    t.running ? 'in progress' : `last event ${shortTs(t.last).slice(0, 5)}`,
    targetMs ? `target time ${fmtDur(targetMs)}` : 'no target time in the statement',
  ].join(' · ');
  return `<span class="task-timer ${cls}${t.running ? ' running' : ''}" id="task-timer" title="${esc(tip)}">
    <span class="tt-icon">⏱</span><span class="tt-elapsed">${fmtDur(ms)}</span>${alvo}${bar}</span>`;
}

// time segment of the repo's progress line: sum of the tasks' durations
// (the active one counts its elapsed time) against the sum of the target times
function repoTimeHtml(repo) {
  const tasks = repo?.tasks || [];
  const ms = sumElapsed(tasks);
  if (!ms) return '';
  const targetMs = sumTarget(tasks.filter((t) => t.timing?.start));
  const cls = timeClass(ms, targetMs);
  const alvo = targetMs ? ` <span class="rt-target">/ ${fmtDur(targetMs)} target</span>` : '';
  return `time <b class="${cls}">${fmtDur(ms)}</b>${alvo}`;
}

// --- dependencies between tasks (meta.depends_on, resolved by the server) ---
const openDeps = (t) => (t.depends_on || []).filter((d) => !d.missing && d.status !== 'concluida');
const depNum = (slug) => (String(slug).match(/^(\d+)/) || [])[1] || slug;

// discreet line at the top of the task view: "Depends on: <links>"
function renderDepsLine(task) {
  const deps = task.depends_on || [];
  if (!deps.length) return '';
  const links = deps.map((d) => {
    if (d.missing) return `<span class="dep-missing" title="task not found in the repo">${esc(d.title)}</span>`;
    const s = st(d.status);
    const ok = d.status === 'concluida';
    return `<a class="dep-link ${ok ? 'dep-ok' : 'dep-wait'}" data-task="${esc(d.slug)}" title="${esc(d.slug)}: ${s.label}">${s.icon} ${esc(d.title)}</a>`;
  });
  return `<div class="deps-line">Depends on: ${links.join('<span class="dep-sep">·</span>')}</div>`;
}

function wireDeps(content) {
  content.querySelectorAll('.dep-link').forEach((el) => {
    el.onclick = (e) => {
      e.preventDefault();
      state.task = el.dataset.task;
      state.tab = null;
      reconcile();
      saveSel();
      renderAll();
    };
  });
}

// tokens somados por agente a partir de costs.jsonl
function tokensByAgent(costs) {
  const m = {};
  for (const c of costs || []) {
    const k = c.agente || '?';
    m[k] ||= { in: 0, out: 0, total: 0 };
    m[k].in += Number(c.tokens_in) || 0;
    m[k].out += Number(c.tokens_out) || 0;
    m[k].total += Number(c.tokens_total) || (Number(c.tokens_in) || 0) + (Number(c.tokens_out) || 0);
  }
  return m;
}

async function renderMermaidIn(container) {
  const blocks = container.querySelectorAll('code.language-mermaid');
  for (const code of blocks) {
    const src = code.textContent;
    const holder = document.createElement('div');
    holder.className = 'mermaid-block';
    try {
      const { svg } = await mermaid.render(`mm-${++mermaidSeq}`, src);
      holder.innerHTML = svg;
    } catch (e) {
      holder.innerHTML = `<pre>${esc(src)}</pre><p style="color:#ef4444">mermaid: ${e.message}</p>`;
    }
    code.closest('pre').replaceWith(holder);
  }
}

// validates the selection against the current data (repo/task/tab may have disappeared)
function reconcile() {
  if (!state.repos.some((r) => r.slug === state.repo)) {
    state.repo = state.repos[0]?.slug ?? null;
    state.task = null;
    state.tab = null;
  }
  const repo = currentRepo();
  if (state.task && !repo?.tasks.some((t) => t.slug === state.task)) {
    state.task = null;
    state.tab = null;
  }
  const task = currentTask();
  if (task) {
    const valid = task.files.some((f) => f.name === state.tab) || isPanel(state.tab);
    if (!valid) state.tab = task.files[0]?.name ?? 'panel:sala';
  } else {
    state.tab = null;
  }
}

// --- repos column (collapsible: initials + dot rail) ---
function renderRepos() {
  const el = $('#repos');
  if (!state.repos.length) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = state.repos
    .map((r) => {
      const total = r.tasks.length;
      const blocked = r.tasks.filter((t) => t.blocked).length;
      const allDone = r.status === 'concluido' || (total > 0 && r.counts.concluida === total);
      const dot = allDone ? 'ok' : 'andamento';
      const active = r.slug === state.repo ? ' active' : '';
      const attn = r.awaiting ? ' attn' : '';
      if (collapsed.repos) {
        let tip = `${r.title} — ${total ? `${total} task${total === 1 ? '' : 's'}` : 'no tasks'}`;
        if (r.awaiting) tip += ` · ✋ ${r.awaiting} awaiting you`;
        if (allDone) tip += ' · ✓ done';
        return `<button class="repo-rail${active}${attn}" data-repo="${esc(r.slug)}" title="${esc(tip)}">
          <span class="rail-ini">${esc(repoInitials(r.title))}</span><span class="dot ${dot}"></span></button>`;
      }
      const badges = [];
      badges.push(total ? `<i class="sb">${total} task${total === 1 ? '' : 's'}</i>` : '<i class="sb sb-muted">no tasks</i>');
      if (blocked) badges.push(`<i class="sb sb-lock">${blocked} 🔒</i>`);
      if (r.awaiting) badges.push(`<i class="sb sb-wait" title="messages awaiting your reply">✋ ${r.awaiting} awaiting you</i>`);
      if (allDone) badges.push('<i class="sb sb-done">✓ done</i>');
      else if (r.status) badges.push(`<i class="sb sb-st" title="repo status">${esc(r.status)}</i>`);
      if (r.tokens?.total) badges.push(`<i class="sb sb-tok" title="repo's total tokens">${fmtTok(r.tokens.total)} tok</i>`);
      return `<button class="repo${active}${attn}" data-repo="${esc(r.slug)}">
        <span class="repo-title"><span class="dot ${dot}" title="${esc(r.status || '')}"></span>${esc(r.title)}</span>
        <span class="repo-badges">${badges.join('')}</span>
      </button>`;
    })
    .join('');
  el.querySelectorAll('[data-repo]').forEach((b) => {
    b.onclick = () => {
      if (state.repo !== b.dataset.repo) {
        state.repo = b.dataset.repo;
        state.task = null;
        state.tab = null;
      }
      saveSel();
      renderAll();
    };
  });
}

// --- selected repo's tasks column (collapsible: status icon rail) ---
function renderTasksCol() {
  const el = $('#tasks');
  const repo = currentRepo();
  $('#tasks-col').style.display = repo ? '' : 'none';
  if (!repo) {
    el.innerHTML = '';
    return;
  }
  const items = [];
  if (collapsed.tasks) {
    items.push(`<button class="task-rail overview${state.task === null ? ' active' : ''}" data-task="" title="Overview">📋</button>`);
    for (const t of repo.tasks) {
      const s = st(t.status);
      const icon = t.blocked ? '🔒' : s.icon;
      let tip = t.blocked ? `${t.title} — awaiting ${openDeps(t).map((d) => d.title).join(', ')}` : `${t.title} — ${s.label}`;
      if (t.awaiting) tip += ` · ✋${t.awaiting} awaiting you`;
      items.push(`<button class="task-rail ${s.cls}${t.blocked ? ' blocked' : ''}${t.awaiting ? ' attn' : ''}${t.slug === state.task ? ' active' : ''}"
        data-task="${esc(t.slug)}" title="${esc(tip)}">${icon}</button>`);
    }
  } else {
    items.push(`<button class="task overview${state.task === null ? ' active' : ''}" data-task="">📋 Overview</button>`);
    for (const t of repo.tasks) {
      const s = st(t.status);
      // task blocked by an unfinished dependency: lock + dimmed
      const open = openDeps(t);
      const icon = t.blocked ? '🔒' : s.icon;
      let tip = t.blocked ? `${t.slug}: awaiting ${open.map((d) => d.title).join(', ')}` : `${t.slug}: ${s.label}`;
      if (t.awaiting) tip += ` — ${t.awaiting} question(s) awaiting you`;
      const chips = [];
      if (t.awaiting) chips.push(`<span class="pill-wait" title="awaiting your reply">✋${t.awaiting}</span>`);
      if (t.dag?.nodes?.length) {
        const ds = dagStats(t.dag);
        chips.push(`<span class="dag-badge ${ds.alert ? 'dag-block' : ds.done === ds.total ? 'dag-done' : 'dag-todo'}" title="completed DAG nodes">${ds.done}/${ds.total}</span>`);
      }
      items.push(`<button class="task ${s.cls}${t.blocked ? ' blocked' : ''}${t.awaiting ? ' attn' : ''}${t.slug === state.task ? ' active' : ''}" data-task="${esc(t.slug)}"
        title="${esc(tip)}"><span class="ticon">${icon}</span><span class="task-title">${esc(truncWord(t.title, 26))}</span>${chips.join('')}</button>`);
    }
  }
  el.innerHTML = items.join('');
  el.querySelectorAll('[data-task]').forEach((b) => {
    b.onclick = () => {
      state.task = b.dataset.task || null;
      state.tab = null;
      reconcile();
      saveSel();
      renderAll();
    };
  });
}

// --- tabs: task .md files + live panels (siblings, separated by a divider) ---
function renderTabs() {
  const el = $('#tabs');
  const task = currentTask();
  if (!task) {
    el.innerHTML = '';
    el.style.display = 'none';
    return;
  }
  el.style.display = '';
  const mdTabs = task.files.map((f) => {
    const h1 = fileH1(f);
    // stub: file still at the template — dimmed tab (same look as blocked tasks)
    const tip = f.stub ? 'no content yet' : h1 ? `${f.name} — ${h1}` : f.name;
    return `<button class="tab${f.stub ? ' stub' : ''}${f.name === state.tab ? ' active' : ''}" data-tab="${esc(f.name)}" title="${esc(tip)}">${esc(tabLabel(f))}</button>`;
  });
  const logs = task.logs || [];
  const warns = logs.filter((l) => l.level === 'warn').length;
  const errs = logs.filter((l) => l.level === 'error').length;
  const panelTabs = PANELS.map((p) => {
    let extra = '';
    let alert = '';
    let stub = '';
    if (p.id === 'panel:sala' && task.messages?.length) extra = `<span class="minibadge">${task.messages.length}</span>`;
    if (p.id === 'panel:diff') {
      const n = task.commits?.length || 0;
      if (n) extra = `<span class="minibadge">${n}</span>`;
      else stub = ' stub'; // task with no commits in the workspace — dimmed tab
    }
    if (p.id === 'panel:timeline') {
      const n = timelineItems(task).length;
      if (n) extra = `<span class="minibadge">${n}</span>`;
      else stub = ' stub'; // task with no events yet — dimmed tab
    }
    if (p.id === 'panel:logs') {
      if (warns) extra += `<span class="minibadge warn">⚠${warns}</span>`;
      if (errs) extra += `<span class="minibadge err">✕${errs}</span>`;
    }
    if (p.id === 'panel:sala' && task.awaiting) alert = ' waiting'; // unanswered question to the human → amber
    if (p.id === 'panel:dag' && task.dag?.nodes?.length) {
      const s = dagStats(task.dag);
      extra = `<span class="minibadge${s.alert ? ' err' : ''}">${s.done}/${s.total}</span>`;
      if (s.alert) alert = ' alert'; // unaccepted failed guardrail → red tab (takes priority over blue)
      else if (s.running) alert = ' live'; // running node → badge pulses blue
    }
    return `<button class="tab panel-tab${alert}${stub}${p.id === state.tab ? ' active' : ''}" data-tab="${p.id}">${p.label}${extra}</button>`;
  });
  el.innerHTML = mdTabs.join('') + (mdTabs.length ? '<span class="tab-sep"></span>' : '') + panelTabs.join('');
  el.querySelectorAll('button.tab').forEach((b) => {
    b.onclick = () => {
      state.tab = b.dataset.tab;
      if (state.tab === 'panel:sala') salaStick = true; // entering the Room sticks to the bottom
      saveSel();
      renderAll();
    };
  });
}

// --- Room panel: timeline of the conversation between agents (and the human) ---
// A question/decision to the human closes by an explicit LINK (tools/perguntas.mjs,
// annotated server-side into m.pergunta), never by message order — so its badge and
// its "closed by" line reflect m.pergunta.estado/.fechadaPor, not just "is there
// something later".
const PERG_LABEL = { aberta: 'open', respondida: 'answered', dispensada: 'declined' };
function renderSala(task) {
  const msgs = task.messages || [];
  if (!msgs.length) return '<div class="panel-empty">no messages yet — the agents\' conversation shows up here</div>';
  const items = msgs.map((m, i) => {
    const kind = MSGKIND(m.kind);
    const pergunta = m.pergunta || null;
    const key = `${state.repo}/${state.task}/${m.id || m.ts || ''}#${i}`;
    const stateBadge =
      m.kind === 'status' && m.meta?.state ? `<span class="msg-state">${esc(m.meta.state)}</span>` : '';
    let pergBlock = '';
    if (pergunta) {
      const badge = `<span class="perg-badge perg-${pergunta.estado}">${PERG_LABEL[pergunta.estado] || pergunta.estado}</span>`;
      if (pergunta.estado === 'aberta') {
        // The static page doesn't write to the bus: the pending item becomes a
        // record, with no reply box at all.
        pergBlock = STATIC
          ? `${badge}<div class="reply-static">awaiting reply</div>`
          : `${badge}<form class="reply" data-to="${esc(m.from)}" data-kind="${m.kind === 'question' ? 'report' : 'decision'}" data-msg-id="${esc(m.id || '')}">
              <input class="reply-input" data-key="${esc(key)}" placeholder="reply to ${esc(m.from)}…" autocomplete="off" />
              <button type="submit" class="reply-answer">answer</button>
              <button type="button" class="reply-dismiss">don't answer</button>
              <span class="reply-err"></span></form>`;
      } else {
        const closer = pergunta.fechadaPor;
        pergBlock = `${badge}${
          closer
            ? `<div class="perg-closed-by"><span class="msg-ts">${shortTs(closer.ts)}</span> ${esc(closer.from)}: ${esc(closer.body)}</div>`
            : ''
        }`;
      }
    }
    return `<div class="msg kind-${kind}${pergunta ? ' ask' : ''}">
      <div class="msg-head"><span class="msg-ts" title="${esc(m.ts || '')}">${shortTs(m.ts)}</span>
        <span class="msg-route">${esc(m.from || '?')} → ${esc(m.to || '?')}</span>
        <span class="msg-kind k-${kind}">${esc(m.kind || '?')}</span>${stateBadge}</div>
      <div class="msg-body">${esc(m.body || '')}</div>${pergBlock}</div>`;
  });
  return `<div class="sala">${items.join('')}</div>`;
}
const MSGKIND = (k) => (['report', 'question', 'decision', 'approval', 'status'].includes(k) ? k : 'report');

// Posts a reply to /api/bus, linked to `msgId` via meta.responde or
// meta.dispensa — the link is what closes the question, not just posting
// after it. On success, clears the draft and clears the submitting form's error.
async function postSalaReply(f, { to, kind, body, msgId, link }) {
  const err = f.querySelector('.reply-err');
  err.textContent = '';
  const meta = msgId ? { [link]: msgId } : undefined;
  const r = await fetch('/api/bus', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo: state.repo, task: state.task, from: 'humano', to, kind, body, meta }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
}

function wireSala(content) {
  if (STATIC) return; // no reply box on the shared page
  content.querySelectorAll('form.reply').forEach((f) => {
    const input = f.querySelector('.reply-input');
    const msgId = f.dataset.msgId || null;
    if (salaDrafts[input.dataset.key]) input.value = salaDrafts[input.dataset.key];
    input.oninput = () => {
      salaDrafts[input.dataset.key] = input.value;
    };
    input.onfocus = () => {
      salaFocusKey = input.dataset.key;
    };
    input.onblur = () => {
      if (salaFocusKey === input.dataset.key) salaFocusKey = null;
    };
    if (salaFocusKey === input.dataset.key) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
    f.onsubmit = async (e) => {
      e.preventDefault();
      const body = input.value.trim();
      if (!body) return;
      const btns = f.querySelectorAll('button');
      btns.forEach((b) => (b.disabled = true));
      try {
        await postSalaReply(f, { to: f.dataset.to, kind: f.dataset.kind, body, msgId, link: 'responde' });
        input.value = '';
        delete salaDrafts[input.dataset.key];
        salaStick = true; // the reply arrives via SSE — scroll to it
      } catch (e2) {
        f.querySelector('.reply-err').textContent = e2.message;
      }
      btns.forEach((b) => (b.disabled = false));
    };
    const dismissBtn = f.querySelector('.reply-dismiss');
    if (dismissBtn) {
      dismissBtn.onclick = async () => {
        // the typed text (if any) becomes the reason for declining; otherwise a
        // plain default — either way the question closes as "dispensada", never "respondida".
        const body = input.value.trim() || 'declined — no answer needed';
        const btns = f.querySelectorAll('button');
        btns.forEach((b) => (b.disabled = true));
        try {
          await postSalaReply(f, { to: f.dataset.to, kind: 'status', body, msgId, link: 'dispensa' });
          input.value = '';
          delete salaDrafts[input.dataset.key];
          salaStick = true;
        } catch (e2) {
          f.querySelector('.reply-err').textContent = e2.message;
        }
        btns.forEach((b) => (b.disabled = false));
      };
    }
  });
}

// --- Agents: REPO roster (overview) + "active" strip on the task + sheet ---
// Source: repo's agents.json (bus) + .claude/agents definitions (state.agentDefs).
let agentSheet = null; // name of the agent whose sheet is open — survives SSE re-renders

// agents with activity on the task: last_task = current task, or presence in its costs/messages
function agentsInTask(repo, task) {
  const names = new Set();
  for (const c of task.costs || []) if (c.agente) names.add(c.agente);
  // "dag" is not an agent: it's the synthetic origin of node transitions on the bus
  for (const m of task.messages || []) if (m.from && m.from !== 'humano' && m.from !== 'dag') names.add(m.from);
  for (const a of repo?.agents || []) if (a.last_task === task.slug) names.add(a.name);
  for (const a of task.agents || []) names.add(a.name); // legacy — task's agents.json
  return [...names];
}

// full repo roster — clickable cards (opens the sheet) in the overview
function renderRoster(repo) {
  const agents = repo.agents || [];
  if (!agents.length) return '<h2>Agents</h2><p class="muted">no agents yet</p>';
  const byRepo = tokensByAgent((repo.tasks || []).flatMap((t) => t.costs || []));
  const bySlug = new Map((repo.tasks || []).map((t) => [t.slug, t]));
  const cards = agents.map((a) => {
    const s = a.status || 'ocioso';
    const cls = AGENT_STATUS[s] || 'idle';
    const desc = a.role || state.agentDefs?.[a.name]?.description || '';
    const tok = byRepo[a.name]?.total || 0;
    const lastTitle = a.last_task ? bySlug.get(a.last_task)?.title || a.last_task : '';
    return `<div class="agent-card clickable" data-agent="${esc(a.name)}" title="open ${esc(a.name)}'s sheet">
      <div class="agent-head"><span class="adot ${cls}"></span><strong>${esc(a.name)}</strong>
        <span class="agent-status">${esc(agentStatusLabel(s))}</span></div>
      ${desc ? `<div class="agent-role clamp">${esc(desc)}</div>` : ''}
      ${lastTitle ? `<div class="agent-last" title="${esc(a.last_task)}">last worked on: ${esc(lastTitle)}</div>` : ''}
      <div class="agent-foot"><span title="${esc(a.last_active || '')}">${a.last_active ? relTime(a.last_active) : '—'}</span>
        <span class="agent-tokens">${tok ? `${fmtTok(tok)} tok` : ''}</span></div></div>`;
  });
  return `<h2>Agents</h2><div class="agents">${cards.join('')}</div>`;
}

// thin strip at the top of the task: chips for the agents active on it (clickable → sheet)
function renderAgentStrip(repo, task) {
  const names = agentsInTask(repo, task);
  if (!names.length) return '';
  const byName = new Map([...(task.agents || []), ...(repo?.agents || [])].map((a) => [a.name, a]));
  const chips = names.map((n) => {
    const a = byName.get(n) || {};
    const s = a.status || 'ocioso';
    const cls = AGENT_STATUS[s] || 'idle';
    return `<button class="agent-chip" data-agent="${esc(n)}" title="${esc(n)}: ${esc(agentStatusLabel(s))} — open sheet">
      <span class="adot ${cls}"></span>${esc(n)}</button>`;
  });
  return `<div class="agent-strip"><span class="strip-label">active on this task</span>${chips.join('')}</div>`;
}

function wireAgentClicks(root) {
  root.querySelectorAll('[data-agent]').forEach((el) => {
    el.onclick = () => {
      agentSheet = el.dataset.agent;
      renderSheet();
    };
  });
}

// agent sheet: definition (.claude/agents) + bus state + activity/costs/timeline/logs
function renderSheet() {
  const el = $('#sheet');
  if (!el) return;
  const repo = currentRepo();
  if (!agentSheet || !repo) {
    agentSheet = null;
    el.classList.remove('open');
    el.innerHTML = '';
    return;
  }
  const name = agentSheet;
  const scrollPos = el.scrollTop;
  const task = currentTask();
  const def = state.agentDefs?.[name] || null;
  const bus =
    (repo.agents || []).find((a) => a.name === name) ||
    (task?.agents || []).find((a) => a.name === name) ||
    null;
  const s = bus?.status || 'ocioso';
  const cls = AGENT_STATUS[s] || 'idle';
  const bySlug = new Map((repo.tasks || []).map((t) => [t.slug, t]));
  const acted = (repo.tasks || []).filter(
    (t) => (t.costs || []).some((c) => c.agente === name) || (t.messages || []).some((m) => m.from === name)
  );
  const tokTask = task ? tokensByAgent(task.costs)[name]?.total || 0 : 0;
  const tokRepo = tokensByAgent((repo.tasks || []).flatMap((t) => t.costs || []))[name]?.total || 0;
  const msgs = (task?.messages || []).filter((m) => m.from === name);
  const logs = (task?.logs || []).filter((l) => l.source === name);
  const lastTitle = bus?.last_task ? bySlug.get(bus.last_task)?.title || bus.last_task : null;

  const defHtml = def
    ? `${def.description ? `<p class="sheet-desc">${esc(def.description)}</p>` : ''}
       ${def.resumo ? `<p class="sheet-resumo">${esc(def.resumo)}</p>` : ''}`
    : '<p class="sheet-empty">no definition on record — showing only the bus data</p>';
  const actedHtml = acted.length
    ? acted
        .map((t) => {
          const ts = st(t.status);
          return `<a class="sheet-task" data-task="${esc(t.slug)}" title="${esc(t.slug)}"><span class="status ${ts.cls}">${ts.icon}</span> ${esc(t.title)}</a>`;
        })
        .join('')
    : '<p class="sheet-empty">hasn\'t worked on any task in this repo yet</p>';
  const msgsHtml = !task
    ? '<p class="sheet-empty">open a task to see the timeline</p>'
    : msgs.length
      ? msgs
          .map(
            (m) => `<div class="sheet-msg k-${MSGKIND(m.kind)}"><span class="mts" title="${esc(m.ts || '')}">${shortTs(m.ts)}</span>
              <span class="msg-kind k-${MSGKIND(m.kind)}">${esc(m.kind || '?')}</span> → ${esc(m.to || '?')}
              <div class="mbody">${esc(m.body || '')}</div></div>`
          )
          .join('')
      : '<p class="sheet-empty">no messages from this agent in this task</p>';
  const logsHtml = !task
    ? '<p class="sheet-empty">open a task to see the logs</p>'
    : logs.length
      ? logs
          .map(
            (l) => `<div class="sheet-log lv-${esc(l.level || 'info')}"><span class="mts" title="${esc(l.ts || '')}">${shortTs(l.ts)}</span>
              <span class="llv">${esc(l.level || 'info')}</span> ${esc(l.body || '')}</div>`
          )
          .join('')
      : '<p class="sheet-empty">no logs from this agent in this task</p>';

  el.innerHTML = `
    <div class="sheet-head"><span class="adot ${cls}"></span><strong>${esc(name)}</strong>
      <span class="agent-status">${esc(agentStatusLabel(s))}</span>
      <button class="sheet-close" title="close (Esc)">✕</button></div>
    ${bus?.role ? `<div class="sheet-role">${esc(bus.role)}</div>` : ''}
    ${defHtml}
    <div class="sheet-kv">
      <div><span>last activity</span><b title="${esc(bus?.last_active || '')}">${bus?.last_active ? relTime(bus.last_active) : '—'}</b></div>
      <div><span>last worked on</span><b title="${esc(bus?.last_task || '')}">${lastTitle ? esc(truncWord(lastTitle, 28)) : '—'}</b></div>
      <div><span>tokens · selected task</span><b>${task ? fmtTok(tokTask) : '—'}</b></div>
      <div><span>tokens · repo total</span><b>${fmtTok(tokRepo)}</b></div>
    </div>
    <h3>Tasks worked on</h3>${actedHtml}
    <h3>Timeline${task ? ` · ${esc(truncWord(task.title, 28))}` : ''}</h3>${msgsHtml}
    <h3>Logs${task ? ` · ${esc(truncWord(task.title, 28))}` : ''}</h3>${logsHtml}`;
  el.classList.add('open');
  el.scrollTop = scrollPos;
  el.querySelector('.sheet-close').onclick = () => {
    agentSheet = null;
    renderSheet();
  };
  el.querySelectorAll('.sheet-task').forEach((a) => {
    a.onclick = () => {
      state.task = a.dataset.task;
      state.tab = null;
      reconcile();
      saveSel();
      renderAll();
    };
  });
}

// --- Logs panel: filter by level (persisted) and by source ---
function renderLogs(task) {
  const logs = task.logs || [];
  const level = (l) => (LOG_LEVELS.includes(l.level) ? l.level : 'info');
  const counts = { debug: 0, info: 0, warn: 0, error: 0 };
  for (const l of logs) counts[level(l)]++;
  const sources = [...new Set(logs.map((l) => l.source).filter(Boolean))].sort();
  if (logFilter.source && !sources.includes(logFilter.source)) logFilter.source = '';
  const chips = LOG_LEVELS.map(
    (lv) =>
      `<button class="chip lv-${lv}${logFilter.levels.includes(lv) ? ' on' : ''}" data-level="${lv}">${lv}${counts[lv] ? ` ${counts[lv]}` : ''}</button>`
  ).join('');
  const select = `<select id="log-source"><option value="">all sources</option>${sources
    .map((s) => `<option value="${esc(s)}"${s === logFilter.source ? ' selected' : ''}>${esc(s)}</option>`)
    .join('')}</select>`;
  const shown = logs.filter((l) => logFilter.levels.includes(level(l)) && (!logFilter.source || l.source === logFilter.source));
  const rows = shown
    .map(
      (l) => `<tr class="lv-${level(l)}"><td class="lts" title="${esc(l.ts || '')}">${shortTs(l.ts)}</td>
        <td class="llv">${esc(level(l))}</td><td class="lsrc">${esc(l.source || '')}</td><td>${esc(l.body || '')}</td></tr>`
    )
    .join('');
  const table = shown.length
    ? `<table class="log-table"><tbody>${rows}</tbody></table>`
    : `<div class="panel-empty">${logs.length ? 'nothing matches the current filter' : 'no logs yet'}</div>`;
  const title = `<span class="log-count">${shown.length}/${logs.length} lines${counts.warn ? ` · <b class="w">⚠${counts.warn}</b>` : ''}${counts.error ? ` · <b class="e">✕${counts.error}</b>` : ''}</span>`;
  return `<div class="panel-wrap"><div class="log-controls">${chips}${select}${title}</div>${table}</div>`;
}

function wireLogs(content) {
  content.querySelectorAll('.log-controls .chip').forEach((c) => {
    c.onclick = () => {
      const lv = c.dataset.level;
      logFilter.levels = logFilter.levels.includes(lv) ? logFilter.levels.filter((x) => x !== lv) : [...logFilter.levels, lv];
      saveLogFilter();
      renderAll();
    };
  });
  const sel = content.querySelector('#log-source');
  if (sel)
    sel.onchange = () => {
      logFilter.source = sel.value;
      renderAll();
    };
}

// --- Costs panel: tokens in/out/total per agent + task total ---
function renderCustos(task) {
  const by = tokensByAgent(task.costs);
  const names = Object.keys(by).sort((a, b) => by[b].total - by[a].total);
  if (!names.length) return '<div class="panel-empty">no costs recorded yet</div>';
  const rows = names
    .map(
      (n) => `<tr><td>${esc(n)}</td><td class="num">${fmtTok(by[n].in)}</td>
        <td class="num">${fmtTok(by[n].out)}</td><td class="num">${fmtTok(by[n].total)}</td></tr>`
    )
    .join('');
  const t = task.tokens || { in: 0, out: 0, total: 0 };
  const usd = fmtUsd(task.usd);
  return `<div class="panel-wrap"><table class="cost-table">
    <thead><tr><th>Agent</th><th class="num">in</th><th class="num">out</th><th class="num">total</th></tr></thead>
    <tbody>${rows}<tr class="total"><td>Task total</td><td class="num">${fmtTok(t.in)}</td>
      <td class="num">${fmtTok(t.out)}</td><td class="num">${fmtTok(t.total)}</td></tr></tbody></table>
    ${usd ? `<p class="muted">≈ ${usd} estimated from the price table</p>` : ''}</div>`;
}

// --- Diff panel: commits the task produced in the repo's workspace ---
// Commits come pre-resolved from the server (explicit record + fallback via the task's window).
// Expansions live by HASH (not by index) so they survive SSE re-renders.
const diffOpen = new Set(); // hashes with the diff open
const diffFileClosed = new Set(); // `${hash} ${file}` — files open by default
const diffAutoTasks = new Set(); // tasks whose most recent commit has already been auto-opened

// splits the unified diff into files: each block starts at "diff --git a/x b/x"
function splitDiffFiles(diff) {
  const files = [];
  let cur = null;
  for (const line of String(diff || '').split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      cur = { path: (m ? m[2] : line.slice(11)).trim(), lines: [], add: 0, del: 0 };
      files.push(cur);
      continue;
    }
    if (!cur) {
      // preamble with no file header (rare) — becomes an unnamed block
      if (!line.trim()) continue;
      cur = { path: '', lines: [], add: 0, del: 0 };
      files.push(cur);
    }
    cur.lines.push(line);
    if (line.startsWith('+') && !line.startsWith('+++')) cur.add++;
    else if (line.startsWith('-') && !line.startsWith('---')) cur.del++;
  }
  return files;
}

function diffLineClass(l) {
  if (l.startsWith('@@')) return 'dl-hunk';
  if (l.startsWith('+++') || l.startsWith('---') || /^(index|new file|deleted file|old mode|new mode|similarity|rename|copy|Binary) /.test(l))
    return 'dl-meta';
  if (l.startsWith('+')) return 'dl-add';
  if (l.startsWith('-')) return 'dl-del';
  return 'dl-ctx';
}

// summary of the --stat footer: "4 files changed, 96 insertions(+), 4 deletions(-)"
function statSummary(stat) {
  const last = String(stat || '').trim().split('\n').pop() || '';
  const f = /(\d+)\s+files?\s+changed/.exec(last);
  if (!f) return '';
  const ins = /(\d+)\s+insertions?/.exec(last);
  const del = /(\d+)\s+deletions?/.exec(last);
  return (
    `${f[1]} file${f[1] === '1' ? '' : 's'}` +
    (ins ? ` <b class="d-add">+${ins[1]}</b>` : '') +
    (del ? ` <b class="d-del">−${del[1]}</b>` : '')
  );
}

function renderDiffBody(c) {
  const files = splitDiffFiles(c.diff);
  if (!files.length) return '<div class="diff-empty">no file changes in this commit</div>';
  const blocks = files.map((f) => {
    const key = `${c.hash} ${f.path}`;
    const open = !diffFileClosed.has(key);
    const body = open
      // spans are display:block — no "\n" between them (inside a <pre> it would become an empty line)
      ? `<pre class="diff-lines">${f.lines.map((l) => `<span class="${diffLineClass(l)}">${esc(l) || ' '}</span>`).join('')}</pre>`
      : '';
    return `<div class="diff-file${open ? ' open' : ''}">
      <button class="diff-file-head" data-file="${esc(key)}" title="${esc(f.path)}">
        <span class="caret">${open ? '▾' : '▸'}</span><code>${esc(f.path || '(no file)')}</code>
        <span class="d-counts">${f.add ? `<b class="d-add">+${f.add}</b>` : ''}${f.del ? `<b class="d-del">−${f.del}</b>` : ''}</span>
      </button>${body}</div>`;
  });
  const trunc = c.truncated
    ? `<div class="diff-trunc">diff truncated — first ${String(c.diff || '').split('\n').length} of ${c.totalLines} lines</div>`
    : '';
  const stat = c.stat ? `<pre class="diff-stat">${esc(c.stat)}</pre>` : '';
  return stat + blocks.join('') + trunc;
}

function renderDiff(task) {
  const commits = task.commits || [];
  if (!commits.length)
    return '<div class="panel-empty">no commits in the workspace for this task — the diff shows up here as soon as there is one</div>';
  const key = `${state.repo}/${task.slug}`;
  if (!diffAutoTasks.has(key)) {
    diffAutoTasks.add(key);
    diffOpen.add(commits[0].hash); // first visit: the most recent one starts open
  }
  const items = commits.map((c) => {
    const open = diffOpen.has(c.hash);
    const sum = statSummary(c.stat);
    return `<div class="commit${open ? ' open' : ''}">
      <button class="commit-head" data-hash="${esc(c.hash)}">
        <span class="caret">${open ? '▾' : '▸'}</span>
        <code class="c-hash">${esc(c.shortHash)}</code>
        <span class="c-msg">${esc(c.msg)}</span>
        <span class="c-stat">${sum}</span>
        <span class="c-date" title="${esc(c.date)}">${relTime(c.date)}</span>
      </button>
      ${open ? `<div class="commit-body">${renderDiffBody(c)}</div>` : ''}</div>`;
  });
  return `<div class="panel-wrap diffs">
    <div class="diff-count">${commits.length} commit${commits.length === 1 ? '' : 's'} in the workspace</div>
    ${items.join('')}</div>`;
}

function wireDiff(content) {
  content.querySelectorAll('.commit-head').forEach((b) => {
    b.onclick = () => {
      const h = b.dataset.hash;
      if (diffOpen.has(h)) diffOpen.delete(h);
      else diffOpen.add(h);
      renderAll();
    };
  });
  content.querySelectorAll('.diff-file-head').forEach((b) => {
    b.onclick = () => {
      const k = b.dataset.file;
      if (diffFileClosed.has(k)) diffFileClosed.delete(k);
      else diffFileClosed.add(k);
      renderAll();
    };
  });
}

// --- Timeline panel: single axis merging the task's sources ---
// bus (messages), logs (default: only warn/error), workspace commits, journal
// lines with a recognizable time, and DAG node transitions (messages with from="dag").
const TL_ICON = { bus: '●', dag: '▣', log: '◦', commit: '⎇', journal: '✎' };
const TL_ORIGEM = { bus: 'message', dag: 'DAG', log: 'log', commit: 'commit', journal: 'journal' };
const TL_GAP = 5 * MIN; // above this, a separator shows the time gap

// journal lines with a time: "- 16:03 — text" or "**16:03** — text".
// With no recognizable time, the line is ignored (the journal isn't a log).
function journalItems(task, refMs) {
  const file = (task.files || []).find((f) => /journal/i.test(f.name));
  if (!file || refMs == null) return [];
  const base = new Date(refMs); // local day of the task's first event
  const out = [];
  for (const line of String(file.content || '').split('\n')) {
    const m = /^\s*(?:[-*]\s*)?\**(\d{1,2}):(\d{2})\**\s*[—–:-]?\s*(.+)$/.exec(line);
    if (!m) continue;
    const h = Number(m[1]);
    const mi = Number(m[2]);
    const texto = m[3].replace(/^\*\*|\*\*$/g, '').trim();
    if (h > 23 || mi > 59 || !texto) continue;
    let at = new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, mi).getTime();
    if (at < refMs - 12 * 3600e3) at += 86400e3; // entry after the day rolled over
    out.push({ at, origin: 'journal', text: texto });
  }
  return out;
}

// all of the task's events on a single axis, in chronological order
function timelineItems(task) {
  const items = [];
  for (const m of task.messages || []) {
    const at = Date.parse(m.ts);
    if (isNaN(at)) continue;
    if (m.from === 'dag' && m.meta?.node) {
      items.push({ at, origin: 'dag', text: m.body || `${m.meta.node} → ${m.meta.para}`, tag: m.meta.para });
    } else {
      items.push({ at, origin: 'bus', kind: MSGKIND(m.kind), who: `${m.from || '?'} → ${m.to || '?'}`, text: m.body || '' });
    }
  }
  for (const l of task.logs || []) {
    const lv = LOG_LEVELS.includes(l.level) ? l.level : 'info';
    if (!tlFilter.allLevels && lv !== 'warn' && lv !== 'error') continue;
    const at = Date.parse(l.ts);
    if (isNaN(at)) continue;
    items.push({ at, origin: 'log', level: lv, who: l.source || '', text: l.body || '' });
  }
  for (const c of task.commits || []) {
    const at = Date.parse(c.date);
    if (isNaN(at)) continue;
    items.push({ at, origin: 'commit', who: c.shortHash, text: c.msg || '' });
  }
  const first = items.reduce((a, i) => (a == null || i.at < a ? i.at : a), Date.parse(task.timing?.start ?? '') || null);
  items.push(...journalItems(task, Number.isFinite(first) ? first : null));
  return items.sort((a, b) => a.at - b.at);
}

function tlItemHtml(it) {
  const hora = new Date(it.at).toTimeString().slice(0, 5);
  const cls = it.origin === 'bus' ? `k-${it.kind}` : it.origin === 'log' ? `lv-${it.level}` : it.origin === 'dag' ? `dag-${esc(it.tag || '')}` : '';
  const icon = it.origin === 'log' ? (it.level === 'error' ? '✕' : it.level === 'warn' ? '⚠' : '◦') : TL_ICON[it.origin];
  const who = it.who ? `<span class="tl-who">${esc(it.who)}</span>` : '';
  const tag =
    it.origin === 'bus' ? `<span class="tl-kind k-${it.kind}">${esc(it.kind)}</span>` : it.origin === 'dag' ? '<span class="tl-kind tl-k-dag">DAG</span>' : '';
  return `<div class="tl-item tl-${it.origin} ${cls}" title="${esc(TL_ORIGEM[it.origin])}">
    <span class="tl-time">${hora}</span><span class="tl-dot">${icon}</span>
    <span class="tl-body">${who}${tag}<span class="tl-text">${esc(it.text)}</span></span></div>`;
}

function renderTimeline(task) {
  const items = timelineItems(task);
  const logs = (task.logs || []).length;
  const controls = `<div class="tl-controls">
    <button class="chip${tlFilter.allLevels ? ' on' : ''}" id="tl-levels" title="by default the timeline only carries warn/error logs">all levels${logs ? ` (${logs} logs)` : ''}</button>
    <span class="log-count">${items.length} event${items.length === 1 ? '' : 's'}</span></div>`;
  if (!items.length)
    return `<div class="panel-wrap">${controls}<div class="panel-empty">no events yet — messages, logs, commits, journal and DAG transitions show up here in order</div></div>`;
  // grouping by proximity: a gap larger than 5 min becomes a "+Nmin" separator
  const groups = [];
  let cur = null;
  for (const it of items) {
    if (!cur || it.at - cur.last > TL_GAP) {
      groups.push((cur = { items: [], last: it.at, gap: cur ? it.at - cur.last : 0 }));
    }
    cur.items.push(it);
    cur.last = it.at;
  }
  const total = items[items.length - 1].at - items[0].at;
  const body = groups
    .map(
      (g, i) =>
        (i ? `<div class="tl-gap"><span>+${fmtDur(g.gap)}</span></div>` : '') +
        `<div class="tl-group">${g.items.map(tlItemHtml).join('')}</div>`
    )
    .join('');
  return `<div class="panel-wrap tl"><div class="tl-head">${controls}
    <span class="tl-span">${new Date(items[0].at).toTimeString().slice(0, 5)} → ${new Date(items[items.length - 1].at)
      .toTimeString()
      .slice(0, 5)} · ${fmtDur(total)}</span></div>${body}</div>`;
}

function wireTimeline(content) {
  const b = content.querySelector('#tl-levels');
  if (b)
    b.onclick = () => {
      tlFilter.allLevels = !tlFilter.allLevels;
      try {
        localStorage.setItem(LS_TL, tlFilter.allLevels ? '1' : '0');
      } catch {}
      renderAll();
    };
}

// --- DAG panel: mermaid graph + node table derived from dag.json ---
const DAG_STATUS = {
  todo: { label: 'to do', cls: 'dag-todo', mm: 'dagtodo' },
  executando: { label: 'running', cls: 'dag-exec', mm: 'dagexec' },
  concluida: { label: 'done', cls: 'dag-done', mm: 'dagdone' },
  bloqueada: { label: 'blocked', cls: 'dag-block', mm: 'dagblock' },
};
const dagSt = (s) => DAG_STATUS[s] || DAG_STATUS.todo;
const GR_STATUS = ['pendente', 'pass', 'falha', 'aceito'];
const grSt = (s) => (GR_STATUS.includes(s) ? s : 'pendente');
const GR_ICON = { pass: '✓', falha: '✕', aceito: '~', pendente: '◦' };
// display label for the raw guardrail status value (the gr-<status> CSS class stays untranslated)
const GR_LABEL = { pendente: 'pending', pass: 'pass', falha: 'failed', aceito: 'accepted' };

function dagGrCounts(nodes) {
  const c = { pass: 0, falha: 0, aceito: 0, pendente: 0 };
  for (const n of nodes) for (const g of n.guardrails || []) if (g) c[grSt(g.status)]++;
  return c;
}

// DAG summary: node progress + guardrails; alert = an open, unaccepted failure
function dagStats(dag) {
  const nodes = dag?.nodes || [];
  const done = nodes.filter((n) => n.status === 'concluida').length;
  const running = nodes.some((n) => n.status === 'executando');
  const gr = dagGrCounts(nodes);
  return { total: nodes.length, done, running, gr, alert: gr.falha > 0 };
}

// topological order (DFS over dependencies); tolerates cycles and unknown deps
function dagTopo(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seen = new Set();
  const out = [];
  const visit = (n, stack) => {
    if (!n || seen.has(n.id) || stack.has(n.id)) return;
    stack.add(n.id);
    for (const d of n.depends_on || []) visit(byId.get(d), stack);
    stack.delete(n.id);
    seen.add(n.id);
    out.push(n);
  };
  for (const n of nodes) visit(n, new Set());
  return out;
}

// escapes the text of a mermaid label (quotes and characters with special meaning)
const mmEsc = (s) =>
  String(s ?? '').replace(/[#"<>\[\]{}|]/g, (c) => ({ '#': '#35;', '"': '#quot;', '<': '#lt;', '>': '#gt;', '[': '#91;', ']': '#93;', '{': '#123;', '}': '#125;', '|': '#124;' }[c]));

// generates the flowchart TD text from the nodes (synthetic ids d0..dN — the
// JSON's ids may contain characters invalid for mermaid)
function dagMermaid(nodes) {
  const idOf = new Map(nodes.map((n, i) => [n.id, `d${i}`]));
  const lines = ['flowchart TD'];
  nodes.forEach((n, i) => {
    const g = dagGrCounts([n]);
    const badge = (n.guardrails || []).length ? ` ✓${g.pass} ✗${g.falha + g.aceito} ◦${g.pendente}` : '';
    lines.push(`  d${i}["${mmEsc(n.titulo || n.id)}${badge}"]`);
    lines.push(`  class d${i} ${dagSt(n.status).mm}`);
  });
  for (const n of nodes)
    for (const d of n.depends_on || []) if (idOf.has(d) && idOf.has(n.id)) lines.push(`  ${idOf.get(d)} --> ${idOf.get(n.id)}`);
  lines.push('  classDef dagtodo fill:#2a2f3a,stroke:#8b93a3,color:#d8dce5');
  lines.push('  classDef dagexec fill:#14263f,stroke:#6ea8fe,stroke-width:2px,color:#d8dce5');
  lines.push('  classDef dagdone fill:#122a1c,stroke:#4ade80,color:#d8dce5');
  lines.push('  classDef dagblock fill:#2f1518,stroke:#ef4444,color:#d8dce5');
  return lines.join('\n');
}

// guardrail expanded in the table: title/severity come from the pool (fallback: just the id)
function renderGuardrail(g, poolBy) {
  const p = poolBy.get(g.id);
  const s = grSt(g.status);
  const tip = [p?.verificacao, g.nota && s !== 'aceito' ? `note: ${g.nota}` : ''].filter(Boolean).join(' — ');
  const sev = p?.severidade ? ` <span class="gr-sev">${esc(p.severidade)}</span>` : '';
  const nota = s === 'aceito' && g.nota ? `<div class="gr-nota">${esc(g.nota)}</div>` : '';
  return `<div class="gr-line" title="${esc(tip)}"><span class="gr-badge gr-${s}">${GR_ICON[s]} ${esc(GR_LABEL[s] || s)}</span> ${esc(p?.titulo || g.id)}${sev}${nota}</div>`;
}

function renderDag(task) {
  const nodes = task.dag?.nodes || [];
  if (!nodes.length) return '<div class="panel-empty">no DAG — generated during the plan phase</div>';
  const s = dagStats(task.dag);
  const poolBy = new Map((state.pool || []).map((g) => [g.id, g]));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const grTotal = s.gr.pass + s.gr.falha + s.gr.aceito + s.gr.pendente;
  const summary = `<div class="dag-summary">
    <span class="dag-prog${s.done === s.total ? ' ok' : ''}">${s.done}/${s.total} nodes completed</span>
    ${grTotal ? `<span class="dag-gr">guardrails:
      <b class="gr-pass">✓${s.gr.pass}</b>
      ${s.gr.falha ? `<b class="gr-falha">✕${s.gr.falha}</b>` : ''}
      ${s.gr.aceito ? `<b class="gr-aceito">~${s.gr.aceito}</b>` : ''}
      <b class="gr-pendente">◦${s.gr.pendente}</b></span>` : ''}
  </div>`;
  const graph = `<pre><code class="language-mermaid">${esc(dagMermaid(nodes))}</code></pre>`;
  const rows = dagTopo(nodes)
    .map((n) => {
      const d = dagSt(n.status);
      const deps = (n.depends_on || []).map((id) => esc(byId.get(id)?.titulo || id)).join(', ') || '—';
      const grs = (n.guardrails || []).map((g) => renderGuardrail(g, poolBy)).join('') || '<span class="muted">—</span>';
      return `<tr><td>${esc(n.titulo || n.id)}</td>
        <td><span class="dag-badge ${d.cls}">${esc(d.label)}</span></td>
        <td>${esc(n.agente || '—')}</td><td class="dag-deps">${deps}</td><td>${grs}</td></tr>`;
    })
    .join('');
  const table = `<table class="dag-table"><thead><tr><th>Node</th><th>Status</th><th>Agent</th><th>Depends on</th><th>Guardrails</th></tr></thead><tbody>${rows}</tbody></table>`;
  return `<div class="panel-wrap dag">${summary}${graph}${table}</div>`;
}

// --- world state (push model: estado.json + acessos.json written by the agents) ---
// Each card shows "updated X ago" from its atualizado_em — push honesty:
// more than 30 min without an update turns amber.
const STALE_MS = 30 * 60 * 1000;
function ageBadge(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const stale = !isNaN(d) && Date.now() - d.getTime() > STALE_MS;
  return `<span class="state-age${stale ? ' stale' : ''}" title="${esc(ts)}">updated ${relTime(ts)}</span>`;
}
const stateCard = (title, ts, body) =>
  `<div class="state-card"><div class="state-head"><h3>${title}</h3>${ageBadge(ts)}</div>${body}</div>`;
// access health dot: green = responded to the ping; gray = down or never checked
const accDot = (up) =>
  `<span class="acc-dot${up ? ' up' : ''}" title="${up ? 'responding' : up === false ? 'no response' : 'not checked'}"></span>`;

// simple semver comparison: extracts the numeric sequences ("v1.38.1" → [1,38,1])
function semverParts(s) {
  const m = String(s ?? '').match(/\d+(?:\.\d+)*/);
  return m ? m[0].split('.').map(Number) : null;
}
function belowMin(val, min) {
  const a = semverParts(val);
  const b = semverParts(min);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

function renderAcessosCard(acessos) {
  const last = acessos.map((a) => a.registrado_em).filter(Boolean).sort().pop();
  const rows = acessos
    .map(
      (a) => `<div class="acc">
        <div class="acc-line">${accDot(a.up)}<strong>${esc(a.nome || a.url || '?')}</strong>
          <span class="acc-type">${esc(accessTypeLabel(a.tipo || 'outro'))}</span>
          ${a.url ? `<a class="acc-url" href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.url)}</a>` : ''}</div>
        ${a.nota ? `<div class="acc-note">${esc(a.nota)}</div>` : ''}
      </div>`
    )
    .join('');
  return stateCard('Access', last, rows);
}

function renderRuntimeCard(rt) {
  const deps = Array.isArray(rt.deployments) ? rt.deployments : [];
  const rows = deps.length
    ? deps
        .map((d) => {
          const m = /^(\d+)\/(\d+)$/.exec(String(d.ready ?? ''));
          const cls = m ? (Number(m[1]) >= Number(m[2]) && Number(m[2]) > 0 ? 'ok' : 'partial') : '';
          const rs = Number(d.restarts) || 0;
          return `<div class="rt-row"><strong>${esc(d.nome || '?')}</strong>
            <span class="rt-ready ${cls}" title="ready pods">${esc(d.ready ?? '—')}</span>
            <span class="rt-meta">${rs} restart${rs === 1 ? '' : 's'}</span>
            ${d.idade ? `<span class="rt-meta" title="age">${esc(d.idade)}</span>` : ''}</div>`;
        })
        .join('')
    : '<div class="state-empty">nothing running</div>';
  const imgs =
    Array.isArray(rt.imagens) && rt.imagens.length
      ? `<div class="rt-images" title="images">${rt.imagens.map((i) => esc(i)).join(' · ')}</div>`
      : '';
  return stateCard('Runtime', rt.atualizado_em, rows + imgs);
}

function renderAmbienteCard(amb) {
  const minimos = amb.minimos && typeof amb.minimos === 'object' ? amb.minimos : {};
  const rows = Object.keys(amb)
    .filter((k) => k !== 'minimos' && k !== 'atualizado_em' && (typeof amb[k] === 'string' || typeof amb[k] === 'number'))
    .map((k) => {
      const min = minimos[k];
      const bad = min != null && belowMin(amb[k], min);
      const minHtml = min != null ? `<span class="env-min${bad ? ' bad' : ''}" title="required minimum">min ${esc(min)}</span>` : '';
      return `<div class="env-row"><span class="env-k">${esc(k)}</span><span class="env-val${bad ? ' bad' : ''}">${esc(amb[k])}</span>${minHtml}</div>`;
    })
    .join('');
  return stateCard('Environment', amb.atualizado_em, rows || '<div class="state-empty">no data</div>');
}

function renderOrigemCard(o) {
  const up =
    typeof o.upstream === 'string' && /^https?:\/\//i.test(o.upstream)
      ? `<a class="acc-url" href="${esc(o.upstream)}" target="_blank" rel="noopener">${esc(o.upstream)}</a>`
      : o.upstream
        ? `<span class="env-val">${esc(o.upstream)}</span>`
        : '<span class="state-empty">local repo</span>';
  const cl = o.clonado_em ? `<div class="rt-meta">cloned on ${esc(o.clonado_em)}</div>` : '';
  return stateCard('Origin', o.atualizado_em, `<div class="env-row"><span class="env-k">upstream</span>${up}</div>${cl}`);
}

function renderStateGrid(repo) {
  const cards = [];
  if (repo.acessos?.length) cards.push(renderAcessosCard(repo.acessos));
  const e = repo.estado || {};
  if (e.runtime && typeof e.runtime === 'object') cards.push(renderRuntimeCard(e.runtime));
  if (e.ambiente && typeof e.ambiente === 'object') cards.push(renderAmbienteCard(e.ambiente));
  if (e.origem && typeof e.origem === 'object') cards.push(renderOrigemCard(e.origem));
  return cards.length ? `<div class="state-grid">${cards.join('')}</div>` : '';
}

// repo's progress summary line (aggregated by the server): tasks · DAG nodes · checks
function renderProgressLine(repo) {
  const p = repo.progress;
  if (!p || !p.tasks?.total) return '';
  const segs = [`<b>${p.tasks.done}/${p.tasks.total}</b> tasks`];
  if (p.dag?.total) segs.push(`DAG <b>${p.dag.done}/${p.dag.total}</b> nodes`);
  const g = p.gr || {};
  if (g.pass + g.falha + g.aceito + g.pendente > 0) {
    segs.push(
      `checks <b class="gr-pass">${g.pass} pass</b>` +
        (g.falha ? ` · <b class="gr-falha">${g.falha} failed</b>` : '') +
        (g.aceito ? ` · <b class="gr-aceito">${g.aceito} accepted</b>` : '') +
        ` · <b class="gr-pendente">${g.pendente} pending</b>`
    );
  }
  const tempo = repoTimeHtml(repo);
  if (tempo) segs.push(`<span data-repo-time>${tempo}</span>`);
  return `<div class="progress-line">${segs.join('<span class="prog-sep">·</span>')}</div>`;
}

// Pending: questions awaiting the human + accepted risks from the tasks' reviews
function renderPendencias(repo) {
  const waits = (repo.tasks || []).filter((t) => t.awaiting);
  const risks = (repo.tasks || []).flatMap((t) => (t.risks || []).map((r) => ({ t, r })));
  if (!waits.length && !risks.length) return '';
  const parts = ['<h2>Pending</h2>'];
  for (const t of waits) {
    const q = (t.awaitingMsgs || [])[0];
    const preview = q?.body ? ` <span class="pend-preview">— “${esc(truncWord(q.body, 90))}”</span>` : '';
    parts.push(
      `<div class="pend pend-wait"><a data-sala="${esc(t.slug)}" title="open ${esc(t.slug)}'s Room">✋ ${esc(t.title)}: ${t.awaiting} question${t.awaiting === 1 ? '' : 's'} awaiting you</a>${preview}</div>`
    );
  }
  for (const { t, r } of risks)
    parts.push(
      `<div class="pend pend-risk"><span class="pend-tag">accepted risk</span><span class="pend-task" title="${esc(t.slug)}">${esc(t.title)}</span> — ${marked.parseInline(r)}</div>`
    );
  return parts.join('');
}

// compact access line in the task view (next to the breadcrumb)
function renderAccessChips(repo) {
  const acessos = repo?.acessos || [];
  if (!acessos.length) return '';
  return `<span class="crumb-access">${acessos
    .map(
      (a) =>
        `<span class="acc-mini">${accDot(a.up)}${
          a.url
            ? `<a href="${esc(a.url)}" target="_blank" rel="noopener" title="${esc([a.url, a.nota].filter(Boolean).join(' — '))}">${esc(a.nome || a.url)}</a>`
            : esc(a.nome || '')
        }</span>`
    )
    .join('')}</span>`;
}

function renderRepoOverview(repo) {
  const parts = [];
  const meta = [];
  if (repo.stack?.length) meta.push(repo.stack.map((s) => `<span class="badge">${esc(s)}</span>`).join(''));
  if (repo.git) {
    meta.push(
      `<span class="badge git" title="workspace: ${esc(repo.workspace)}">⎇ ${esc(repo.git.branch)}</span>` +
        (repo.git.lastCommit ? `<span class="git-commit" title="last commit">${esc(repo.git.lastCommit)}</span>` : '')
    );
  }
  if (repo.tokens?.total) {
    meta.push(
      `<span class="badge" title="repo's tokens (in ${fmtTok(repo.tokens.in)} / out ${fmtTok(repo.tokens.out)})">Σ ${fmtTok(repo.tokens.total)} tok${repo.usd != null ? ` · ~${fmtUsd(repo.usd)}` : ''}</span>`
    );
  }
  if (meta.length) parts.push(`<div class="repo-meta">${meta.join(' ')}</div>`);

  parts.push(renderProgressLine(repo));
  parts.push(renderStateGrid(repo)); // world state (push): Access / Runtime / Environment / Origin

  if (repo.tasks.length) {
    const anyTok = repo.tasks.some((t) => t.tokens?.total);
    const anyDag = repo.tasks.some((t) => t.dag?.nodes?.length);
    parts.push(
      `<h2>Tasks</h2><table class="task-table"><thead><tr><th>#</th><th>Task</th><th>Status</th>${anyDag ? '<th>DAG</th>' : ''}${anyTok ? '<th class="num">Tokens</th>' : ''}</tr></thead><tbody>` +
        repo.tasks
          .map((t, i) => {
            const s = st(t.status);
            const tok = anyTok ? `<td class="num">${t.tokens?.total ? fmtTok(t.tokens.total) : '—'}</td>` : '';
            let dag = '';
            if (anyDag) {
              if (t.dag?.nodes?.length) {
                const ds = dagStats(t.dag);
                dag = `<td><span class="dag-badge ${ds.alert ? 'dag-block' : ds.done === ds.total ? 'dag-done' : 'dag-todo'}" title="${ds.alert ? 'guardrail failed' : 'completed nodes'}">${ds.done}/${ds.total}</span></td>`;
              } else dag = '<td class="muted">—</td>';
            }
            // blocked by a dependency: "awaiting <nn>" badge + dimmed line
            const open = openDeps(t);
            const dep = t.blocked
              ? ` <span class="dep-badge" title="awaiting: ${esc(open.map((d) => d.title).join(', '))}">🔒 awaiting ${esc(open.map((d) => depNum(d.slug)).join(', '))}</span>`
              : '';
            return `<tr class="task-row${t.blocked ? ' blocked' : ''}" data-task="${esc(t.slug)}"><td class="num">${i + 1}</td>
              <td>${esc(t.title)}</td><td><span class="status ${s.cls}">${s.icon} ${s.label}</span>${dep}</td>${dag}${tok}</tr>`;
          })
          .join('') +
        `</tbody></table>`
    );
  } else {
    parts.push('<p class="muted">No tasks in this repo yet.</p>');
  }

  parts.push(renderPendencias(repo)); // questions awaiting you + accepted risks from the reviews
  parts.push(renderRoster(repo)); // full roster of the repo's agents (cards → sheet)

  if (repo.context) parts.push(`<hr class="sep" />${marked.parse(repo.context)}`);
  else parts.push('<p class="muted">No 00-contexto.md yet.</p>');

  return `<div class="md wide">${parts.join('')}</div>`;
}

// discreet breadcrumb at the top of the content: "repo › task" (repo clickable → overview);
// extra = right-aligned content (compact access line in the task view)
function renderCrumb(repo, task, extra = '') {
  const t = task ? `<span class="crumb-sep">›</span><span>${esc(task.title)}</span>${taskTimerHtml(task)}` : '';
  return `<div class="crumb"><a class="crumb-repo" title="repo overview">${esc(repo.title)}</a>${t}${extra}</div>`;
}

function wireCrumb(content) {
  const a = content.querySelector('.crumb-repo');
  if (a)
    a.onclick = () => {
      state.task = null;
      state.tab = null;
      reconcile();
      saveSel();
      renderAll();
    };
}

async function renderContent() {
  const content = $('#content');
  const scrollPos = content.scrollTop;
  if (!state.repos.length) {
    content.innerHTML = '<div class="empty"><p>no repos — create one with the pilot</p></div>';
    return;
  }
  const repo = currentRepo();
  if (!repo) {
    content.innerHTML = '<div class="empty"><p>select a repo on the side</p></div>';
    return;
  }
  const task = currentTask();
  if (!task) {
    content.innerHTML = renderCrumb(repo, null) + renderRepoOverview(repo);
    wireCrumb(content);
    wireAgentClicks(content); // roster cards → sheet
    // click on a task-table row → selects the task
    content.querySelectorAll('.task-row').forEach((row) => {
      row.onclick = () => {
        state.task = row.dataset.task;
        state.tab = null;
        reconcile();
        saveSel();
        renderAll();
      };
    });
    // "awaiting you" pending item → the originating task's Room
    content.querySelectorAll('[data-sala]').forEach((a) => {
      a.onclick = () => {
        state.task = a.dataset.sala;
        state.tab = 'panel:sala';
        salaStick = true;
        reconcile();
        saveSel();
        renderAll();
      };
    });
    content.scrollTop = scrollPos;
    return;
  }
  // common top of any task tab: breadcrumb (+ repo's access) + agent strip + dependencies
  const pre = renderCrumb(repo, task, renderAccessChips(repo)) + renderAgentStrip(repo, task) + renderDepsLine(task);
  const wireTop = () => {
    wireCrumb(content);
    wireAgentClicks(content);
    wireDeps(content);
  };
  if (state.tab === 'panel:sala') {
    content.innerHTML = pre + renderSala(task);
    wireTop();
    wireSala(content);
    content.scrollTop = salaStick ? content.scrollHeight : scrollPos;
    return;
  }
  if (state.tab === 'panel:dag') {
    content.innerHTML = pre + renderDag(task);
    await renderMermaidIn(content); // the derived graph becomes SVG here
  } else if (state.tab === 'panel:diff') {
    content.innerHTML = pre + renderDiff(task);
    wireDiff(content);
  } else if (state.tab === 'panel:timeline') {
    content.innerHTML = pre + renderTimeline(task);
    wireTimeline(content);
  } else if (state.tab === 'panel:logs') {
    content.innerHTML = pre + renderLogs(task);
    wireLogs(content);
  } else if (state.tab === 'panel:custos') {
    content.innerHTML = pre + renderCustos(task);
  } else if (!task.files.length) {
    content.innerHTML = pre + '<div class="empty"><p>task with no files yet — the statement shows up here as soon as it exists</p></div>';
  } else {
    const file = task.files.find((f) => f.name === state.tab) || task.files[0];
    content.innerHTML = pre + `<div class="md">${marked.parse(file.content)}</div>`;
    await renderMermaidIn(content);
  }
  wireTop();
  content.scrollTop = scrollPos;
}

// --- off-tab alert: blinking title + amber favicon while there's something pending ---
// While totals.awaiting > 0 the title alternates every 2s with "✋ awaiting you" and the
// tab gets an amber favicon (drawn on canvas — no new file).
const ICON_ALERT = '✋ awaiting you';
let normalTitle = 'Workspace for Agents';
let titleTimer = null;
let titleFlipped = false;
let amberIcon = null;
const baseIcon = document.querySelector('link[rel="icon"]')?.getAttribute('href') || '';

function amberFavicon() {
  if (amberIcon) return amberIcon;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#fbbf24'; // --wait
  g.beginPath();
  g.arc(32, 32, 31, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#0f1115'; // --bg
  g.fillRect(27, 13, 10, 26); // stem of the "!"
  g.fillRect(27, 44, 10, 10); // dot
  amberIcon = c.toDataURL('image/png');
  return amberIcon;
}

// swaps the <link rel=icon> by replacing the node (just changing the href doesn't always repaint the tab)
function setFavicon(href) {
  document.querySelectorAll('link[rel="icon"]').forEach((l) => l.remove());
  const l = document.createElement('link');
  l.rel = 'icon';
  l.href = href;
  document.head.appendChild(l);
}

function updateAwaitAlert(n) {
  if (n > 0 && !titleTimer) {
    setFavicon(amberFavicon());
    titleTimer = setInterval(() => {
      titleFlipped = !titleFlipped;
      document.title = titleFlipped ? ICON_ALERT : normalTitle;
    }, 2000);
  } else if (!n && titleTimer) {
    clearInterval(titleTimer);
    titleTimer = null;
    titleFlipped = false;
    if (baseIcon) setFavicon(baseIcon);
    document.title = normalTitle;
  }
}

function renderHeader() {
  const repo = currentRepo();
  normalTitle = repo ? `${repo.title} - Workspace for Agents` : 'Workspace for Agents';
  if (!titleFlipped) document.title = normalTitle; // don't override the alert's blink
  // "awaiting you": unanswered questions/decisions to the human, in any repo.
  // Click navigates to the originating task's Room (priority: the selected repo).
  const aw = $('#await-badge');
  const n = state.totals?.awaiting || 0;
  aw.textContent = n ? `✋ ${n} awaiting you` : '';
  aw.title = n ? "open the Room of the task awaiting your reply" : '';
  aw.onclick = !n
    ? null
    : () => {
        const hit = [currentRepo(), ...state.repos]
          .filter(Boolean)
          .flatMap((r) => (r.tasks || []).filter((t) => t.awaiting).map((t) => ({ r, t })))[0];
        if (!hit) return;
        state.repo = hit.r.slug;
        state.task = hit.t.slug;
        state.tab = 'panel:sala';
        salaStick = true;
        reconcile();
        saveSel();
        renderAll();
      };
  updateAwaitAlert(n);
  // project total (all repos): summed task time + tokens + estimated USD
  // (USD only with tools/prices.json). The live tasks' time ticks every 30s.
  const pc = $('#proj-cost');
  const tot = state.totals;
  const projMs = state.repos.reduce((a, r) => a + sumElapsed(r.tasks), 0);
  const partes = [];
  if (projMs) partes.push(`Σ ${fmtDur(projMs)}`);
  if (tot?.tokens?.total) partes.push(`${fmtTok(tot.tokens.total)} tok`);
  if (tot?.tokens?.total && tot.usd != null) partes.push(`~${fmtUsd(tot.usd)}`);
  pc.textContent = partes.join(' · ');
  const dicas = [];
  if (projMs) dicas.push(`summed time across the project's tasks: ${fmtDur(projMs)}`);
  if (tot?.tokens?.total) dicas.push(`in ${fmtTok(tot.tokens.in)} / out ${fmtTok(tot.tokens.out)}`);
  pc.title = dicas.join(' · ');
}

// 30s tick: only the time bits, no re-render (doesn't touch selection, tab,
// scroll, Room drafts or Diff expansions)
function refreshTimes() {
  renderHeader();
  const rt = document.querySelector('[data-repo-time]');
  if (rt) rt.innerHTML = repoTimeHtml(currentRepo());
  const tt = document.querySelector('#task-timer');
  if (tt) tt.outerHTML = taskTimerHtml(currentTask());
}

async function renderAll() {
  renderHeader();
  renderRepos();
  renderTasksCol();
  renderTabs();
  await renderContent();
  renderSheet(); // an open agent sheet survives the SSE re-render
}

let loadSeq = 0;
let loadRetry = null;
async function load() {
  clearTimeout(loadRetry);
  const seq = ++loadSeq;
  let data;
  if (STATIC) {
    data = window.__DATA__ || { repos: [] }; // repo state embedded by share.mjs
  } else {
    try {
      data = await (await fetch('/api/state')).json();
    } catch {
      // fetch failed (server restarting/busy): without a retry the SSE event that
      // triggered this load is lost and the panel stays stale until the next one
      loadRetry = setTimeout(load, 1000);
      return;
    }
  }
  if (seq !== loadSeq) return; // delayed response from an old load — discard
  state.repos = data.repos || [];
  state.totals = data.totals || null;
  state.pool = Array.isArray(data.guardrailPool) ? data.guardrailPool : [];
  state.agentDefs = data.agentDefs && typeof data.agentDefs === 'object' ? data.agentDefs : {};
  reconcile();
  await renderAll();
}

// Live: SSE reloads the state on every file change, without losing the selection.
// Static: the page itself is the source — HEAD + ETag every 5s; a new version arrives
// as a SOFT update (downloads the html, extracts the state and re-renders in place,
// preserving the viewer's scroll/tab); a real reload only if the CODE changed.
function connect() {
  if (STATIC) {
    let lastTag = null;
    let syncing = false;
    setInterval(async () => {
      if (syncing) return;
      try {
        const r = await fetch(location.href, { method: 'HEAD', cache: 'no-store' });
        const tag = r.headers.get('etag') || r.headers.get('last-modified');
        const changed = lastTag && tag && tag !== lastTag;
        if (tag) lastTag = tag;
        $('#live-dot').classList.remove('off');
        if (!changed) return;
        syncing = true;
        const txt = await (await fetch(location.href, { cache: 'no-store' })).text();
        const hash = txt.match(/__APP_HASH__ = "([^"]+)"/)?.[1];
        const dataLine = txt.match(/window\.__DATA__ = (.+);/)?.[1];
        if (hash && window.__APP_HASH__ && hash !== window.__APP_HASH__) {
          location.reload(); // new code — needs a real reload
          return;
        }
        if (dataLine) {
          window.__DATA__ = JSON.parse(dataLine);
          window.__BUILD_AT__ = txt.match(/__BUILD_AT__ = "([^"]+)"/)?.[1] ?? window.__BUILD_AT__;
          await load();
        }
        syncing = false;
      } catch {
        syncing = false;
        $('#live-dot').classList.add('off');
      }
    }, 5000);
    return;
  }
  const es = new EventSource('/api/events');
  es.onopen = () => {
    $('#live-dot').classList.remove('off');
    // Re-syncs on EVERY (re)connection: broadcasts are ephemeral — a change that
    // happened while the connection was down/reconnecting doesn't repeat, and
    // without this load() the panel would stay stale until the next event (F5).
    load();
  };
  es.onmessage = () => load();
  es.onerror = () => {
    $('#live-dot').classList.add('off');
    es.close();
    setTimeout(connect, 1500);
  };
}

// Esc closes the open agent sheet
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && agentSheet) {
    agentSheet = null;
    renderSheet();
  }
});

// Room: if the user scrolls up, auto-scroll releases; near the bottom, it sticks again
$('#content').addEventListener('scroll', () => {
  if (state.tab !== 'panel:sala') return;
  const c = $('#content');
  salaStick = c.scrollTop + c.clientHeight >= c.scrollHeight - 40;
});

// Shared page: a single repo — the repos column serves no purpose, and the
// first load always opens on the repo overview (reading starts from the start).
if (STATIC) $('#repos-col').style.display = 'none';
else restoreSel();
applyCollapse();
wireToggles();
load();
connect();
setInterval(refreshTimes, 30000); // timers run without depending on a new event
