// Deterministic workspace checks — no model in the loop.
//
// Two classes:
//   - structural (default): meta.json readable with the fields the panel uses;
//     a task marked "done" has every DAG node done, no guardrail
//     pending/failed, and no unanswered question to the human. These are the
//     ones wired into the end-of-turn Stop hook, and they BLOCK.
//   - lints (--lint): quality-of-trail predicates. They never block a turn —
//     they fail at task close and in CI.
//
// Usage:
//   node tools/check.mjs                     structural, every repo
//   node tools/check.mjs <repo> [<task>]     structural, scoped
//   node tools/check.mjs [<repo> [<task>]] --lint
//   node tools/check.mjs --rules            what each predicate requires and returns
//   node tools/check.mjs --hook [--soft]     Stop-hook mode, stdin = the hook's JSON payload
//
// WFA_TASK=<repo>/<task> restricts --hook to one task (so one agent's
// in-progress task doesn't block another agent's end of turn).
// WFA_ROOT resolves the root the same way every other tool does (tools/root.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { stateRoot } from './root.mjs';
import { validateDag, loadPool } from './dag.mjs';
import { TEMPLATE_BY_FILE } from './templates.mjs';
import { openQuestions } from './questions.mjs';

const ROOT = stateRoot();
const REPOS_DIR = path.join(ROOT, 'repos');
const GRACE_MS = 2 * 60 * 1000;

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}
function readIfExists(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}
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

function listRepos() {
  return fs.existsSync(REPOS_DIR)
    ? fs.readdirSync(REPOS_DIR).filter((d) => !d.startsWith('.') && fs.existsSync(path.join(REPOS_DIR, d, 'meta.json'))).sort()
    : [];
}
function listTasks(repoDir) {
  const dir = path.join(repoDir, 'tasks');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((d) => /^\d{2}-/.test(d)).sort() : [];
}

