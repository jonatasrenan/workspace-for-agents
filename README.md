# Workspace for Agents

A studio for conducting technical work by delegating to a team of AI subagents — and watching the collaboration happen live.

Each project becomes a **repo**; each repo has **tasks**; each task has a **DAG** of subtasks with attached guardrails. Messages between the pilot and the agents, operational logs, token cost, commits and diffs are recorded in files and rendered by a local panel that updates itself.

The harness is [Claude Code](https://claude.com/claude-code): `CLAUDE.md` instructs the pilot agent, and `.claude/agents/` brings the specialized executors. The tools in `tools/` are plain Node — **zero npm dependencies**, nothing to install.

## How it works

- **You talk in natural language.** "New project about X", "let's work on task 02", "close this task". The pilot maps the intent to commands and drives.
- **The pilot never does manual grunt work.** Operating the cluster, reading logs and metrics, running tests and reviewing all go to the subagents in `.claude/agents/`; independent fronts go out in parallel.
- **Several agents can work the same task at once.** A node that only produces trail (a document, an analysis) runs alongside the others in the same tree; a node that touches code gets its own `git worktree` per branch, with the state root pointed back at the main tree — see the full rule in `CLAUDE.md`.
- **Every delegation leaves a trace.** Each agent cycle is posted to the task's bus (`spawned` → `working` → `done`) and the token cost is recorded — the panel shows the collaboration in real time.
- **State is push.** Whoever performs an operation records the result; the viewer renders what's saved in `repos/<repo>/`. On its own it only does two things: pings the URLs already registered in Access (to show whether they're up) and reads `workspace/<repo>/`'s git history to build the Diff tab.
- **Code stays separate.** Each project's code lives in `workspace/<repo>/`, its own clean git repository, outside this harness's version control.

## Requirements

- **Node.js 20.13+** (developed on 24.x). No npm dependencies. The tools in `tools/` run on Node 18, but the viewer uses recursive `fs.watch`, which on Linux only exists from 20.13 on — below that the panel still works, it just doesn't auto-refresh.
- **git** — `new-repo.mjs` initializes each project's repository and the Diff tab reads the workspace's history.
- An agent that reads `CLAUDE.md` and `.claude/` — the project is written for Claude Code.
- Optional, only for the example projects: Docker and minikube (the `k8s-operator`, `log-reader` and `metrics-reader` agents operate on them). The studio's engine does not depend on Kubernetes.
- Optional, only to publish a repo as a page: AWS CLI with access to an S3 bucket and a CloudFront distribution.

## First steps

```sh
git clone https://github.com/jonatasrenan/workspace-for-agents.git
cd workspace-for-agents

# 1. create a project: repos/<slug>/ (metadata) + workspace/<slug>/ (git init)
node tools/new-repo.mjs "My project"

# 2. create the first task: statement, plan, journal and review from templates
node tools/new-task.mjs my-project "Initial deploy"

# 3. open the panel (loopback only; PORT and HOST can be overridden via env)
node viewer/server.mjs     # http://localhost:4500
```

`repos/` and `workspace/` are ignored by git: they're **your** state, not the engine. A fresh clone starts empty — the panel opens with no repos until you create the first one.

From there, talk to the agent. As it plans the task, the decomposition gets recorded as a DAG; as it executes, messages, logs and costs show up in the panel.

## The panel

`node viewer/server.mjs` comes up on `http://localhost:4500`, listening only on `127.0.0.1`. Per task, it brings: **Room** (bus messages), **DAG** (nodes and guardrails, live), **Logs**, **Costs**, **Diff** (the commits recorded on the task, plus the ones from the period it was open) and **Timeline**, plus the task's files; and, per repo, an **Overview** with the agent roster, access, runtime and progress. File changes arrive via SSE — no need to reload.

When an agent asks the human a question, you answer through the panel itself (it posts to the bus) or through the conversation. A question closes by an explicit link to its id, not by whichever message comes next — the panel's "answer"/"don't answer" buttons record that link for you; answering in the conversation instead, the pilot records it on your behalf.

## Tools

All of them run from the project root, with no magic arguments:

