// Tests for tools/learnings.mjs, run as a PROCESS against a temp WFA_ROOT.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LEARNINGS = path.join(HERE, 'learnings.mjs');
const NEW_REPO = path.join(HERE, 'new-repo.mjs');
const NEW_TASK = path.join(HERE, 'new-task.mjs');

// spawnSync (not execFileSync): execFileSync only exposes stderr via the
// thrown error on a NON-zero exit — on a successful (exit 0) run, warnings
// learnings.mjs prints to stderr (e.g. "already exists — skipped") would be
// silently lost. spawnSync always gives both streams regardless of status.
function run(file, args, opts = {}) {
  const r = spawnSync('node', [file, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...opts.env },
    input: opts.input ?? '',
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// execFile's promisified form has no `input` shortcut (that's execFileSync-only)
// — feeding stdin async means writing to child.stdin ourselves and ending it,
// or the child's readFileSync(0) blocks forever waiting for EOF that never comes.
function runAsync(file, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [file, ...args], { env: { ...process.env, ...opts.env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(opts.input ?? '');
  });
}

function makeRoot() {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'wfa-learnings-'));
  fs.mkdirSync(path.join(T, 'repos'), { recursive: true });
  const env = { WFA_ROOT: T };
  run(NEW_REPO, ['Sonda'], { env });
  run(NEW_TASK, ['sonda', 'Task one'], { env });
  return { T, env };
}

const item = (title, i) => `## ${title}
- **Status**: open
- **Origin**: x
- **Learning**: learning number ${i}.
- **How to apply**: apply it.
`;

test('append rejects the whole submission when a required field is missing, writes nothing', () => {
  const { T, env } = makeRoot();
  const before = fs.readFileSync(path.join(T, 'learnings.md'), 'utf8'); // new-repo.mjs already seeded it
  const res = run(LEARNINGS, ['append', '--task', 'sonda/01'], {
    env,
    input: '## Missing origin\n- **Status**: open\n- **Learning**: x\n- **How to apply**: y\n',
  });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /missing \*\*Origin\*\*/);
  assert.equal(fs.readFileSync(path.join(T, 'learnings.md'), 'utf8'), before); // untouched
  fs.rmSync(T, { recursive: true, force: true });
});

test('append with --task fills the Origin field; a duplicate title is skipped with a warning, not an error', () => {
  const { T, env } = makeRoot();
  let res = run(LEARNINGS, ['append', '--task', 'sonda/01'], { env, input: item('Dup title', 1) });
  assert.equal(res.status, 0);
  let text = fs.readFileSync(path.join(T, 'learnings.md'), 'utf8');
  assert.match(text, /- \*\*Origin\*\*: repos\/sonda\/tasks\/01-task-one \(\d{4}-\d{2}-\d{2}\)/);

  res = run(LEARNINGS, ['append', '--task', 'sonda/01'], { env, input: item('Dup title', 2) });
  assert.equal(res.status, 0);
  assert.match(res.stderr, /already exists — skipped/);
  text = fs.readFileSync(path.join(T, 'learnings.md'), 'utf8');
  assert.equal((text.match(/## Dup title/g) || []).length, 1);
  assert.match(text, /learning number 1/);
  assert.doesNotMatch(text, /learning number 2/);

  fs.rmSync(T, { recursive: true, force: true });
});

test('promote sets Status to mastered and records which task proved it; unknown title fails listing real titles only', () => {
  const { T, env } = makeRoot();
  run(LEARNINGS, ['append', '--task', 'sonda/01'], { env, input: item('Some item', 1) });

  let res = run(LEARNINGS, ['promote', 'Some item', '--task', 'sonda/01'], { env });
  assert.equal(res.status, 0);
  const text = fs.readFileSync(path.join(T, 'learnings.md'), 'utf8');
  assert.match(text, /- \*\*Status\*\*: mastered/);
  assert.match(text, /- \*\*Promoted\*\*: repos\/sonda\/tasks\/01-task-one/);

  res = run(LEARNINGS, ['promote', 'Does not exist', '--task', 'sonda/01'], { env });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /existing: Some item/);
  assert.doesNotMatch(res.stderr, /short topic/); // the format doc's fenced example must never look like a real title

  fs.rmSync(T, { recursive: true, force: true });
});

test('note appends a dated line to an existing item without touching its other fields', () => {
  const { T, env } = makeRoot();
  run(LEARNINGS, ['append', '--task', 'sonda/01'], { env, input: item('Noted item', 1) });
  const res = run(LEARNINGS, ['note', 'Noted item', 'it happened again'], { env });
  assert.equal(res.status, 0);
  const text = fs.readFileSync(path.join(T, 'learnings.md'), 'utf8');
  assert.match(text, /- \*\*Note \(\d{4}-\d{2}-\d{2}\)\*\*: it happened again/);
  assert.match(text, /learning number 1/);
  fs.rmSync(T, { recursive: true, force: true });
});

test('--task pointing at a nonexistent repo/task is refused, listing what exists', () => {
  const { T, env } = makeRoot();
  const before = fs.readFileSync(path.join(T, 'learnings.md'), 'utf8');
  const res = run(LEARNINGS, ['append', '--task', 'sonda/99'], { env, input: item('X', 1) });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /task not found.*existing: 01-task-one/s);
  assert.equal(fs.readFileSync(path.join(T, 'learnings.md'), 'utf8'), before);
  fs.rmSync(T, { recursive: true, force: true });
});

test('concurrency: N simultaneous append processes with different items all land in the file', async () => {
  const { T, env } = makeRoot();
  const N = 12;
  const runs = [];
  for (let i = 0; i < N; i++) {
    runs.push(runAsync(LEARNINGS, ['append', '--task', 'sonda/01', '--quiet'], { env, input: item(`Concurrent item ${i}`, i) }));
  }
  const results = await Promise.all(runs);
  for (const r of results) assert.equal(r.status, 0, r.stderr);

  const text = fs.readFileSync(path.join(T, 'learnings.md'), 'utf8');
  for (let i = 0; i < N; i++) {
    assert.match(text, new RegExp(`## Concurrent item ${i}\\b`), `item ${i} missing — a write was lost under concurrency`);
  }
  fs.rmSync(T, { recursive: true, force: true });
});
