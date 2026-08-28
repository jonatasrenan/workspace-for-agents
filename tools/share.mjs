// Publica UM repo como página estática em <WFA_SHARE_BASE>/<uuid>/index.html
// (S3 + CloudFront, um UUID por caminho — configuração em .env, ver .env.example).
//
// Uso:
//   node tools/share.mjs <repo>                  # gera e publica (cria uuid na 1ª vez)
//   node tools/share.mjs <repo> --sem-custos     # publica sem o painel Custos / badges de tokens
//   node tools/share.mjs <repo> --dry-run        # só gera o html local, mostra o caminho
//   node tools/share.mjs <repo> --off            # pausa a republicação automática (página fica no ar)
//   node tools/share.mjs <repo> --delete         # tira do ar (remove do S3 + apaga o registro)
//   node tools/share.mjs <repo> --quiet          # modo silencioso (usado pelo viewer)
//
// O ESCOPO é o repo: a página leva só aquele repo (tasks, agentes que atuaram
// nele, guardrails, totais recalculados) — nenhum outro repo do harness entra no
// HTML. Vários repos podem estar compartilhados ao mesmo tempo, cada um com sua URL.
//
// O viewer (viewer/server.mjs) chama este script sozinho quando um repo com share
// ativo muda — o agente nunca faz deploy manualmente.
//
// Registro: .shares.json na raiz (fora do git):
//   { "shares": { "<repo>": { uuid, url, auto, custos, publicado_em } } }
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
// --- configuração de publicação: sem defaults, tudo vem do ambiente ---
// Variáveis de ambiente ou um `.env` na raiz (não versionado — modelo em .env.example).
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
  WFA_SHARE_BUCKET: 'bucket S3 de destino (ex.: meu-bucket-de-site)',
  WFA_SHARE_DIST: 'id da distribuição CloudFront à frente do bucket (ex.: E123ABC456DEFG)',
  WFA_SHARE_BASE: 'URL base pública, sem barra final (ex.: https://exemplo.com)',
  AWS_PROFILE: 'perfil do AWS CLI com acesso ao bucket e à distribuição',
  AWS_DEFAULT_REGION: 'região da AWS (ex.: us-east-1)',
};

// Só publicar e despublicar tocam a AWS: --dry-run e --off não exigem configuração.
function config() {
  const faltando = Object.keys(CONFIG_OBRIGATORIA).filter((k) => !process.env[k]);
  if (faltando.length) {
    console.error('publicação não configurada. Defina no ambiente ou em um .env na raiz:');
    for (const k of faltando) console.error(`  ${k}  — ${CONFIG_OBRIGATORIA[k]}`);
    console.error('modelo pronto: cp .env.example .env  (sem AWS, use --dry-run para gerar só o HTML local)');
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
  console.error('uso: node tools/share.mjs <repo> [--sem-custos|--dry-run|--off|--delete|--quiet]');
  process.exit(1);
}
// Flag desconhecida NUNCA passa: um "--dry-runn" digitado errado publicaria de
// verdade em S3, que é a única ação irreversível deste projeto.
const FLAGS_VALIDAS = ['--dry-run', '--quiet', '--off', '--delete', '--sem-custos'];
const desconhecidas = args.filter((a) => a.startsWith('--') && !FLAGS_VALIDAS.includes(a));
if (desconhecidas.length) {
  console.error(`flag desconhecida: ${desconhecidas.join(', ')} — aceitas: ${FLAGS_VALIDAS.join(', ')}`);
  process.exit(1);
}
const posicionais = args.filter((a) => !a.startsWith('--'));
if (posicionais.length > 1) {
  console.error(`só um repo por vez: recebi ${posicionais.join(', ')}`);
  process.exit(1);
}
if (!fs.existsSync(path.join(ROOT, 'repos', slug))) {
  console.error(`repo não encontrado: repos/${slug}`);
  process.exit(1);
}

// Falha cedo: publicar exige a infraestrutura configurada. --dry-run, --off e
// --delete seguem sem isso (o --delete pede a configuração só quando há o que remover).
const CFG = dry || off || del ? null : config();

// --- registro de shares (um por repo) ---
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
  fs.renameSync(tmp, SHARES_FILE); // troca atômica: o viewer lê este arquivo a cada mudança
}

const shares = readShares();
const entry = shares[slug] ?? null;

if (off) {
  if (!entry) {
    log(`repo não está compartilhado: ${slug}`);
    process.exit(0);
  }
  entry.auto = false;
  writeShares(shares);
  log('republicação automática pausada (a página continua no ar)');
  process.exit(0);
}

if (del) {
  if (!entry) {
    log(`repo não está compartilhado: ${slug}`);
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
    console.error(`remoção no S3 falhou: ${e.message}`);
    process.exit(1);
  }
  delete shares[slug];
  writeShares(shares);
  log(`descompartilhado (removido do S3): ${slug} — um novo compartilhamento gera outra URL`);
  process.exit(0);
}

