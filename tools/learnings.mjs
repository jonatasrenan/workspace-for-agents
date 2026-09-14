// Cross-task memory (learnings.md) — mechanical IO, under a lock, dedupe by
// title, and the four required fields checked at the door. Never edited by
// hand: two agents doing Read then Edit on the same file in the same window
// is a textbook lost update — the second write wins and the first agent's
// item disappears with no error at all.
//
// Usage:
//   node tools/learnings.mjs append [--task <repo>/<task>] [--quiet]   (stdin = one or more "## <title>" blocks)
//   node tools/learnings.mjs promote "<title>" --task <repo>/<task> [--quiet]
//   node tools/learnings.mjs note "<title>" "<text>" [--quiet]
//
// Every new item needs all four fields — **Status**, **Origin**, **Learning**,
// **How to apply** — or the WHOLE submission is rejected (nothing is written).
// An item whose title already exists is skipped with a warning, not an error.
// --task accepts the numeric prefix ("meu-repo/01") like every other tool.
import fs from 'node:fs';
import path from 'node:path';
import { stateRoot } from './root.mjs';
import { writeAtomic, lockFile, ensureMemoryFiles } from './fs.mjs';

const ROOT = stateRoot();
const FILE = path.join(ROOT, 'learnings.md');
const REQUIRED_FIELDS = ['Status', 'Origin', 'Learning', 'How to apply'];

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function parseArgs(argv, valueFlags, boolFlags = []) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      if (boolFlags.includes(name)) {
        flags[name] = true;
      } else if (valueFlags.includes(name)) {
        if (i + 1 >= argv.length) die(`--${name} requires a value`);
        flags[name] = argv[++i];
      } else {
        die(`unknown flag: --${name} (accepted: ${[...valueFlags, ...boolFlags].map((f) => `--${f}`).join(', ')})`);
      }
    } else {
      pos.push(a);
    }
  }
  return { flags, pos };
}

