// Access entries (live URLs) for a repo — repos/<repo>/access.json.
// PUSH model: whoever opens/exposes an access entry registers it here; the viewer only renders.
// An ephemeral URL (port-forward, tunnel) ALWAYS comes with --note saying how to recreate it.
// Usage:
//   node tools/access.mjs add <repo> --name N --url U --type app|metrics|dashboard|other [--note "..."]
//     (upsert by name: if it already exists, updates url/type/note and registered_at)
//   node tools/access.mjs remove <repo> --name N
//   node tools/access.mjs list <repo>
// Format: {"accesses":[{"name","url","type","note","registered_at"}]}
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson, updateJson } from './jsonfile.mjs';
import { stateRoot } from './root.mjs';

const ROOT = stateRoot();
const TYPES = ['app', 'metrics', 'dashboard', 'other'];

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

function readAccess(repoDir) {
  const file = path.join(repoDir, 'access.json');
  if (!fs.existsSync(file)) return { accesses: [] };
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(data.accesses)) die(`${path.relative(ROOT, file)} missing "accesses" field (array)`);
    return data;
  } catch (e) {
    if (e instanceof SyntaxError) die(`${path.relative(ROOT, file)} is not valid JSON: ${e.message}`);
    throw e;
  }
}

// Read→modify→write under a lock: two agents registering access entries at the same time
// can't overwrite each other's record nor leave the file half-written.
function mutateAccess(repoDir, fn) {
  const file = path.join(repoDir, 'access.json');
  updateJson(file, { accesses: [] }, (data) => {
    if (!data || !Array.isArray(data.accesses)) die(`${path.relative(ROOT, file)} invalid: missing "accesses" field (array)`);
    fn(data);
    return data;
  });
  touchMeta(repoDir);
}

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === 'add') {
  const { flags, pos } = parseArgs(rest, ['name', 'url', 'type', 'note']);
  const [repoSlug] = pos;
  if (!repoSlug || !flags.name || !flags.url || !flags.type) {
    die('usage: node tools/access.mjs add <repo> --name N --url U --type app|metrics|dashboard|other [--note "..."]');
  }
  if (!TYPES.includes(flags.type)) die(`invalid type: "${flags.type}" — accepted: ${TYPES.join(', ')}`);
  const repoDir = resolveRepo(repoSlug);
  let existente;
  const registro = {
    name: flags.name,
    url: flags.url,
    type: flags.type,
    note: flags.note ?? '',
    registered_at: new Date().toISOString(),
  };
  mutateAccess(repoDir, (data) => {
    existente = data.accesses.find((a) => a.name === flags.name);
    if (existente) {
      registro.note = flags.note ?? existente.note ?? '';
      data.accesses[data.accesses.indexOf(existente)] = registro;
    } else {
      data.accesses.push(registro);
    }
  });
  console.log(`access ${existente ? 'updated' : 'registered'}: ${registro.name} [${registro.type}] ${registro.url} in repos/${repoSlug}/access.json`);
} else if (cmd === 'remove') {
  const { flags, pos } = parseArgs(rest, ['name']);
  const [repoSlug] = pos;
  if (!repoSlug || !flags.name) die('usage: node tools/access.mjs remove <repo> --name N');
  const repoDir = resolveRepo(repoSlug);
  mutateAccess(repoDir, (data) => {
    const idx = data.accesses.findIndex((a) => a.name === flags.name);
    if (idx === -1) {
      const names = data.accesses.map((a) => a.name);
      die(`access not found: "${flags.name}"${names.length ? ` — existing: ${names.join(', ')}` : ' — no access registered'}`);
    }
    data.accesses.splice(idx, 1);
  });
  console.log(`access removed: ${flags.name} from repos/${repoSlug}/access.json`);
} else if (cmd === 'list') {
  const { pos } = parseArgs(rest, []);
  const [repoSlug] = pos;
  const repoDir = resolveRepo(repoSlug);
  const { accesses } = readAccess(repoDir);
  if (!accesses.length) {
    console.log(`(no access registered in repos/${repoSlug})`);
    process.exit(0);
  }
  for (const a of accesses) {
    const note = a.note ? `  — ${a.note}` : '';
    console.log(`${a.name} [${a.type}]  ${a.url}  (registered ${a.registered_at})${note}`);
  }
} else {
  die('usage: node tools/access.mjs <add|remove|list> <repo> [...]');
}
