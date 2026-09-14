// Whether a question to the human is open — by explicit LINK, not by message
// order. Shared by bus.mjs (writes the link), check.mjs (the "awaiting" gate)
// and the viewer (Room rendering + the POST /api/bus route) — one rule, one
// place, so the panel and the checker can never drift back into disagreeing
// about what "still open" means.
//
// A question is any bus message with kind "question"|"decision" addressed to
// "human". It closes when some LATER message carries meta.answers (answered)
// or meta.dismisses (declined) pointing at it. THE FIRST explicit link to a
// given question is the one that counts — a second message pointing at the
// same question changes neither its state nor the answer shown for it.
//
// Legacy fallback (messages recorded before every message had an id): a human
// message with NO answers/dismisses at all closes every earlier question that
// has no id — this is what keeps old messages.jsonl files readable without a
// migration, and it never fires for a message that already has an id.

// The human's name on the bus. Trail written before the rename says "humano";
// both are recognized so an old task's open question doesn't turn invisible.
const HUMAN = ['human', 'humano'];
const isHuman = (who) => HUMAN.includes(who);

// New id for a message born at `ts` (an ISO timestamp). Not just the
// timestamp: two messages posted in the same millisecond (two agents on two
// tasks) must not collide.
export function newId(ts) {
  const base = Date.parse(ts);
  const stamp = Number.isFinite(base) ? base : Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${rand}`;
}

// The reference a link points at: the message's own id, or — for a message
// from before ids existed — its position, "<ts>#<index>".
export function messageRef(m, i) {
  return m?.id ?? `${m?.ts}#${i}`;
}

// Index of the message that `ref` resolves to, in `messages` (order as read
// from messages.jsonl), or -1 if it resolves to nothing.
export function refIndex(messages, ref) {
  return messages.findIndex((m, i) => messageRef(m, i) === ref);
}

export function isQuestion(m) {
  return isHuman(m?.to) && (m?.kind === 'question' || m?.kind === 'decision');
}

// The link a message carries, if any: {state, ref}. "answers"/"dismisses" are
// the current names; "responde"/"dispensa" are the pre-rename ones, still read
// so migrated-or-not trail behaves the same.
function linkOf(m) {
  const answers = m?.meta?.answers ?? m?.meta?.responde;
  if (answers !== undefined) return { state: 'answered', ref: answers };
  const dismisses = m?.meta?.dismisses ?? m?.meta?.dispensa;
  if (dismisses !== undefined) return { state: 'dismissed', ref: dismisses };
  return null;
}

// One entry per message in `messages` (same order, same length): null for
// anything that isn't a question; otherwise {state: 'open'|'answered'|'dismissed', closedByIndex}.
export function questionStates(messages) {
  const states = messages.map(() => null);

  // Explicit links, in document order — the first one to reach a given
  // question index is the one that sets its state; later ones are no-ops.
  for (let i = 0; i < messages.length; i++) {
    const link = linkOf(messages[i]);
    if (!link) continue;
    const qIdx = refIndex(messages, link.ref);
    if (qIdx === -1 || qIdx >= i || !isQuestion(messages[qIdx])) continue;
    if (states[qIdx]) continue;
    states[qIdx] = { state: link.state, closedByIndex: i };
  }

  // Legacy positional fallback, id-less questions only: the last human
  // message that carries no explicit link closes every earlier id-less
  // question still unresolved.
  let lastPositionalHuman = -1;
  for (let i = 0; i < messages.length; i++) {
    if (isHuman(messages[i]?.from) && !linkOf(messages[i])) lastPositionalHuman = i;
  }
  if (lastPositionalHuman !== -1) {
    for (let i = 0; i < lastPositionalHuman; i++) {
      if (isQuestion(messages[i]) && !messages[i].id && !states[i]) {
        states[i] = { state: 'answered', closedByIndex: lastPositionalHuman };
      }
    }
  }

  for (let i = 0; i < messages.length; i++) {
    if (isQuestion(messages[i]) && !states[i]) states[i] = { state: 'open', closedByIndex: null };
  }
  return states;
}

// Question messages still "open" — what the "awaiting" gate/lint and the
// Room's "awaiting you" counter both mean by "open".
export function openQuestions(messages) {
  const states = questionStates(messages);
  return messages.filter((m, i) => states[i]?.state === 'open');
}
