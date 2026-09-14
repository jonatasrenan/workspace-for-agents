import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newId, messageRef, refIndex, isQuestion, questionStates, openQuestions } from './questions.mjs';

function q(id, ts) {
  return { id, ts, from: 'pilot', to: 'human', kind: 'question', body: `q-${id}` };
}
function answer(ts, answersRef, from = 'human') {
  return { id: newId(ts), ts, from, to: 'pilot', kind: 'status', body: 'ok', meta: { answers: answersRef } };
}
function dismiss(ts, dismissesRef, from = 'human') {
  return { id: newId(ts), ts, from, to: 'pilot', kind: 'status', body: 'skip', meta: { dismisses: dismissesRef } };
}
function humanNoLink(ts) {
  return { id: newId(ts), ts, from: 'human', to: 'pilot', kind: 'status', body: 'hi' };
}

test('newId: two calls at the same ts do not collide', () => {
  const a = newId('2026-01-01T00:00:00.000Z');
  const b = newId('2026-01-01T00:00:00.000Z');
  assert.notEqual(a, b);
});

test('isQuestion: only kind question|decision addressed to human counts', () => {
  assert.equal(isQuestion({ to: 'human', kind: 'question' }), true);
  assert.equal(isQuestion({ to: 'human', kind: 'decision' }), true);
  assert.equal(isQuestion({ to: 'human', kind: 'status' }), false);
  assert.equal(isQuestion({ to: 'pilot', kind: 'question' }), false);
});

test('messageRef/refIndex: id when present, "<ts>#<index>" fallback otherwise', () => {
  const msgs = [{ ts: 't1' }, { id: 'abc', ts: 't2' }];
  assert.equal(messageRef(msgs[0], 0), 't1#0');
  assert.equal(messageRef(msgs[1], 1), 'abc');
  assert.equal(refIndex(msgs, 't1#0'), 0);
  assert.equal(refIndex(msgs, 'abc'), 1);
  assert.equal(refIndex(msgs, 'nope'), -1);
});

test('a plain question with no link at all is open', () => {
  const msgs = [q('q1', 't1')];
  const states = questionStates(msgs);
  assert.equal(states[0].state, 'open');
  assert.equal(openQuestions(msgs).length, 1);
});

test('an explicit answers link closes exactly that question, leaves siblings open', () => {
  const msgs = [q('q1', 't1'), q('q2', 't2'), answer('t3', 'q1')];
  const states = questionStates(msgs);
  assert.equal(states[0].state, 'answered');
  assert.equal(states[0].closedByIndex, 2);
  assert.equal(states[1].state, 'open');
  assert.deepEqual(
    openQuestions(msgs).map((m) => m.id),
    ['q2']
  );
});

test('an explicit dismisses link marks dismissed, distinct from answered', () => {
  const msgs = [q('q1', 't1'), dismiss('t2', 'q1')];
  const states = questionStates(msgs);
  assert.equal(states[0].state, 'dismissed');
});

test('the FIRST explicit link to a question wins; a later one changes nothing', () => {
  const msgs = [q('q1', 't1'), answer('t2', 'q1'), dismiss('t3', 'q1')];
  const states = questionStates(msgs);
  assert.equal(states[0].state, 'answered'); // the first link (answer), not the second (dismiss)
  assert.equal(states[0].closedByIndex, 1);
});

test('a link to a nonexistent reference is a no-op — the question stays open', () => {
  const msgs = [q('q1', 't1'), answer('t2', 'ghost-id')];
  const states = questionStates(msgs);
  assert.equal(states[0].state, 'open');
});

test('legacy fallback: a human message with no link closes earlier id-less questions only', () => {
  const idless = { ts: 't1', from: 'pilot', to: 'human', kind: 'question', body: 'old question, no id' };
  const withId = q('q2', 't2');
  const msgs = [idless, withId, humanNoLink('t3')];
  const states = questionStates(msgs);
  assert.equal(states[0].state, 'answered', 'id-less question closes positionally');
  assert.equal(states[1].state, 'open', 'a question WITH an id is never closed by the legacy heuristic');
});

test('legacy fallback never fires when the closing human message itself carries a link', () => {
  const idless = { ts: 't1', from: 'pilot', to: 'human', kind: 'question', body: 'old question, no id' };
  const msgs = [idless, answer('t2', 't1#0')]; // linked explicitly instead of positionally
  const states = questionStates(msgs);
  assert.equal(states[0].state, 'answered');
  assert.equal(states[0].closedByIndex, 1);
});

// Trail written before the rename: "humano" as the actor and responde/dispensa as
// the link. It is read by the same rule, or a task in flight would reopen
// questions that were already answered.
test('pre-rename trail: "humano" + responde/dispensa still close the question', () => {
  const q1 = { id: 'q1', ts: 't1', from: 'piloto', to: 'humano', kind: 'question', body: 'A ou B?' };
  const q2 = { id: 'q2', ts: 't2', from: 'piloto', to: 'humano', kind: 'question', body: 'C?' };
  const msgs = [
    q1,
    q2,
    { id: 'a1', ts: 't3', from: 'humano', to: 'piloto', kind: 'status', body: 'B', meta: { responde: 'q1' } },
    { id: 'd1', ts: 't4', from: 'humano', to: 'piloto', kind: 'status', body: 'skip', meta: { dispensa: 'q2' } },
  ];
  const states = questionStates(msgs);
  assert.equal(states[0].state, 'answered');
  assert.equal(states[1].state, 'dismissed');
  assert.equal(openQuestions(msgs).length, 0);
});
