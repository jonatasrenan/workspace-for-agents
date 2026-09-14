// Tests for tools/migrate.mjs — builds a repo with the PRE-rename vocabulary
// (Portuguese file names, keys and values) under a temporary WFA_ROOT, runs the
// migration as a process, and asserts that the result is what the current tools
// and the panel read. Idempotency is part of the contract: running it twice
// must not touch anything the second time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATE = path.join(HERE, 'migrate.mjs');

function run(args, env) {
  try {
    const out = execFileSync('node', [MIGRATE, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout: out, stderr: '' };
  } catch (e) {
    return { status: e.status ?? 1, stdout: e.stdout?.toString() ?? '', stderr: e.stderr?.toString() ?? '' };
  }
}

const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

// A repo exactly as the pre-rename tools would have left it on disk.
function oldRoot() {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'wfa-migrate-'));
  const repo = path.join(T, 'repos', 'sonda');
  const task = path.join(repo, 'tasks', '01-deploy');
  write(path.join(repo, 'meta.json'), JSON.stringify({ title: 'Sonda', stack: [], status: 'em-andamento', created: '2026-01-01', updated: '2026-01-02', workspace: 'workspace/sonda', jargao_permitido: { 'bus.mjs': 'why' } }));
  write(path.join(repo, '00-contexto.md'), '# Contexto\n');
  write(path.join(repo, 'agents.json'), JSON.stringify({ agents: [{ name: 'k8s-operator', role: 'ops', status: 'ocioso', last_task: '01-deploy' }] }));
  write(path.join(repo, 'acessos.json'), JSON.stringify({ acessos: [{ nome: 'app', url: 'http://x', tipo: 'metricas', nota: 'port-forward', registrado_em: '2026-01-01T00:00:00.000Z' }] }));
  write(path.join(repo, 'estado.json'), JSON.stringify({ runtime: { deployments: [{ nome: 'hello', ready: '2/2', idade: '10m' }], imagens: ['hello:1'], atualizado_em: '2026-01-01T00:00:00.000Z' }, ambiente: { docker: '27', minimos: { docker: '>26' } }, origem: { upstream: null, clonado_em: '2026-01-01' } }));
  write(path.join(task, 'meta.json'), JSON.stringify({ title: 'Deploy', status: 'concluida', created: '2026-01-01', updated: '2026-01-02' }));
  write(path.join(task, '00-enunciado.md'), '# Enunciado\n');
  write(path.join(task, '10-plano.md'), '# Plano\n');
  write(path.join(task, '20-journal.md'), '# Journal\n');
  write(
    path.join(task, 'dag.json'),
    JSON.stringify({
      nodes: [
        { id: 'n1', titulo: 'Build', status: 'concluida', agente: 'k8s-operator', tags: ['codigo'], guardrails: [{ id: 'cod-deps-minimas', status: 'aceito', nota: 'aceito: sem tempo' }] },
        { id: 'n2', titulo: 'Deploy', status: 'executando', depends_on: ['n1'], tags: ['k8s'], guardrails: [{ id: 'k8s-imagem-tag', status: 'pendente' }] },
      ],
    })
  );
  write(
    path.join(task, 'messages.jsonl'),
    [
      JSON.stringify({ id: 'q1', ts: '2026-01-01T00:00:00.000Z', from: 'piloto', to: 'humano', kind: 'question', body: 'A ou B?' }),
      JSON.stringify({ id: 'a1', ts: '2026-01-01T00:01:00.000Z', from: 'humano', to: 'piloto', kind: 'status', body: 'B', meta: { responde: 'q1' } }),
      JSON.stringify({ ts: '2026-01-01T00:02:00.000Z', from: 'dag', to: 'sala', kind: 'status', body: 'node n1 → concluida', meta: { node: 'n1', para: 'concluida' } }),
    ].join('\n') + '\n'
  );
  write(path.join(task, 'costs.jsonl'), JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', agente: 'k8s-operator', tokens_in: 10, tokens_out: 5, tokens_total: 15, modelo: 'claude-opus-5' }) + '\n');
  return { T, repo, task };
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const readJsonl = (p) => fs.readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('migrate: artifacts, state files, keys and values all move to the English names', () => {
  const { T, repo, task } = oldRoot();
  const res = run(['--all'], { WFA_ROOT: T });
  assert.equal(res.status, 0, res.stderr);

  // artifacts and state files renamed
  for (const f of [path.join(repo, '00-context.md'), path.join(task, '00-brief.md'), path.join(task, '10-plan.md'), path.join(repo, 'access.json'), path.join(repo, 'state.json')]) {
    assert.ok(fs.existsSync(f), `missing ${path.relative(T, f)}`);
  }
  for (const f of [path.join(repo, '00-contexto.md'), path.join(task, '00-enunciado.md'), path.join(task, '10-plano.md'), path.join(repo, 'acessos.json'), path.join(repo, 'estado.json')]) {
    assert.ok(!fs.existsSync(f), `still there: ${path.relative(T, f)}`);
  }

  // meta: status vocabulary and the lint's allow-list key
  assert.equal(readJson(path.join(repo, 'meta.json')).status, 'in-progress');
  assert.deepEqual(readJson(path.join(repo, 'meta.json')).allowed_jargon, { 'bus.mjs': 'why' });
  assert.equal(readJson(path.join(task, 'meta.json')).status, 'done');

  // dag: keys, statuses, guardrail ids, tags and the accepted note's prefix
  const dag = readJson(path.join(task, 'dag.json'));
  assert.equal(dag.nodes[0].title, 'Build');
  assert.equal(dag.nodes[0].agent, 'k8s-operator');
  assert.equal(dag.nodes[0].status, 'done');
  assert.deepEqual(dag.nodes[0].tags, ['code']);
  assert.equal(dag.nodes[0].guardrails[0].id, 'code-minimal-deps');
  assert.equal(dag.nodes[0].guardrails[0].status, 'accepted');
  assert.equal(dag.nodes[0].guardrails[0].note, 'accepted: sem tempo');
  assert.equal(dag.nodes[1].status, 'running');
  assert.equal(dag.nodes[1].guardrails[0].id, 'k8s-image-tag');
  assert.equal(dag.nodes[1].guardrails[0].status, 'pending');

  // agents, access, state
  assert.equal(readJson(path.join(repo, 'agents.json')).agents[0].status, 'idle');
  const access = readJson(path.join(repo, 'access.json')).accesses[0];
  assert.deepEqual(
    { name: access.name, type: access.type, note: access.note, registered_at: access.registered_at },
    { name: 'app', type: 'metrics', note: 'port-forward', registered_at: '2026-01-01T00:00:00.000Z' }
  );
  const state = readJson(path.join(repo, 'state.json'));
  assert.equal(state.runtime.deployments[0].name, 'hello');
  assert.equal(state.runtime.deployments[0].age, '10m');
  assert.deepEqual(state.runtime.images, ['hello:1']);
  assert.equal(state.runtime.updated_at, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(state.environment.minimums, { docker: '>26' });
  assert.equal(state.origin.cloned_at, '2026-01-01');

  // bus: actors, the closing link and the DAG transition
  const msgs = readJsonl(path.join(task, 'messages.jsonl'));
  assert.equal(msgs[0].from, 'pilot');
  assert.equal(msgs[0].to, 'human');
  assert.equal(msgs[1].meta.answers, 'q1');
  assert.equal(msgs[1].meta.responde, undefined);
  assert.equal(msgs[2].to, 'room');
  assert.equal(msgs[2].body, 'node n1 → done');
  assert.equal(msgs[2].meta.to, 'done');

  // costs
  const cost = readJsonl(path.join(task, 'costs.jsonl'))[0];
  assert.equal(cost.agent, 'k8s-operator');
  assert.equal(cost.model, 'claude-opus-5');

  fs.rmSync(T, { recursive: true, force: true });
});

test('migrate: idempotent — a second run reports zero changes and rewrites nothing', () => {
  const { T, task } = oldRoot();
  assert.equal(run(['--all'], { WFA_ROOT: T }).status, 0);
  const before = fs.readFileSync(path.join(task, 'dag.json'), 'utf8');

  const again = run(['--all'], { WFA_ROOT: T });
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /\n0 change\(s\)/);
  assert.equal(fs.readFileSync(path.join(task, 'dag.json'), 'utf8'), before);

  fs.rmSync(T, { recursive: true, force: true });
});

test('migrate: --dry-run lists the changes and writes nothing', () => {
  const { T, task } = oldRoot();
  const res = run(['--all', '--dry-run'], { WFA_ROOT: T });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /\[dry-run\] rename 10-plano\.md → 10-plan\.md/);
  assert.match(res.stdout, /nothing written/);
  assert.ok(fs.existsSync(path.join(task, '10-plano.md')));
  assert.ok(!fs.existsSync(path.join(task, '10-plan.md')));

  fs.rmSync(T, { recursive: true, force: true });
});

test('migrate: a repo named explicitly migrates only that repo, and a missing one is a usage error', () => {
  const { T, task } = oldRoot();
  const missing = run(['ghost'], { WFA_ROOT: T });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /repo not found/);
  assert.ok(fs.existsSync(path.join(task, '10-plano.md')), 'nothing migrated on a usage error');

  assert.equal(run(['sonda'], { WFA_ROOT: T }).status, 0);
  assert.ok(fs.existsSync(path.join(task, '10-plan.md')));

  fs.rmSync(T, { recursive: true, force: true });
});
