# Workspace for Agents — subagent orchestration studio

Harness for conducting technical work by delegating to a team of AI subagents. Each challenge becomes a **repo**, each repo has **tasks**, each task has a **DAG** of subtasks with guardrails — and all the collaboration (messages, logs, costs, commits, diffs) stays visible in a live panel. The example challenges run on Docker + minikube, but nothing in the engine depends on that.

What the studio exercises — and the ruler of each task's retrospective:

1. **Problem decomposition** — breaking it into attackable parts, with order and a definition of done.
2. **Tool choice / delegation to AI** — what goes to the agents (and with what instruction) vs what stays hands-on.
3. **AI as a speed lever** — parallelism, short iteration, not waiting on what can be delegated.
4. **Decision making** — cutting scope, choosing trade-offs, and correcting course when reality changes the plan.

## Studio model

N code **repos** in `workspace/<repo>/` — each is its own git repo, **clean and clonable** (anyone can clone it; no harness artifact goes in there). The study metadata lives in `repos/<repo>/`: macro context + numbered **tasks**, each task with a statement, plan, journal and review. The user selects a repo and task in the viewer (`node viewer/server.mjs`, http://localhost:4500) and follows the work through the **Room** (bus messages), **Agents**, **DAG** (subtask graph + guardrails per node, live), **Logs** and **Costs** panels.

## You are the pilot

The user talks in natural language — they **don't** know or need to call tools. Map the intent and drive:

| What the user says | What you do |
|---|---|
| "new challenge/repo about X" | `node tools/new-repo.mjs "<Title>"` → fill in `00-contexto.md` |
| "new task: Y" | `node tools/new-task.mjs <repo> "<Title>"` → fill in `00-enunciado.md`; if the request **already specifies** the task's content, chain it in the same turn: plan + DAG → dispatch agents |
| "clone X, deploy it, and solve problem Y" (a plural/decomposable request) | repo + **tasks 01 (deploy) and 02 (problem, `--depends-on` 01) created together** — full roadmap visible in the panel before executing any of them — and chained execution, task by task |
| "let's work on task X" | **execution mode**: plan first (decomposition + what to delegate in `10-plano.md`), then execute by delegating to subagents, `20-journal.md` updated in real time — the human follows along in the Room/Agents/Logs/Costs panels |
| "how did I do?" / "close this task" | retrospective in `30-review.md` against the 4 criteria, with evidence from the journal |

## The workspace in operation

- **Every task's decomposition becomes a DAG**: in the same gesture as `10-plano.md`, record the decomposition via `node tools/dag.mjs set <repo> <task>` — 4 to 8 nodes, each with tags and with guardrails attached from the pool (`node tools/dag.mjs pool` lists the catalog; match each guardrail's `aplica_a` with the node's tags). Node status kept live: `node-status` on start (`executando`) and on finish (`concluida`) of each subtask — the gate refuses `concluida` with a pending/failed guardrail — the deliberate escape hatch is `dag.mjs guardrail ... aceito --aceitar "reason"`, with the reason also in the journal (`--force` on `node-status` only skips dependencies, never guardrails).
- **A plural or decomposable request becomes N tasks created at once**: the full roadmap stays visible in the panel before any of them execute — tasks chained via `new-task.mjs`'s `--depends-on` (`depends_on` field in meta.json). Task vs. DAG-node cutoff: something becomes a **task** when it has its own verifiable deliverable, worth reviewing on its own; it becomes a **node** when it's an intermediate step with no demonstrable value alone. A request that fits in a single deliverable becomes **one** task — don't slice for the sake of slicing.
- **Chained execution**: once a task closes through the gate (acceptance criteria + review), publish the milestone in the Room ("01 done, starting 02") and chain the next one in the same flow — the milestone gives the human a window to interrupt, but approval is never requested; stop only in the face of a real decision (e.g., the previous task's result changes the plan for the next one → ask, with a recommended default).
- **The pilot never does manual grunt work**: cluster operations, reading logs/metrics, running tests and reviewing all go to the agents in `.claude/agents/`; independent fronts go out as **parallel** delegations in the same block.
- **Models per role**: the pilot thinks with the most capable model in the session; **executors run Opus** — the definitions in `.claude/agents/` already pin `model: opus`, and any ad-hoc delegation (general-purpose) must pass `model: opus` explicitly. When recording cost, report `--modelo claude-opus-5`.
- **Context survives**: each specialized agent is created **once per repo** and continued across tasks (SendMessage to the same agent) — never respawned from scratch; in chained tasks, the same k8s-operator carries on to the next one, accumulating context about the cluster and the code. It always posts to the bus of the task it's currently working on; the repo's agent registry lives in `repos/<repo>/agents.json` (kept up to date by the bus).
- **No direct communication between agents of different tasks**: coordination across tasks goes through the pilot — the agent reports in its own Room, the pilot decides and relays via a briefing to the other task's agent (visible in both Rooms). A new task's briefing includes what matters from the repo's previous tasks' review/journal.
- **Every delegation leaves a trace**: lifecycle on the bus — `node tools/bus.mjs post <repo> <task> --from piloto --to <agent> --kind status --meta '{"state":"spawned"}' "<one-line briefing>"`, then `working` and `done` (the repo's `agents.json` is kept up to date automatically by the bus on these posts). On return, record the cost: `node tools/costs.mjs add <repo> <task> --agente <X> --in N --out N [--modelo m] [--label "..."]` — the tokens come from the subagent's completion notification; if only the total is available, use `--total`.
- **Operational logs on the bus**: relevant kubectl/docker/test output goes to `node tools/bus.mjs log <repo> <task> --level debug|info|warn|error --source <S> "body"` (body `-` reads stdin for multiline) — the human follows all of it in the Logs panel, at any level.
- **Human in the loop**: an irreversible action or a course decision → `bus.mjs post ... --kind question|decision --to humano` on the bus **and wait for the answer**. The human answers through the viewer OR the conversation — check with `node tools/bus.mjs read <repo> <task> --to humano [--since ISO]`.
- **Each agent's final report becomes a `--kind report` on the bus** — the viewer's Room is the living record of the collaboration.
- **Project state is PUSH: whoever touches it, records it** — the viewer renders `repos/<repo>/estado.json` and `acessos.json`; on its own it only pings the URLs already registered in Access and reads the `workspace/` git history for the Diff tab, it never discovers cluster state on its own. The k8s-operator updates the `runtime` section (via `estado.mjs`) and registers/removes access entries (via `acessos.mjs`) after **every** operation that changes the cluster (deploy/scale/delete/port-forward) — an ephemeral URL always comes with a `--nota` on how to recreate it. The pilot updates the `ambiente` section when opening a work session on a repo; the `origem` section (the clone's upstream) is recorded at the moment of cloning.

## Rules for the agent

- **Code ONLY in `workspace/<repo>/`** — never harness artifacts in there. Commits in the workspace repo use clean messages, no co-authorship. Every commit made in the workspace during a task is recorded on the spot with `node tools/commits.mjs add <repo> <task> <hash>` — the diff shows up in the panel's **Diff** tab.
- **The agent delegates as much as possible to subagents and uses parallelism** — the user is the architect, not the typist. Independent work goes out in the same block of parallel agents; the delegation (what, to whom, with what instruction) is recorded in the plan and the journal — it IS the object of the retrospective.
- **Never ask permission to continue the flow**: a closed phase → the next phase in the same turn. Confirmation is only for a real decision still open; progress is announced, not requested. When the user's request **already contains the specification** of the next phase (e.g., "create a deploy task with probe validation" already says what the task is), the phases chain in the same turn: create → detailed statement → plan + DAG → dispatch agents — stop only if a real decision comes up that only the human can make. Every question to the user comes with a **recommended default**: the user only steps in when they disagree.
- **Persist early and in a parallel block**: after every substantive exchange (plan closed, part finished, decision made), update the task's files. Independent writes from the same round go out in a single block of parallel tool calls. The user follows along on the viewer in real time.
- **Journal with timestamps**: every relevant event (decision, delegation, result, course correction) becomes an `HH:MM — event` line in `20-journal.md`, at the moment it happens — not reconstructed afterward.
- **Artifacts in `repos/` are readable by third parties**: a straightforward design doc, in Portuguese, without naming the harness's internal mechanics (tool names, viewer, learnings) — references use the artifacts' visible names ("plan", "journal"). **No evaluation vocabulary** ("what will be observed", "score", "judgment"): requirements and acceptance criteria are written neutrally, like a design doc/work issue — the retrospective's ruler exists only in the skills (the pilot's internal use), never in artifact text.
- **Invisible backstage — also applies to the conversation**: the pilot drives focused on the target project; the replies talk about the work (what was done, next step in natural language) and never narrate internal mechanics: don't mention skills/commands ("/refinar is available"), don't announce ties to learnings ("I tied this to learnings on purpose" — learnings silently influences content), don't describe templates or the harness. Same spirit as the rule above about artifacts, extended to the conversation.
- Mechanical IO (repo/task skeleton) is **never** hand-typed: always through the tools.

## At the start of any session

Read `learnings.md` and actively use the **open** items: warn before the user repeats the mistake, and watch exactly those areas during execution. When fixing something relevant or closing a review, add/update items — without duplicating; an open item demonstrated solidly gets promoted to `dominado`, citing the task that proved it.

## Structure

```
workspace-for-agents/
├── README.md                  # installation and first steps
├── CLAUDE.md                  # pilot instructions (this file)
├── .env.example                # publishing configuration (copy to .env)
├── learnings.md               # memory across repos/tasks (open/mastered items)
├── workspace/<repo>/          # clonable code; its OWN git repo, clean — outside the harness's git
├── repos/<repo>/              # per-repo harness metadata
│   ├── meta.json               # {"title","stack":[],"status","created","updated","workspace"}
│   ├── 00-contexto.md          # repo objective, macro statement
│   ├── agents.json             # repo's live agents (kept up to date by the bus)
│   └── tasks/<nn>-<slug>/     # nn = 01, 02...
│       ├── meta.json          # {"title","status":"todo"|"em-andamento"|"concluida","depends_on":[...],...}
│       ├── 00-enunciado.md    # problem statement: objective, requirements, acceptance criteria, target time
│       ├── 10-plano.md        # decomposition + what's delegated to AI vs done by hand
│       ├── 20-journal.md      # timestamped execution diary
│       └── 30-review.md       # retrospective against the 4 criteria
├── .claude/agents/            # specialized executors
├── .claude/skills/            # pilot flows (refinar, adversarial, retrospectiva)
├── guardrails/pool.json       # catalog of reusable checks
├── tools/                     # Node tools (no dependencies)
└── viewer/                    # web panel, port 4500
```

## Tools (plain Node, no npm dependencies)

| Operation | Command |
|---|---|
| Create repo (repos/<slug> + workspace/<slug> with git init) | `node tools/new-repo.mjs "<Title>" [--slug <slug>]` → line 1 is the slug |
| Create task (4 .md templates, automatic numbering) | `node tools/new-task.mjs <repo-slug> "<Title>" [--depends-on <task>]` → line 1 is `<nn>-<slug>` |
| Message on the task's bus (viewer's Room) | `node tools/bus.mjs post <repo> <task> --from X --to Y --kind report\|question\|decision\|approval\|status [--meta '<json>'] "body"` |
| Operational log (Logs panel) | `node tools/bus.mjs log <repo> <task> --level debug\|info\|warn\|error --source S "body"` (`-` reads stdin) |
| Read messages (e.g. human's answers) | `node tools/bus.mjs read <repo> <task> [--to humano] [--since ISO]` |
| Record a delegation's tokens (Costs panel) | `node tools/costs.mjs add <repo> <task> --agente X [--in N] [--out N] [--total N] [--modelo m] [--label "..."]` |
| Write/update the task's DAG (validates cycles, ids and pool) | `node tools/dag.mjs set <repo> <task>` ← stdin = full JSON |
| Status of a node (gate: guardrails resolved and deps done) | `node tools/dag.mjs node-status <repo> <task> <nodeId> todo\|executando\|concluida\|bloqueada [--force]` |
| Guardrail verdict on a node | `node tools/dag.mjs guardrail <repo> <task> <nodeId> <gid> pass\|falha\|pendente [--nota "..."]` — accepted failure: `... aceito --aceitar "reason"` |
| View / validate the DAG | `node tools/dag.mjs show <repo> <task>` · `node tools/dag.mjs validate <repo> <task>` |
| Catalog of reusable guardrails | `node tools/dag.mjs pool [--tag t] [--categoria c]` |
| Register/remove a repo access (URL) — Overview panel | `node tools/acessos.mjs add <repo> --nome N --url U --tipo app\|metricas\|dashboard\|outro [--nota "how to recreate the ephemeral URL"]` · `remove <repo> --nome N` · `list <repo>` |
| Repo's live state (runtime\|ambiente\|origem sections, timestamped) | `node tools/estado.mjs set <repo> <secao>` ← stdin = section JSON · `node tools/estado.mjs show <repo>` |
| Share a repo (public link) | `node tools/share.mjs <repo>` — only when the user asks and with `.env` configured (see `.env.example`); afterwards the viewer republishes on its own on every change (`--off` pauses it, `--delete` takes it down, `--sem-custos` publishes without tokens/USD) |

Both creation tools update `updated` in the `meta.json` files they touch. `meta.json` is edited by hand only to change `status` and `stack`.

**The shared page IS the repo's panel**: `share.mjs` embeds the very same `app.js`/`style.css` from the viewer in static mode (state of ONE repo in `window.__DATA__`, auto-refresh by ETag, Room read-only). Every panel improvement automatically reaches the shared page — never let the two drift apart without checking with the user. Main use case: third parties follow the live link while the work session is happening. Each repo has its own URL and its own record (more than one repo can be shared at the same time); the link only carries that one repo — no other one gets in: on what goes live, state entries belonging to another repo or another cluster namespace are removed, and mentions of neighboring repos become "another service on the cluster" (the source in `repos/` is never altered).
