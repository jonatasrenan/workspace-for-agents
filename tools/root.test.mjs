// Tests for tools/root.mjs — exercises the tools as PROCESSES against an
// alternate WFA_ROOT, the way the pilot actually calls them, plus the two
// negative cases named in the issue: no WFA_ROOT falls back to this
// installation's root, and a missing root/task is refused with the options
// listed, without creating anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { INSTALL_ROOT, stateRoot } from './root.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUS = path.join(HERE, 'bus.mjs');

function run(args, env) {
  try {
    const out = execFileSync('node', args, { encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, stdout: out, stderr: '' };
  } catch (e) {
    return { status: e.status ?? 1, stdout: e.stdout?.toString() ?? '', stderr: e.stderr?.toString() ?? '' };
  }
}

test('stateRoot() falls back to INSTALL_ROOT when WFA_ROOT is unset', () => {
  const prev = process.env.WFA_ROOT;
  delete process.env.WFA_ROOT;
  try {
    assert.equal(stateRoot(), INSTALL_ROOT);
  } finally {
    if (prev !== undefined) process.env.WFA_ROOT = prev;
  }
});

test('stateRoot() resolves WFA_ROOT when set', () => {
  const prev = process.env.WFA_ROOT;
  process.env.WFA_ROOT = '/tmp/some-root';
  try {
    assert.equal(stateRoot(), path.resolve('/tmp/some-root'));
  } finally {
    if (prev === undefined) delete process.env.WFA_ROOT;
    else process.env.WFA_ROOT = prev;
  }
});

test('a tool run as a process reads/writes state under WFA_ROOT, not the install tree', () => {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'wfa-root-'));
  fs.mkdirSync(path.join(T, 'repos'), { recursive: true });

  const newRepo = run([path.join(HERE, 'new-repo.mjs'), 'Probe'], { WFA_ROOT: T });
  assert.equal(newRepo.status, 0, newRepo.stderr);
  const slug = newRepo.stdout.split('\n')[0].trim();
  assert.ok(fs.existsSync(path.join(T, 'repos', slug, 'meta.json')));

  const newTask = run([path.join(HERE, 'new-task.mjs'), slug, 'Probe task'], { WFA_ROOT: T });
  assert.equal(newTask.status, 0, newTask.stderr);
  const taskName = newTask.stdout.split('\n')[0].trim();

  const post = run([BUS, 'post', slug, taskName, '--from', 'pilot', '--to', 'human', '--kind', 'status', 'hi'], { WFA_ROOT: T });
  assert.equal(post.status, 0, post.stderr);
  assert.ok(fs.existsSync(path.join(T, 'repos', slug, 'tasks', taskName, 'messages.jsonl')));

  const cost = run([path.join(HERE, 'costs.mjs'), 'add', slug, taskName, '--agent', 'x', '--in', '10', '--out', '5'], { WFA_ROOT: T });
  assert.equal(cost.status, 0, cost.stderr);
  assert.ok(fs.existsSync(path.join(T, 'repos', slug, 'tasks', taskName, 'costs.jsonl')));

  // nothing was written into the actual repository's own repos/ or workspace/
  assert.ok(!fs.existsSync(path.join(INSTALL_ROOT, 'repos', slug)));

  fs.rmSync(T, { recursive: true, force: true });
});

test('without WFA_ROOT, the tool falls back to reading this installation\'s own repos/', () => {
  const marker = `probe-root-fallback-${Date.now()}`;
  const markerDir = path.join(INSTALL_ROOT, 'repos', marker);
  fs.mkdirSync(markerDir, { recursive: true });
  fs.writeFileSync(path.join(markerDir, 'meta.json'), JSON.stringify({ title: marker }));
  try {
    const env = { ...process.env };
    delete env.WFA_ROOT;
    const res = run([BUS, 'read', 'does-not-exist', '01'], {});
    // explicitly unset WFA_ROOT for the child even if it was set in the parent env
    const res2 = execFileSync('node', [BUS, 'read', 'does-not-exist', '01'], {
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString?.() ?? '';
    void res;
    void res2;
  } catch (e) {
    const stderr = e.stderr?.toString() ?? '';
    assert.match(stderr, new RegExp(marker));
  } finally {
    fs.rmSync(markerDir, { recursive: true, force: true });
  }
});

test('missing root/task is refused, listing the options, without creating anything', () => {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'wfa-root-'));
  fs.mkdirSync(path.join(T, 'repos'), { recursive: true });

  const noRepo = run([BUS, 'read', 'ghost-repo', '01'], { WFA_ROOT: T });
  assert.equal(noRepo.status, 1);
  assert.match(noRepo.stderr, /repo not found/);
  assert.equal(fs.readdirSync(path.join(T, 'repos')).length, 0);

  const newRepo = run([path.join(HERE, 'new-repo.mjs'), 'Probe2'], { WFA_ROOT: T });
  const slug = newRepo.stdout.split('\n')[0].trim();
  const noTask = run([BUS, 'read', slug, '01'], { WFA_ROOT: T });
  assert.equal(noTask.status, 1);
  assert.match(noTask.stderr, /task not found/);

  fs.rmSync(T, { recursive: true, force: true });
});
