// Repo/task artifact templates — module shared between new-repo.mjs,
// new-task.mjs and the viewer (stub detection: orange tab while the template hasn't been touched).

// Repo's 00-contexto.md (lives in repos/<slug>/, outside the workspace)
export const CONTEXTO_TEMPLATE = [
  '00-contexto.md',
  `# Context

## Repo objective
_(what this repo proves/delivers, in 2-3 sentences)_

## Macro statement
_(the general problem the tasks derive from)_

## Stack and environment
_(languages, frameworks, what runs on Docker vs minikube)_

## Out of scope
_(what deliberately does NOT go in)_
`,
];

// A task's stages: [file, content]
export const TASK_TEMPLATES = {
  enunciado: [
    '00-enunciado.md',
    `# Statement

## Objective
_(not yet defined)_

## Requirements
_(not yet defined)_

## Acceptance criteria
_(what needs to be running/demonstrable at the end)_

## Target time
_(not yet defined)_
`,
  ],
  plano: [
    '10-plano.md',
    `# Plan

## Decomposition
_(the problem broken into 3-6 attackable parts, order of attack, each one with a definition of done)_

| # | Part | Done when | Who does it |
|---|---|---|---|

## Delegation
_(what goes to AI — and with what instruction — vs what stays hands-on; where there's parallelism)_

## Plan risks
_(what could blow the schedule, and each one's plan B)_
`,
  ],
  journal: [
    '20-journal.md',
    `# Journal

_(timestamped execution diary — one line per event: decision, delegation, result, course correction. Format: \`HH:MM — event\`)_
`,
  ],
  review: [
    '30-review.md',
    `# Review

_(what happened and the evidence behind it, through each lens, then what to change next time)_

## Retrospective

| Lens | What happened | Evidence |
|---|---|---|
| Problem decomposition | | |
| Delegation and tool choice | | |
| Pace and parallelism | | |
| Decisions and scope cuts | | |

## What worked

## What to change next time
_(actionable items, 1 line each)_
`,
  ],
};

// Title slug: lowercase, no accents, words joined by hyphens.
// ~40 char limit, always cutting on a whole-word boundary
// (never mid-word, never with a trailing hyphen at the end).
export const slugify = (s, max = 42) => {
  const full = s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (full.length <= max) return full;
  if (full[max] === '-') return full.slice(0, max); // the cut lands exactly on a boundary
  const cut = full.slice(0, max);
  const at = cut.lastIndexOf('-');
  return at > 0 ? cut.slice(0, at) : cut; // single word longer than the limit: hard cut
};

// filename -> content (to detect a stub by exact comparison)
export const TEMPLATE_BY_FILE = Object.fromEntries([
  CONTEXTO_TEMPLATE,
  ...Object.values(TASK_TEMPLATES),
]);
