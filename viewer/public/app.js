/* global marked, mermaid */
// Painel do Workspace for Agents: dois níveis de seleção (repo → task), dados via
// /api/state + SSE (/api/events). Além das abas de .md, cada task tem os
// painéis vivos Sala / Agentes / Logs / Custos. Seleção e filtros persistem
// em localStorage.
mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'loose' });

// Tachado só com ~~duplo~~: o default do marked/GFM aceita ~simples~, o que
// transforma aproximações ("~0,5M ... ~30 B") em texto riscado e quebra o ** no meio.
marked.use({
  tokenizer: {
    del(src) {
      if (!src.startsWith('~')) return false;
      const cap = /^~~(?=[^\s~])([\s\S]*?[^\s~])~~(?!~)/.exec(src);
      if (cap) return { type: 'del', raw: cap[0], text: cap[1], tokens: this.lexer.inlineTokens(cap[1]) };
      return { type: 'text', raw: '~', text: '~' }; // ~ solto = "aproximadamente", nunca risco
    },
  },
});

const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let mermaidSeq = 0;

// --- modo estático (página compartilhada de UM repo) ---
// tools/share.mjs publica ESTA mesma app com o state do repo embutido em
// window.__DATA__: sem SSE e sem POST /api/bus (a Sala fica só de leitura, as
// perguntas ao humano aparecem como registro), atualização por ETag da própria
// página. __NO_COSTS__ = publicado com --sem-custos (painel Custos fora).
const STATIC = !!window.__STATIC__;
const NO_COSTS = !!window.__NO_COSTS__;

const LS_KEY = 'wfa:sel';
const LS_LOGS = 'wfa:logfilter';
const state = {
  repos: [],
  totals: null, // agregados do projeto (tokens + usd + aguardando humano) vindos do server
  pool: [], // guardrails/pool.json — resolve título/verificação dos guardrails da DAG
  agentDefs: {}, // .claude/agents/<nome>.md → { description, resumo } (via server)
  repo: null, // slug do repo selecionado
  task: null, // slug da task selecionada; null = visão geral do repo
  tab: null, // nome do .md ativo OU id de painel ("panel:sala", ...)
};

// painéis vivos — abas irmãs das abas de .md, sempre presentes na task
// (o roster de Agentes vive na visão geral do repo; a task mostra só a faixa "atuando")
const PANELS = [
  { id: 'panel:dag', label: 'DAG' },
  { id: 'panel:diff', label: 'Diff' },
  { id: 'panel:timeline', label: 'Linha do tempo' },
  { id: 'panel:sala', label: 'Sala' },
  { id: 'panel:logs', label: 'Logs' },
  { id: 'panel:custos', label: 'Custos' },
].filter((p) => !(NO_COSTS && p.id === 'panel:custos'));
const isPanel = (tab) => PANELS.some((p) => p.id === tab);

// Linha do tempo: por padrão os logs entram só com warn/error (o resto é ruído
// ao lado das mensagens); o toggle "todos os níveis" persiste.
const LS_TL = 'wfa:timeline';
const tlFilter = { allLevels: false };
try {
  tlFilter.allLevels = localStorage.getItem(LS_TL) === '1';
} catch {}

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];
const logFilter = { levels: [...LOG_LEVELS], source: '' }; // padrão: tudo visível
try {
  const s = JSON.parse(localStorage.getItem(LS_LOGS));
  if (Array.isArray(s?.levels)) logFilter.levels = s.levels.filter((l) => LOG_LEVELS.includes(l));
} catch {}
function saveLogFilter() {
  try {
    localStorage.setItem(LS_LOGS, JSON.stringify({ levels: logFilter.levels }));
  } catch {}
}

// Sala: auto-scroll gruda no fim, a menos que o usuário tenha rolado para cima;
// rascunhos e foco da caixa de resposta sobrevivem ao re-render do SSE.
let salaStick = true;
const salaDrafts = {};
let salaFocusKey = null;

const STATUS = {
  todo: { icon: '○', label: 'todo', cls: 'todo' },
  'em-andamento': { icon: '▶', label: 'em andamento', cls: 'andamento' },
  concluida: { icon: '✓', label: 'concluída', cls: 'concluida' },
};
const st = (s) => STATUS[s] || STATUS.todo;

const AGENT_STATUS = { ocioso: 'idle', executando: 'run', concluido: 'done' };

// colapso das colunas Repos/Tasks — persiste em chaves separadas
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
    btn.title = collapsed[k] ? 'expandir coluna' : 'recolher coluna';
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

// iniciais para o trilho colapsado: 2 letras das 2 primeiras palavras (ou 2 chars)
function repoInitials(title) {
  const words = String(title || '?').split(/[^a-zA-Z0-9]+/).filter(Boolean);
  const s = words.length >= 2 ? words[0][0] + words[1][0] : (words[0] || '?').slice(0, 2);
  return s.toUpperCase();
}

