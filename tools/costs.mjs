// Records and reports token costs per task — mechanical IO, the LLM never hand-types JSONL.
// The price table lives in tools/prices.json (USD per million tokens) and is ADJUSTABLE BY
// THE USER: edit/add models freely; "default" covers an unknown model or a record
// without in/out split — in those cases the USD is marked with "~" (estimate).
// Usage:
//   node tools/costs.mjs add <repo> <task> --agente X [--in N] [--out N] [--total N] [--modelo m] [--label "..."]
//   node tools/costs.mjs report [<repo> [<task>]]
//     no args → whole project, aggregated by repo; with repo → by task; with repo+task → by agent.
// <task> accepts the full directory name OR just the numeric prefix ("01").
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson, updateJson } from './jsonfile.mjs';
import { INSTALL_ROOT, stateRoot } from './root.mjs';

const ROOT = stateRoot();
// The price table ships with the program, not with the caller's state: it has to
// come from INSTALL_ROOT, or running against an external WFA_ROOT would look for
// it there and fail.
const PRICES = JSON.parse(fs.readFileSync(path.join(INSTALL_ROOT, 'tools', 'prices.json'), 'utf8'));

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
      if (!valueFlags.includes(name)) die(`unknown flag: --${name} (accepted: ${valueFlags.map((f) => `--${f}`).join(', ')})`);
      if (i + 1 >= argv.length) die(`--${name} requires a value`);
      flags[name] = argv[++i];
    } else {
      pos.push(a);
    }
  }
  return { flags, pos };
}

function resolveRepo(repoSlug) {
  const reposDir = path.join(ROOT, 'repos');
  const repoDir = path.join(reposDir, repoSlug);
  if (!fs.existsSync(path.join(repoDir, 'meta.json'))) {
    const existentes = fs.existsSync(reposDir) ? fs.readdirSync(reposDir).filter((d) => !d.startsWith('.')) : [];
    die(`repo not found: ${repoSlug}${existentes.length ? ` — existing: ${existentes.join(', ')}` : ' — no repo created yet (use new-repo.mjs)'}`);
  }
  return repoDir;
}

// Resolves <task> by full name or numeric prefix ("01"), with an error that lists the options.
function resolveTask(repoSlug, taskArg) {
  const repoDir = resolveRepo(repoSlug);
  const tasksDir = path.join(repoDir, 'tasks');
  const tasks = fs.existsSync(tasksDir) ? fs.readdirSync(tasksDir).filter((d) => /^\d{2}-/.test(d)).sort() : [];
  const prefixo = /^\d+$/.test(taskArg) ? taskArg.padStart(2, '0') : null;
  const match = tasks.find((d) => d === taskArg) ?? (prefixo && tasks.find((d) => d.startsWith(`${prefixo}-`)));
  if (!match) {
    die(`task not found: "${taskArg}" in repos/${repoSlug}/tasks${tasks.length ? ` — existing: ${tasks.join(', ')}` : ' — no task created yet (use new-task.mjs)'}`);
  }
  return { taskDir: path.join(tasksDir, match), taskName: match };
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

function parseNum(flags, name) {
  if (flags[name] === undefined) return undefined;
  const n = Number(flags[name]);
  if (!Number.isFinite(n) || n < 0) die(`--${name} requires a number >= 0: "${flags[name]}"`);
  return n;
}

// Price for the model: exact match, otherwise the longest key contained in the model name (e.g.:
// "claude-sonnet-4-5" matches "claude-sonnet"); null = unknown → falls back to default.
function priceFor(modelo) {
  if (!modelo) return null;
  if (PRICES[modelo]) return PRICES[modelo];
  const candidatas = Object.keys(PRICES)
    .filter((k) => k !== 'default' && modelo.includes(k))
    .sort((a, b) => b.length - a.length);
  return candidatas.length ? PRICES[candidatas[0]] : null;
}

// USD for a record. approx=true when the default price was used (unknown model or no
// in/out split — in that case applies the default's in/out average to the total).
function entryCost(e) {
  const temSplit = Number.isFinite(e.tokens_in) && Number.isFinite(e.tokens_out);
  const preco = priceFor(e.modelo);
  if (temSplit && preco) return { usd: (e.tokens_in * preco.in + e.tokens_out * preco.out) / 1e6, approx: false };
  const d = PRICES.default;
  if (temSplit) return { usd: (e.tokens_in * d.in + e.tokens_out * d.out) / 1e6, approx: true };
  return { usd: ((e.tokens_total ?? 0) * (d.in + d.out)) / 2 / 1e6, approx: true };
}

function readCosts(taskDir) {
  const file = path.join(taskDir, 'costs.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l, i) => {
      try {
        return JSON.parse(l);
      } catch {
        die(`line ${i + 1} of ${path.relative(ROOT, file)} is not valid JSON`);
      }
    });
}

function aggregate(entries, keyFn) {
  const grupos = new Map();
  for (const e of entries) {
    const key = keyFn(e);
    const g = grupos.get(key) ?? { in: 0, out: 0, total: 0, usd: 0, approx: false, semSplit: false };
    if (Number.isFinite(e.tokens_in)) g.in += e.tokens_in;
    else g.semSplit = true;
    if (Number.isFinite(e.tokens_out)) g.out += e.tokens_out;
    else g.semSplit = true;
    g.total += e.tokens_total ?? (e.tokens_in ?? 0) + (e.tokens_out ?? 0);
    const { usd, approx } = entryCost(e);
    g.usd += usd;
    g.approx = g.approx || approx;
    grupos.set(key, g);
  }
  return grupos;
}

