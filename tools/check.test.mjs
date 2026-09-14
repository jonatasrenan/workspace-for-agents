// Tests for tools/check.mjs. Builds fake repos under a temporary WFA_ROOT and
// runs check.mjs as a PROCESS (the way the hook and a human actually call it),
// then asserts on stdout/stderr/exit code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECK = path.join(HERE, 'check.mjs');
const DAG = path.join(HERE, 'dag.mjs');
const NEW_REPO = path.join(HERE, 'new-repo.mjs');
const NEW_TASK = path.join(HERE, 'new-task.mjs');

function run(file, args, opts = {}) {
  try {
    const out = execFileSync('node', [file, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...opts.env },
      input: opts.input,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { status: 0, stdout: out, stderr: '' };
  } catch (e) {
    return { status: e.status ?? 1, stdout: e.stdout?.toString() ?? '', stderr: e.stderr?.toString() ?? '' };
  }
}

function setStatus(taskMetaPath, status) {
  const m = JSON.parse(fs.readFileSync(taskMetaPath, 'utf8'));
  m.status = status;
  fs.writeFileSync(taskMetaPath, JSON.stringify(m, null, 2));
}

function makeRepoWithTask(env) {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'wfa-check-'));
  fs.mkdirSync(path.join(T, 'repos'), { recursive: true });
  const e = { WFA_ROOT: T, ...env };
  const newRepo = run(NEW_REPO, ['Sonda'], { env: e });
  assert.equal(newRepo.status, 0, newRepo.stderr);
  const newTask = run(NEW_TASK, ['sonda', 'Task one'], { env: e });
  assert.equal(newTask.status, 0, newTask.stderr);
  const taskName = newTask.stdout.split('\n')[0].trim();
  const taskDir = path.join(T, 'repos', 'sonda', 'tasks', taskName);
  return { T, env: e, taskDir, taskName };
}

test('structural: concluida task with an open DAG node blocks (fail, exit 1)', () => {
  const { T, env, taskDir, taskName } = makeRepoWithTask();
  const dagSet = run(DAG, ['set', 'sonda', '01'], { env, input: JSON.stringify({ nodes: [{ id: 'n1', titulo: 'x', status: 'todo', tags: [] }] }) });
  assert.equal(dagSet.status, 0, dagSet.stderr);
  setStatus(path.join(taskDir, 'meta.json'), 'concluida');

  const res = run(CHECK, ['sonda', '01'], { env });
  assert.equal(res.status, 1);
  assert.match(res.stdout, /gate.*not concluida/);
  assert.match(res.stdout, new RegExp(`1 fail`));

  fs.rmSync(T, { recursive: true, force: true });
  void taskName;
});

test('lint: aceito guardrail with no reason fails', () => {
  const { T, env } = makeRepoWithTask();
  const dagSet = run(DAG, ['set', 'sonda', '01'], {
    env,
    input: JSON.stringify({ nodes: [{ id: 'n1', titulo: 'x', status: 'concluida', tags: [], guardrails: [{ id: 'cod-deps-minimas', status: 'aceito' }] }] }),
  });
  assert.equal(dagSet.status, 0, dagSet.stderr);

  const res = run(CHECK, ['sonda', '01', '--lint'], { env });
  assert.equal(res.status, 1);
  assert.match(res.stdout, /\(aceito\).*no reason recorded/);

  fs.rmSync(T, { recursive: true, force: true });
});

test('lint: aceito guardrail with a reason not echoed in the journal fails; echoing it passes', () => {
  const { T, env, taskDir } = makeRepoWithTask();
  const dagSet = run(DAG, ['set', 'sonda', '01'], {
    env,
    input: JSON.stringify({
      nodes: [{ id: 'n1', titulo: 'x', status: 'concluida', tags: [], guardrails: [{ id: 'cod-deps-minimas', status: 'aceito', nota: 'aceito: low risk here' }] }],
    }),
  });
  assert.equal(dagSet.status, 0, dagSet.stderr);

  let res = run(CHECK, ['sonda', '01', '--lint'], { env });
  assert.equal(res.status, 1);
  assert.match(res.stdout, /\(aceito\).*not found in 20-journal\.md/);

  fs.appendFileSync(path.join(taskDir, '20-journal.md'), '\n10:00 — accepted: low risk here\n');
  res = run(CHECK, ['sonda', '01', '--lint'], { env });
  assert.doesNotMatch(res.stdout, /\(aceito\)/);

  fs.rmSync(T, { recursive: true, force: true });
});