function saveSel() {
  if (STATIC) return; // página compartilhada não guarda seleção no navegador de quem lê
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

// corta em fronteira de palavra (~n chars) com reticências
function truncWord(s, n = 24) {
  if (s.length <= n) return s;
  const cut = s.slice(0, n + 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > 8 ? cut.slice(0, sp) : s.slice(0, n)).trimEnd() + '…';
}

function fileH1(file) {
  return (file.content.match(/^#\s+(.+)$/m) || [])[1]?.trim() || '';
}

// rótulo curto da aba: H1 cortado no primeiro "—" ("Plano", "Journal"...);
// 00-enunciado.md (H1 = título da task) vira "Enunciado"; fora do padrão,
// primeiro segmento truncado ~24 chars em palavra. O H1 completo fica no conteúdo.
function tabLabel(file) {
  if (file.name === '00-enunciado.md') return 'Enunciado';
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
  if (s < 60) return `${Math.floor(s)}s atrás`;
  if (s < 3600) return `${Math.floor(s / 60)}min atrás`;
  if (s < 86400) return `${Math.floor(s / 3600)}h atrás`;
  return `${Math.floor(s / 86400)}d atrás`;
}

// --- tempo (task, repo, projeto) ---
// O server manda timing = { start, last, targetMin, running } por task: start é o
// primeiro evento real (mensagem/log/custo). O decorrido de uma task viva é
// recalculado no cliente (tick de 30s), sem depender de novo evento no SSE.
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

// verde até 75% do alvo · âmbar acima · vermelho estourado (sem alvo: neutro)
function timeClass(ms, targetMs) {
  if (!targetMs) return 'tt-none';
  const p = ms / targetMs;
  return p > 1 ? 'tt-over' : p > 0.75 ? 'tt-warn' : 'tt-ok';
}

// cronômetro da task (topo, junto do breadcrumb): decorrido vs alvo + barra com
// marcos a 25/50/75%. Task concluída mostra a duração total, estática.
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
        .map((m) => `<u style="left:${m}%" title="${fmtDur((targetMs * m) / 100)} (${m}% do tempo-alvo)"></u>`)
        .join('')}</span>`
    : '';
  const tip = [
    `início ${shortTs(t.start).slice(0, 5)}`,
    t.running ? 'em andamento' : `último evento ${shortTs(t.last).slice(0, 5)}`,
    targetMs ? `tempo-alvo ${fmtDur(targetMs)}` : 'sem tempo-alvo no enunciado',
  ].join(' · ');
  return `<span class="task-timer ${cls}${t.running ? ' running' : ''}" id="task-timer" title="${esc(tip)}">
    <span class="tt-icon">⏱</span><span class="tt-elapsed">${fmtDur(ms)}</span>${alvo}${bar}</span>`;
}

// segmento de tempo da linha de progresso do repo: soma das durações das tasks
// (a ativa entra com o decorrido) contra a soma dos tempos-alvo
function repoTimeHtml(repo) {
  const tasks = repo?.tasks || [];
  const ms = sumElapsed(tasks);
  if (!ms) return '';
  const targetMs = sumTarget(tasks.filter((t) => t.timing?.start));
  const cls = timeClass(ms, targetMs);
  const alvo = targetMs ? ` <span class="rt-target">/ ${fmtDur(targetMs)} alvo</span>` : '';
  return `tempo <b class="${cls}">${fmtDur(ms)}</b>${alvo}`;
}

// --- dependências entre tasks (meta.depends_on, resolvido pelo server) ---
const openDeps = (t) => (t.depends_on || []).filter((d) => !d.missing && d.status !== 'concluida');
const depNum = (slug) => (String(slug).match(/^(\d+)/) || [])[1] || slug;

// linha discreta no topo da visão da task: "Depende de: <links>"
function renderDepsLine(task) {
  const deps = task.depends_on || [];
  if (!deps.length) return '';
  const links = deps.map((d) => {
    if (d.missing) return `<span class="dep-missing" title="task não encontrada no repo">${esc(d.title)}</span>`;
    const s = st(d.status);
    const ok = d.status === 'concluida';
    return `<a class="dep-link ${ok ? 'dep-ok' : 'dep-wait'}" data-task="${esc(d.slug)}" title="${esc(d.slug)}: ${s.label}">${s.icon} ${esc(d.title)}</a>`;
  });
  return `<div class="deps-line">Depende de: ${links.join('<span class="dep-sep">·</span>')}</div>`;
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

// valida a seleção contra os dados atuais (repo/task/aba podem ter sumido)
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

// --- coluna de repos (colapsável: trilho de iniciais + dot) ---
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
        let tip = `${r.title} — ${total ? `${total} task${total === 1 ? '' : 's'}` : 'sem tasks'}`;
        if (r.awaiting) tip += ` · ✋ ${r.awaiting} aguardando você`;
        if (allDone) tip += ' · ✓ concluído';
        return `<button class="repo-rail${active}${attn}" data-repo="${esc(r.slug)}" title="${esc(tip)}">
          <span class="rail-ini">${esc(repoInitials(r.title))}</span><span class="dot ${dot}"></span></button>`;
      }
      const badges = [];
      badges.push(total ? `<i class="sb">${total} task${total === 1 ? '' : 's'}</i>` : '<i class="sb sb-muted">sem tasks</i>');
      if (blocked) badges.push(`<i class="sb sb-lock">${blocked} 🔒</i>`);
      if (r.awaiting) badges.push(`<i class="sb sb-wait" title="mensagens aguardando sua resposta">✋ ${r.awaiting} aguardando você</i>`);
      if (allDone) badges.push('<i class="sb sb-done">✓ concluído</i>');
      else if (r.status) badges.push(`<i class="sb sb-st" title="status do repo">${esc(r.status)}</i>`);
      if (r.tokens?.total) badges.push(`<i class="sb sb-tok" title="tokens somados do repo">${fmtTok(r.tokens.total)} tok</i>`);
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

// --- coluna de tasks do repo selecionado (colapsável: trilho de ícones de status) ---
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
    items.push(`<button class="task-rail overview${state.task === null ? ' active' : ''}" data-task="" title="Visão geral">📋</button>`);
    for (const t of repo.tasks) {
      const s = st(t.status);
      const icon = t.blocked ? '🔒' : s.icon;
      let tip = t.blocked ? `${t.title} — aguarda ${openDeps(t).map((d) => d.title).join(', ')}` : `${t.title} — ${s.label}`;
      if (t.awaiting) tip += ` · ✋${t.awaiting} aguardando você`;
      items.push(`<button class="task-rail ${s.cls}${t.blocked ? ' blocked' : ''}${t.awaiting ? ' attn' : ''}${t.slug === state.task ? ' active' : ''}"
        data-task="${esc(t.slug)}" title="${esc(tip)}">${icon}</button>`);
    }
  } else {
    items.push(`<button class="task overview${state.task === null ? ' active' : ''}" data-task="">📋 Visão geral</button>`);
    for (const t of repo.tasks) {
      const s = st(t.status);
      // task bloqueada por dependência não-concluída: cadeado + esmaecida
      const open = openDeps(t);
      const icon = t.blocked ? '🔒' : s.icon;
      let tip = t.blocked ? `${t.slug}: aguarda ${open.map((d) => d.title).join(', ')}` : `${t.slug}: ${s.label}`;
      if (t.awaiting) tip += ` — ${t.awaiting} pergunta(s) aguardando você`;
      const chips = [];
      if (t.awaiting) chips.push(`<span class="pill-wait" title="aguardando sua resposta">✋${t.awaiting}</span>`);
      if (t.dag?.nodes?.length) {
        const ds = dagStats(t.dag);
        chips.push(`<span class="dag-badge ${ds.alert ? 'dag-block' : ds.done === ds.total ? 'dag-done' : 'dag-todo'}" title="nós da DAG concluídos">${ds.done}/${ds.total}</span>`);
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

// --- abas: .md da task + painéis vivos (irmãs, separadas por um traço) ---
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
    // stub: arquivo ainda no template — aba esmaecida (mesma cara das tasks bloqueadas)
    const tip = f.stub ? 'ainda sem conteúdo' : h1 ? `${f.name} — ${h1}` : f.name;
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
      else stub = ' stub'; // task sem commits no workspace — aba esmaecida
    }
    if (p.id === 'panel:timeline') {
      const n = timelineItems(task).length;
      if (n) extra = `<span class="minibadge">${n}</span>`;
      else stub = ' stub'; // task ainda sem nenhum evento — aba esmaecida
    }
    if (p.id === 'panel:logs') {
      if (warns) extra += `<span class="minibadge warn">⚠${warns}</span>`;
      if (errs) extra += `<span class="minibadge err">✕${errs}</span>`;
    }
    if (p.id === 'panel:sala' && task.awaiting) alert = ' waiting'; // pergunta ao humano sem resposta → âmbar
    if (p.id === 'panel:dag' && task.dag?.nodes?.length) {
      const s = dagStats(task.dag);
      extra = `<span class="minibadge${s.alert ? ' err' : ''}">${s.done}/${s.total}</span>`;
      if (s.alert) alert = ' alert'; // guardrail em falha não-aceita → aba vermelha (prioridade sobre o azul)
      else if (s.running) alert = ' live'; // nó executando → badge pulsa em azul
    }
    return `<button class="tab panel-tab${alert}${stub}${p.id === state.tab ? ' active' : ''}" data-tab="${p.id}">${p.label}${extra}</button>`;
  });
  el.innerHTML = mdTabs.join('') + (mdTabs.length ? '<span class="tab-sep"></span>' : '') + panelTabs.join('');
  el.querySelectorAll('button.tab').forEach((b) => {
    b.onclick = () => {
      state.tab = b.dataset.tab;
      if (state.tab === 'panel:sala') salaStick = true; // ao entrar na Sala, gruda no fim
      saveSel();
      renderAll();
    };
  });
}

// --- painel Sala: timeline da conversa entre agentes (e humano) ---
function renderSala(task) {
  const msgs = task.messages || [];
  if (!msgs.length) return '<div class="panel-empty">sem mensagens ainda — a conversa dos agentes aparece aqui</div>';
  const items = msgs.map((m, i) => {
    const kind = MSGKIND(m.kind);
    const ask = m.to === 'humano' && (m.kind === 'question' || m.kind === 'decision');
    const key = `${state.repo}/${state.task}/${m.ts || ''}#${i}`;
    const stateBadge =
      m.kind === 'status' && m.meta?.state ? `<span class="msg-state">${esc(m.meta.state)}</span>` : '';
    // resposta a pergunta vira report; resposta a pedido de decisão vira decision.
    // Página estática não escreve no bus: a pendência vira registro, sem caixa de resposta.
    const reply = !ask
      ? ''
      : STATIC
        ? '<div class="reply-static">aguardando resposta</div>'
        : `<form class="reply" data-to="${esc(m.from)}" data-kind="${m.kind === 'question' ? 'report' : 'decision'}">
          <input class="reply-input" data-key="${esc(key)}" placeholder="responder a ${esc(m.from)}…" autocomplete="off" />
          <button type="submit">enviar</button><span class="reply-err"></span></form>`;
    return `<div class="msg kind-${kind}${ask ? ' ask' : ''}">
      <div class="msg-head"><span class="msg-ts" title="${esc(m.ts || '')}">${shortTs(m.ts)}</span>
        <span class="msg-route">${esc(m.from || '?')} → ${esc(m.to || '?')}</span>
        <span class="msg-kind k-${kind}">${esc(m.kind || '?')}</span>${stateBadge}</div>
      <div class="msg-body">${esc(m.body || '')}</div>${reply}</div>`;
  });
  return `<div class="sala">${items.join('')}</div>`;
}
const MSGKIND = (k) => (['report', 'question', 'decision', 'approval', 'status'].includes(k) ? k : 'report');

