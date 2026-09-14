import { test } from 'node:test';
import assert from 'node:assert/strict';
import { novoId, refDaMensagem, indiceDaReferencia, ehPergunta, estadoDasPerguntas, perguntasAbertas } from './perguntas.mjs';

function q(id, ts) {
  return { id, ts, from: 'piloto', to: 'humano', kind: 'question', body: `q-${id}` };
}
function answer(ts, respondeRef, from = 'humano') {
  return { id: novoId(ts), ts, from, to: 'piloto', kind: 'status', body: 'ok', meta: { responde: respondeRef } };
}
function dismiss(ts, dispensaRef, from = 'humano') {
  return { id: novoId(ts), ts, from, to: 'piloto', kind: 'status', body: 'skip', meta: { dispensa: dispensaRef } };
}
function humanNoLink(ts) {
  return { id: novoId(ts), ts, from: 'humano', to: 'piloto', kind: 'status', body: 'hi' };
}

test('novoId: two calls at the same ts do not collide', () => {
  const a = novoId('2026-01-01T00:00:00.000Z');
  const b = novoId('2026-01-01T00:00:00.000Z');
  assert.notEqual(a, b);
});

test('ehPergunta: only kind question|decision addressed to humano counts', () => {
  assert.equal(ehPergunta({ to: 'humano', kind: 'question' }), true);
  assert.equal(ehPergunta({ to: 'humano', kind: 'decision' }), true);
  assert.equal(ehPergunta({ to: 'humano', kind: 'status' }), false);
  assert.equal(ehPergunta({ to: 'piloto', kind: 'question' }), false);
});

test('refDaMensagem/indiceDaReferencia: id when present, "<ts>#<index>" fallback otherwise', () => {
  const msgs = [{ ts: 't1' }, { id: 'abc', ts: 't2' }];
  assert.equal(refDaMensagem(msgs[0], 0), 't1#0');
  assert.equal(refDaMensagem(msgs[1], 1), 'abc');
  assert.equal(indiceDaReferencia(msgs, 't1#0'), 0);
  assert.equal(indiceDaReferencia(msgs, 'abc'), 1);
  assert.equal(indiceDaReferencia(msgs, 'nope'), -1);
});

test('a plain question with no link at all is aberta', () => {
  const msgs = [q('q1', 't1')];
  const estados = estadoDasPerguntas(msgs);
  assert.equal(estados[0].estado, 'aberta');
  assert.equal(perguntasAbertas(msgs).length, 1);
});

test('an explicit responde link closes exactly that question, leaves siblings open', () => {
  const msgs = [q('q1', 't1'), q('q2', 't2'), answer('t3', 'q1')];
  const estados = estadoDasPerguntas(msgs);
  assert.equal(estados[0].estado, 'respondida');
  assert.equal(estados[0].fechadaPorIndex, 2);
  assert.equal(estados[1].estado, 'aberta');
  assert.deepEqual(
    perguntasAbertas(msgs).map((m) => m.id),
    ['q2']
  );
});

test('an explicit dispensa link marks dispensada, distinct from respondida', () => {
  const msgs = [q('q1', 't1'), dismiss('t2', 'q1')];
  const estados = estadoDasPerguntas(msgs);
  assert.equal(estados[0].estado, 'dispensada');
});

test('the FIRST explicit link to a question wins; a later one changes nothing', () => {
  const msgs = [q('q1', 't1'), answer('t2', 'q1'), dismiss('t3', 'q1')];
  const estados = estadoDasPerguntas(msgs);
  assert.equal(estados[0].estado, 'respondida'); // the first link (answer), not the second (dismiss)
  assert.equal(estados[0].fechadaPorIndex, 1);
});

test('a link to a nonexistent reference is a no-op — the question stays open', () => {
  const msgs = [q('q1', 't1'), answer('t2', 'ghost-id')];
  const estados = estadoDasPerguntas(msgs);
  assert.equal(estados[0].estado, 'aberta');
});

test('legacy fallback: a human message with no link closes earlier id-less questions only', () => {
  const idless = { ts: 't1', from: 'piloto', to: 'humano', kind: 'question', body: 'old question, no id' };
  const withId = q('q2', 't2');
  const msgs = [idless, withId, humanNoLink('t3')];
  const estados = estadoDasPerguntas(msgs);
  assert.equal(estados[0].estado, 'respondida', 'id-less question closes positionally');
  assert.equal(estados[1].estado, 'aberta', 'a question WITH an id is never closed by the legacy heuristic');
});

test('legacy fallback never fires when the closing human message itself carries a link', () => {
  const idless = { ts: 't1', from: 'piloto', to: 'humano', kind: 'question', body: 'old question, no id' };
  const msgs = [idless, answer('t2', 't1#0')]; // linked explicitly instead of positionally
  const estados = estadoDasPerguntas(msgs);
  assert.equal(estados[0].estado, 'respondida');
  assert.equal(estados[0].fechadaPorIndex, 1);
});
