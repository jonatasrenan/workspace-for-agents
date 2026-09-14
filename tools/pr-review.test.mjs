// Tests for tools/pr-review.mjs. Pure-logic pieces (areaFor, computeSignature,
// resolveBase) are unit-tested directly; post/verify's actual `gh` interaction
// (publishing to / reading from a real PR) is NOT exercised here — there is no
// live PR to test against in this environment. Their argument validation and
// the merge-commit refusal (the one behavior a wrong CI checkout would trip)
// ARE exercised, as processes, against throwaway git repos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { areaFor, groupByArea, resolveBase } from './pr-review.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PR_REVIEW = path.join(HERE, 'pr-review.mjs');

test('areaFor: classifies by top-level directory / extension', () => {
  assert.equal(areaFor('tools/bus.mjs'), 'tools');
  assert.equal(areaFor('viewer/server.mjs'), 'panel');
  assert.equal(areaFor('viewer/public/app.js'), 'panel');
  assert.equal(areaFor('.claude/agents/x.md'), 'agents and harness config');
  assert.equal(areaFor('.github/workflows/check.yml'), 'agents and harness config');
  assert.equal(areaFor('guardrails/pool.json'), 'guardrails');
  assert.equal(areaFor('README.md'), 'docs');
  assert.equal(areaFor('.env.example'), 'other');
});

test('groupByArea: groups a file list, preserving each area as its own bucket', () => {
  const groups = groupByArea(['tools/a.mjs', 'tools/b.mjs', 'README.md', 'x.txt']);
  assert.deepEqual(groups.tools, ['tools/a.mjs', 'tools/b.mjs']);
  assert.deepEqual(groups.docs, ['README.md']);
  assert.deepEqual(groups.other, ['x.txt']);
});

function makeGitRepo() {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'wfa-prreview-'));
  const git = (args) => execFileSync('git', args, { cwd: T, encoding: 'utf8' });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@test.com']);
  git(['config', 'user.name', 'test']);
  fs.writeFileSync(path.join(T, 'a.txt'), 'a\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'base']);
  const base = git(['rev-parse', 'HEAD']).trim();
  fs.writeFileSync(path.join(T, 'a.txt'), 'a\nb\n');
  fs.writeFileSync(path.join(T, 'c.txt'), 'c\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'change']);
  const head = git(['rev-parse', 'HEAD']).trim();
  return { T, git, base, head };
}

function run(args, opts = {}) {
  const r = spawnSync('node', [PR_REVIEW, ...args], { cwd: opts.cwd, encoding: 'utf8', input: opts.input ?? '' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// computeSignature() itself is exercised as a process below (two briefings,
// same base/head, must print the same hash) rather than by importing and
// calling it directly here: it calls the module's internal git() helper,
// which is pinned to REPO_ROOT at IMPORT time (correct for the real CLI,
// where each invocation is a fresh process — but a direct in-process call
// after process.chdir() would silently keep operating on THIS test file's
// own repo, found by testing, not inspection).
test('computeSignature (via the CLI, across two separate processes): same base/head -> same signature; a different diff -> a different one', () => {
  const { T, git, base, head } = makeGitRepo();
  try {
    const sig = (h) => run(['--base', base, '--head', h], { cwd: T }).stdout.match(/signature: ([0-9a-f]{16})/)[1];
    assert.equal(sig(head), sig(head), 'two separate processes, same content, must sign the same');

    fs.writeFileSync(path.join(T, 'a.txt'), 'a\nb\nd\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'more']);
    const head2 = git(['rev-parse', 'HEAD']).trim();
    assert.notEqual(sig(head2), sig(head), 'a different diff must sign differently');
  } finally {
    fs.rmSync(T, { recursive: true, force: true });
  }
});

test('resolveBase (direct call): explicit --base is returned as-is', () => {
  assert.equal(resolveBase('some-explicit-ref'), 'some-explicit-ref');
});

test('base resolution (via the CLI): with no upstream and no --base, refuses rather than silently picking a remote', () => {
  const { T, base } = makeGitRepo();
  try {
    const res = run([], { cwd: T });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /cannot resolve a base/);
    void base;
  } finally {
    fs.rmSync(T, { recursive: true, force: true });
  }
});

test('briefing: with an explicit base it runs end to end, includes the signature and the checks section', () => {
  const { T, base, head } = makeGitRepo();
  try {
    const res = run(['--base', base, '--head', head], { cwd: T });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /=== PR review briefing ===/);
    assert.match(res.stdout, /## Files changed \(2\)/);
    assert.match(res.stdout, /signature: [0-9a-f]{16}/);
    assert.match(res.stdout, /## Deterministic checks/);
  } finally {
    fs.rmSync(T, { recursive: true, force: true });
  }
});

test('post: rejects stdin missing "verdict", or invalid JSON, without needing gh at all', () => {
  const { T, base, head } = makeGitRepo();
  try {
    let res = run(['post', '--dry-run', '--base', base, '--head', head], { cwd: T, input: '{"findings":[]}' });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /needs a non-empty "verdict"/);

    res = run(['post', '--dry-run', '--base', base, '--head', head], { cwd: T, input: 'not json' });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /not valid JSON/);
  } finally {
    fs.rmSync(T, { recursive: true, force: true });
  }
});

test('post --dry-run: embeds a signature that matches the briefing\'s, and never calls gh', () => {
  const { T, base, head } = makeGitRepo();
  try {
    const briefing = run(['--base', base, '--head', head], { cwd: T });
    const sigMatch = briefing.stdout.match(/signature: ([0-9a-f]{16})/);
    assert.ok(sigMatch);

    const res = run(['post', '--dry-run', '--base', base, '--head', head], {
      cwd: T,
      input: JSON.stringify({ verdict: 'approved', findings: [], checked: ['tests'] }),
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /dry-run — nothing published/);
    assert.match(res.stdout, new RegExp(`wfa-pr-review: \\{"hash":"${sigMatch[1]}"`));
  } finally {
    fs.rmSync(T, { recursive: true, force: true });
  }
});

test('verify: a merge commit as HEAD (the synthetic pull_request checkout) is refused unless --head is given', () => {
  const { T, git, base } = makeGitRepo();
  try {
    git(['checkout', '-q', '-b', 'feature']);
    fs.writeFileSync(path.join(T, 'feat.txt'), 'x\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'feature commit']);
    const featureHead = git(['rev-parse', 'HEAD']).trim();
    git(['checkout', '-q', 'main']);
    git(['merge', '-q', '--no-ff', 'feature', '-m', 'synthetic merge']);

    const res = run(['verify', '--pr', '1', '--base', base], { cwd: T });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /is a merge commit/);
    assert.match(res.stderr, /--head/);
    void featureHead;
  } finally {
    fs.rmSync(T, { recursive: true, force: true });
  }
});

test('verify: usage error without --pr', () => {
  const res = run(['verify'], { cwd: process.cwd() });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /usage: node tools\/pr-review\.mjs verify --pr N/);
});