function wireSala(content) {
  if (STATIC) return; // sem caixa de resposta na página compartilhada
  content.querySelectorAll('form.reply').forEach((f) => {
    const input = f.querySelector('.reply-input');
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
      const err = f.querySelector('.reply-err');
      const btn = f.querySelector('button');
      err.textContent = '';
      btn.disabled = true;
      try {
        const r = await fetch('/api/bus', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repo: state.repo, task: state.task, from: 'humano', to: f.dataset.to, kind: f.dataset.kind, body }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
        input.value = '';
        delete salaDrafts[input.dataset.key];
        salaStick = true; // a resposta chega via SSE — rola para ela
      } catch (e2) {
        err.textContent = e2.message;
      }
      btn.disabled = false;
    };
  });
}

// --- Agentes: roster do REPO (visão geral) + faixa "atuando" na task + ficha ---
// Fonte: agents.json do repo (bus) + definições .claude/agents (state.agentDefs).
let agentSheet = null; // nome do agente com ficha aberta — sobrevive ao re-render do SSE

// agentes com atividade na task: last_task = task atual, ou presença em costs/messages dela
function agentsInTask(repo, task) {
  const names = new Set();
  for (const c of task.costs || []) if (c.agente) names.add(c.agente);
  // "dag" não é agente: é a origem sintética das transições de nó no bus
  for (const m of task.messages || []) if (m.from && m.from !== 'humano' && m.from !== 'dag') names.add(m.from);
  for (const a of repo?.agents || []) if (a.last_task === task.slug) names.add(a.name);
  for (const a of task.agents || []) names.add(a.name); // legado — agents.json da task
  return [...names];
}

