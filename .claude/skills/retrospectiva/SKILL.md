---
name: retrospectiva
description: Evaluates a task's execution against the studio's 4 criteria (decomposition, delegation and choice of AI tools, speed lever, decision-making), with a score 1-5 per criterion anchored in the journal and the git log, gaps, and an improvement plan in 30-review.md. Use when the user types /retrospectiva, when closing a task, or asks "how did I do?".
---

# /retrospectiva — evaluate the execution against the 4 criteria

A retrospective exists to improve the next execution. An inflated score destroys the purpose — be rigorous; the yardstick is "would this execution hold up under a senior colleague's critical review?".

## Evidence (collect before opining)

1. Resolve the target task (the active one; otherwise list and ask, with default on the most recent).
2. Read `20-journal.md` (timeline, delegations, real vs planned state), `00-enunciado.md` (acceptance criteria and promised schedule), and the task's Room (`node tools/bus.mjs read <repo> <task>`) — the journal and the bus messages are the primary sources of evidence for the collaboration.
3. `git -C workspace/<repo> log --oneline --stat` — commit rhythm is objective evidence: how long did the first commit take? Small, frequent commits or one big commit at the end? Do the messages state intent?
4. Final state: which acceptance criteria from the statement were verified as met (the journal should say; if it doesn't, that's already a process gap).
5. The task's token cost: sum up the task's `costs.jsonl` (fed by `tools/costs.mjs` on each delegation) — total and per agent. Cost × result is objective evidence for criterion 3.
6. The task's DAG (`node tools/dag.mjs show <repo> <task>`): nodes, deps, attached guardrails, % of completed nodes, and `aceito` guardrails with their reasons — objective evidence for criteria 1 and 4.

## The 4 criteria — score 1-5, each with cited evidence

For each criterion: **score**, **evidence** (a quote from the journal with time, commit hash, concrete finding — never an impression), **main gap** (what a demanding reviewer would expect and didn't see, specific).

1. **Decomposition** — did the problem become attackable parts with a conscious order? The DAG is the objective evidence: nodes well sliced (neither a monolith nor crumbs)? `depends_on` reflecting real dependencies, not a linear queue? relevant guardrails attached to each node? And the % of nodes completed at the end. Yardstick: 5 = plan in minutes, slices with a done criterion, replanned when reality hit; 3 = a plan exists but slices are large/order hid risk; 1 = dove into code with no plan, integration discovered at the end.
2. **Delegation and choice of AI tools** — did it delegate the right task to the right executor, with a briefing that allowed autonomous work? Yardstick: 5 = parallel delegations when independent, briefings with context and success criteria, checked results before building on top of them; 3 = delegated, but serialized or with a vague briefing that required rework; 1 = did by hand what an executor would do better, or delegated and trusted blindly.
3. **AI as a speed lever** — did the AI really speed things up? Compare the clock: how much time between "problem detected" and "cause found" when diagnosis was delegated vs when the log was read by hand. Yardstick: 5 = task's target time respected, waits filled with parallel work; 3 = lever used in part of the flow, but avoidable manual bottlenecks; 1 = AI used as autocomplete, target time blown with no decision. Cite the task's total token cost as evidence: a good lever is a result delivered at a proportional cost; tokens burned on rework/vague briefing count against it.
4. **Decision-making** — were decisions under uncertainty fast, recorded, and defensible? Conscious scope cuts (recorded) count in favor; prolonged indecision and rework from a deferred decision count against. A guardrail marked `aceito` with no fix is a conscious decision **if the recorded reason holds up** (unlikely risk within the task's scope, a defensible cut) — and counts against it if it's an excuse ("no time", "I'll look at it later"). Does the defense of the choices hold up at the end? Yardstick: 5 = decisions with an explicit trade-off at the right time; 3 = reasonable decisions but late or unrecorded; 1 = drift.

## Recording

1. Add to `30-review.md` the section `## Retrospective — <date hh:mm>` — the recorded text is read by third parties: use the template's neutral headings (Problem decomposition / Choice and delegation of AI tools / AI as a speed lever / Decision-making) and never evaluation vocabulary ("evaluator's score", "what will be observed") outside the table:
   - table: criterion · score · one-line summary;
   - per criterion: evidence and gap;
   - **Improvement plan**: 2-4 prioritized, actionable items for the next execution ("dispatch log-reader on the first CrashLoopBackOff instead of reading a dump", not "delegate more");
   - an honest one-line verdict, in neutral voice (e.g. "does the delivery hold up under critical review? yes/no, why").
2. **Suggest items for the root `learnings.md`**: each recurring or costly gap becomes an `open` item linked to the task; a previously open pattern that was demonstrated solidly in this execution is promoted to `mastered` citing the task as evidence. Don't duplicate — update existing items. Propose the list and apply it unless there's an objection.
3. Summarize the verdict in the conversation in 3-4 lines: score per criterion, the strongest point, the highest-return adjustment for next time.
