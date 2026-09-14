// Atomic writes and a lock that REFUSES rather than loses data.
//
// jsonfile.mjs's lock is best-effort by design: state files (meta.json,
// agents.json, dag.json) would rather get written without the lock than have
// the studio seize up — losing a millisecond-old status update is cheap.
// Cross-task memory is the opposite case: several agents append to
// learnings.md from different tasks in the same window, a lost item is a
// silent bug (not "the studio kept moving"), and nobody is blocked by a
// learnings write taking an extra second. So the rule flips here: refuse the
// write rather than risk losing another agent's item. The two files are kept
// separate on purpose — mixing the semantics is exactly how a "just this
// once" best-effort write creeps into the path that can't afford it.
import fs from 'node:fs';
import path from 'node:path';

export function writeAtomic(file, text) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function wait(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Locks held by this process: a caller that dies via process.exit() (die()
// patterns everywhere in tools/*.mjs do exactly this) skips every pending
// `finally` — including the release() a lockFile() caller relies on — so the
// lock has to be swept here too, the same defense jsonfile.mjs uses.
const LOCKS_HELD = new Set();
process.on('exit', () => {
  for (const lock of LOCKS_HELD) {
    try {
      fs.rmSync(lock, { recursive: true, force: true });
    } catch {}
  }
});

// Directory lock (mkdir is atomic), with retry+jitter and a stale lock
// (older than staleMs) discarded. Returns a release() function. THROWS if the
// lock can't be acquired within timeoutMs — unlike jsonfile.mjs, the caller
// must not proceed with the write in that case.
export function lockFile(file, { timeoutMs = 5000, staleMs = 60_000 } = {}) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      LOCKS_HELD.add(lock);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        LOCKS_HELD.delete(lock);
        try {
          fs.rmSync(lock, { recursive: true, force: true });
        } catch {}
      };
    } catch {
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > staleMs) {
          fs.rmSync(lock, { recursive: true, force: true });
          continue;
        }
      } catch {}
      if (Date.now() > deadline) {
        throw new Error(`could not acquire the lock on ${path.basename(file)} within ${timeoutMs}ms — another process is holding it`);
      }
      wait(10 + Math.floor(Math.random() * 30));
    }
  }
}

const DEFAULT_LEARNINGS_TEMPLATE = `# Learnings

Knowledge base accumulated across repos and tasks. Each item is born from a task retrospective, a correction made during execution, or research. Status: **open** (still a mistake/forgotten) -> **mastered** (solidly demonstrated in a later task).

The pilot reads this file at the start of any session and actively uses the **open** items: it warns before you repeat the mistake and watches those areas during execution.

Format of each item:

\`\`\`
## <short topic>
- **Status**: open | mastered
- **Origin**: repos/<repo>/tasks/<nn>-<slug> (date)
- **Learning**: what became clear, in 1-3 sentences.
- **How to apply**: the practical trigger for next time.
\`\`\`

---

_(no items yet — the file grows with each retrospective)_
`;

// Creates <root>/learnings.md when it doesn't exist yet, seeded from
// <root>/learnings.template.md if that file is there, or from a small
// built-in default otherwise (a temp test root won't carry the template
// file, and still needs a valid seed).
export function ensureMemoryFiles(root) {
  const file = path.join(root, 'learnings.md');
  if (fs.existsSync(file)) return false;
  const tplPath = path.join(root, 'learnings.template.md');
  let tpl = DEFAULT_LEARNINGS_TEMPLATE;
  try {
    tpl = fs.readFileSync(tplPath, 'utf8');
  } catch {}
  writeAtomic(file, tpl);
  return true;
}
