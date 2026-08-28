// Leitura e escrita de JSON de estado com segurança para processos concorrentes.
//
// O estúdio manda agentes trabalharem em paralelo, e vários deles escrevem nos
// mesmos arquivos (meta.json, agents.json, dag.json, acessos.json, estado.json).
// Um read-modify-write ingênuo perde atualizações e, pior, deixa o arquivo pela
// metade quando duas escritas se cruzam. Aqui:
//   - writeJson: grava num tmp do mesmo diretório e renomeia (rename é atômico
//     no mesmo filesystem) — leitor nenhum enxerga arquivo parcial;
//   - updateJson: serializa o ciclo ler→alterar→gravar com um lock de diretório
//     (mkdir é atômico), com espera curta e lock velho descartado.
import fs from 'node:fs';
import path from 'node:path';

const LOCK_TENTATIVAS = 100; // ~2s de espera total
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
  // Espera bloqueante: estas ferramentas são scripts curtos e síncronos.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Locks vivos deste processo: uma ferramenta que aborta com process.exit no meio
// de um update não pode deixar o lock para trás e travar a próxima.
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
      // Lock de um processo que morreu no meio não pode travar o estúdio.
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_VELHO_MS) {
          fs.rmSync(lock, { recursive: true, force: true });
          continue;
        }
      } catch {}
      esperar(LOCK_ESPERA_MS);
    }
  }
  return null; // sem lock, seguimos assim mesmo: melhor gravar do que travar
}

// Aplica `fn` ao conteúdo atual do arquivo e grava o retorno. `fallback` é o
// valor usado quando o arquivo não existe ou está ilegível.
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
