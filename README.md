# JaiRA

Interactive agent-orchestration app on top of [ai-exec](../ai-exec/README.md):
hierarchical workflows (state machines over agents, LLM calls, and human
interaction) with durable tasks, a board UI (coming in phase 3), and humans in
the loop.

- [SPEC.md](SPEC.md) — product spec (the hierarchical-workflow formalism is
  normative in `ai-exec/SPEC.md`).
- [DESIGN.md](DESIGN.md) — implementation design; §1a/§1b track status, §14 the
  phase plan.

## Packages

| Package | Contents |
| --- | --- |
| `@jaira/shared` | Task model, project config, `.jaira/` path layout, JSON helpers |
| `@jaira/persistence` | Durable stores: task JSON files, better-sqlite3 DB (task lifecycle, runs, `EngineEvent` journal), content-addressed workflow snapshots, crash recovery |
| `@jaira/cli` | Headless `jaira` CLI: project init, ad-hoc workflow runs, task lifecycle |
| `@jaira/app` | Electron shell + React renderer (phase 3; stub) |

Engine semantics live in the sibling repo's packages (`@ai-exec/core`,
`@ai-exec/services`, `@ai-exec/llm`, `@ai-exec/hw`), consumed as TypeScript
source via cross-repo `file:` links (`file:../../../ai-exec/packages/*`). The
[ai-exec](https://github.com/ofersadgat/ai-exec) repo must be checked out next
to this one:

```text
<parent>/
  ai-exec/     # git@github.com:ofersadgat/ai-exec.git
  JaiRA/       # this repo
```

## Development

```sh
# from <parent>/, with ai-exec checked out alongside:
( cd ../ai-exec && npm install )   # populate ai-exec deps (file: links are symlinks)
npm install
npm run typecheck
npm test
```

## Continuous integration

CI runs on both GitLab (`.gitlab-ci.yml`) and GitHub Actions
(`.github/workflows/ci.yml`); each checks out ai-exec as a sibling, installs
both, and runs `typecheck` + `test`. GitHub-hosted runners are free (unlimited
for public repos; 2,000 min/month for private). If ai-exec is private, GitHub
CI needs an `AI_EXEC_TOKEN` secret and GitLab CI needs this project on
ai-exec's job-token allowlist (see the comments in each CI file).

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

`--fake` runs against a JSON-scripted executor instead of real providers —
rules like `[{"model": "critic", "output": {"outcome": "clean", ...}}]` are
matched against the operation's model and prompt. `--interactions` scripts UI
states: `{"<stateId>": [<response>, ...]}`. Real providers are configured in
`.jaira/config.json` under `providers` (name → llm-call config, e.g.
`{"model": "claude-sonnet-5"}`) and executed via `@ai-exec/llm` with API keys
from the environment.

## License

JaiRA is licensed under the [GNU General Public License v3.0](LICENSE). The
sibling `ai-exec` library is MIT-licensed.
