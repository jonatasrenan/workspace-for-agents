// Whether a question to the human is open — by explicit LINK, not by message
// order. Shared by bus.mjs (writes the link), check.mjs (the "aguardando" gate)
// and the viewer (Room rendering + the POST /api/bus route) — one rule, one
// place, so the panel and the checker can never drift back into disagreeing
// about what "still open" means.
//
// A question is any bus message with kind "question"|"decision" addressed to
// "humano". It closes when some LATER message carries meta.responde (answered)
// or meta.dispensa (declined) pointing at it. THE FIRST explicit link to a
// given question is the one that counts — a second message pointing at the
// same question changes neither its state nor the answer shown for it.
//
// Legacy fallback (messages recorded before every message had an id): a human
// message with NO responde/dispensa at all closes every earlier question that
// has no id — this is what keeps old messages.jsonl files readable without a
// migration, and it never fires for a message that already has an id.

// New id for a message born at `ts` (an ISO timestamp). Not just the
// timestamp: two messages posted in the same millisecond (two agents on two
// tasks) must not collide.
export function novoId(ts) {
  const base = Date.parse(ts);
  const stamp = Number.isFinite(base) ? base : Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${rand}`;
}

// The reference a link points at: the message's own id, or — for a message
// from before ids existed — its position, "<ts>#<index>".
export function refDaMensagem(m, i) {
  return m?.id ?? `${m?.ts}#${i}`;
}

// Index of the message that `ref` resolves to, in `messages` (order as read
// from messages.jsonl), or -1 if it resolves to nothing.
export function indiceDaReferencia(messages, ref) {
  return messages.findIndex((m, i) => refDaMensagem(m, i) === ref);
}

export function ehPergunta(m) {
  return m?.to === 'humano' && (m?.kind === 'question' || m?.kind === 'decision');
}

// One entry per message in `messages` (same order, same length): null for
// anything that isn't a question; otherwise {estado: 'aberta'|'respondida'|'dispensada', fechadaPorIndex}.
export function estadoDasPerguntas(messages) {
  const estados = messages.map(() => null);

  // Explicit links, in document order — the first one to reach a given
  // question index is the one that sets its state; later ones are no-ops.
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const respondeRef = m?.meta?.responde;
    const dispensaRef = m?.meta?.dispensa;
    const ref = respondeRef ?? dispensaRef;
    if (ref === undefined) continue;
    const qIdx = indiceDaReferencia(messages, ref);
    if (qIdx === -1 || qIdx >= i || !ehPergunta(messages[qIdx])) continue;
    if (estados[qIdx]) continue;
    estados[qIdx] = { estado: respondeRef !== undefined ? 'respondida' : 'dispensada', fechadaPorIndex: i };
  }

  // Legacy positional fallback, id-less questions only: the last human
  // message that carries no explicit link closes every earlier id-less
  // question still unresolved.
  let lastPositionalHuman = -1;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m?.from === 'humano' && m?.meta?.responde === undefined && m?.meta?.dispensa === undefined) lastPositionalHuman = i;
  }
  if (lastPositionalHuman !== -1) {
    for (let i = 0; i < lastPositionalHuman; i++) {
      if (ehPergunta(messages[i]) && !messages[i].id && !estados[i]) {
        estados[i] = { estado: 'respondida', fechadaPorIndex: lastPositionalHuman };
      }
    }
  }

  for (let i = 0; i < messages.length; i++) {
    if (ehPergunta(messages[i]) && !estados[i]) estados[i] = { estado: 'aberta', fechadaPorIndex: null };
  }
  return estados;
}

// Question messages still "aberta" — what the "aguardando" gate/lint and the
// Room's "awaiting you" counter both mean by "open".
export function perguntasAbertas(messages) {
  const estados = estadoDasPerguntas(messages);
  return messages.filter((m, i) => estados[i]?.estado === 'aberta');
}
