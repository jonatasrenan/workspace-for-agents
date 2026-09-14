// Publishes ONE repo as a static page at <WFA_SHARE_BASE>/<uuid>/index.html
// (S3 + CloudFront, one UUID per path — configuration in .env, see .env.example).
//
// Usage:
//   node tools/share.mjs <repo>                  # generates and publishes (creates a uuid the 1st time)
//   node tools/share.mjs <repo> --sem-custos     # publishes without the Costs panel / token badges
//   node tools/share.mjs <repo> --dry-run        # only generates the local html, shows the path
//   node tools/share.mjs <repo> --off            # pauses automatic republishing (page stays up)
//   node tools/share.mjs <repo> --delete         # takes it down (removes from S3 + deletes the record)
//   node tools/share.mjs <repo> --quiet          # silent mode (used by the viewer)
//
// The SCOPE is the repo: the page only carries that repo (tasks, agents that
// acted on it, guardrails, recalculated totals) — no other repo from the harness
// goes into the HTML. Several repos can be shared at the same time, each with its own URL.
//
// The viewer (viewer/server.mjs) calls this script on its own when a repo with
// an active share changes — the agent never deploys manually.
//
// Registry: .shares.json at the root (outside git):
//   { "shares": { "<repo>": { uuid, url, auto, custos, publicado_em } } }
//
// Deliberately NOT using tools/root.mjs here: this script also reads the
// viewer's own assets (viewer/public/*) from the same tree it computes ROOT
// from, and it embeds the viewer's server module (buildState, below) directly
// — splitting "state root" from "install root" the way the other tools do
// would be a change of a different nature (which tree do the viewer assets
// come from when WFA_ROOT and the install differ?), out of scope here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildState } from '../viewer/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'viewer', 'public');
const SHARES_FILE = path.join(ROOT, '.shares.json');
// --- publishing configuration: no defaults, everything comes from the environment ---
// Environment variables or a `.env` at the root (not versioned — template in .env.example).
function carregarDotEnv() {
  let txt;
  try {
    txt = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  } catch {
    return;
  }
  for (const linha of txt.split('\n')) {
    if (linha.trim().startsWith('#')) continue;
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(linha.replace(/\r$/, ''));
    if (!m) continue;
    const valor = m[2].trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = valor;
  }
}
carregarDotEnv();

const CONFIG_OBRIGATORIA = {
  WFA_SHARE_BUCKET: 'destination S3 bucket (e.g. my-site-bucket)',
  WFA_SHARE_DIST: 'CloudFront distribution id in front of the bucket (e.g. E123ABC456DEFG)',
  WFA_SHARE_BASE: 'public base URL, no trailing slash (e.g. https://example.com)',
  AWS_PROFILE: 'AWS CLI profile with access to the bucket and the distribution',
  AWS_DEFAULT_REGION: 'AWS region (e.g. us-east-1)',
};

// Only publishing and unpublishing touch AWS: --dry-run and --off don't require configuration.
function config() {
  const faltando = Object.keys(CONFIG_OBRIGATORIA).filter((k) => !process.env[k]);
  if (faltando.length) {
    console.error('publishing not configured. Set these in the environment or in a .env at the root:');
    for (const k of faltando) console.error(`  ${k}  — ${CONFIG_OBRIGATORIA[k]}`);
    console.error('ready-made template: cp .env.example .env  (without AWS, use --dry-run to generate just the local HTML)');
    process.exit(1);
  }
  return {
    bucket: process.env.WFA_SHARE_BUCKET,
    dist: process.env.WFA_SHARE_DIST,
    base: process.env.WFA_SHARE_BASE.replace(/\/+$/, ''),
    env: { ...process.env },
  };
}

const args = process.argv.slice(2);
const slug = args.find((a) => !a.startsWith('--'));
const dry = args.includes('--dry-run');
const quiet = args.includes('--quiet');
const off = args.includes('--off');
const del = args.includes('--delete');
const semCustos = args.includes('--sem-custos');
const log = (...a) => !quiet && console.log(...a);