// --- state ESCOPADO no repo ---
// Tudo que a página mostra sai daqui: qualquer campo com outro repo dentro seria
// vazamento, então o payload é remontado do zero com o repo pedido.
const full = buildState();
const repo = full.repos.find((r) => r.slug === slug);
if (!repo) {
  console.error(`repo não encontrado no state: ${slug}`);
  process.exit(1);
}

// agentes que atuaram NESTE repo (roster + custos + mensagens + DAG): só as
// definições deles vão junto — o catálogo inteiro de .claude/agents não é do repo.
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

// --sem-custos: os números somem do PAYLOAD (não só da tela) — a página publicada
// não carrega token/USD nenhum; a flag fica no registro e vale nas republicações.
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

// --- limpeza: nada de outro repo sai na publicação ---
// Um repo pode citar os vizinhos legitimamente (mesmo cluster, mesma máquina):
// entradas identificadas por outro repo (linha de deployment/serviço/acesso) são
// REMOVIDAS e as menções restantes em texto viram "outro repo". A fonte em
// repos/ não é tocada — a limpeza acontece só no que vai para o ar.
const outros = full.repos
  .filter((r) => r.slug !== slug)
  .map((r) => r.slug)
  .sort((a, b) => b.length - a.length); // slug mais longo primeiro: evita substituição parcial
const OUTRO = 'outro serviço do cluster';
const scrubStr = (s) => outros.reduce((acc, o) => acc.split(o).join(OUTRO), s);
// Item do estado que não é deste repo: identificado por outro repo, ou vivendo em
// outro namespace ("kube-system/metrics-server") — a página mostra o runtime DO
// repo, não o inventário da máquina onde ele roda.
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
      if (outros.includes(k)) continue; // coleção indexada por repo: a chave alheia sai inteira
      out[scrubStr(k)] = scrub(val, inEstado || k === 'estado' || k === 'acessos');
    }
    return out;
  }
  return v;
}
const clean = scrub(data);

// guarda dura: depois da limpeza, nenhum slug de outro repo pode sobrar no payload
const dataJsonRaw = JSON.stringify(clean);
if (clean.repos.length !== 1 || clean.repos[0].slug !== slug) {
  console.error(`abortado: o payload deveria conter só ${slug}`);
  process.exit(1);
}
const vazou = outros.filter((s) => dataJsonRaw.includes(s));
if (vazou.length) {
  console.error(`abortado: o payload de ${slug} ainda menciona outro(s) repo(s): ${vazou.join(', ')}`);
  process.exit(1);
}

// --- html autocontido: MESMO app.js/style.css do viewer, em modo estático ---
// O esqueleto é o próprio viewer/public/index.html (fonte única): as tags externas
// viram conteúdo embutido. Toda melhoria no painel entra aqui automaticamente.
const pub = (f) => fs.readFileSync(path.join(PUBLIC_DIR, f), 'utf8');
const css = pub('style.css');
const appJs = pub('app.js');
const markedJs = pub('vendor/marked.min.js');
const mermaidJs = pub('vendor/mermaid.min.js');
const dataJson = dataJsonRaw.replace(/</g, '\\u003c');
const buildAt = new Date().toISOString();
// hash do código da página: dados novos com mesmo código → atualização suave no
// navegador de quem assiste; código novo → reload completo.
const appHash = crypto.createHash('sha1').update(appJs).update(css).digest('hex').slice(0, 12);
const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const title = `${repo.title} — Workspace for Agents`;

const bootstrap = `
window.__STATIC__ = true;
window.__NO_COSTS__ = ${semCustos ? 'true' : 'false'};
window.__BUILD_AT__ = "${buildAt}";
window.__APP_HASH__ = "${appHash}";
window.__DATA__ = ${dataJson};`;

// substituições sobre o esqueleto do viewer — se alguma não casar, o index.html
// mudou de forma e a página sairia quebrada: falha alto em vez de publicar lixo.
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
    console.error(`esqueleto do viewer mudou: nada casou com ${re} em viewer/public/index.html`);
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
log(`html gerado: ${outFile} (${(html.length / 1024 / 1024).toFixed(1)} MB)`);

if (dry) {
  log('(dry-run — nada foi enviado)');
  process.exit(0);
}

// uuid = identidade permanente DESTE compartilhamento: republicar mantém a URL;
// só --delete (que apaga o registro) faz um futuro share nascer com outra.
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
  console.error(`deploy falhou: ${e.message}`);
  process.exit(1);
}

shares[slug] = { uuid, url, auto: true, custos: !semCustos, publicado_em: buildAt };
writeShares(shares);
log(`✅ ${url}`);
process.exit(0);
