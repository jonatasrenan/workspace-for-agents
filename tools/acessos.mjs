// Access entries (live URLs) for a repo — repos/<repo>/acessos.json.
// PUSH model: whoever opens/exposes an access entry registers it here; the viewer only renders.
// An ephemeral URL (port-forward, tunnel) ALWAYS comes with --nota saying how to recreate it.
// Usage:
//   node tools/acessos.mjs add <repo> --nome N --url U --tipo app|metricas|dashboard|outro [--nota "..."]
//     (upsert by nome: if it already exists, updates url/tipo/nota and registrado_em)
//   node tools/acessos.mjs remove <repo> --nome N
//   node tools/acessos.mjs list <repo>
// Format: {"acessos":[{"nome","url","tipo","nota","registrado_em"}]}
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson, updateJson } from './jsonfile.mjs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TIPOS = ['app', 'metricas', 'dashboard', 'outro'];

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

// Resolves <repo>, with an error that lists the options.
function resolveRepo(repoSlug) {
  if (!repoSlug) die('missing argument: <repo>');
  const reposDir = path.join(ROOT, 'repos');
  const repoDir = path.join(reposDir, repoSlug);
  if (!fs.existsSync(path.join(repoDir, 'meta.json'))) {
    const existentes = fs.existsSync(reposDir) ? fs.readdirSync(reposDir).filter((d) => !d.startsWith('.')) : [];
    die(`repo not found: ${repoSlug}${existentes.length ? ` — existing: ${existentes.join(', ')}` : ' — no repo created yet (use new-repo.mjs)'}`);
  }
  return repoDir;
}

function touchMeta(repoDir) {
  const metaPath = path.join(repoDir, 'meta.json');
  if (!fs.existsSync(metaPath)) return;
  updateJson(metaPath, null, (meta) => {
    if (!meta) return undefined; // meta unreadable: this command won't be the one to rewrite it
    meta.updated = new Date().toISOString().slice(0, 10);
    return meta;
  });
}

function readAcessos(repoDir) {
  const file = path.join(repoDir, 'acessos.json');
  if (!fs.existsSync(file)) return { acessos: [] };
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(data.acessos)) die(`${path.relative(ROOT, file)} missing "acessos" field (array)`);
    return data;
  } catch (e) {
    if (e instanceof SyntaxError) die(`${path.relative(ROOT, file)} is not valid JSON: ${e.message}`);
    throw e;
  }
}

// Read→modify→write under a lock: two agents registering access entries at the same time
// can't overwrite each other's record nor leave the file half-written.
function mutateAcessos(repoDir, fn) {
  const file = path.join(repoDir, 'acessos.json');
  updateJson(file, { acessos: [] }, (data) => {
    if (!data || !Array.isArray(data.acessos)) die(`${path.relative(ROOT, file)} invalid: missing "acessos" field (array)`);
    fn(data);
    return data;
  });
  touchMeta(repoDir);
}

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === 'add') {
  const { flags, pos } = parseArgs(rest, ['nome', 'url', 'tipo', 'nota']);
  const [repoSlug] = pos;
  if (!repoSlug || !flags.nome || !flags.url || !flags.tipo) {
    die('usage: node tools/acessos.mjs add <repo> --nome N --url U --tipo app|metricas|dashboard|outro [--nota "..."]');
  }
  if (!TIPOS.includes(flags.tipo)) die(`invalid tipo: "${flags.tipo}" — accepted: ${TIPOS.join(', ')}`);
  const repoDir = resolveRepo(repoSlug);
  let existente;
  const registro = {
    nome: flags.nome,
    url: flags.url,
    tipo: flags.tipo,
    nota: flags.nota ?? '',
    registrado_em: new Date().toISOString(),
  };
  mutateAcessos(repoDir, (data) => {
    existente = data.acessos.find((a) => a.nome === flags.nome);
    if (existente) {
      registro.nota = flags.nota ?? existente.nota ?? '';
      data.acessos[data.acessos.indexOf(existente)] = registro;
    } else {
      data.acessos.push(registro);
    }
  });
  console.log(`access ${existente ? 'updated' : 'registered'}: ${registro.nome} [${registro.tipo}] ${registro.url} in repos/${repoSlug}/acessos.json`);
} else if (cmd === 'remove') {
  const { flags, pos } = parseArgs(rest, ['nome']);
  const [repoSlug] = pos;
  if (!repoSlug || !flags.nome) die('usage: node tools/acessos.mjs remove <repo> --nome N');
  const repoDir = resolveRepo(repoSlug);
  mutateAcessos(repoDir, (data) => {
    const idx = data.acessos.findIndex((a) => a.nome === flags.nome);
    if (idx === -1) {
      const nomes = data.acessos.map((a) => a.nome);
      die(`access not found: "${flags.nome}"${nomes.length ? ` — existing: ${nomes.join(', ')}` : ' — no access registered'}`);
    }
    data.acessos.splice(idx, 1);
  });
  console.log(`access removed: ${flags.nome} from repos/${repoSlug}/acessos.json`);
} else if (cmd === 'list') {
  const { pos } = parseArgs(rest, []);
  const [repoSlug] = pos;
  const repoDir = resolveRepo(repoSlug);
  const { acessos } = readAcessos(repoDir);
  if (!acessos.length) {
    console.log(`(no access registered in repos/${repoSlug})`);
    process.exit(0);
  }
  for (const a of acessos) {
    const nota = a.nota ? `  — ${a.nota}` : '';
    console.log(`${a.nome} [${a.tipo}]  ${a.url}  (registered ${a.registrado_em})${nota}`);
  }
} else {
  die('usage: node tools/acessos.mjs <add|remove|list> <repo> [...]');
}