// roster completo do repo — cards clicáveis (abre a ficha) na visão geral
function renderRoster(repo) {
  const agents = repo.agents || [];
  if (!agents.length) return '<h2>Agentes</h2><p class="muted">sem agentes ainda</p>';
  const byRepo = tokensByAgent((repo.tasks || []).flatMap((t) => t.costs || []));
  const bySlug = new Map((repo.tasks || []).map((t) => [t.slug, t]));
  const cards = agents.map((a) => {
    const s = a.status || 'ocioso';
    const cls = AGENT_STATUS[s] || 'idle';
    const desc = a.role || state.agentDefs?.[a.name]?.description || '';
    const tok = byRepo[a.name]?.total || 0;
    const lastTitle = a.last_task ? bySlug.get(a.last_task)?.title || a.last_task : '';
    return `<div class="agent-card clickable" data-agent="${esc(a.name)}" title="abrir ficha de ${esc(a.name)}">
      <div class="agent-head"><span class="adot ${cls}"></span><strong>${esc(a.name)}</strong>
        <span class="agent-status">${esc(s)}</span></div>
      ${desc ? `<div class="agent-role clamp">${esc(desc)}</div>` : ''}
      ${lastTitle ? `<div class="agent-last" title="${esc(a.last_task)}">último trabalho: ${esc(lastTitle)}</div>` : ''}
      <div class="agent-foot"><span title="${esc(a.last_active || '')}">${a.last_active ? relTime(a.last_active) : '—'}</span>
        <span class="agent-tokens">${tok ? `${fmtTok(tok)} tok` : ''}</span></div></div>`;
  });
  return `<h2>Agentes</h2><div class="agents">${cards.join('')}</div>`;
}

// faixa fina no topo da task: chips dos agentes atuando nela (clicáveis → ficha)
function renderAgentStrip(repo, task) {
  const names = agentsInTask(repo, task);
  if (!names.length) return '';
  const byName = new Map([...(task.agents || []), ...(repo?.agents || [])].map((a) => [a.name, a]));
  const chips = names.map((n) => {
    const a = byName.get(n) || {};
    const s = a.status || 'ocioso';
    const cls = AGENT_STATUS[s] || 'idle';
    return `<button class="agent-chip" data-agent="${esc(n)}" title="${esc(n)}: ${esc(s)} — abrir ficha">
      <span class="adot ${cls}"></span>${esc(n)}</button>`;
  });
  return `<div class="agent-strip"><span class="strip-label">atuando nesta task</span>${chips.join('')}</div>`;
}

function wireAgentClicks(root) {
  root.querySelectorAll('[data-agent]').forEach((el) => {
    el.onclick = () => {
      agentSheet = el.dataset.agent;
      renderSheet();
    };
  });
}

