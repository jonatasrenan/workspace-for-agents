// Live state of a repo — repos/<repo>/estado.json, timestamped sections.
// PUSH model: whoever touches the environment registers the state; the viewer only renders.
// Usage:
//   node tools/state.mjs set <repo> <secao>   (stdin = the section's JSON; atualizado_em is written automatically)
//   node tools/state.mjs show <repo>
// Valid sections: runtime, ambiente, origem. Suggested formats:
//   runtime  = {"deployments":[{"nome":"hello-k8s","ready":"2/2","restarts":0,"idade":"101m"}],
//               "imagens":["hello-k8s:1.0.0"]}
//   ambiente = {"docker":"27.4.0","minikube":"v1.38.1","kubectl":"v1.35.1",
//               "minimos":{"docker":">29.5","minikube":">1.38"}}
//   origem   = {"upstream":"<origin remote URL, or null if the repo is local>","clonado_em":"YYYY-MM-DD"}
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson, updateJson } from './jsonfile.mjs';
import { stateRoot } from './root.mjs';

const ROOT = stateRoot();
const SECOES = ['runtime', 'ambiente', 'origem'];

function die(msg) {
  console.error(msg);
  process.exit(1);
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

function readEstado(repoDir) {
  const file = path.join(repoDir, 'estado.json');
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    die(`${path.relative(ROOT, file)} is not valid JSON: ${e.message}`);
  }
}

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === 'set') {
  const [repoSlug, secao] = rest;
  if (!repoSlug || !secao) die('usage: node tools/state.mjs set <repo> <secao>  (stdin = the section\'s JSON)');
  if (!SECOES.includes(secao)) die(`invalid section: "${secao}" — accepted: ${SECOES.join(', ')}`);
  const repoDir = resolveRepo(repoSlug);
  const stdin = fs.readFileSync(0, 'utf8').trim();
  if (!stdin) die('stdin empty — send the section\'s JSON (e.g.: echo \'{"docker":"27.4.0"}\' | node tools/state.mjs set <repo> ambiente)');
  let dados;
  try {
    dados = JSON.parse(stdin);
  } catch (e) {
    die(`stdin is not valid JSON: ${e.message}`);
  }
  if (dados === null || typeof dados !== 'object' || Array.isArray(dados)) {
    die('the section must be a JSON object ({...}), not an array/scalar');
  }
  // Read→modify→write under a lock: different sections written in parallel (the
  // operator updates runtime while the pilot updates ambiente) aren't lost.
  updateJson(path.join(repoDir, 'estado.json'), {}, (estado) => {
    if (!estado || typeof estado !== 'object' || Array.isArray(estado)) die(`repos/${repoSlug}/estado.json is not a valid JSON object`);
    estado[secao] = { ...dados, atualizado_em: new Date().toISOString() };
    return estado;
  });
  touchMeta(repoDir);
  console.log(`section "${secao}" written to repos/${repoSlug}/estado.json`);
} else if (cmd === 'show') {
  const [repoSlug] = rest;
  const repoDir = resolveRepo(repoSlug);
  const estado = readEstado(repoDir);
  if (!Object.keys(estado).length) {
    console.log(`(no state registered in repos/${repoSlug} — use "set")`);
    process.exit(0);
  }
  console.log(JSON.stringify(estado, null, 2));
} else {
  die('usage: node tools/state.mjs <set|show> <repo> [...]');
}
