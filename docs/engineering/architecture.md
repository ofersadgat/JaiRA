---
id: engineering/architecture
type: standing
status: shipped
updated: 2026-08-04
---

# Architecture

The layer map every engineering unit places itself in. Phase 4 of
[WORKFLOW.md](../../WORKFLOW.md) reads this before designing anything, and amends
it — with a decision record — when a feature changes the shape.

> **Seeded from [README.md](../../README.md) and [DESIGN.md](../../DESIGN.md).**
> What is here is verified against those; what is missing is the reasoning behind
> the boundaries, which should be written down as it comes up.

## The shape

JaiRA is an interactive agent-orchestration app over
[declarative-ai](https://github.com/ofersadgat/declarative-ai): hierarchical
workflows — state machines over agents, LLM calls, and human interaction — with
durable tasks and humans in the loop.

Engine semantics are **not ours**. They live in the sibling repo and are consumed
as TypeScript source over cross-repo `file:` links. The two repos must sit side
by side, and the sibling must be named `declarative-ai` — both CI configs assume
it.

```text
<parent>/
  declarative-ai/     @declarative-ai/hw, exec, promptop, llm, validate
  JaiRA/              this repo
```

## Layers

Ordered by dependency. A unit names its layer in its doc, and may only depend
downward.

| Layer | Package | Owns |
| --- | --- | --- |
| `shared` | `@jaira/shared` | Task model, project config, `.jaira/` path layout, JSON helpers, view models, the typed IPC contract |
| `data` | `@jaira/persistence` | Task JSON files, the better-sqlite3 DB (lifecycle, runs, the `EngineEvent` journal), content-addressed workflow snapshots, crash recovery, the board/detail projection |
| `core` | `@jaira/runtime` | The engine harness: capability registry, prompt executor, scripted doubles, the interaction hub |
| `cli` | `@jaira/cli` | Headless `jaira`: init, ad-hoc runs, task lifecycle, board |
| `ui` | `@jaira/app` | Electron main + preload + React renderer |

## Boundaries that are load-bearing

These are not conventions. Crossing one is a design change, not a refactor.

| Boundary | Rule | Why |
| --- | --- | --- |
| Renderer ↔ main | The human-gate dialog is the **only** path by which a human answer enters a run; the interaction hub is reachable from the IPC layer alone, and answers are re-validated in the main process | A renderer bug must not be able to corrupt a run (SPEC §11.4) |
| Workflow ↔ run | `task start` snapshots the workflow content-addressed and pins the hash; the run executes against the pin | A run is reproducible and survives edits to the workflow underneath it |
| Windows ↔ WSL | Every child process goes through one mapper; Windows git is never run against `\\wsl$` | Path translation in one place; the alternative is slow and permission-fragile |
| Project ↔ worktree | A bound task gets a git worktree **outside** the project, at `<project-parent>/.jaira-worktrees/<projectName>/<taskId>/` | The workspace can't be confused with the project, and removal can't take the project with it |
| Derived ↔ committed | `.jaira/workflows/` is meant to be committed; `jaira.db*` and `snapshots/` are derived and gitignored | The authored half travels with the branch; the derived half does not |

## Data and its source of truth

| Data | Lives in | Source of truth |
| --- | --- | --- |
| Task definition | `.jaira/tasks/*.json` | The file |
| Task lifecycle, runs, events | `.jaira/jaira.db` | The DB; the journal is append-only |
| Workflow states | `.jaira/workflows/**` (project) over `~/.jaira/workflows/**` (shared base) | First match wins, `PATH`-style |
| A run's workflow | `.jaira/snapshots/<hash>/` | The pinned snapshot, never the live files |
| Secrets | The environment | Never the repo |

## Traps

- **Native-module ABI.** `better-sqlite3` is a V8-ABI addon and one build cannot
  serve both Node and Electron (Node 22 → `NODE_MODULE_VERSION` 127, Electron 33
  → 130). Both are cached side by side under `build/abi/<abi>/` and each runtime
  loads its own, so the app and the tests can run at once. `npm install` fetches
  both; `npm run abi` redoes it.
- **Model ids are route-prefixed.** `anthropic/claude-sonnet-5`, not
  `claude-sonnet-5`. Routing is explicit in declarative-ai and a bare id is a
  fail-fast error.
- **Interaction responses key on function name, not state id.** A UI state is an
  ordinary `FunctionOp`, so `--interactions` is keyed by the registered function.

## Amendments

| Date | What changed | What forced it |
| --- | --- | --- |
| 2026-08-04 | Seeded from README.md and DESIGN.md | The docs tree was created |