// ficha do agente: definição (.claude/agents) + estado do bus + atuação/custos/timeline/logs
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
    : '<p class="sheet-empty">sem definição registrada — mostrando só os dados do bus</p>';
  const actedHtml = acted.length
    ? acted
        .map((t) => {
          const ts = st(t.status);
          return `<a class="sheet-task" data-task="${esc(t.slug)}" title="${esc(t.slug)}"><span class="status ${ts.cls}">${ts.icon}</span> ${esc(t.title)}</a>`;
        })
        .join('')
    : '<p class="sheet-empty">ainda não atuou em nenhuma task deste repo</p>';
  const msgsHtml = !task
    ? '<p class="sheet-empty">abra uma task para ver a timeline</p>'
    : msgs.length
      ? msgs
          .map(
            (m) => `<div class="sheet-msg k-${MSGKIND(m.kind)}"><span class="mts" title="${esc(m.ts || '')}">${shortTs(m.ts)}</span>
              <span class="msg-kind k-${MSGKIND(m.kind)}">${esc(m.kind || '?')}</span> → ${esc(m.to || '?')}
              <div class="mbody">${esc(m.body || '')}</div></div>`
          )
          .join('')
      : '<p class="sheet-empty">sem mensagens deste agente nesta task</p>';
  const logsHtml = !task
    ? '<p class="sheet-empty">abra uma task para ver os logs</p>'
    : logs.length
      ? logs
          .map(
            (l) => `<div class="sheet-log lv-${esc(l.level || 'info')}"><span class="mts" title="${esc(l.ts || '')}">${shortTs(l.ts)}</span>
              <span class="llv">${esc(l.level || 'info')}</span> ${esc(l.body || '')}</div>`
          )
          .join('')
      : '<p class="sheet-empty">sem logs deste agente nesta task</p>';

  el.innerHTML = `
    <div class="sheet-head"><span class="adot ${cls}"></span><strong>${esc(name)}</strong>
      <span class="agent-status">${esc(s)}</span>
      <button class="sheet-close" title="fechar (Esc)">✕</button></div>
    ${bus?.role ? `<div class="sheet-role">${esc(bus.role)}</div>` : ''}
    ${defHtml}
    <div class="sheet-kv">
      <div><span>última atividade</span><b title="${esc(bus?.last_active || '')}">${bus?.last_active ? relTime(bus.last_active) : '—'}</b></div>
      <div><span>último trabalho</span><b title="${esc(bus?.last_task || '')}">${lastTitle ? esc(truncWord(lastTitle, 28)) : '—'}</b></div>
      <div><span>tokens · task selecionada</span><b>${task ? fmtTok(tokTask) : '—'}</b></div>
      <div><span>tokens · total do repo</span><b>${fmtTok(tokRepo)}</b></div>
    </div>
    <h3>Tasks em que atuou</h3>${actedHtml}
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

// --- painel Logs: filtro por nível (persistido) e por origem ---
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
  const select = `<select id="log-source"><option value="">todas as origens</option>${sources
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
    : `<div class="panel-empty">${logs.length ? 'nada passa no filtro atual' : 'sem logs ainda'}</div>`;
  const title = `<span class="log-count">${shown.length}/${logs.length} linhas${counts.warn ? ` · <b class="w">⚠${counts.warn}</b>` : ''}${counts.error ? ` · <b class="e">✕${counts.error}</b>` : ''}</span>`;
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

// --- painel Custos: tokens in/out/total por agente + total da task ---
function renderCustos(task) {
  const by = tokensByAgent(task.costs);
  const names = Object.keys(by).sort((a, b) => by[b].total - by[a].total);
  if (!names.length) return '<div class="panel-empty">sem custos registrados ainda</div>';
  const rows = names
    .map(
      (n) => `<tr><td>${esc(n)}</td><td class="num">${fmtTok(by[n].in)}</td>
        <td class="num">${fmtTok(by[n].out)}</td><td class="num">${fmtTok(by[n].total)}</td></tr>`
    )
    .join('');
  const t = task.tokens || { in: 0, out: 0, total: 0 };
  const usd = fmtUsd(task.usd);
  return `<div class="panel-wrap"><table class="cost-table">
    <thead><tr><th>Agente</th><th class="num">in</th><th class="num">out</th><th class="num">total</th></tr></thead>
    <tbody>${rows}<tr class="total"><td>Total da task</td><td class="num">${fmtTok(t.in)}</td>
      <td class="num">${fmtTok(t.out)}</td><td class="num">${fmtTok(t.total)}</td></tr></tbody></table>
    ${usd ? `<p class="muted">≈ ${usd} estimado pela tabela de preços</p>` : ''}</div>`;
}

// --- painel Diff: commits que a task produziu no workspace do repo ---
// Os commits vêm prontos do server (registro explícito + fallback pela janela da task).
// Expansões vivem por HASH (não por índice) para sobreviverem ao re-render do SSE.
const diffOpen = new Set(); // hashes com o diff aberto
const diffFileClosed = new Set(); // `${hash} ${arquivo}` — arquivos abrem por padrão
const diffAutoTasks = new Set(); // tasks cujo commit mais recente já foi auto-aberto

// quebra o diff unificado em arquivos: cada bloco começa em "diff --git a/x b/x"
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
      // preâmbulo sem cabeçalho de arquivo (raro) — vira um bloco sem nome
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

// resumo do rodapé do --stat: "4 files changed, 96 insertions(+), 4 deletions(-)"
function statSummary(stat) {
  const last = String(stat || '').trim().split('\n').pop() || '';
  const f = /(\d+)\s+files?\s+changed/.exec(last);
  if (!f) return '';
  const ins = /(\d+)\s+insertions?/.exec(last);
  const del = /(\d+)\s+deletions?/.exec(last);
  return (
    `${f[1]} arquivo${f[1] === '1' ? '' : 's'}` +
    (ins ? ` <b class="d-add">+${ins[1]}</b>` : '') +
    (del ? ` <b class="d-del">−${del[1]}</b>` : '')
  );
}

function renderDiffBody(c) {
  const files = splitDiffFiles(c.diff);
  if (!files.length) return '<div class="diff-empty">sem alterações de arquivo neste commit</div>';
  const blocks = files.map((f) => {
    const key = `${c.hash} ${f.path}`;
    const open = !diffFileClosed.has(key);
    const body = open
      // spans são display:block — sem "\n" entre eles (dentro de <pre> viraria linha vazia)
      ? `<pre class="diff-lines">${f.lines.map((l) => `<span class="${diffLineClass(l)}">${esc(l) || ' '}</span>`).join('')}</pre>`
      : '';
    return `<div class="diff-file${open ? ' open' : ''}">
      <button class="diff-file-head" data-file="${esc(key)}" title="${esc(f.path)}">
        <span class="caret">${open ? '▾' : '▸'}</span><code>${esc(f.path || '(sem arquivo)')}</code>
        <span class="d-counts">${f.add ? `<b class="d-add">+${f.add}</b>` : ''}${f.del ? `<b class="d-del">−${f.del}</b>` : ''}</span>
      </button>${body}</div>`;
  });
  const trunc = c.truncated
    ? `<div class="diff-trunc">diff truncado — primeiras ${String(c.diff || '').split('\n').length} de ${c.totalLines} linhas</div>`
    : '';
  const stat = c.stat ? `<pre class="diff-stat">${esc(c.stat)}</pre>` : '';
  return stat + blocks.join('') + trunc;
}

function renderDiff(task) {
  const commits = task.commits || [];
  if (!commits.length)
    return '<div class="panel-empty">sem commits no workspace nesta task — o diff aparece aqui assim que houver</div>';
  const key = `${state.repo}/${task.slug}`;
  if (!diffAutoTasks.has(key)) {
    diffAutoTasks.add(key);
    diffOpen.add(commits[0].hash); // primeira visita: o mais recente já vem aberto
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
    <div class="diff-count">${commits.length} commit${commits.length === 1 ? '' : 's'} no workspace</div>
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

// --- painel Linha do tempo: eixo único mesclando as origens da task ---
// bus (mensagens), logs (padrão: só warn/error), commits do workspace, linhas do
// journal com hora reconhecível e transições de nós da DAG (mensagens from="dag").
const TL_ICON = { bus: '●', dag: '▣', log: '◦', commit: '⎇', journal: '✎' };
const TL_ORIGEM = { bus: 'mensagem', dag: 'DAG', log: 'log', commit: 'commit', journal: 'journal' };
const TL_GAP = 5 * MIN; // acima disso, separador com o buraco de tempo

// linhas do journal com hora: "- 16:03 — texto" ou "**16:03** — texto".
// Sem hora reconhecível, a linha é ignorada (o journal não é um log).
function journalItems(task, refMs) {
  const file = (task.files || []).find((f) => /journal/i.test(f.name));
  if (!file || refMs == null) return [];
  const base = new Date(refMs); // dia local do primeiro evento da task
  const out = [];
  for (const line of String(file.content || '').split('\n')) {
    const m = /^\s*(?:[-*]\s*)?\**(\d{1,2}):(\d{2})\**\s*[—–:-]?\s*(.+)$/.exec(line);
    if (!m) continue;
    const h = Number(m[1]);
    const mi = Number(m[2]);
    const texto = m[3].replace(/^\*\*|\*\*$/g, '').trim();
    if (h > 23 || mi > 59 || !texto) continue;
    let at = new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, mi).getTime();
    if (at < refMs - 12 * 3600e3) at += 86400e3; // entrada depois da virada do dia
    out.push({ at, origin: 'journal', text: texto });
  }
  return out;
}

// todos os eventos da task num eixo só, em ordem cronológica
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
    <button class="chip${tlFilter.allLevels ? ' on' : ''}" id="tl-levels" title="por padrão a linha do tempo só traz logs warn/error">todos os níveis${logs ? ` (${logs} logs)` : ''}</button>
    <span class="log-count">${items.length} evento${items.length === 1 ? '' : 's'}</span></div>`;
  if (!items.length)
    return `<div class="panel-wrap">${controls}<div class="panel-empty">sem eventos ainda — mensagens, logs, commits, journal e transições da DAG aparecem aqui em ordem</div></div>`;
  // agrupamento por proximidade: buraco maior que 5 min vira separador "+Nmin"
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

// --- painel DAG: grafo mermaid + tabela de nós derivados de dag.json ---
const DAG_STATUS = {
  todo: { label: 'todo', cls: 'dag-todo', mm: 'dagtodo' },
  executando: { label: 'executando', cls: 'dag-exec', mm: 'dagexec' },
  concluida: { label: 'concluída', cls: 'dag-done', mm: 'dagdone' },
  bloqueada: { label: 'bloqueada', cls: 'dag-block', mm: 'dagblock' },
};
const dagSt = (s) => DAG_STATUS[s] || DAG_STATUS.todo;
const GR_STATUS = ['pendente', 'pass', 'falha', 'aceito'];
const grSt = (s) => (GR_STATUS.includes(s) ? s : 'pendente');
const GR_ICON = { pass: '✓', falha: '✕', aceito: '~', pendente: '◦' };

function dagGrCounts(nodes) {
  const c = { pass: 0, falha: 0, aceito: 0, pendente: 0 };
  for (const n of nodes) for (const g of n.guardrails || []) if (g) c[grSt(g.status)]++;
  return c;
}

// resumo da DAG: progresso de nós + guardrails; alert = falha não-aceita aberta
function dagStats(dag) {
  const nodes = dag?.nodes || [];
  const done = nodes.filter((n) => n.status === 'concluida').length;
  const running = nodes.some((n) => n.status === 'executando');
  const gr = dagGrCounts(nodes);
  return { total: nodes.length, done, running, gr, alert: gr.falha > 0 };
}

// ordem topológica (DFS pelas dependências); tolera ciclos e deps desconhecidas
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

// escapa o texto de um label mermaid (aspas e caracteres com significado)
const mmEsc = (s) =>
  String(s ?? '').replace(/[#"<>\[\]{}|]/g, (c) => ({ '#': '#35;', '"': '#quot;', '<': '#lt;', '>': '#gt;', '[': '#91;', ']': '#93;', '{': '#123;', '}': '#125;', '|': '#124;' }[c]));

// gera o texto flowchart TD a partir dos nós (ids sintéticos d0..dN — ids do
// JSON podem conter caracteres inválidos para o mermaid)
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

// guardrail expandido na tabela: título/severidade vêm do pool (fallback: só o id)
function renderGuardrail(g, poolBy) {
  const p = poolBy.get(g.id);
  const s = grSt(g.status);
  const tip = [p?.verificacao, g.nota && s !== 'aceito' ? `nota: ${g.nota}` : ''].filter(Boolean).join(' — ');
  const sev = p?.severidade ? ` <span class="gr-sev">${esc(p.severidade)}</span>` : '';
  const nota = s === 'aceito' && g.nota ? `<div class="gr-nota">${esc(g.nota)}</div>` : '';
  return `<div class="gr-line" title="${esc(tip)}"><span class="gr-badge gr-${s}">${GR_ICON[s]} ${esc(s)}</span> ${esc(p?.titulo || g.id)}${sev}${nota}</div>`;
}

function renderDag(task) {
  const nodes = task.dag?.nodes || [];
  if (!nodes.length) return '<div class="panel-empty">sem DAG — gerada na fase de plano</div>';
  const s = dagStats(task.dag);
  const poolBy = new Map((state.pool || []).map((g) => [g.id, g]));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const grTotal = s.gr.pass + s.gr.falha + s.gr.aceito + s.gr.pendente;
  const summary = `<div class="dag-summary">
    <span class="dag-prog${s.done === s.total ? ' ok' : ''}">${s.done}/${s.total} nós concluídos</span>
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
  const table = `<table class="dag-table"><thead><tr><th>Nó</th><th>Status</th><th>Agente</th><th>Depende de</th><th>Guardrails</th></tr></thead><tbody>${rows}</tbody></table>`;
  return `<div class="panel-wrap dag">${summary}${graph}${table}</div>`;
}

// --- estado do mundo (modelo push: estado.json + acessos.json escritos pelos agentes) ---
// Cada card mostra "atualizado há X" do seu atualizado_em — honestidade do push:
// mais de 30 min sem update fica âmbar.
const STALE_MS = 30 * 60 * 1000;
function ageBadge(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const stale = !isNaN(d) && Date.now() - d.getTime() > STALE_MS;
  return `<span class="state-age${stale ? ' stale' : ''}" title="${esc(ts)}">atualizado ${relTime(ts)}</span>`;
}
const stateCard = (title, ts, body) =>
  `<div class="state-card"><div class="state-head"><h3>${title}</h3>${ageBadge(ts)}</div>${body}</div>`;
// dot de saúde do acesso: verde = respondeu ao ping; cinza = down ou nunca verificado
const accDot = (up) =>
  `<span class="acc-dot${up ? ' up' : ''}" title="${up ? 'respondendo' : up === false ? 'sem resposta' : 'não verificado'}"></span>`;

// comparação semver simples: extrai as sequências numéricas ("v1.38.1" → [1,38,1])
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
          <span class="acc-type">${esc(a.tipo || 'outro')}</span>
          ${a.url ? `<a class="acc-url" href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.url)}</a>` : ''}</div>
        ${a.nota ? `<div class="acc-note">${esc(a.nota)}</div>` : ''}
      </div>`
    )
    .join('');
  return stateCard('Acessos', last, rows);
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
            <span class="rt-ready ${cls}" title="pods prontos">${esc(d.ready ?? '—')}</span>
            <span class="rt-meta">${rs} restart${rs === 1 ? '' : 's'}</span>
            ${d.idade ? `<span class="rt-meta" title="idade">${esc(d.idade)}</span>` : ''}</div>`;
        })
        .join('')
    : '<div class="state-empty">nada no ar</div>';
  const imgs =
    Array.isArray(rt.imagens) && rt.imagens.length
      ? `<div class="rt-images" title="imagens">${rt.imagens.map((i) => esc(i)).join(' · ')}</div>`
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
      const minHtml = min != null ? `<span class="env-min${bad ? ' bad' : ''}" title="mínimo exigido">mín ${esc(min)}</span>` : '';
      return `<div class="env-row"><span class="env-k">${esc(k)}</span><span class="env-val${bad ? ' bad' : ''}">${esc(amb[k])}</span>${minHtml}</div>`;
    })
    .join('');
  return stateCard('Ambiente', amb.atualizado_em, rows || '<div class="state-empty">sem dados</div>');
}