if (!slug || /[/\\]|\.\./.test(slug)) {
  console.error('usage: node tools/share.mjs <repo> [--sem-custos|--dry-run|--off|--delete|--quiet]');
  process.exit(1);
}
// An unknown flag must NEVER go through: a mistyped "--dry-runn" would actually
// publish to S3, which is this project's only irreversible action.
const FLAGS_VALIDAS = ['--dry-run', '--quiet', '--off', '--delete', '--sem-custos'];
const desconhecidas = args.filter((a) => a.startsWith('--') && !FLAGS_VALIDAS.includes(a));
if (desconhecidas.length) {
  console.error(`unknown flag: ${desconhecidas.join(', ')} — accepted: ${FLAGS_VALIDAS.join(', ')}`);
  process.exit(1);
}
const posicionais = args.filter((a) => !a.startsWith('--'));
if (posicionais.length > 1) {
  console.error(`only one repo at a time: got ${posicionais.join(', ')}`);
  process.exit(1);
}
if (!fs.existsSync(path.join(ROOT, 'repos', slug))) {
  console.error(`repo not found: repos/${slug}`);
  process.exit(1);
}

// Fail early: publishing requires the infrastructure to be configured. --dry-run,
// --off and --delete proceed without it (--delete only requires it when there's something to remove).
const CFG = dry || off || del ? null : config();

// --- share registry (one per repo) ---
function readShares() {
  try {
    const reg = JSON.parse(fs.readFileSync(SHARES_FILE, 'utf8'));
    if (reg && typeof reg.shares === 'object' && !Array.isArray(reg.shares)) return reg.shares;
  } catch {}
  return {};
}
function writeShares(shares) {
  const tmp = SHARES_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ shares }, null, 2) + '\n');
  fs.renameSync(tmp, SHARES_FILE); // atomic swap: the viewer reads this file on every change
}

const shares = readShares();
const entry = shares[slug] ?? null;

if (off) {
  if (!entry) {
    log(`repo is not shared: ${slug}`);
    process.exit(0);
  }
  entry.auto = false;
  writeShares(shares);
  log('automatic republishing paused (the page stays up)');
  process.exit(0);
}

if (del) {
  if (!entry) {
    log(`repo is not shared: ${slug}`);
    process.exit(0);
  }
  const { bucket: BUCKET, dist: DIST_ID, env: AWS_ENV } = config();
  try {
    execFileSync('aws', ['s3', 'rm', `s3://${BUCKET}/${entry.uuid}/`, '--recursive', '--only-show-errors'], {
      env: AWS_ENV,
      stdio: quiet ? 'ignore' : 'inherit',
    });
    execFileSync(
      'aws',
      ['cloudfront', 'create-invalidation', '--distribution-id', DIST_ID, '--paths', `/${entry.uuid}/*`, '--query', 'Invalidation.Id', '--output', 'text'],
      { env: AWS_ENV, stdio: quiet ? 'ignore' : 'inherit' }
    );
  } catch (e) {
    console.error(`removal on S3 failed: ${e.message}`);
    process.exit(1);
  }
  delete shares[slug];
  writeShares(shares);
  log(`unshared (removed from S3): ${slug} — a new share will generate a different URL`);
  process.exit(0);
}

// --- state SCOPED to the repo ---
// Everything the page shows comes from here: any field carrying another repo
// inside it would be a leak, so the payload is rebuilt from scratch with just the requested repo.
const full = buildState();
const repo = full.repos.find((r) => r.slug === slug);
if (!repo) {
  console.error(`repo not found in state: ${slug}`);
  process.exit(1);
}