// --task <repo>/<task>: resolves against repos/, task by full name or numeric
// prefix ("01"). Dies listing what exists when the repo or the task isn't there.
function resolveTaskRef(taskRef) {
  const [repoSlug, taskArg] = String(taskRef).split('/');
  if (!repoSlug || !taskArg) die(`--task must be "<repo>/<task>", got "${taskRef}"`);
  const reposDir = path.join(ROOT, 'repos');
  const repoDir = path.join(reposDir, repoSlug);
  if (!fs.existsSync(path.join(repoDir, 'meta.json'))) {
    const existentes = fs.existsSync(reposDir) ? fs.readdirSync(reposDir).filter((d) => !d.startsWith('.')) : [];
    die(`repo not found: ${repoSlug}${existentes.length ? ` — existing: ${existentes.join(', ')}` : ' — no repo created yet (use new-repo.mjs)'}`);
  }
  const tasksDir = path.join(repoDir, 'tasks');
  const tasks = fs.existsSync(tasksDir) ? fs.readdirSync(tasksDir).filter((d) => /^\d{2}-/.test(d)).sort() : [];
  const prefixo = /^\d+$/.test(taskArg) ? taskArg.padStart(2, '0') : null;
  const match = tasks.find((d) => d === taskArg) ?? (prefixo && tasks.find((d) => d.startsWith(`${prefixo}-`)));
  if (!match) {
    die(`task not found: "${taskArg}" in repos/${repoSlug}/tasks${tasks.length ? ` — existing: ${tasks.join(', ')}` : ' — no task created yet (use new-task.mjs)'}`);
  }
  return `repos/${repoSlug}/tasks/${match}`;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// Splits stdin text into "## <title>" blocks, trimmed, in order.
function splitItems(text) {
  const parts = text.split(/\n(?=##[ \t]+)/);
  return parts.map((b) => b.trim()).filter((b) => b.startsWith('## '));
}

function itemTitle(block) {
  return (block.match(/^##[ \t]+(.+)$/m)?.[1] ?? '').trim();
}

function missingFields(block) {
  return REQUIRED_FIELDS.filter((f) => !new RegExp(`^-\\s*\\*\\*${escapeRe(f)}\\*\\*:`, 'm').test(block));
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function setField(block, field, value) {
  const re = new RegExp(`^(-\\s*\\*\\*${escapeRe(field)}\\*\\*:).*$`, 'm');
  if (re.test(block)) return block.replace(re, `$1 ${value}`);
  return `${block}\n- **${field}**: ${value}`;
}

// Fenced ```...``` ranges: the format documentation at the top of the file
// shows "## <short topic>" as a literal example, and it must never be
// mistaken for a real item header.
function fencedRanges(text) {
  const ranges = [];
  for (const m of text.matchAll(/```[\s\S]*?```/g)) ranges.push([m.index, m.index + m[0].length]);
  return ranges;
}
function insideAny(idx, ranges) {
  return ranges.some(([s, e]) => idx >= s && idx < e);
}

// Every "## <title>" header in fileText that is a real item (i.e. not inside
// a fenced code example), as {title, index}, in document order.
function headerMarks(fileText) {
  const fences = fencedRanges(fileText);
  const marks = [];
  for (const m of fileText.matchAll(/^##[ \t]+(.+)$/gm)) {
    if (insideAny(m.index, fences)) continue;
    marks.push({ title: m[1].trim(), index: m.index });
  }
  return marks;
}

function existingTitles(fileText) {
  return new Set(headerMarks(fileText).map((m) => m.title));
}

const PLACEHOLDER = '_(no items yet — the file grows with each retrospective)_';

function readFileText() {
  ensureMemoryFiles(ROOT);
  return fs.readFileSync(FILE, 'utf8');
}

function appendBlocksToText(fileText, blocks) {
  let out = fileText;
  if (out.includes(PLACEHOLDER)) out = out.replace(`\n${PLACEHOLDER}\n`, '\n');
  const trimmed = out.replace(/\s+$/, '');
  return `${trimmed}\n\n${blocks.join('\n\n')}\n`;
}

function findItemBlock(fileText, title) {
  const marks = headerMarks(fileText);
  const idx = marks.findIndex((m) => m.title === title);
  if (idx === -1) return null;
  const start = marks[idx].index;
  const end = idx + 1 < marks.length ? marks[idx + 1].index : fileText.length;
  return { start, end, block: fileText.slice(start, end) };
}

function withLock(fn) {
  const release = lockFile(FILE, { timeoutMs: 5000, staleMs: 60_000 });
  try {
    return fn();
  } finally {
    release();
  }
}

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === 'append') {
  const { flags } = parseArgs(rest, ['task'], ['quiet']);
  const stdin = fs.readFileSync(0, 'utf8');
  const blocks = splitItems(stdin);
  if (!blocks.length) die('stdin has no "## <title>" item to append');

  const errors = [];
  for (const b of blocks) {
    const missing = missingFields(b);
    if (missing.length) errors.push(`"${itemTitle(b) || '(untitled)'}": missing ${missing.map((f) => `**${f}**`).join(', ')}`);
  }
  if (errors.length) {
    die(`append rejected — every item needs all four fields (nothing was written):\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  }

  const originRef = flags.task ? resolveTaskRef(flags.task) : null;
  let written = 0;
  let skipped = 0;
  withLock(() => {
    const fileText = readFileText();
    const titles = existingTitles(fileText);
    const toAppend = [];
    for (const b of blocks) {
      const title = itemTitle(b);
      if (titles.has(title)) {
        skipped++;
        if (!flags.quiet) console.error(`warning: "${title}" already exists — skipped`);
        continue;
      }
      let block = b;
      if (originRef) block = setField(block, 'Origin', `${originRef} (${today()})`);
      toAppend.push(block);
      titles.add(title);
      written++;
    }
    if (toAppend.length) writeAtomic(FILE, appendBlocksToText(fileText, toAppend));
  });
  if (!flags.quiet) console.log(`learnings.md: ${written} item(s) appended, ${skipped} skipped (already existed)`);
} else if (cmd === 'promote') {
  const { flags, pos } = parseArgs(rest, ['task'], ['quiet']);
  const [title] = pos;
  if (!title) die('usage: node tools/learnings.mjs promote "<title>" --task <repo>/<task>');
  if (!flags.task) die('promote requires --task <repo>/<task> — the task that proved the item');
  const originRef = resolveTaskRef(flags.task);
  withLock(() => {
    const fileText = readFileText();
    const found = findItemBlock(fileText, title);
    if (!found) {
      const titles = [...existingTitles(fileText)];
      die(`item not found: "${title}"${titles.length ? ` — existing: ${titles.join(', ')}` : ' — learnings.md has no items yet'}`);
    }
    let block = setField(found.block.trimEnd(), 'Status', 'mastered');
    block = setField(block, 'Promoted', `${originRef} (${today()})`);
    const newText = fileText.slice(0, found.start) + block + '\n' + fileText.slice(found.end);
    writeAtomic(FILE, newText);
  });
  if (!flags.quiet) console.log(`learnings.md: "${title}" promoted to mastered (${originRef})`);
} else if (cmd === 'note') {
  const { flags, pos } = parseArgs(rest, [], ['quiet']);
  const [title, text] = pos;
  if (!title || text === undefined) die('usage: node tools/learnings.mjs note "<title>" "<text>"');
  withLock(() => {
    const fileText = readFileText();
    const found = findItemBlock(fileText, title);
    if (!found) {
      const titles = [...existingTitles(fileText)];
      die(`item not found: "${title}"${titles.length ? ` — existing: ${titles.join(', ')}` : ' — learnings.md has no items yet'}`);
    }
    const block = `${found.block.trimEnd()}\n- **Note (${today()})**: ${text}`;
    const newText = fileText.slice(0, found.start) + block + '\n' + fileText.slice(found.end);
    writeAtomic(FILE, newText);
  });
  if (!flags.quiet) console.log(`learnings.md: note added to "${title}"`);
} else {
  die('usage: node tools/learnings.mjs <append|promote|note> [...]  (the file header documents each subcommand)');
}
