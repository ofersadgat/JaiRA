# JaiRA

Interactive agent-orchestration app on top of [declarative-ai](https://github.com/ofersadgat/declarative-ai):
hierarchical workflows (state machines over agents, LLM calls, and human
interaction) with durable tasks, a board UI (coming in phase 3), and humans in
the loop.

- [SPEC.md](SPEC.md) — product spec (the hierarchical-workflow formalism is
  normative in `declarative-ai/SPEC.md`).
- [DESIGN.md](DESIGN.md) — implementation design; §1a/§1b track status, §14 the
  phase plan.

## Packages

| Package | Contents |
| --- | --- |
| `@jaira/shared` | Task model, project config, `.jaira/` path layout, JSON helpers, view models, the typed IPC contract |
| `@jaira/persistence` | Durable stores: task JSON files, better-sqlite3 DB (task lifecycle, runs, `EngineEvent` journal), content-addressed workflow snapshots, crash recovery, and the board/detail projection |
| `@jaira/runtime` | The engine harness: capability registry, prompt executor, scripted fake/interaction doubles, the interaction hub, the demo workflow |
| `@jaira/cli` | Headless `jaira` CLI: project init, ad-hoc workflow runs, task lifecycle, board |
| `@jaira/app` | Electron main + preload + React renderer (board, task detail, human gates) |

Engine semantics live in the sibling repo's packages — `@declarative-ai/hw` (the
workflow engine), `@declarative-ai/exec` (the one execution seam, plus the op
model and JSON core it re-exports), `@declarative-ai/promptop` +
`@declarative-ai/llm` (structured LLM calls), `@declarative-ai/validate` (Ajv) —
consumed as TypeScript source via cross-repo `file:` links
(`file:../../../declarative-ai/packages/*`). The
[declarative-ai](https://github.com/ofersadgat/declarative-ai) repo must be
checked out next to this one, **in a directory named `declarative-ai`** (the
`file:` paths and both CI configs assume that name):

```text
<parent>/
  declarative-ai/   # git@github.com:ofersadgat/declarative-ai.git
  JaiRA/            # this repo
```

## Development

```sh
# from <parent>/, with declarative-ai checked out alongside:
( cd ../declarative-ai && npm install )   # populate declarative-ai deps (file: links are symlinks)
npm install
npm run typecheck
npm test
```

## Continuous integration

CI runs on both GitLab (`.gitlab-ci.yml`) and GitHub Actions
(`.github/workflows/ci.yml`); each checks out declarative-ai as a sibling,
installs both, and runs `typecheck` + `test`. GitHub-hosted runners are free
(unlimited for public repos; 2,000 min/month for private).

The GitHub repos are public, so GitHub CI needs no extra configuration. The
GitLab mirrors are private, so JaiRA's pipeline clones declarative-ai with
`CI_JOB_TOKEN`, which requires this project on declarative-ai's *Settings →
CI/CD → Job token allowlist*. See the comments in each CI file.

## CLI

```sh
npm run jaira -- init --project <dir>       # create <dir>/.jaira/
npm run jaira -- run --root feature/plan --inputs @inputs.json \
    --fake @rules.json --interactions @responses.json   # ad-hoc headless run
npm run jaira -- task create --title "..." --workflow feature/plan --inputs @inputs.json
npm run jaira -- task start <taskId> [--fake ...] [--interactions ...]
npm run jaira -- task list | status <taskId> [--events N] | cancel <taskId>
```

Workflow state files live in `.jaira/workflows/` (state id = path, e.g.
`feature/plan.json` → `feature/plan`). `task start` validates, snapshots the
workflow into `.jaira/snapshots/<hash>/`, pins the hash, and records the
engine's event stream in `.jaira/jaira.db`; interrupted tasks (crash, kill)
are detected on the next open and re-run from the workflow start against the
pinned snapshot.

`--fake` swaps in a JSON-scripted prompt executor instead of a real provider —
rules like `[{"model": "critic", "output": {"outcome": "clean", ...}}]` are
matched against the operation's configured model and rendered prompt.

`--interactions` scripts the interactive states. A UI state is an ordinary
`FunctionOp` naming a registered function, so responses are keyed by **function
name** (not state id): `{"choose_option": [{"decision": "approve"}, ...]}`, with
`"*"` as a catch-all. A function that is never registered fails only if its
state is actually reached.

Real runs read `.jaira/config.json`: `models.default` supplies the model for
states that name none, and must be route-prefixed
(`anthropic/claude-sonnet-5`, `openrouter/openai/gpt-5`) — routing is explicit
in declarative-ai and a bare id is a fail-fast error. Calls execute via
`@declarative-ai/promptop` over `@declarative-ai/llm`, with API keys from the
environment.

## The app

```bash
npm run app        # build main + renderer, switch the native ABI, launch Electron
```

The window opens on the project named by `JAIRA_PROJECT`, the first CLI argument,
or the current directory if it already contains `.jaira/`. The board shows the
workflow's child states as columns with each task in the column its active path
runs through; double-click a card whose path goes deeper to open the sub-board.
The right panel holds the instance tree, run history, a live event stream and the
run's outputs. When a workflow reaches an interactive state, a dialog asks for the
decision — that dialog is the *only* way a human answer can enter a run
(SPEC §11.4), because the interaction hub is reachable only from the IPC layer.

`JAIRA_CAPTURE=<file.png>` screenshots the window once it settles and exits,
which is how the UI is checked without a human at the keyboard.

> **Native-module ABI.** `better-sqlite3` is a V8-ABI addon, so one build cannot
> serve both Node and Electron (Node 22 wants `NODE_MODULE_VERSION` 127, Electron
> 33 wants 130). `npm run app` switches it automatically; switch back with
> `npm run abi:node` before running the tests or the CLI. Getting it wrong throws
> a loud "compiled against a different Node.js version" on the first DB open.

## License

JaiRA is licensed under the [GNU General Public License v3.0](LICENSE). The
sibling `declarative-ai` library is MIT-licensed.
