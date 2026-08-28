// Acessos (URLs vivas) de um repo — repos/<repo>/acessos.json.
// Modelo PUSH: quem abre/expõe um acesso registra aqui; o viewer só renderiza.
// URL efêmera (port-forward, túnel) SEMPRE entra com --nota dizendo como recriar.
// Uso:
//   node tools/acessos.mjs add <repo> --nome N --url U --tipo app|metricas|dashboard|outro [--nota "..."]
//     (upsert por nome: se já existe, atualiza url/tipo/nota e o registrado_em)
//   node tools/acessos.mjs remove <repo> --nome N
//   node tools/acessos.mjs list <repo>
// Formato: {"acessos":[{"nome","url","tipo","nota","registrado_em"}]}
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
      if (!valueFlags.includes(name)) die(`flag desconhecida: --${name} (aceitas: ${valueFlags.map((f) => `--${f}`).join(', ')})`);
      if (i + 1 >= argv.length) die(`--${name} exige um valor`);
      flags[name] = argv[++i];
    } else {
      pos.push(a);
    }
  }
  return { flags, pos };
}

// Resolve <repo> com erro que lista as opções.
function resolveRepo(repoSlug) {
  if (!repoSlug) die('falta argumento: <repo>');
  const reposDir = path.join(ROOT, 'repos');
  const repoDir = path.join(reposDir, repoSlug);
  if (!fs.existsSync(path.join(repoDir, 'meta.json'))) {
    const existentes = fs.existsSync(reposDir) ? fs.readdirSync(reposDir).filter((d) => !d.startsWith('.')) : [];
    die(`repo não encontrado: ${repoSlug}${existentes.length ? ` — existentes: ${existentes.join(', ')}` : ' — nenhum repo criado ainda (use new-repo.mjs)'}`);
  }
  return repoDir;
}

function touchMeta(repoDir) {
  const metaPath = path.join(repoDir, 'meta.json');
  if (!fs.existsSync(metaPath)) return;
  updateJson(metaPath, null, (meta) => {
    if (!meta) return undefined; // meta ilegível: não é este comando que vai reescrevê-lo
    meta.updated = new Date().toISOString().slice(0, 10);
    return meta;
  });
}

function readAcessos(repoDir) {
  const file = path.join(repoDir, 'acessos.json');
  if (!fs.existsSync(file)) return { acessos: [] };
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(data.acessos)) die(`${path.relative(ROOT, file)} sem campo "acessos" (array)`);
    return data;
  } catch (e) {
    if (e instanceof SyntaxError) die(`${path.relative(ROOT, file)} não é JSON válido: ${e.message}`);
    throw e;
  }
}

// Ler→alterar→gravar sob lock: dois agentes registrando acessos ao mesmo tempo
// não podem sobrescrever o registro um do outro nem deixar o arquivo pela metade.
function mutateAcessos(repoDir, fn) {
  const file = path.join(repoDir, 'acessos.json');
  updateJson(file, { acessos: [] }, (data) => {
    if (!data || !Array.isArray(data.acessos)) die(`${path.relative(ROOT, file)} inválido: sem campo "acessos" (array)`);
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
    die('uso: node tools/acessos.mjs add <repo> --nome N --url U --tipo app|metricas|dashboard|outro [--nota "..."]');
  }
  if (!TIPOS.includes(flags.tipo)) die(`tipo inválido: "${flags.tipo}" — aceitos: ${TIPOS.join(', ')}`);
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
  console.log(`acesso ${existente ? 'atualizado' : 'registrado'}: ${registro.nome} [${registro.tipo}] ${registro.url} em repos/${repoSlug}/acessos.json`);
} else if (cmd === 'remove') {
  const { flags, pos } = parseArgs(rest, ['nome']);
  const [repoSlug] = pos;
  if (!repoSlug || !flags.nome) die('uso: node tools/acessos.mjs remove <repo> --nome N');
  const repoDir = resolveRepo(repoSlug);
  mutateAcessos(repoDir, (data) => {
    const idx = data.acessos.findIndex((a) => a.nome === flags.nome);
    if (idx === -1) {
      const nomes = data.acessos.map((a) => a.nome);
      die(`acesso não encontrado: "${flags.nome}"${nomes.length ? ` — existentes: ${nomes.join(', ')}` : ' — nenhum acesso registrado'}`);
    }
    data.acessos.splice(idx, 1);
  });
  console.log(`acesso removido: ${flags.nome} de repos/${repoSlug}/acessos.json`);
} else if (cmd === 'list') {
  const { pos } = parseArgs(rest, []);
  const [repoSlug] = pos;
  const repoDir = resolveRepo(repoSlug);
  const { acessos } = readAcessos(repoDir);
  if (!acessos.length) {
    console.log(`(nenhum acesso registrado em repos/${repoSlug})`);
    process.exit(0);
  }
  for (const a of acessos) {
    const nota = a.nota ? `  — ${a.nota}` : '';
    console.log(`${a.nome} [${a.tipo}]  ${a.url}  (registrado ${a.registrado_em})${nota}`);
  }
} else {
  die('uso: node tools/acessos.mjs <add|remove|list> <repo> [...]');
}