function renderOrigemCard(o) {
  const up =
    typeof o.upstream === 'string' && /^https?:\/\//i.test(o.upstream)
      ? `<a class="acc-url" href="${esc(o.upstream)}" target="_blank" rel="noopener">${esc(o.upstream)}</a>`
      : o.upstream
        ? `<span class="env-val">${esc(o.upstream)}</span>`
        : '<span class="state-empty">repo local</span>';
  const cl = o.clonado_em ? `<div class="rt-meta">clonado em ${esc(o.clonado_em)}</div>` : '';
  return stateCard('Origem', o.atualizado_em, `<div class="env-row"><span class="env-k">upstream</span>${up}</div>${cl}`);
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

// linha-resumo do progresso do repo (agregado pelo server): tasks · nós de DAG · verificações
function renderProgressLine(repo) {
  const p = repo.progress;
  if (!p || !p.tasks?.total) return '';
  const segs = [`<b>${p.tasks.done}/${p.tasks.total}</b> tasks`];
  if (p.dag?.total) segs.push(`DAG <b>${p.dag.done}/${p.dag.total}</b> nós`);
  const g = p.gr || {};
  if (g.pass + g.falha + g.aceito + g.pendente > 0) {
    segs.push(
      `verificações <b class="gr-pass">${g.pass} pass</b>` +
        (g.falha ? ` · <b class="gr-falha">${g.falha} falha${g.falha === 1 ? '' : 's'}</b>` : '') +
        (g.aceito ? ` · <b class="gr-aceito">${g.aceito} aceito${g.aceito === 1 ? '' : 's'}</b>` : '') +
        ` · <b class="gr-pendente">${g.pendente} pendente${g.pendente === 1 ? '' : 's'}</b>`
    );
  }
  const tempo = repoTimeHtml(repo);
  if (tempo) segs.push(`<span data-repo-time>${tempo}</span>`);
  return `<div class="progress-line">${segs.join('<span class="prog-sep">·</span>')}</div>`;
}

// Pendências: perguntas aguardando o humano + riscos aceitos nas reviews das tasks
function renderPendencias(repo) {
  const waits = (repo.tasks || []).filter((t) => t.awaiting);
  const risks = (repo.tasks || []).flatMap((t) => (t.risks || []).map((r) => ({ t, r })));
  if (!waits.length && !risks.length) return '';
  const parts = ['<h2>Pendências</h2>'];
  for (const t of waits) {
    const q = (t.awaitingMsgs || [])[0];
    const preview = q?.body ? ` <span class="pend-preview">— “${esc(truncWord(q.body, 90))}”</span>` : '';
    parts.push(
      `<div class="pend pend-wait"><a data-sala="${esc(t.slug)}" title="abrir a Sala de ${esc(t.slug)}">✋ ${esc(t.title)}: ${t.awaiting} pergunta${t.awaiting === 1 ? '' : 's'} aguardando você</a>${preview}</div>`
    );
  }
  for (const { t, r } of risks)
    parts.push(
      `<div class="pend pend-risk"><span class="pend-tag">risco aceito</span><span class="pend-task" title="${esc(t.slug)}">${esc(t.title)}</span> — ${marked.parseInline(r)}</div>`
    );
  return parts.join('');
}

// linha compacta de acessos na visão da task (junto do breadcrumb)
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
        (repo.git.lastCommit ? `<span class="git-commit" title="último commit">${esc(repo.git.lastCommit)}</span>` : '')
    );
  }
  if (repo.tokens?.total) {
    meta.push(
      `<span class="badge" title="tokens do repo (in ${fmtTok(repo.tokens.in)} / out ${fmtTok(repo.tokens.out)})">Σ ${fmtTok(repo.tokens.total)} tok${repo.usd != null ? ` · ~${fmtUsd(repo.usd)}` : ''}</span>`
    );
  }
  if (meta.length) parts.push(`<div class="repo-meta">${meta.join(' ')}</div>`);

  parts.push(renderProgressLine(repo));
  parts.push(renderStateGrid(repo)); // estado do mundo (push): Acessos / Runtime / Ambiente / Origem

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
                dag = `<td><span class="dag-badge ${ds.alert ? 'dag-block' : ds.done === ds.total ? 'dag-done' : 'dag-todo'}" title="${ds.alert ? 'guardrail em falha' : 'nós concluídos'}">${ds.done}/${ds.total}</span></td>`;
              } else dag = '<td class="muted">—</td>';
            }
            // bloqueada por dependência: badge "aguarda <nn>" + linha esmaecida
            const open = openDeps(t);
            const dep = t.blocked
              ? ` <span class="dep-badge" title="aguarda: ${esc(open.map((d) => d.title).join(', '))}">🔒 aguarda ${esc(open.map((d) => depNum(d.slug)).join(', '))}</span>`
              : '';
            return `<tr class="task-row${t.blocked ? ' blocked' : ''}" data-task="${esc(t.slug)}"><td class="num">${i + 1}</td>
              <td>${esc(t.title)}</td><td><span class="status ${s.cls}">${s.icon} ${s.label}</span>${dep}</td>${dag}${tok}</tr>`;
          })
          .join('') +
        `</tbody></table>`
    );
  } else {
    parts.push('<p class="muted">Nenhuma task ainda neste repo.</p>');
  }

  parts.push(renderPendencias(repo)); // perguntas aguardando você + riscos aceitos das reviews
  parts.push(renderRoster(repo)); // roster completo dos agentes do repo (cards → ficha)

  if (repo.context) parts.push(`<hr class="sep" />${marked.parse(repo.context)}`);
  else parts.push('<p class="muted">Sem 00-contexto.md ainda.</p>');

  return `<div class="md wide">${parts.join('')}</div>`;
}

