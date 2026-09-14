---
name: retrospectiva
description: Closes a task's execution by looking at it through the studio's 4 lenses (problem decomposition, delegation and tool choice, pace and parallelism, decisions and scope cuts), each anchored in the journal and the git log, with gaps and an improvement plan in 30-review.md. Use when the user types /retrospectiva, or when closing a task.
---

# /retrospectiva — close the execution through the 4 lenses

A retrospective exists to improve the next execution. A soft, feel-good pass destroys the purpose — be rigorous; the yardstick is "would this execution hold up under a senior colleague's critical review?".

## Evidence (collect before opining)

1. Resolve the target task (the active one; otherwise list and ask, with default on the most recent).
2. Read `20-journal.md` (timeline, delegations, real vs planned state), `00-enunciado.md` (acceptance criteria and promised schedule), and the task's Room (`node tools/bus.mjs read <repo> <task>`) — the journal and the bus messages are the primary sources of evidence for the collaboration.
3. `git -C workspace/<repo> log --oneline --stat` — commit rhythm is objective evidence: how long did the first commit take? Small, frequent commits or one big commit at the end? Do the messages state intent?
4. Final state: which acceptance criteria from the statement were verified as met (the journal should say; if it doesn't, that's already a process gap).
5. The task's token cost: sum up the task's `costs.jsonl` (fed by `tools/costs.mjs` on each delegation) — total and per agent, with timestamps.
6. The task's DAG (`node tools/dag.mjs show <repo> <task>`): nodes, deps, attached guardrails, % of completed nodes, and `aceito` guardrails with their reasons.

## The 4 lenses — each with the question it answers and the evidence behind it

For each lens: **what happened** (one or two sentences, concrete) and **evidence** (a quote from the journal with time, commit hash, a DAG fact, a bus message — never an impression).

1. **Problem decomposition** — did the split into tasks and nodes match the actual work? Evidence: the DAG (nodes well sliced — neither a monolith nor crumbs — `depends_on` reflecting real dependencies, not a linear queue), `10-plano.md`, and the order in which nodes actually closed vs the order planned.
2. **Delegation and tool choice** — what was delegated, to whom, with what instruction; what the pilot did by hand that an executor should have done instead. Evidence: the bus (briefings, `spawned`/`working`/`done` cycles), the journal.
3. **Pace and parallelism** — did independent fronts run together, or did one wait on another that had no real dependency on it? Evidence: journal timestamps, and token cost per agent (a good lever shows a result delivered at proportional cost; tokens burned on rework or a vague briefing count against it).
4. **Decisions and scope cuts** — what was decided, with what default, and what was consciously left out. Evidence: `decision` messages on the bus, the journal. A guardrail marked `aceito` counts here too: the recorded reason is either a defensible cut or an excuse ("no time", "I'll look at it later") — say which.

## Recording

1. Add to `30-review.md` the section `## Retrospective — <date hh:mm>` — the recorded text is read by third parties: use the template's neutral headings and never evaluation vocabulary ("evaluator's score", "what will be observed") anywhere in it:
   - table: lens · what happened · evidence (one row per lens, filled in from the section above);
   - **Improvement plan**: 2-4 prioritized, actionable items for the next execution ("dispatch log-reader on the first CrashLoopBackOff instead of reading a dump", not "delegate more");
   - an honest one-line verdict, in neutral voice (e.g. "does the delivery hold up under critical review? yes/no, why").
2. **Suggest items for the root `learnings.md`**: each recurring or costly gap becomes an `open` item linked to the task; a previously open pattern that was demonstrated solidly in this execution is promoted to `mastered` citing the task as evidence. Don't duplicate — update existing items. Propose the list and apply it unless there's an objection.
3. Summarize the verdict in the conversation in 3-4 lines: one line per lens, the strongest point, the highest-return adjustment for next time.