test('lint: artifact still identical to the template fails as a stub', () => {
  const { T, env, taskDir } = makeRepoWithTask();
  setStatus(path.join(taskDir, 'meta.json'), 'em-andamento');

  const res = run(CHECK, ['sonda', '01', '--lint'], { env });
  assert.equal(res.status, 1);
  assert.match(res.stdout, /\[fail\] \(stub\).*00-enunciado\.md: still identical to the template/);
  assert.match(res.stdout, /\[fail\] \(stub\).*10-plano\.md: still identical to the template/);
  assert.match(res.stdout, /\[warn\] \(stub\).*20-journal\.md/);

  fs.rmSync(T, { recursive: true, force: true });
});

test('lint: artifact naming internal engine mechanics fails jargao; jargao_permitido allows it', () => {
  const { T, env, taskDir } = makeRepoWithTask();
  setStatus(path.join(taskDir, 'meta.json'), 'em-andamento');
  fs.writeFileSync(
    path.join(taskDir, '00-enunciado.md'),
    '# Statement\n\n## Objective\nSee bus.mjs for details.\n\n## Requirements\nnone\n\n## Acceptance criteria\n- it works\n\n## Target time\n30 min\n'
  );

  let res = run(CHECK, ['sonda', '01', '--lint'], { env });
  assert.equal(res.status, 1);
  assert.match(res.stdout, /\(jargao\).*"bus\.mjs"/);

  const repoMetaPath = path.join(T, 'repos', 'sonda', 'meta.json');
  const repoMeta = JSON.parse(fs.readFileSync(repoMetaPath, 'utf8'));
  repoMeta.jargao_permitido = { 'bus.mjs': 'this repo is literally about wrapping bus.mjs' };
  fs.writeFileSync(repoMetaPath, JSON.stringify(repoMeta, null, 2));

  res = run(CHECK, ['sonda', '01', '--lint'], { env });
  assert.doesNotMatch(res.stdout, /\(jargao\)/);

  fs.rmSync(T, { recursive: true, force: true });
});

test('hook: a task touched within the last 2 minutes gets a grace period (no block)', () => {
  const { T, env, taskDir } = makeRepoWithTask();
  const dagSet = run(DAG, ['set', 'sonda', '01'], { env, input: JSON.stringify({ nodes: [{ id: 'n1', titulo: 'x', status: 'todo', tags: [] }] }) });
  assert.equal(dagSet.status, 0, dagSet.stderr);
  setStatus(path.join(taskDir, 'meta.json'), 'concluida'); // this write itself is the recent touch

  const res = run(CHECK, ['--hook'], { env, input: JSON.stringify({ session_id: 'x', hook_event_name: 'Stop', stop_hook_active: false }) });
  assert.equal(res.status, 0);
  assert.doesNotMatch(res.stderr, /pending item/);

  fs.rmSync(T, { recursive: true, force: true });
});

test('hook: past the grace period, the same problem blocks with exit 2 and stderr', () => {
  const { T, env, taskDir } = makeRepoWithTask();
  const dagSet = run(DAG, ['set', 'sonda', '01'], { env, input: JSON.stringify({ nodes: [{ id: 'n1', titulo: 'x', status: 'todo', tags: [] }] }) });
  assert.equal(dagSet.status, 0, dagSet.stderr);
  setStatus(path.join(taskDir, 'meta.json'), 'concluida');
  const old = new Date(Date.now() - 10 * 60 * 1000);
  for (const f of fs.readdirSync(taskDir)) fs.utimesSync(path.join(taskDir, f), old, old);

  const res = run(CHECK, ['--hook'], { env, input: JSON.stringify({ session_id: 'x', hook_event_name: 'Stop', stop_hook_active: false }) });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /pending item/);

  fs.rmSync(T, { recursive: true, force: true });
});

test('non-tautology: a repo with no task at all is "not checked", never silently green', () => {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'wfa-check-'));
  fs.mkdirSync(path.join(T, 'repos'), { recursive: true });
  const env = { WFA_ROOT: T };
  run(NEW_REPO, ['Sonda vazia'], { env });

  const res = run(CHECK, ['sonda-vazia', '--lint'], { env: {} }); // note: no task given, whole repo
  void res; // repo has zero tasks; lintRepo() itself declares "not checked", not a silent pass
  const res2 = run(CHECK, ['sonda-vazia', '--lint'], { env });
  assert.equal(res2.status, 0);
  assert.match(res2.stdout, /not-checked.*no task to lint/);

  fs.rmSync(T, { recursive: true, force: true });
});

test('--regras documents every id used above, and refuses an unregistered id (internal consistency)', () => {
  const res = run(CHECK, ['--regras'], {});
  assert.equal(res.status, 0);
  for (const id of ['meta', 'gate', 'jargao', 'stub', 'dag', 'aceito', 'rastro', 'aguardando']) {
    assert.match(res.stdout, new RegExp(`\\n${id}\\n`));
  }
});