function printTable(titulo, grupos) {
  if (!grupos.size) {
    console.log(`${titulo}: no cost recorded`);
    return;
  }
  const fmt = (n) => n.toLocaleString('en-US');
  const linhas = [...grupos.entries()].map(([nome, g]) => [
    nome,
    g.semSplit && g.in === 0 ? '-' : fmt(g.in),
    g.semSplit && g.out === 0 ? '-' : fmt(g.out),
    fmt(g.total),
    `${g.approx ? '~' : ''}$${g.usd.toFixed(2)}`,
  ]);
  const soma = [...grupos.values()].reduce(
    (t, g) => ({ in: t.in + g.in, out: t.out + g.out, total: t.total + g.total, usd: t.usd + g.usd, approx: t.approx || g.approx }),
    { in: 0, out: 0, total: 0, usd: 0, approx: false }
  );
  if (grupos.size > 1) linhas.push(['TOTAL', fmt(soma.in), fmt(soma.out), fmt(soma.total), `${soma.approx ? '~' : ''}$${soma.usd.toFixed(2)}`]);
  const header = [titulo, 'in', 'out', 'total', 'USD'];
  const larguras = header.map((h, c) => Math.max(h.length, ...linhas.map((l) => l[c].length)));
  const render = (l) => l.map((cel, c) => (c === 0 ? cel.padEnd(larguras[c]) : cel.padStart(larguras[c]))).join('  ');
  console.log(render(header));
  console.log(larguras.map((w) => '-'.repeat(w)).join('  '));
  for (const l of linhas) console.log(render(l));
}

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === 'add') {
  const { flags, pos } = parseArgs(rest, ['agente', 'in', 'out', 'total', 'modelo', 'label']);
  const [repoSlug, taskArg] = pos;
  if (!repoSlug || !taskArg || !flags.agente) {
    die('usage: node tools/costs.mjs add <repo> <task> --agente X [--in N] [--out N] [--total N] [--modelo m] [--label "..."]');
  }
  const tokensIn = parseNum(flags, 'in');
  const tokensOut = parseNum(flags, 'out');
  let total = parseNum(flags, 'total');
  const temSplit = tokensIn !== undefined && tokensOut !== undefined;
  if (!temSplit && total === undefined) {
    die('provide --in N --out N (together) OR --total N');
  }
  if (temSplit && total === undefined) total = tokensIn + tokensOut;
  const { taskDir, taskName } = resolveTask(repoSlug, taskArg);
  const registro = { ts: new Date().toISOString(), agente: flags.agente };
  if (tokensIn !== undefined) registro.tokens_in = tokensIn;
  if (tokensOut !== undefined) registro.tokens_out = tokensOut;
  registro.tokens_total = total;
  if (flags.modelo) registro.modelo = flags.modelo;
  if (flags.label) registro.label = flags.label;
  fs.appendFileSync(path.join(taskDir, 'costs.jsonl'), JSON.stringify(registro) + '\n');
  touchMeta(taskDir);
  const { usd, approx } = entryCost(registro);
  console.log(`cost recorded: ${flags.agente} ${registro.tokens_total.toLocaleString('en-US')} tokens (${approx ? '~' : ''}$${usd.toFixed(2)}) in repos/${repoSlug}/tasks/${taskName}/costs.jsonl`);
} else if (cmd === 'report') {
  const { pos } = parseArgs(rest, []);
  const [repoSlug, taskArg] = pos;
  if (repoSlug && taskArg) {
    const { taskDir, taskName } = resolveTask(repoSlug, taskArg);
    const entries = readCosts(taskDir).map((e) => ({ ...e }));
    printTable(`${repoSlug}/${taskName} (by agent)`, aggregate(entries, (e) => e.agente ?? '?'));
  } else if (repoSlug) {
    const repoDir = resolveRepo(repoSlug);
    const tasksDir = path.join(repoDir, 'tasks');
    const tasks = fs.existsSync(tasksDir) ? fs.readdirSync(tasksDir).filter((d) => /^\d{2}-/.test(d)).sort() : [];
    const entries = tasks.flatMap((t) => readCosts(path.join(tasksDir, t)).map((e) => ({ ...e, _task: t })));
    printTable(`${repoSlug} (by task)`, aggregate(entries, (e) => e._task));
  } else {
    const reposDir = path.join(ROOT, 'repos');
    const repos = fs.existsSync(reposDir) ? fs.readdirSync(reposDir).filter((d) => !d.startsWith('.')).sort() : [];
    const entries = repos.flatMap((r) => {
      const tasksDir = path.join(reposDir, r, 'tasks');
      const tasks = fs.existsSync(tasksDir) ? fs.readdirSync(tasksDir).filter((d) => /^\d{2}-/.test(d)) : [];
      return tasks.flatMap((t) => readCosts(path.join(tasksDir, t)).map((e) => ({ ...e, _repo: r })));
    });
    printTable('project (by repo)', aggregate(entries, (e) => e._repo));
  }
} else {
  die('usage: node tools/costs.mjs <add|report> [...]');
}