// Same stub heuristic the viewer uses for the orange-tab check.
function isStub(name, content) {
  const tpl = TEMPLATE_BY_FILE[name];
  if (tpl != null && content.trim() === tpl.trim()) return true;
  for (const line of content.split('\n')) {
    const l = line.trim();
    if (!l || l === '-' || /^#{1,6}\s/.test(l)) continue;
    if (/^_?\(.*\)_?$/.test(l)) continue;
    if (/^\|[\s|:-]*\|$/.test(l)) continue;
    return false;
  }
  return true;
}

// HTML comments are template instructions, never rendered by the panel — they
// don't count as artifact text for any lint that reads artifact content.
function stripHtmlComments(s) {
  return s.replace(/<!--[\s\S]*?-->/g, '');
}

function mostRecentMtime(dir) {
  let latest = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  for (const f of entries) {
    try {
      const st = fs.statSync(path.join(dir, f));
      if (st.mtimeMs > latest) latest = st.mtimeMs;
    } catch {}
  }
  return latest;
}

// ---------------------------------------------------------------------------
// RULES registry — the single source for the list AND the label of every
// finding. finding() refuses an id that isn't registered here, so --rules
// (one screen: what each predicate requires and what it returns) never goes
// stale relative to the code.
// ---------------------------------------------------------------------------
const STRUCT_RULES = {
  meta: {
    type: 'structural',
    requires: 'Every repo\'s and task\'s meta.json parses as JSON and has the fields the panel reads: title, status, created, updated (repo also: workspace, stack; task also: a status in todo|in-progress|done).',
    returns: 'One "fail" per missing/invalid field or unreadable file.',
  },
  gate: {
    type: 'structural',
    requires: 'A task marked "done" has a dag.json with at least one node, every node done, no guardrail pending/fail across any node, and no question/decision to the human left open by tools/questions.mjs\'s link rule.',
    returns: 'One "fail" per violated condition, naming the offending node(s)/guardrail(s)/message(s).',
  },
  vacuum: {
    type: 'structural',
    requires: 'The resolved root (WFA_ROOT, or this installation) actually has a repos/ directory with at least one repo in it — this only applies when no <repo> was named on the command line.',
    returns: '"not checked", naming the exact root path it ran against, when there is no repo at all. Never printed as passing/consistent: an empty root and a root that fully passed must never look the same in the output. A <repo> named explicitly that does not exist stays a plain usage error (exit 1), not this.',
  },
};

const RULES = {
  jargon: {
    type: 'lint',
    requires: 'No artifact (00-context.md, 00-brief.md, 10-plan.md, 20-journal.md, 30-review.md) names the engine\'s internal mechanics by naming a tool file, the viewer/panel, the harness itself, learnings.md, guardrails/pool.json, CLAUDE.md, or a pilot skill/slash command — and none uses interview/evaluation vocabulary (rubric, candidate, interview, evaluator, "how did I do", "what will be observed"). HTML comments in the .md don\'t count — they\'re template instructions, never rendered.',
    returns: 'One "fail" per matched term per file, with the term and an approximate line. A repo may allow a specific term by declaring "allowed_jargon": {"<term>": "<reason>"} in its own meta.json.',
  },
  stub: {
    type: 'lint',
    requires: 'A task that is todo, in-progress or done has 00-brief.md and 10-plan.md filled in (not identical to the template).',
    returns: '"fail" per stub brief/plan; "warn" per stub 20-journal.md/30-review.md (these two don\'t block, but are still worth flagging).',
  },
  dag: {
    type: 'lint',
    requires: 'A task whose 10-plan.md is filled in (not a stub) has a dag.json that validates with zero errors from the very validateDag() the `dag.mjs` CLI uses.',
    returns: '"fail" with the exact validateDag() error list when missing/invalid; "not checked" when the plan itself is still a stub — there is nothing to validate yet.',
  },
  accepted: {
    type: 'lint',
    requires: 'Every DAG guardrail with status "accepted" has a reason recorded in its note (via --accept), and that reason\'s text also appears somewhere in 20-journal.md.',
    returns: '"fail" per accepted guardrail with a missing reason or a reason not echoed in the journal; "not checked" when the task has no accepted guardrail.',
  },
  trail: {
    type: 'lint',
    requires: 'A task marked "done" has at least one entry in costs.jsonl AND at least one in commits.jsonl.',
    returns: '"fail" naming which of the two is missing; "not checked" for a task not yet done.',
  },
  awaiting: {
    type: 'lint',
    requires: 'A task marked "done" has no question/decision still open per tools/questions.mjs (same rule as the "gate" structural check — a question closes by an explicit link, not by being followed by any later message).',
    returns: '"fail" with the count and a one-line excerpt of each; "not checked" for a task not yet done.',
  },
};

const ALL_RULES = { ...STRUCT_RULES, ...RULES };

function finding(id, level, extra) {
  if (!ALL_RULES[id]) throw new Error(`internal error: unregistered check id "${id}" — add it to STRUCT_RULES/RULES first`);
  return { id, level, ...extra };
}

function printRules() {
  for (const [cls, rules] of [['Structural (block the end of turn)', STRUCT_RULES], ['Lints (--lint; block task close + CI)', RULES]]) {
    console.log(`\n${cls}\n${'='.repeat(cls.length)}`);
    for (const [id, r] of Object.entries(rules)) {
      console.log(`\n${id}`);
      console.log(`  requires: ${r.requires}`);
      console.log(`  returns:  ${r.returns}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Structural checks
// ---------------------------------------------------------------------------
const REPO_META_FIELDS = ['title', 'status', 'created', 'updated'];
const TASK_META_FIELDS = ['title', 'status', 'created', 'updated'];
const TASK_STATUSES = ['todo', 'in-progress', 'done'];

function structuralRepo(repoSlug, onlyTask) {
  const out = [];
  const repoDir = path.join(REPOS_DIR, repoSlug);
  const meta = readJson(path.join(repoDir, 'meta.json'));
  if (!meta) {
    out.push(finding('meta', 'fail', { repo: repoSlug, msg: `${repoSlug}: meta.json missing or not valid JSON` }));
    return out;
  }
  for (const field of REPO_META_FIELDS) {
    if (meta[field] === undefined) out.push(finding('meta', 'fail', { repo: repoSlug, msg: `${repoSlug}: meta.json missing field "${field}"` }));
  }
  const tasks = onlyTask ? [onlyTask] : listTasks(repoDir);
  for (const taskName of tasks) out.push(...structuralTask(repoSlug, repoDir, taskName));
  return out;
}

function structuralTask(repoSlug, repoDir, taskName) {
  const out = [];
  const ref = `${repoSlug}/${taskName}`;
  const taskDir = path.join(repoDir, 'tasks', taskName);
  const meta = readJson(path.join(taskDir, 'meta.json'));
  if (!meta) {
    out.push(finding('meta', 'fail', { repo: repoSlug, task: taskName, msg: `${ref}: meta.json missing or not valid JSON` }));
    return out;
  }
  for (const field of TASK_META_FIELDS) {
    if (meta[field] === undefined) out.push(finding('meta', 'fail', { repo: repoSlug, task: taskName, msg: `${ref}: meta.json missing field "${field}"` }));
  }
  if (meta.status !== undefined && !TASK_STATUSES.includes(meta.status)) {
    out.push(finding('meta', 'fail', { repo: repoSlug, task: taskName, msg: `${ref}: meta.json has invalid status "${meta.status}" — accepted: ${TASK_STATUSES.join(', ')}` }));
  }
  if (meta.status !== 'done') return out;

  const dag = readJson(path.join(taskDir, 'dag.json'));
  if (!dag || !Array.isArray(dag.nodes) || !dag.nodes.length) {
    out.push(finding('gate', 'fail', { repo: repoSlug, task: taskName, msg: `${ref}: marked done but has no dag.json (or it has no nodes)` }));
  } else {
    const open = dag.nodes.filter((n) => n.status !== 'done');
    if (open.length) out.push(finding('gate', 'fail', { repo: repoSlug, task: taskName, msg: `${ref}: marked done with ${open.length} DAG node(s) not done: ${open.map((n) => n.id).join(', ')}` }));
    const badGr = [];
    for (const n of dag.nodes) for (const g of n.guardrails ?? []) if (g.status === 'pending' || g.status === 'fail') badGr.push(`${n.id}/${g.id}[${g.status}]`);
    if (badGr.length) out.push(finding('gate', 'fail', { repo: repoSlug, task: taskName, msg: `${ref}: marked done with unresolved guardrail(s): ${badGr.join(', ')}` }));
  }

  const messages = readJsonl(path.join(taskDir, 'messages.jsonl'));
  const pending = openQuestions(messages);
  if (pending.length) {
    out.push(finding('gate', 'fail', { repo: repoSlug, task: taskName, msg: `${ref}: marked done with ${pending.length} unanswered question(s)/decision(s) to the human` }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lints
// ---------------------------------------------------------------------------
const TOOL_FILE_NAMES = [
  'bus.mjs', 'costs.mjs', 'commits.mjs', 'access.mjs', 'state.mjs', 'dag.mjs',
  'check.mjs', 'share.mjs', 'jsonfile.mjs', 'root.mjs', 'templates.mjs',
  'new-repo.mjs', 'new-task.mjs', 'learnings.mjs', 'pr-review.mjs', 'questions.mjs', 'migrate.mjs',
  'fs.mjs', 'server.mjs', 'app.js', 'style.css',
  // pre-rename names: an artifact written before the tools were renamed names
  // the engine just as loudly, and must keep failing this lint.
  'acessos.mjs', 'estado.mjs', 'perguntas.mjs',
];
const ENGINE_TERMS = [
  'guardrails/pool.json', 'learnings.md', 'CLAUDE.md', 'the viewer', 'the panel',
  'WFA_ROOT', 'WFA_TASK', 'messages.jsonl', 'logs.jsonl', 'costs.jsonl',
  'commits.jsonl', 'dag.json', 'agents.json', '.claude/agents', '.claude/skills',
];
const SKILL_COMMANDS = ['/refine', '/retrospective', '/adversarial', '/refine', '/retrospective'];
// Deliberately conservative: only phrases specific enough that a false
// positive is unlikely in ordinary technical writing. Bare words like
// "score" or "judgment" are common enough in unrelated contexts (a caching
// score, engineering judgment) that flagging them would just train people to
// reach for allowed_jargon instead of reading the finding.
// Both languages: artifacts are written in English now, but the voice this lint
// refuses reads the same in Portuguese, and older trail is in it.
const EVAL_VOICE_TERMS = [
  'evaluation vocabulary', 'evaluator', 'rubric', 'candidate', 'interview',
  'how did i do', 'what will be observed', 'score (1-5)', 'score 1-5',
  'vocabulário de avaliação', 'avaliador', 'rubrica', 'candidato', 'entrevista',
  'como me saí', 'o que será observado', 'nota (1-5)', 'nota 1-5',
];
const JARGON_TERMS = [...TOOL_FILE_NAMES, ...ENGINE_TERMS, ...SKILL_COMMANDS, ...EVAL_VOICE_TERMS];

const ARTIFACT_FILES = ['00-brief.md', '10-plan.md', '20-journal.md', '30-review.md'];

function lintJargaoInFile(repoSlug, taskName, filePath, fileLabel, allowed) {
  const out = [];
  const raw = readIfExists(filePath);
  if (raw == null) return out;
  const content = stripHtmlComments(raw);
  const lower = content.toLowerCase();
  for (const term of JARGON_TERMS) {
    if (allowed[term]) continue;
    const idx = lower.indexOf(term.toLowerCase());
    if (idx === -1) continue;
    const line = content.slice(0, idx).split('\n').length;
    out.push(finding('jargon', 'fail', { repo: repoSlug, task: taskName, msg: `${repoSlug}${taskName ? `/${taskName}` : ''} ${fileLabel}:${line}: mentions "${term}" — internal mechanics/evaluation vocabulary don't belong in an artifact read by third parties (allow with allowed_jargon in meta.json if this repo's own subject legitimately needs the term)` }));
  }
  return out;
}

function lintRepo(repoSlug, onlyTask) {
  const out = [];
  const repoDir = path.join(REPOS_DIR, repoSlug);
  const repoMeta = readJson(path.join(repoDir, 'meta.json')) || {};
  const allowed = repoMeta.allowed_jargon && typeof repoMeta.allowed_jargon === 'object' ? repoMeta.allowed_jargon : {};

  out.push(...lintJargaoInFile(repoSlug, null, path.join(repoDir, '00-context.md'), '00-context.md', allowed));

  const tasks = onlyTask ? [onlyTask] : listTasks(repoDir);
  if (!tasks.length) {
    out.push(finding('stub', 'not-checked', { repo: repoSlug, msg: `${repoSlug}: no task to lint` }));
    return out;
  }
  for (const taskName of tasks) out.push(...lintTask(repoSlug, repoDir, taskName, allowed));
  return out;
}

function lintTask(repoSlug, repoDir, taskName, allowed) {
  const out = [];
  const ref = `${repoSlug}/${taskName}`;
  const taskDir = path.join(repoDir, 'tasks', taskName);
  const meta = readJson(path.join(taskDir, 'meta.json'));
  const status = meta?.status ?? 'todo';

  // jargon — every artifact file, regardless of task status
  for (const file of ARTIFACT_FILES) out.push(...lintJargaoInFile(repoSlug, taskName, path.join(taskDir, file), file, allowed));

  // stub — enunciado/plano block, journal/review warn; only meaningful once the
  // task is at least started (a fresh "todo" task is a stub by definition).
  const contents = {};
  for (const file of ARTIFACT_FILES) contents[file] = readIfExists(path.join(taskDir, file));
  if (status === 'todo') {
    out.push(finding('stub', 'not-checked', { repo: repoSlug, task: taskName, msg: `${ref}: still todo — not checked` }));
  } else {
    const stubLevel = { '00-brief.md': 'fail', '10-plan.md': 'fail', '20-journal.md': 'warn', '30-review.md': 'warn' };
    for (const file of ARTIFACT_FILES) {
      const content = contents[file];
      if (content != null && isStub(file, content)) {
        out.push(finding('stub', stubLevel[file], { repo: repoSlug, task: taskName, msg: `${ref} ${file}: still identical to the template` }));
      }
    }
  }

  // dag — only meaningful once the plan is filled in
  const planoContent = contents['10-plan.md'];
  const planoIsStub = planoContent == null || isStub('10-plan.md', planoContent);
  if (planoIsStub) {
    out.push(finding('dag', 'not-checked', { repo: repoSlug, task: taskName, msg: `${ref}: plan is still a stub — nothing to validate yet` }));
  } else {
    const dag = readJson(path.join(taskDir, 'dag.json'));
    if (!dag) {
      out.push(finding('dag', 'fail', { repo: repoSlug, task: taskName, msg: `${ref}: plan is filled in but there is no dag.json` }));
    } else {
      const errors = validateDag(dag, loadPool());
      if (errors.length) out.push(finding('dag', 'fail', { repo: repoSlug, task: taskName, msg: `${ref}: dag.json is invalid — ${errors.join('; ')}` }));
    }
  }

  // accepted — every accepted guardrail needs a reason, echoed in the journal
  const dag2 = readJson(path.join(taskDir, 'dag.json'));
  const accepted = dag2?.nodes ? dag2.nodes.flatMap((n) => (n.guardrails ?? []).filter((g) => g.status === 'accepted').map((g) => ({ node: n.id, ...g }))) : [];
  if (!accepted.length) {
    out.push(finding('accepted', 'not-checked', { repo: repoSlug, task: taskName, msg: `${ref}: no accepted guardrail` }));
  } else {
    const journal = (contents['20-journal.md'] ?? '').toLowerCase();
    for (const g of accepted) {
      const reason = (g.note ?? '').replace(/^(accepted|aceito):\s*/i, '').trim();
      if (!reason) {
        out.push(finding('accepted', 'fail', { repo: repoSlug, task: taskName, msg: `${ref}: guardrail "${g.id}" on node "${g.node}" is accepted with no reason recorded` }));
      } else if (!journal.includes(reason.toLowerCase())) {
        out.push(finding('accepted', 'fail', { repo: repoSlug, task: taskName, msg: `${ref}: guardrail "${g.id}" on node "${g.node}" accepted with reason "${reason}", not found in 20-journal.md` }));
      }
    }
  }

  // trail / awaiting — only meaningful once the task is done
  if (status !== 'done') {
    out.push(finding('trail', 'not-checked', { repo: repoSlug, task: taskName, msg: `${ref}: not done yet` }));
    out.push(finding('awaiting', 'not-checked', { repo: repoSlug, task: taskName, msg: `${ref}: not done yet` }));
  } else {
    const costs = readJsonl(path.join(taskDir, 'costs.jsonl'));
    const commits = readJsonl(path.join(taskDir, 'commits.jsonl'));
    const missing = [!costs.length && 'costs.jsonl', !commits.length && 'commits.jsonl'].filter(Boolean);
    if (missing.length) out.push(finding('trail', 'fail', { repo: repoSlug, task: taskName, msg: `${ref}: done with no ${missing.join(' and ')} recorded` }));

    const messages = readJsonl(path.join(taskDir, 'messages.jsonl'));
    const pending = openQuestions(messages);
    if (pending.length) {
      out.push(finding('awaiting', 'fail', { repo: repoSlug, task: taskName, msg: `${ref}: ${pending.length} unanswered question(s) to the human — ${pending.map((m) => `"${String(m.body).slice(0, 60)}"`).join('; ')}` }));
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------
function summarize(findings) {
  const c = { fail: 0, warn: 0, 'not-checked': 0 };
  for (const f of findings) c[f.level] = (c[f.level] ?? 0) + 1;
  return c;
}

function printFindings(findings, { quiet } = {}) {
  for (const f of findings) {
    if (quiet && f.level === 'not-checked') continue;
    console.log(`[${f.level}] (${f.id}) ${f.msg}`);
  }
  const c = summarize(findings);
  console.log(`\n${c.fail} fail / ${c.warn} warn / ${c['not-checked']} not checked`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseCli(argv) {
  const flags = { lint: false, hook: false, soft: false, rules: false };
  const pos = [];
  for (const a of argv) {
    if (a === '--lint') flags.lint = true;
    else if (a === '--hook') flags.hook = true;
    else if (a === '--soft') flags.soft = true;
    else if (a === '--rules') flags.rules = true;
    else if (a.startsWith('--')) {
      console.error(`unknown flag: ${a} — accepted: --lint, --hook, --soft, --rules`);
      process.exit(1);
    } else pos.push(a);
  }
  return { flags, pos };
}

function resolveTargetRepos(repoSlug) {
  if (!repoSlug) return { repos: listRepos(), vacuumOk: true };
  if (!fs.existsSync(path.join(REPOS_DIR, repoSlug, 'meta.json'))) {
    const existentes = listRepos();
    console.error(`repo not found: ${repoSlug}${existentes.length ? ` — existing: ${existentes.join(', ')}` : ' — no repo created yet (use new-repo.mjs)'}`);
    process.exit(1);
  }
  return { repos: [repoSlug], vacuumOk: false };
}

// <task> accepts the full directory name OR just the numeric prefix ("01"),
// same convention as every other tool.
function resolveTaskName(repoDir, taskArg) {
  const tasks = listTasks(repoDir);
  const prefixo = /^\d+$/.test(taskArg) ? taskArg.padStart(2, '0') : null;
  const match = tasks.find((d) => d === taskArg) ?? (prefixo && tasks.find((d) => d.startsWith(`${prefixo}-`)));
  if (!match) {
    console.error(`task not found: "${taskArg}" in repos/${path.basename(repoDir)}/tasks${tasks.length ? ` — existing: ${tasks.join(', ')}` : ' — no task created yet (use new-task.mjs)'}`);
    process.exit(1);
  }
  return match;
}

function runHook() {
  let payload = {};
  try {
    const stdin = fs.readFileSync(0, 'utf8').trim();
    if (stdin) payload = JSON.parse(stdin);
  } catch {
    // malformed/empty payload: proceed as if nothing was flagged by the caller
  }
  const soft = process.argv.includes('--soft');
  const release = (msg) => {
    if (soft) {
      if (msg) console.log(msg);
      process.exit(0);
    }
    console.log(msg ?? '');
    process.exit(0);
  };
  const block = (msg) => {
    if (soft) {
      console.log(msg);
      process.exit(0);
    }
    console.error(msg);
    process.exit(2);
  };

  // A second Stop in the same chain: release with a warning instead of
  // blocking again, or the hook loops forever.
  if (payload.stop_hook_active) {
    release('check.mjs --hook: stop_hook_active — releasing to avoid a loop.');
    return;
  }

  if (!fs.existsSync(REPOS_DIR) || !listRepos().length) {
    // Same declared vacuum as the plain command, not a silent pass: a worktree
    // whose WFA_ROOT wasn't pointed back at the main tree looks exactly like
    // this, and staying quiet here is how that mistake goes unnoticed.
    release(`check.mjs --hook: not checked — no repo in this root (${ROOT}).`);
    return;
  }

  let repos = listRepos();
  let onlyTask = null;
  if (process.env.WFA_TASK) {
    const [repoSlug, taskArg] = process.env.WFA_TASK.split('/');
    if (!repoSlug || !taskArg) {
      block(`check.mjs --hook: WFA_TASK must be "<repo>/<task>", got "${process.env.WFA_TASK}"`);
      return;
    }
    if (!fs.existsSync(path.join(REPOS_DIR, repoSlug, 'meta.json'))) {
      release(`check.mjs --hook: WFA_TASK names a repo that doesn't exist ("${repoSlug}") — releasing.`);
      return;
    }
    const resolved = listTasks(path.join(REPOS_DIR, repoSlug)).find(
      (d) => d === taskArg || (/^\d+$/.test(taskArg) && d.startsWith(`${taskArg.padStart(2, '0')}-`))
    );
    if (!resolved) {
      release(`check.mjs --hook: WFA_TASK names a task that doesn't exist ("${process.env.WFA_TASK}") — releasing.`);
      return;
    }
    repos = [repoSlug];
    onlyTask = resolved;
  }

  const findings = [];
  for (const repoSlug of repos) {
    const repoDir = path.join(REPOS_DIR, repoSlug);
    if (!fs.existsSync(path.join(repoDir, 'meta.json'))) continue;
    const tasks = onlyTask ? [onlyTask] : listTasks(repoDir);
    for (const taskName of tasks) {
      const taskDir = path.join(repoDir, 'tasks', taskName);
      if (!fs.existsSync(taskDir)) continue;
      // Work in progress from some conversation gets a grace period — the
      // pendency falls to that conversation's own next turn instead.
      if (Date.now() - mostRecentMtime(taskDir) < GRACE_MS) continue;
      findings.push(...structuralTask(repoSlug, repoDir, taskName));
    }
  }

  if (!findings.length) {
    release('');
    return;
  }
  const lines = findings.map((f) => `- ${f.msg}`).join('\n');
  block(`check.mjs: end-of-turn structural check found ${findings.length} pending item(s):\n${lines}`);
}

function main() {
  const { flags, pos } = parseCli(process.argv.slice(2));

  if (flags.rules) {
    printRules();
    return;
  }
  if (flags.hook) {
    runHook();
    return;
  }

  const [repoArg, taskArg] = pos;
  const { repos, vacuumOk } = resolveTargetRepos(repoArg);
  if (!repos.length && vacuumOk) {
    printFindings([finding('vacuum', 'not-checked', { msg: `no repo in this root (${ROOT})` })]);
    process.exit(0);
  }

  let resolvedTask = null;
  if (repoArg && taskArg) resolvedTask = resolveTaskName(path.join(REPOS_DIR, repoArg), taskArg);

  let findings = [];
  if (flags.lint) {
    for (const repoSlug of repos) findings.push(...lintRepo(repoSlug, resolvedTask));
  } else {
    for (const repoSlug of repos) findings.push(...structuralRepo(repoSlug, resolvedTask));
  }

  printFindings(findings);
  const failed = findings.some((f) => f.level === 'fail');
  process.exit(failed ? 1 : 0);
}

main();