// breadcrumb discreto no topo do conteúdo: "repo › task" (repo clicável → visão geral);
// extra = conteúdo alinhado à direita (linha compacta de acessos na visão da task)
function renderCrumb(repo, task, extra = '') {
  const t = task ? `<span class="crumb-sep">›</span><span>${esc(task.title)}</span>${taskTimerHtml(task)}` : '';
  return `<div class="crumb"><a class="crumb-repo" title="visão geral do repo">${esc(repo.title)}</a>${t}${extra}</div>`;
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
    content.innerHTML = '<div class="empty"><p>nenhum repo — crie um com o piloto</p></div>';
    return;
  }
  const repo = currentRepo();
  if (!repo) {
    content.innerHTML = '<div class="empty"><p>selecione um repo ao lado</p></div>';
    return;
  }
  const task = currentTask();
  if (!task) {
    content.innerHTML = renderCrumb(repo, null) + renderRepoOverview(repo);
    wireCrumb(content);
    wireAgentClicks(content); // cards do roster → ficha
    // clique numa linha da tabela de tasks → seleciona a task
    content.querySelectorAll('.task-row').forEach((row) => {
      row.onclick = () => {
        state.task = row.dataset.task;
        state.tab = null;
        reconcile();
        saveSel();
        renderAll();
      };
    });
    // pendência "aguardando você" → Sala da task de origem
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
  // topo comum de qualquer aba da task: breadcrumb (+ acessos do repo) + faixa de agentes + dependências
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
    await renderMermaidIn(content); // o grafo derivado vira SVG aqui
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
    content.innerHTML = pre + '<div class="empty"><p>task ainda sem arquivos — o enunciado aparece aqui assim que existir</p></div>';
  } else {
    const file = task.files.find((f) => f.name === state.tab) || task.files[0];
    content.innerHTML = pre + `<div class="md">${marked.parse(file.content)}</div>`;
    await renderMermaidIn(content);
  }
  wireTop();
  content.scrollTop = scrollPos;
}

