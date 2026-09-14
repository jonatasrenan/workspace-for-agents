// Reads and writes state JSON safely under concurrent processes.
//
// The studio has agents work in parallel, and several of them write to the
// same files (meta.json, agents.json, dag.json, acessos.json, estado.json).
// A naive read-modify-write loses updates and, worse, leaves the file half
// written when two writes overlap. Here:
//   - writeJson: writes to a tmp file in the same directory and renames it (rename is
//     atomic on the same filesystem) — no reader ever sees a partial file;
//   - updateJson: serializes the read→modify→write cycle with a directory lock
//     (mkdir is atomic), with a short wait and a stale lock discarded.
import fs from 'node:fs';
import path from 'node:path';

const LOCK_TENTATIVAS = 100; // ~2s total wait
const LOCK_ESPERA_MS = 20;
const LOCK_VELHO_MS = 15_000;

export function writeJson(file, data) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export function readJson(file, fallback = undefined) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    if (fallback !== undefined) return fallback;
    throw e;
  }
}

function esperar(ms) {
  // Blocking wait: these tools are short, synchronous scripts.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Locks held by this process: a tool that aborts with process.exit in the middle
// of an update must not leave the lock behind and block the next one.
const LOCKS_ABERTOS = new Set();
process.on('exit', () => {
  for (const lock of LOCKS_ABERTOS) {
    try {
      fs.rmSync(lock, { recursive: true, force: true });
    } catch {}
  }
});

function adquirirLock(file) {
  const lock = `${file}.lock`;
  for (let i = 0; i < LOCK_TENTATIVAS; i++) {
    try {
      fs.mkdirSync(lock);
      LOCKS_ABERTOS.add(lock);
      return lock;
    } catch {
      // A lock from a process that died mid-way must not block the studio.
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_VELHO_MS) {
          fs.rmSync(lock, { recursive: true, force: true });
          continue;
        }
      } catch {}
      esperar(LOCK_ESPERA_MS);
    }
  }
  return null; // no lock, proceed anyway: better to write than to hang
}

// Applies `fn` to the file's current contents and writes the return value. `fallback` is the
// value used when the file doesn't exist or is unreadable.
export function updateJson(file, fallback, fn) {
  const lock = adquirirLock(file);
  try {
    const atual = readJson(file, fallback);
    const novo = fn(atual);
    if (novo !== undefined) writeJson(file, novo);
    return novo;
  } finally {
    if (lock) {
      LOCKS_ABERTOS.delete(lock);
      fs.rmSync(lock, { recursive: true, force: true });
    }
  }
}
