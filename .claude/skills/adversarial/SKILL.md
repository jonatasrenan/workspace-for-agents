---
name: adversarial
description: Adversarial review of a stage of the active task — dispatches the adversarial-reviewer agent against the plan, the code, or the deploy, triages the findings by confirming each one, and records the result in 30-review.md. Use when the user types /adversarial, when a stage looks ready, or before declaring the task delivered.
---

# /adversarial — review a stage before trusting it

"Looks ready" is the most dangerous state of a task. This flow submits ONE stage to a deliberate attack before you build on top of it.

## Flow

1. **Identify the target stage** of the active task (with no active task in the conversation, resolve that first). Three possible targets — choose by the moment, with an explicit default:
   - **plan** (`10-plan.md`) — right after planning, before executing;
   - **code** (`workspace/<repo>/`) — after implementing, before deploying;
   - **deploy** (manifests + real state on minikube) — after the rollout, before declaring it delivered.
   If the user didn't specify, propose the most recently completed stage as the default.
2. **The review is per DAG node**: locate the node(s) that cover the target stage (`node tools/dag.mjs show <repo> <task>`) and their attached guardrails — the `verification` of each guardrail in the pool is the attack's script.
3. **Dispatch the `adversarial-reviewer` agent** with a precise briefing: what the target is, where it lives (absolute paths), the acceptance criteria from the `00-brief.md` (paste them into the prompt — the agent attacks against them), the guardrails of the node(s) with the verifications pasted in (id + `verification`), and any suspicion of yours ("I'm suspicious of the probe", "the test for X seems weak to me"). One target per dispatch — reviewing everything at once dilutes the attack.
4. **Triage — no finding passes without your confirmation**: for each finding in the report, verify the evidence (re-read the excerpt, run the cited command). Classify:
   - **confirmed** → decide with the user: fix now or accept as a risk (under tight target-time, `[LOW]` is almost always an accepted risk — say so);
   - **refuted** → record why (insufficient evidence or the agent's misreading);
   - the agent's "not verified — hypothesis" finding: verify it yourself before classifying.
5. **Record the verdict per guardrail in the DAG**: `node tools/dag.mjs guardrail <repo> <task> <nodeId> <gid> pass|fail --note "one-line evidence"`. A failure the human decides not to fix → `node tools/dag.mjs guardrail <repo> <task> <nodeId> <gid> accepted --accept "reason"` — and the reason also goes into `30-review.md`. A pending/failed guardrail blocks the node's `node-status done`, by design.
6. **Record in the task's `30-review.md`** — cumulative, one section per review. The recorded text is read by third parties: neutral working voice, no evaluation vocabulary or agent names as process roles:
   - `## Independent review — <stage> — <hh:mm>`
   - table: finding · severity · status (**fixed** / **accepted as risk** / **refuted**) · one-line evidence or reason;
   - the agent's "not refuted" list goes in with the technical content as-is — it's the stage's foundation of trust.
   Also record the **confirmed** findings on the bus: `node tools/bus.mjs post <repo> <task> --from pilot --to human --kind report "adversarial review <stage>: N confirmed (X HIGH) — <one-line summary>"` — the viewer's Room is the review's live record.
7. **Fixes are the pilot's**: apply them yourself (or delegate to the appropriate executor — `test-runner` to re-check the suite, `k8s-operator` to re-apply a manifest), never to the adversarial-reviewer. After fixing a `[HIGH]` finding, re-dispatch the attack at just that point to confirm it's closed — and update the corresponding guardrail to `pass`.
8. Close with the verdict in the conversation in one line: "stage X: N findings (A fixed, B accepted, C refuted) — safe to build on" or "open HIGH finding: <which> — resolve before continuing".

Note in `20-journal.md` that the review happened and its cost in minutes, in working voice ("independent review of the deploy — N min"): reviewing consumes target-time, and the decision to spend it is part of what the retrospective looks at.