// agents that acted on THIS repo (roster + costs + messages + DAG): only their
// definitions go along — the full .claude/agents catalog is not part of the repo.
const agentNames = new Set();
for (const a of repo.agents || []) if (a?.name) agentNames.add(a.name);
for (const t of repo.tasks || []) {
  for (const a of t.agents || []) if (a?.name) agentNames.add(a.name);
  for (const c of t.costs || []) if (c?.agente) agentNames.add(c.agente);
  for (const m of t.messages || []) {
    for (const who of [m?.from, m?.to]) if (who && who !== 'humano' && who !== 'dag') agentNames.add(who);
  }
  for (const n of t.dag?.nodes || []) if (n?.agente) agentNames.add(n.agente);
}
const agentDefs = {};
for (const [name, def] of Object.entries(full.agentDefs || {})) if (agentNames.has(name)) agentDefs[name] = def;

// --sem-custos: the numbers disappear from the PAYLOAD (not just the screen) — the
// published page carries no token/USD figures at all; the flag stays in the record and applies to republishes.
if (semCustos) {
  for (const t of repo.tasks || []) {
    t.costs = [];
    t.tokens = { in: 0, out: 0, total: 0 };
    t.usd = null;
  }
  repo.tokens = { in: 0, out: 0, total: 0 };
  repo.usd = null;
}

const data = {
  repos: [repo],
  totals: { tokens: { ...repo.tokens }, usd: repo.usd, awaiting: repo.awaiting },
  guardrailPool: full.guardrailPool,
  agentDefs,
};

// --- cleanup: nothing from another repo goes into the publication ---
// A repo may legitimately mention its neighbors (same cluster, same machine):
// entries identified by another repo (a deployment/service/access line) are
// REMOVED and the remaining textual mentions become "another repo". The
// source in repos/ is not touched — the cleanup only happens on what goes live.
const outros = full.repos
  .filter((r) => r.slug !== slug)
  .map((r) => r.slug)
  .sort((a, b) => b.length - a.length); // longest slug first: avoids a partial substitution
const OUTRO = 'another service on the cluster';
const scrubStr = (s) => outros.reduce((acc, o) => acc.split(o).join(OUTRO), s);
// A state item that isn't from this repo: identified by another repo, or living in
// another namespace ("kube-system/metrics-server") — the page shows the repo's own
// runtime, not the inventory of the machine it runs on.
const isAlheio = (v, inEstado) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const id = [v.nome, v.name, v.slug, v.deployment, v.servico].find((x) => typeof x === 'string')?.trim();
  if (id == null) return false;
  if (outros.includes(id)) return true;
  return inEstado && id.includes('/') && id.split('/')[0] !== slug;
};
function scrub(v, inEstado = false) {
  if (typeof v === 'string') return scrubStr(v);
  if (Array.isArray(v)) return v.filter((x) => !isAlheio(x, inEstado)).map((x) => scrub(x, inEstado));
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (outros.includes(k)) continue; // collection indexed by repo: the foreign key goes out whole
      out[scrubStr(k)] = scrub(val, inEstado || k === 'estado' || k === 'acessos');
    }
    return out;
  }
  return v;
}
const clean = scrub(data);

// hard guard: after cleanup, no other repo's slug can be left in the payload
const dataJsonRaw = JSON.stringify(clean);
if (clean.repos.length !== 1 || clean.repos[0].slug !== slug) {
  console.error(`aborted: the payload should only contain ${slug}`);
  process.exit(1);
}
const vazou = outros.filter((s) => dataJsonRaw.includes(s));
if (vazou.length) {
  console.error(`aborted: ${slug}'s payload still mentions other repo(s): ${vazou.join(', ')}`);
  process.exit(1);
}

