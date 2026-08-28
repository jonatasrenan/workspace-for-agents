// Setup determinístico de repo — a LLM nunca datilografa esqueleto.
// Uso: node tools/new-repo.mjs "Título do repo" [--slug <slug>]
// Cria em uma chamada:
//   repos/<slug>/           (meta.json + 00-contexto.md + tasks/)
//   workspace/<slug>/       (git init -b main + README.md mínimo — repo de código LIMPO)
// Imprime no stdout: linha 1 é o slug (o agente usa direto).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CONTEXTO_TEMPLATE, slugify } from './templates.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
// Parsing explícito: o valor de --slug não pode ser confundido com o título, e
// flag desconhecida é erro (silenciosamente ignorada, criaria o repo errado).
const posicionais = [];
let slugArg = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--slug') {
    slugArg = args[++i] ?? null;
    if (slugArg === null || slugArg.startsWith('--')) {
      console.error('--slug exige um valor: --slug <slug>');
      process.exit(1);
    }
  } else if (args[i].startsWith('--')) {
    console.error(`flag desconhecida: ${args[i]} — aceita: --slug <slug>`);
    process.exit(1);
  } else {
    posicionais.push(args[i]);
  }
}
const title = posicionais[0];
if (!title || posicionais.length > 1) {
  console.error('uso: node tools/new-repo.mjs "Título do repo" [--slug <slug>]');
  process.exit(1);
}

const slug = slugArg ? slugify(slugArg) : slugify(title);
if (!slug) {
  console.error(`título/slug não gera slug válido: "${slugArg ?? title}"`);
  process.exit(1);
}

const repoDir = path.join(ROOT, 'repos', slug);
const wsDir = path.join(ROOT, 'workspace', slug);
if (fs.existsSync(repoDir) || fs.existsSync(wsDir)) {
  console.error(`repo já existe: ${slug} (${fs.existsSync(repoDir) ? 'repos/' : 'workspace/'}${slug})`);
  process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);

// --- repos/<slug>/: metadados do harness ---
fs.mkdirSync(path.join(repoDir, 'tasks'), { recursive: true });
fs.writeFileSync(
  path.join(repoDir, 'meta.json'),
  JSON.stringify(
    { title, stack: [], status: 'em-andamento', created: today, updated: today, workspace: `workspace/${slug}` },
    null,
    2
  ) + '\n'
);
const [contextoFile, contextoContent] = CONTEXTO_TEMPLATE;
fs.writeFileSync(path.join(repoDir, contextoFile), contextoContent);

// --- workspace/<slug>/: repo de código próprio, limpo (sem artefatos do harness) ---
fs.mkdirSync(wsDir, { recursive: true });
const git = spawnSync('git', ['init', '-b', 'main'], { cwd: wsDir, stdio: 'pipe' });
if (git.status !== 0) {
  console.error(`git init falhou em workspace/${slug}: ${git.stderr}`);
  process.exit(1);
}
fs.writeFileSync(path.join(wsDir, 'README.md'), `# ${title}\n`);

console.log(slug);
console.log(`criados: repos/${slug}/ (meta.json, ${contextoFile}, tasks/) e workspace/${slug}/ (git main, README.md)`);
console.log('próximo passo: preencher 00-contexto.md e criar a primeira task com new-task.mjs');
