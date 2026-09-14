// Live state of a repo — repos/<repo>/state.json, timestamped sections.
// PUSH model: whoever touches the environment registers the state; the viewer only renders.
// Usage:
//   node tools/state.mjs set <repo> <section>   (stdin = the section's JSON; updated_at is written automatically)
//   node tools/state.mjs show <repo>
// Valid sections: runtime, environment, origin. Suggested formats:
//   runtime  = {"deployments":[{"name":"hello-k8s","ready":"2/2","restarts":0,"age":"101m"}],
//               "images":["hello-k8s:1.0.0"]}
//   environment = {"docker":"27.4.0","minikube":"v1.38.1","kubectl":"v1.35.1",
//               "minimums":{"docker":">29.5","minikube":">1.38"}}
//   origin      = {"upstream":"<origin remote URL, or null if the repo is local>","cloned_at":"YYYY-MM-DD"}
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson, updateJson } from './jsonfile.mjs';
import { stateRoot } from './root.mjs';

const ROOT = stateRoot();
const SECTIONS = ['runtime', 'environment', 'origin'];

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

function readState(repoDir) {
  const file = path.join(repoDir, 'state.json');
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    die(`${path.relative(ROOT, file)} is not valid JSON: ${e.message}`);
  }
}

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === 'set') {
  const [repoSlug, section] = rest;
  if (!repoSlug || !section) die('usage: node tools/state.mjs set <repo> <section>  (stdin = the section\'s JSON)');
  if (!SECTIONS.includes(section)) die(`invalid section: "${section}" — accepted: ${SECTIONS.join(', ')}`);
  const repoDir = resolveRepo(repoSlug);
  const stdin = fs.readFileSync(0, 'utf8').trim();
  if (!stdin) die('stdin empty — send the section\'s JSON (e.g.: echo \'{"docker":"27.4.0"}\' | node tools/state.mjs set <repo> environment)');
  let data;
  try {
    data = JSON.parse(stdin);
  } catch (e) {
    die(`stdin is not valid JSON: ${e.message}`);
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    die('the section must be a JSON object ({...}), not an array/scalar');
  }
  // Read→modify→write under a lock: different sections written in parallel (the
  // operator updates runtime while the pilot updates environment) aren't lost.
  updateJson(path.join(repoDir, 'state.json'), {}, (state) => {
    if (!state || typeof state !== 'object' || Array.isArray(state)) die(`repos/${repoSlug}/state.json is not a valid JSON object`);
    state[section] = { ...data, updated_at: new Date().toISOString() };
    return state;
  });
  touchMeta(repoDir);
  console.log(`section "${section}" written to repos/${repoSlug}/state.json`);
} else if (cmd === 'show') {
  const [repoSlug] = rest;
  const repoDir = resolveRepo(repoSlug);
  const state = readState(repoDir);
  if (!Object.keys(state).length) {
    console.log(`(no state registered in repos/${repoSlug} — use "set")`);
    process.exit(0);
  }
  console.log(JSON.stringify(state, null, 2));
} else {
  die('usage: node tools/state.mjs <set|show> <repo> [...]');
}
