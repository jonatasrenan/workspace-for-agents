---
name: refinar
description: Refines a task's statement — tightens the objective, requirements, measurable acceptance criteria, and target time with intermediate milestones — and rewrites 00-enunciado.md. Use when the user types /refinar, creates a new task, or complains that a statement is vague.
---

# /refinar — tighten a task's statement

A vague statement kills a task before it starts: without a measurable criterion there's no way to delegate well or know when it's done. This flow turns `00-enunciado.md` into an executable contract.

## Flow

1. **Resolve the target task**: the active one in the conversation; otherwise list `repos/*/tasks/*/` and ask (with the most recent as default). Read the current `00-enunciado.md` and take a look at `workspace/<repo>/` (README, structure) to calibrate what's realistic within the target time on that code.
2. **Diagnose the gaps** in the current statement, in this order of importance:
   - **Objective**: can you say in one sentence what will be running at the end? If not, that's the first thing to close.
   - **Acceptance criteria**: each one needs to be **verifiable by command or direct observation** ("`curl` on the /X endpoint returns 200 with payload Y", "pod survives `kubectl delete pod`", "suite passes"), never "clean code" or "well structured".
   - **Requirements and constraints**: what is mandatory to use (Docker? minikube? the repo's language?) and what is explicitly out of scope.
   - **Process quality criteria**: the studio's 4 criteria (decomposition, choice/delegation of AI tools, AI as a speed lever, decision-making) translated to THIS task as neutral, verifiable work criteria — e.g. "scope decisions recorded in the journal with justification". In the recorded statement, never use evaluation vocabulary ("what will be observed", "score").
3. **Check the size before refining**: if the requested scope doesn't fit the target time or contains deliverables of a different nature, propose (with a recommended default) breaking it into multiple chained tasks instead of inflating a single one — create them via `node tools/new-task.mjs <repo> "<Title>" --depends-on <previous-task>` and refine each statement in its own file, starting with the first in the chain.
4. **Build the target schedule** with milestones — proportional to the task's target time, this skeleton is for a task of ~60 min:
   - **1/4 of the time**: decomposition done, plan recorded, first delegation dispatched;
   - **1/2 of the time**: functional core running locally (test or direct execution);
   - **2/3 of the time**: something end-to-end in the target environment, even if minimal — if there isn't one, cut scope here;
   - **3/4 of the time**: acceptance criteria being verified one by one;
   - **end**: delivery + record of the decisions that support the result.
5. **Propose the entire refined version** (don't ask field by field): rewrite the complete statement with defaults marked where you assumed ("target time: 60 min (assumed)"). Apply directly to `00-enunciado.md` unless there's an objection — the user only intervenes on what they disagree with.
6. Structure of the rewritten file:
   - `# <task title>`
   - `## Objective` — one sentence, observable end state.
   - `## Requirements` — mandatory and out of scope.
   - `## Acceptance criteria` — checklist, each item with the command/observation that verifies it; the process quality criteria (item 2) go in here, in neutral voice, with no separate observation section.
   - `## Target time and milestones` — moment → expected state table.
7. **Generate/update the task's DAG in the same gesture**: decompose the work into 4-8 nodes with `depends_on`, tags, and guardrails attached from the pool — check `node tools/dag.mjs pool [--tag t]` to match each guardrail's `aplica_a` with the node's tags. Record via `node tools/dag.mjs set <repo> <task>` (stdin = full JSON) and check with `node tools/dag.mjs show <repo> <task>`. The DAG and the `10-plano.md` come out of the same gesture: the prose plan cites the nodes by id.
8. If the task already has a `10-plano.md`, warn that the statement changed underneath it and offer to review the plan (and the DAG) next (default: yes).

The refined version replaces the original; if the statement came from an external source, preserve the original text in a `<details>` block at the end for traceability, with a neutral title (e.g. "Original statement").