// --- self-contained html: the SAME app.js/style.css from the viewer, in static mode ---
// The skeleton is the viewer/public/index.html itself (single source): the external
// tags become embedded content. Every panel improvement reaches this automatically.
const pub = (f) => fs.readFileSync(path.join(PUBLIC_DIR, f), 'utf8');
const css = pub('style.css');
const appJs = pub('app.js');
const markedJs = pub('vendor/marked.min.js');
const mermaidJs = pub('vendor/mermaid.min.js');
const dataJson = dataJsonRaw.replace(/</g, '\\u003c');
const buildAt = new Date().toISOString();
// hash of the page code: new data with the same code → smooth update in the
// browser of whoever's watching; new code → full reload.
const appHash = crypto.createHash('sha1').update(appJs).update(css).digest('hex').slice(0, 12);
const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const title = `${repo.title} — Workspace for Agents`;

const bootstrap = `
window.__STATIC__ = true;
window.__NO_COSTS__ = ${semCustos ? 'true' : 'false'};
window.__BUILD_AT__ = "${buildAt}";
window.__APP_HASH__ = "${appHash}";
window.__DATA__ = ${dataJson};`;

// substitutions on top of the viewer's skeleton — if one doesn't match, index.html
// has changed shape and the page would go out broken: fail loud instead of publishing garbage.
const subs = [
  [/<title>[^<]*<\/title>/, () => `<title>${esc(title)}</title>\n  <meta name="robots" content="noindex" />`],
  [/<link rel="stylesheet" href="\/style\.css"\s*\/?>/, () => `<style>${css}</style>`],
  [/<h1>[^<]*<\/h1>/, () => `<h1>${esc(repo.title)}</h1>`],
  [/<script src="\/vendor\/marked\.min\.js"><\/script>/, () => `<script>${markedJs}</script>`],
  [/<script src="\/vendor\/mermaid\.min\.js"><\/script>/, () => `<script>${mermaidJs}</script>`],
  [/<script src="\/app\.js"><\/script>/, () => `<script>${bootstrap}</script>\n  <script>${appJs}</script>`],
];
let html = pub('index.html');
for (const [re, rep] of subs) {
  if (!re.test(html)) {
    console.error(`viewer skeleton changed: nothing matched ${re} in viewer/public/index.html`);
    process.exit(1);
  }
  html = html.replace(re, rep);
}

const outDir = path.join(os.tmpdir(), `wfa-share-${slug}`);
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'index.html');
const dataFile = path.join(outDir, 'data.json');
fs.writeFileSync(outFile, html);
fs.writeFileSync(dataFile, JSON.stringify(clean, null, 2));
log(`html generated: ${outFile} (${(html.length / 1024 / 1024).toFixed(1)} MB)`);

if (dry) {
  log('(dry-run — nothing was sent)');
  process.exit(0);
}

// uuid = this share's permanent identity: republishing keeps the URL;
// only --delete (which erases the record) makes a future share get a different one.
const uuid = entry?.uuid ?? crypto.randomUUID();
const { bucket: BUCKET, dist: DIST_ID, base: BASE_URL, env: AWS_ENV } = CFG;
const url = `${BASE_URL}/${uuid}/index.html`;

try {
  const cp = (file, key, type) =>
    execFileSync(
      'aws',
      ['s3', 'cp', file, `s3://${BUCKET}/${uuid}/${key}`, '--content-type', type, '--cache-control', 'max-age=15', '--only-show-errors'],
      { env: AWS_ENV, stdio: quiet ? 'ignore' : 'inherit' }
    );
  cp(outFile, 'index.html', 'text/html; charset=utf-8');
  cp(dataFile, 'data.json', 'application/json; charset=utf-8');
  execFileSync(
    'aws',
    ['cloudfront', 'create-invalidation', '--distribution-id', DIST_ID, '--paths', `/${uuid}/*`, '--query', 'Invalidation.Id', '--output', 'text'],
    { env: AWS_ENV, stdio: quiet ? 'ignore' : 'inherit' }
  );
} catch (e) {
  console.error(`deploy failed: ${e.message}`);
  process.exit(1);
}

shares[slug] = { uuid, url, auto: true, custos: !semCustos, publicado_em: buildAt };
writeShares(shares);
log(`✅ ${url}`);
process.exit(0);