// --- alerta fora da aba: título piscando + favicon âmbar enquanto houver pendência ---
// Enquanto totals.awaiting > 0 o título alterna a cada 2s com "✋ aguardando você" e a
// aba fica com um favicon âmbar (desenhado em canvas — nenhum arquivo novo).
const ICON_ALERT = '✋ aguardando você';
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
  g.fillRect(27, 13, 10, 26); // haste do "!"
  g.fillRect(27, 44, 10, 10); // ponto
  amberIcon = c.toDataURL('image/png');
  return amberIcon;
}

// troca o <link rel=icon> substituindo o nó (mudar só o href nem sempre repinta a aba)
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
  if (!titleFlipped) document.title = normalTitle; // sem atropelar o pisca do alerta
  // "aguardando você": perguntas/decisões ao humano sem resposta, em qualquer repo.
  // Clique navega para a Sala da task de origem (prioridade: repo selecionado).
  const aw = $('#await-badge');
  const n = state.totals?.awaiting || 0;
  aw.textContent = n ? `✋ ${n} aguardando você` : '';
  aw.title = n ? 'abrir a Sala da task que aguarda sua resposta' : '';
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
  // total do projeto (todos os repos): tempo somado das tasks + tokens + USD estimado
  // (USD só com tools/prices.json). O tempo das tasks vivas anda no tick de 30s.
  const pc = $('#proj-cost');
  const tot = state.totals;
  const projMs = state.repos.reduce((a, r) => a + sumElapsed(r.tasks), 0);
  const partes = [];
  if (projMs) partes.push(`Σ ${fmtDur(projMs)}`);
  if (tot?.tokens?.total) partes.push(`${fmtTok(tot.tokens.total)} tok`);
  if (tot?.tokens?.total && tot.usd != null) partes.push(`~${fmtUsd(tot.usd)}`);
  pc.textContent = partes.join(' · ');
  const dicas = [];
  if (projMs) dicas.push(`tempo somado das tasks do projeto: ${fmtDur(projMs)}`);
  if (tot?.tokens?.total) dicas.push(`in ${fmtTok(tot.tokens.in)} / out ${fmtTok(tot.tokens.out)}`);
  pc.title = dicas.join(' · ');
}

// tick de 30s: só os pedaços de tempo, sem re-render (não mexe em seleção, aba,
// scroll, rascunhos da Sala nem expansões do Diff)
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
  renderSheet(); // ficha de agente aberta sobrevive ao re-render do SSE
}

let loadSeq = 0;
let loadRetry = null;
async function load() {
  clearTimeout(loadRetry);
  const seq = ++loadSeq;
  let data;
  if (STATIC) {
    data = window.__DATA__ || { repos: [] }; // state do repo embutido pelo share.mjs
  } else {
    try {
      data = await (await fetch('/api/state')).json();
    } catch {
      // fetch falhou (server reiniciando/ocupado): sem retry o evento SSE que
      // motivou este load se perde e o painel fica desatualizado até o próximo
      loadRetry = setTimeout(load, 1000);
      return;
    }
  }
  if (seq !== loadSeq) return; // resposta atrasada de um load antigo — descarta
  state.repos = data.repos || [];
  state.totals = data.totals || null;
  state.pool = Array.isArray(data.guardrailPool) ? data.guardrailPool : [];
  state.agentDefs = data.agentDefs && typeof data.agentDefs === 'object' ? data.agentDefs : {};
  reconcile();
  await renderAll();
}

// Vivo: SSE recarrega o estado a cada mudança de arquivo, sem perder a seleção.
// Estático: a própria página é a fonte — HEAD + ETag a cada 5s; versão nova chega
// como atualização SUAVE (baixa o html, extrai o state e re-renderiza no lugar,
// preservando scroll/aba de quem assiste); reload de verdade só se o CÓDIGO mudou.
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
          location.reload(); // código novo — precisa do reload de verdade
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
    // Re-sincroniza a CADA (re)conexão: broadcasts são efêmeros — uma mudança
    // ocorrida enquanto a conexão estava caída/reconectando não se repete, e
    // sem este load() o painel ficaria desatualizado até o próximo evento (F5).
    load();
  };
  es.onmessage = () => load();
  es.onerror = () => {
    $('#live-dot').classList.add('off');
    es.close();
    setTimeout(connect, 1500);
  };
}

// Esc fecha a ficha de agente aberta
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && agentSheet) {
    agentSheet = null;
    renderSheet();
  }
});

// Sala: se o usuário rola para cima, o auto-scroll solta; perto do fim, gruda de novo
$('#content').addEventListener('scroll', () => {
  if (state.tab !== 'panel:sala') return;
  const c = $('#content');
  salaStick = c.scrollTop + c.clientHeight >= c.scrollHeight - 40;
});

// Página compartilhada: um único repo — a coluna de repos não tem função, e a
// primeira carga sempre abre na visão geral do repo (leitura começa do começo).
if (STATIC) $('#repos-col').style.display = 'none';
else restoreSel();
applyCollapse();
wireToggles();
load();
connect();
setInterval(refreshTimes, 30000); // cronômetros andam sem depender de evento novo
