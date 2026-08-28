// Templates dos artefatos de repo/task — módulo compartilhado entre new-repo.mjs,
// new-task.mjs e o viewer (detecção de stub: aba laranja enquanto o template não foi tocado).

// 00-contexto.md do repo (fica em repos/<slug>/, fora do workspace)
export const CONTEXTO_TEMPLATE = [
  '00-contexto.md',
  `# Contexto

## Objetivo do repo
_(o que este repo prova/entrega, em 2-3 frases)_

## Enunciado macro
_(o problema geral do qual as tarefas derivam)_

## Stack e ambiente
_(linguagens, frameworks, o que roda em Docker vs minikube)_

## Fora de escopo
_(o que conscientemente NÃO entra)_
`,
];

// Etapas de uma task: [arquivo, conteúdo]
export const TASK_TEMPLATES = {
  enunciado: [
    '00-enunciado.md',
    `# Enunciado

## Objetivo
_(ainda não definido)_

## Requisitos
_(ainda não definido)_

## Critérios de aceite
_(o que precisa estar rodando/demonstrável ao final)_

## Tempo-alvo
_(ainda não definido)_
`,
  ],
  plano: [
    '10-plano.md',
    `# Plano

## Decomposição
_(o problema em 3-6 partes atacáveis, ordem de ataque, cada uma com critério de pronto)_

| # | Parte | Pronto quando | Quem faz |
|---|---|---|---|

## Delegação
_(o que vai para a IA — e com qual instrução — vs o que fica na mão; onde há paralelismo)_

## Riscos do plano
_(o que pode estourar o tempo e o plano B de cada um)_
`,
  ],
  journal: [
    '20-journal.md',
    `# Journal

_(diário timestampado da execução — uma linha por evento: decisão, delegação, resultado, correção de rumo. Formato: \`HH:MM — evento\`)_
`,
  ],
  review: [
    '30-review.md',
    `# Review

_(nota e evidência por critério, depois o que mudar na próxima)_

## Avaliação

| Critério | Nota (1-5) | Evidência |
|---|---|---|
| Decomposição | | |
| Delegação e ferramentas | | |
| Velocidade com IA | | |
| Decisões | | |

## O que funcionou

## O que mudar na próxima
_(itens acionáveis, 1 linha cada)_
`,
  ],
};

// Slug de título: minúsculas, sem acento, palavras ligadas por hífen.
// Limite de ~40 chars cortando sempre em fronteira de palavra inteira
// (nunca no meio de uma palavra, nunca com hífen pendurado no fim).
export const slugify = (s, max = 42) => {
  const full = s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (full.length <= max) return full;
  if (full[max] === '-') return full.slice(0, max); // corte cai exatamente numa fronteira
  const cut = full.slice(0, max);
  const at = cut.lastIndexOf('-');
  return at > 0 ? cut.slice(0, at) : cut; // palavra única maior que o limite: corta seca
};

// filename -> conteúdo (para detectar stub por comparação exata)
export const TEMPLATE_BY_FILE = Object.fromEntries([
  CONTEXTO_TEMPLATE,
  ...Object.values(TASK_TEMPLATES),
]);
