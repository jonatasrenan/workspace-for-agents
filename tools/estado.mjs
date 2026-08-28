// Estado vivo de um repo — repos/<repo>/estado.json, seções timestampadas.
// Modelo PUSH: quem toca no ambiente registra o estado; o viewer só renderiza.
// Uso:
//   node tools/estado.mjs set <repo> <secao>   (stdin = JSON da seção; atualizado_em é gravado automaticamente)
//   node tools/estado.mjs show <repo>
// Seções válidas: runtime, ambiente, origem. Formatos sugeridos:
//   runtime  = {"deployments":[{"nome":"hello-k8s","ready":"2/2","restarts":0,"idade":"101m"}],
//               "imagens":["hello-k8s:1.0.0"]}
//   ambiente = {"docker":"27.4.0","minikube":"v1.38.1","kubectl":"v1.35.1",
//               "minimos":{"docker":">29.5","minikube":">1.38"}}
//   origem   = {"upstream":"<url do remote origin, ou null se repo local>","clonado_em":"YYYY-MM-DD"}
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson, updateJson } from './jsonfile.mjs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECOES = ['runtime', 'ambiente', 'origem'];

function die(msg) {
  console.error(msg);
  process.exit(1);
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

function readEstado(repoDir) {
  const file = path.join(repoDir, 'estado.json');
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    die(`${path.relative(ROOT, file)} não é JSON válido: ${e.message}`);
  }
}

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === 'set') {
  const [repoSlug, secao] = rest;
  if (!repoSlug || !secao) die('uso: node tools/estado.mjs set <repo> <secao>  (stdin = JSON da seção)');
  if (!SECOES.includes(secao)) die(`seção inválida: "${secao}" — aceitas: ${SECOES.join(', ')}`);
  const repoDir = resolveRepo(repoSlug);
  const stdin = fs.readFileSync(0, 'utf8').trim();
  if (!stdin) die('stdin vazio — envie o JSON da seção (ex.: echo \'{"docker":"27.4.0"}\' | node tools/estado.mjs set <repo> ambiente)');
  let dados;
  try {
    dados = JSON.parse(stdin);
  } catch (e) {
    die(`stdin não é JSON válido: ${e.message}`);
  }
  if (dados === null || typeof dados !== 'object' || Array.isArray(dados)) {
    die('a seção deve ser um objeto JSON ({...}), não array/escalar');
  }
  // Ler→alterar→gravar sob lock: seções diferentes gravadas em paralelo (o
  // operador atualiza runtime enquanto o piloto atualiza ambiente) não se perdem.
  updateJson(path.join(repoDir, 'estado.json'), {}, (estado) => {
    if (!estado || typeof estado !== 'object' || Array.isArray(estado)) die(`repos/${repoSlug}/estado.json não é um objeto JSON válido`);
    estado[secao] = { ...dados, atualizado_em: new Date().toISOString() };
    return estado;
  });
  touchMeta(repoDir);
  console.log(`seção "${secao}" gravada em repos/${repoSlug}/estado.json`);
} else if (cmd === 'show') {
  const [repoSlug] = rest;
  const repoDir = resolveRepo(repoSlug);
  const estado = readEstado(repoDir);
  if (!Object.keys(estado).length) {
    console.log(`(sem estado registrado em repos/${repoSlug} — use "set")`);
    process.exit(0);
  }
  console.log(JSON.stringify(estado, null, 2));
} else {
  die('uso: node tools/estado.mjs <set|show> <repo> [...]');
}