| Operation | Command |
|---|---|
| Create repo | `node tools/new-repo.mjs "<Title>" [--slug <slug>]` |
| Create task | `node tools/new-task.mjs <repo> "<Title>" [--depends-on "01,02"]` |
| Message on the bus (Room) | `node tools/bus.mjs post <repo> <task> --from X --to Y --kind report\|question\|decision\|approval\|status "body"` — prints the message's id; close a question with `--meta '{"responde":"<id>"}'` or `'{"dispensa":"<id>"}'` |
| Operational log | `node tools/bus.mjs log <repo> <task> --level debug\|info\|warn\|error --source S "body"` |
| Read messages | `node tools/bus.mjs read <repo> <task> [--to X] [--kind K] [--since ISO] [--tail N]` |
| Agents that acted | `node tools/bus.mjs agents <repo> [<task>]` |
| Record tokens | `node tools/costs.mjs add <repo> <task> --agente X (--in N --out N \| --total N) [--modelo m] [--label "..."]` |
| Cost report | `node tools/costs.mjs report [<repo> [<task>]]` |
| Write the DAG | `node tools/dag.mjs set <repo> <task>` (stdin = JSON) |
| Status of a node | `node tools/dag.mjs node-status <repo> <task> <nodeId> todo\|executando\|concluida\|bloqueada [--force]` |
| Guardrail verdict | `node tools/dag.mjs guardrail <repo> <task> <nodeId> <gid> pass\|falha\|pendente [--nota "..."]` — accepted failure: `... aceito --aceitar "reason"` |
| Catalog of guardrails | `node tools/dag.mjs pool [--tag t] [--categoria c]` |
| View / validate DAG | `node tools/dag.mjs show <repo> <task>` · `validate <repo> <task>` |
| Record a commit on the task | `node tools/commits.mjs add <repo> <task> <hash> [--msg "..."]` · `list <repo> <task>` |
| Repo access (URLs) | `node tools/acessos.mjs add\|remove\|list <repo> [...]` |
| Repo live state | `node tools/estado.mjs set <repo> runtime\|ambiente\|origem` (stdin = JSON) · `show <repo>` |
| Publish a repo | `node tools/share.mjs <repo> [--dry-run\|--off\|--delete\|--sem-custos]` |
| Deterministic workspace checks | `node tools/check.mjs [<repo> [<task>]] [--lint]` · `--regras` · `--hook [--soft]` |
| Write cross-task memory | `node tools/learnings.mjs append --task <repo>/<task>` (stdin) · `promote "<title>" --task <repo>/<task>` · `note "<title>" "<text>"` |

## Guardrails

`guardrails/pool.json` is a catalog of reusable checks (each with an `aplica_a` list and a command/observation that proves it). When building the DAG, the pilot attaches to each node the guardrails whose `aplica_a` matches the node's tags. A node only closes as `concluida` once its guardrails are resolved — a failure can be explicitly **accepted**, with a recorded reason.

## Deterministic checks

`tools/check.mjs` runs no model — it's plain code checking the workspace, in two classes. **Structural** checks (`node tools/check.mjs [<repo> [<task>]]`) verify meta.json is readable with the fields the panel needs, and that a task marked `concluida` really has every DAG node done, no pending/failed guardrail, and no unanswered question to the human; they're wired into Claude Code's `Stop` hook (`.claude/settings.json`) and block the end of a turn until the pending item is addressed. **Lints** (`--lint`) check the quality of the trail (no internal-mechanics/evaluation vocabulary leaking into artifacts, no artifact left as a stub, the DAG matching the plan, accepted guardrails with a reason echoed in the journal, cost and commits recorded, no unanswered question) — these never block a turn, but fail when closing a task and in CI. Run `node tools/check.mjs --regras` to see exactly what each predicate requires and returns.

## Publishing a repo as a page

`tools/share.mjs` generates a static page with the same panel (a single repo, read-only) and pushes it to S3 + CloudFront. It's optional and requires **your own** infrastructure:

```sh
cp .env.example .env    # bucket, distribution, base URL, AWS profile and region
node tools/share.mjs my-project --dry-run   # generates the HTML in a temp dir, without touching AWS
node tools/share.mjs my-project             # publishes
```

Without the variables configured, the command fails saying exactly what's missing. While the share is active, the viewer republishes the page on its own on every change to the repo; `--off` pauses the republishing (the page stays up) and `--delete` takes it down — this last one also needs the AWS credentials.

## Structure

```
workspace-for-agents/
├── CLAUDE.md              # pilot agent instructions
├── learnings.md           # memory across tasks (open/mastered items) — written only via tools/learnings.mjs
├── learnings.template.md  # seed for a fork that wants to start with empty memory
├── .claude/
│   ├── agents/            # executors: k8s-operator, log-reader, metrics-reader,
│   │                      # test-runner, adversarial-reviewer
│   └── skills/            # flows: refinar, adversarial, retrospectiva
├── guardrails/pool.json   # catalog of reusable checks
├── tools/                 # Node tools (no dependencies)
├── viewer/                # local web panel (port 4500); vendor/ carries marked and mermaid
├── .env.example            # publishing configuration (copy to .env)
├── repos/<repo>/          # your state: context, tasks, bus, costs, DAG  (git-ignored)
└── workspace/<repo>/      # each project's code, its own git repo      (git-ignored)
```

## License

MIT — see [LICENSE](LICENSE). Third-party libraries in `viewer/public/vendor/` keep their own MIT licenses, documented in [viewer/public/vendor/README.md](viewer/public/vendor/README.md).
