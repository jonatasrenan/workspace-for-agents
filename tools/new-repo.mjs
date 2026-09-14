// Deterministic repo setup — the LLM never hand-types the skeleton.
// Usage: node tools/new-repo.mjs "Repo title" [--slug <slug>]
// Creates in one call:
//   repos/<slug>/           (meta.json + 00-context.md + tasks/)
//   workspace/<slug>/       (git init -b main + minimal README.md — CLEAN code repo)
// Prints to stdout: line 1 is the slug (the agent uses it directly).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CONTEXT_TEMPLATE, slugify } from './templates.mjs';
import { stateRoot } from './root.mjs';
import { ensureMemoryFiles } from './fs.mjs';

const ROOT = stateRoot();
// This is the session's entry point: a fresh WFA_ROOT (or a fresh clone) gets
// its learnings.md seeded here, once, instead of every tool having to check.
ensureMemoryFiles(ROOT);
const args = process.argv.slice(2);
// Explicit parsing: the --slug value must not be confused with the title, and
// an unknown flag is an error (silently ignoring it would create the wrong repo).
const posicionais = [];
let slugArg = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--slug') {
    slugArg = args[++i] ?? null;
    if (slugArg === null || slugArg.startsWith('--')) {
      console.error('--slug requires a value: --slug <slug>');
      process.exit(1);
    }
  } else if (args[i].startsWith('--')) {
    console.error(`unknown flag: ${args[i]} — accepted: --slug <slug>`);
    process.exit(1);
  } else {
    posicionais.push(args[i]);
  }
}
const title = posicionais[0];
if (!title || posicionais.length > 1) {
  console.error('usage: node tools/new-repo.mjs "Repo title" [--slug <slug>]');
  process.exit(1);
}

const slug = slugArg ? slugify(slugArg) : slugify(title);
if (!slug) {
  console.error(`title/slug does not produce a valid slug: "${slugArg ?? title}"`);
  process.exit(1);
}

const repoDir = path.join(ROOT, 'repos', slug);
const wsDir = path.join(ROOT, 'workspace', slug);
if (fs.existsSync(repoDir) || fs.existsSync(wsDir)) {
  console.error(`repo already exists: ${slug} (${fs.existsSync(repoDir) ? 'repos/' : 'workspace/'}${slug})`);
  process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);

// --- repos/<slug>/: harness metadata ---
fs.mkdirSync(path.join(repoDir, 'tasks'), { recursive: true });
fs.writeFileSync(
  path.join(repoDir, 'meta.json'),
  JSON.stringify(
    { title, stack: [], status: 'em-andamento', created: today, updated: today, workspace: `workspace/${slug}` },
    null,
    2
  ) + '\n'
);
const [contextFile, contextContent] = CONTEXT_TEMPLATE;
fs.writeFileSync(path.join(repoDir, contextFile), contextContent);

// --- workspace/<slug>/: repo's own code, clean (no harness artifacts) ---
fs.mkdirSync(wsDir, { recursive: true });
const git = spawnSync('git', ['init', '-b', 'main'], { cwd: wsDir, stdio: 'pipe' });
if (git.status !== 0) {
  console.error(`git init failed in workspace/${slug}: ${git.stderr}`);
  process.exit(1);
}
fs.writeFileSync(path.join(wsDir, 'README.md'), `# ${title}\n`);

console.log(slug);
console.log(`created: repos/${slug}/ (meta.json, ${contextFile}, tasks/) and workspace/${slug}/ (git main, README.md)`);
console.log('next step: fill in 00-context.md and create the first task with new-task.mjs');
