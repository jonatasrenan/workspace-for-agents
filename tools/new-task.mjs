// Creates a repo task from the templates (headers ready-made, LLM only fills them in).
// Usage: node tools/new-task.mjs <repo-slug> "Task title" [--depends-on "01,02"]
// Creates repos/<repo>/tasks/<nn>-<slug>/ with meta.json + the 4 .md files;
// nn is the next free number (01, 02, ...). Updates the repo's meta.updated.
// --depends-on: comma-separated list of tasks that already exist in the repo (numeric
// prefix or full name); writes "depends_on": ["<nn-slug>", ...] to the created task's
// meta.json. Field absent = no dependency.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TASK_TEMPLATES, slugify } from './templates.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Resolves the --depends-on items (prefix "01" or full name) against the list
// of existing tasks; returns full names, without duplicates. Throws an Error with a
// clear message (listing the repo's tasks) when an item doesn't exist.
export function resolveDependsOn(raw, tasks) {
  const tokens = String(raw)
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  if (!tokens.length) {
    throw new Error('--depends-on is empty — pass a comma-separated list (e.g.: "01,02")');
  }
  const resolved = [];
  for (const t of tokens) {
    const prefixo = /^\d+$/.test(t) ? t.padStart(2, '0') : null;
    const match = tasks.find((d) => d === t) ?? (prefixo && tasks.find((d) => d.startsWith(`${prefixo}-`)));
    if (!match) {
      throw new Error(
        `dependency not found: "${t}"${tasks.length ? ` — existing tasks: ${tasks.join(', ')}` : ' — no task created yet in this repo'}`
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
        console.error('--depends-on requires a value (e.g.: --depends-on "01,02")');
        process.exit(1);
      }
      dependsOnRaw = argv[++i];
    } else if (argv[i].startsWith('--')) {
      console.error(`unknown flag: ${argv[i]} (accepted: --depends-on)`);
      process.exit(1);
    } else {
      pos.push(argv[i]);
    }
  }
  const [repoSlug, title] = pos;
  if (!repoSlug || !title) {
    console.error('usage: node tools/new-task.mjs <repo-slug> "Task title" [--depends-on "01,02"]');
    process.exit(1);
  }

  if (/[/\\]|\.\./.test(repoSlug)) {
    console.error(`invalid repo: "${repoSlug}" — use only the repo slug (no slashes or "..")`);
    process.exit(1);
  }
  const repoDir = path.join(ROOT, 'repos', repoSlug);
  if (!fs.existsSync(path.join(repoDir, 'meta.json'))) {
    const existentes = fs.existsSync(path.join(ROOT, 'repos'))
      ? fs.readdirSync(path.join(ROOT, 'repos')).filter((d) => !d.startsWith('.'))
      : [];
    console.error(`repo not found: ${repoSlug}${existentes.length ? ` — existing: ${existentes.join(', ')}` : ' — no repo created yet (use new-repo.mjs)'}`);
    process.exit(1);
  }

  const slug = slugify(title);
  if (!slug) {
    console.error(`title does not produce a valid slug: "${title}"`);
    process.exit(1);
  }

  const tasksDir = path.join(repoDir, 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  const existing = fs.readdirSync(tasksDir).filter((d) => /^\d{2}-/.test(d)).sort();
  if (existing.some((d) => d.replace(/^\d{2}-/, '') === slug)) {
    console.error(`task already exists: ${existing.find((d) => d.replace(/^\d{2}-/, '') === slug)}`);
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

  // update the repo's updated field
  const metaPath = path.join(repoDir, 'meta.json');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  meta.updated = today;
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');

  console.log(taskName);
  console.log(
    `created: repos/${repoSlug}/tasks/${taskName}/ (meta.json, ${Object.values(TASK_TEMPLATES)
      .map(([f]) => f)
      .join(', ')})`
  );
  if (dependsOn) console.log(`depends on: ${dependsOn.join(', ')}`);
}

// Guard: only runs as CLI (allows importing resolveDependsOn in tests).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
