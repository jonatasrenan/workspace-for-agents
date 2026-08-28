// Cria uma task de repo a partir dos templates (cabeçalhos prontos, LLM só preenche).
// Uso: node tools/new-task.mjs <repo-slug> "Título da task" [--depends-on "01,02"]
// Cria repos/<repo>/tasks/<nn>-<slug>/ com meta.json + os 4 .md;
// nn é o próximo número livre (01, 02, ...). Atualiza meta.updated do repo.
// --depends-on: lista separada por vírgula de tasks já existentes no repo (prefixo
// numérico ou nome completo); grava "depends_on": ["<nn-slug>", ...] no meta.json
// da task criada. Campo ausente = sem dependência.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TASK_TEMPLATES, slugify } from './templates.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Resolve os itens de --depends-on (prefixo "01" ou nome completo) contra a lista
// de tasks existentes; retorna nomes completos, sem duplicatas. Lança Error com
// mensagem clara (listando as tasks do repo) quando algum item não existe.
export function resolveDependsOn(raw, tasks) {
  const tokens = String(raw)
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  if (!tokens.length) {
    throw new Error('--depends-on vazio — passe uma lista separada por vírgula (ex.: "01,02")');
  }
  const resolved = [];
  for (const t of tokens) {
    const prefixo = /^\d+$/.test(t) ? t.padStart(2, '0') : null;
    const match = tasks.find((d) => d === t) ?? (prefixo && tasks.find((d) => d.startsWith(`${prefixo}-`)));
    if (!match) {
      throw new Error(
        `dependência não encontrada: "${t}"${tasks.length ? ` — tasks existentes: ${tasks.join(', ')}` : ' — nenhuma task criada ainda neste repo'}`
      );
    }
    if (!resolved.includes(match)) resolved.push(match);
  }
  return resolved;
}

function main() {
  const argv = process.argv.slice(2);
  const pos = [];
  let dependsOnRaw;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--depends-on') {
      if (i + 1 >= argv.length) {
        console.error('--depends-on exige um valor (ex.: --depends-on "01,02")');
        process.exit(1);
      }
      dependsOnRaw = argv[++i];
    } else if (argv[i].startsWith('--')) {
      console.error(`flag desconhecida: ${argv[i]} (aceita: --depends-on)`);
      process.exit(1);
    } else {
      pos.push(argv[i]);
    }
  }
  const [repoSlug, title] = pos;
  if (!repoSlug || !title) {
    console.error('uso: node tools/new-task.mjs <repo-slug> "Título da task" [--depends-on "01,02"]');
    process.exit(1);
  }

  if (/[/\\]|\.\./.test(repoSlug)) {
    console.error(`repo inválido: "${repoSlug}" — use só o slug do repo (sem barras nem "..")`);
    process.exit(1);
  }
  const repoDir = path.join(ROOT, 'repos', repoSlug);
  if (!fs.existsSync(path.join(repoDir, 'meta.json'))) {
    const existentes = fs.existsSync(path.join(ROOT, 'repos'))
      ? fs.readdirSync(path.join(ROOT, 'repos')).filter((d) => !d.startsWith('.'))
      : [];
    console.error(`repo não encontrado: ${repoSlug}${existentes.length ? ` — existentes: ${existentes.join(', ')}` : ' — nenhum repo criado ainda (use new-repo.mjs)'}`);
    process.exit(1);
  }

  const slug = slugify(title);
  if (!slug) {
    console.error(`título não gera slug válido: "${title}"`);
    process.exit(1);
  }

  const tasksDir = path.join(repoDir, 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  const existing = fs.readdirSync(tasksDir).filter((d) => /^\d{2}-/.test(d)).sort();
  if (existing.some((d) => d.replace(/^\d{2}-/, '') === slug)) {
    console.error(`task já existe: ${existing.find((d) => d.replace(/^\d{2}-/, '') === slug)}`);
    process.exit(1);
  }

  let dependsOn;
  if (dependsOnRaw !== undefined) {
    try {
      dependsOn = resolveDependsOn(dependsOnRaw, existing);
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
  }

  const nn = String(Math.max(0, ...existing.map((d) => parseInt(d, 10))) + 1).padStart(2, '0');
  const taskName = `${nn}-${slug}`;
  const taskDir = path.join(tasksDir, taskName);
  fs.mkdirSync(taskDir);

  const today = new Date().toISOString().slice(0, 10);
  const taskMeta = { title, status: 'todo', created: today, updated: today };
  if (dependsOn) taskMeta.depends_on = dependsOn;
  fs.writeFileSync(path.join(taskDir, 'meta.json'), JSON.stringify(taskMeta, null, 2) + '\n');
  for (const [file, content] of Object.values(TASK_TEMPLATES)) {
    fs.writeFileSync(path.join(taskDir, file), content);
  }

  // atualiza updated do repo
  const metaPath = path.join(repoDir, 'meta.json');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  meta.updated = today;
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');

  console.log(taskName);
  console.log(
    `criados: repos/${repoSlug}/tasks/${taskName}/ (meta.json, ${Object.values(TASK_TEMPLATES)
      .map(([f]) => f)
      .join(', ')})`
  );
  if (dependsOn) console.log(`depende de: ${dependsOn.join(', ')}`);
}

// Guard: só executa como CLI (permite importar resolveDependsOn em testes).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
