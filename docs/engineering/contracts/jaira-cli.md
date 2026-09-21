---
id: engineering/contracts/jaira-cli
type: engineering-contract
status: shipped
updated: 2026-09-13
visibility: public
kind: cli
owned_by: [engineering/units/cli]
consumers: ["people at a terminal", "scripts and CI jobs", "pre-commit hooks running workflow lint and workflow check", "the jaira wrapper package importing bin/jaira.js"]
since: 2026-07-17
siblings: [engineering/contracts/refusal-errors, engineering/contracts/fake-rules-format, engineering/contracts/interactions-script-format, engineering/contracts/task-view-models, engineering/contracts/jaira-layout]
---

# jaira CLI

The `jaira` command line: its commands, flags, environment variables, what each prints and the exit code that is its verdict.

## A caller reaches for the CLI to drive JaiRA without a window, and never for a run that needs a person to approve a tool call

**Use when.** Setting up a project, creating, starting, resuming, inspecting or cancelling tasks, checking workflows and trimming history from a terminal, a script or CI. Running a process against scripted answers with `--fake` and `--interactions`.

**Do not use when.** A run's policy can escalate a tool call to a person: the CLI has no approvals inbox and refuses such a run. A gate must be answered with no TTY attached and no `--interactions` script. A workflow mounts a hosted fan-out, which the CLI has no host for.

## The shape is one global layer and one table of commands

### Global flags, environment and streams apply to every command

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `--home <dir>` | path, anywhere on the line | no | the shared root for this invocation; sets `JAIRA_HOME` for the dispatch and restores it after |
| `JAIRA_HOME` | environment path | no | the shared root when `--home` is absent; default `~/.jaira` |
| `JAIRA_LOG` | environment, any value | no | library log records are written to stderr with their scopes |
| stdin and stdout both TTYs | process state | no | enables the y/N module approval prompt and the terminal changeset reviewer |
| SIGINT | signal | no | aborts the run in flight; the task finishes `canceled` |
| `<json\|@file>` | string | where a flag takes one | inline JSON, or `@` and a path relative to the working directory |
| `--project <dir>` | path | no | the project, default the working directory, on every command that opens one |
| exit `0` | code | yes | success, a run that ended `completed`, lint clean, a check that conforms |
| exit `1` | code | yes | any thrown error, a run that did not complete, lint errors or unreadable files, a check that does not conform, a worktree not removed, and every `parseArgs` error |
| exit `2` | code | yes | a usage error with usage on stderr, or no command at all with usage on stdout |

### Stderr carries notes, never the result

| Line | When |
| --- | --- |
| `error: <message>` | any failure, followed by usage on exit 2 |
| `recovered N interrupted task(s): <ids>` | a project open marked tasks `interrupted` |
| `warning: process left running by a previous session: <command> (pid N)` | a project open found an orphaned child |
| `resuming <taskId>: N operation(s) loaded` | a start continues a task with history |
| `task <taskId>: workflow '<root>' snapshot <12 hex>[ (pinned)][ · worktree <path> (<branch>)]` | a durable run began |
| `approved N function file(s): <files>` | a start approved modules |
| `warning: could not store artifact '<name>': <message>` | a returned artifact could not be placed |
| `nothing was deleted — re-run with --apply to prune` | `prune` without `--apply` |

### Commands print JSON on stdout unless marked text

| Command | Flags and arguments | Stdout |
| --- | --- | --- |
| `init` | `--project` | text `initialized JaiRA project at <.jaira>` |
| `run --root <stateId>` | `--project`, `--workflows <dir>`, `--inputs`, `--interactions`, `--fake`, `--repair-turns <n>`, `--non-interactive`, `--approve-functions` | `{taskId, status, outputs?, failure?, metrics, causes?, artifacts?: [{path, storedAt, bytes}]}` from a new task titled `run · <root>` labelled `adhoc`; with `--workflows`, `{status, outputs?, failure?, metrics}` and nothing recorded |
| `task create` | `--title` and `--workflow <rootStateId>` required; `--description`, `--label` repeatable, `--inputs`, `--branch`, `--project` | `{taskId, status: "queued"}` |
| `task start <taskId>` | `--interactions`, `--fake`, `--repair-turns`, `--project`, `--non-interactive`, `--approve-functions` | the durable `run` report; a task with journal history is loaded and continued |
| `task list` | `--project` | `[{taskId, status, title, workflow, snapshotHash?}]`; `title` is `(missing task file)` when the file is gone |
| `task status <taskId>` | `--events <n>`, `--project` | `{taskId, status, title, workflow, snapshotHash?, runs: [{outcome, startedAt, endedAt?, outputs?, failure?}], events?}`; `runs` holds at most one entry; `events` holds the last n journal events as `{seq, ...event}` |
| `task cancel <taskId>` | `--project` | `{taskId, status: "canceled"}`, or `"cancel_requested"` when another live process owns the run |
| `task move <taskId>` | `--to <stateId>` required; `--workflow <rootStateId>`, `--skip`, `--dry-run`, `--interactions`, `--fake`, `--repair-turns`, `--project`, `--non-interactive`, `--approve-functions` | `connect(task, target)` per [task-channels](task-channels.md): with `--dry-run`, or when refused, the `TaskConnectResult`; otherwise the durable `run` report of the task run here to take the move — reopened if it had finished — with `connect: <resolution> — <taskId> will stand at '<path>' in '<workflow>'` on stderr first. One JSON document either way |
| `board` | `--level <stateId>`, `--json`, `--project` | text board, or `BoardView` JSON per [task-view-models](task-view-models.md) |
| `worktree list` | `--project` | `[{path, branch?, taskId?, status?, prunable?}]` |
| `worktree remove <taskId>` | `--force`, `--project` | `{taskId, removed, reason?}` |
| `changeset review` | `--task <id>` or `--dir <path>`, `--base <rev>` default `HEAD`, `--loop`, `--interactions`, `--fake`, `--repair-turns`, `--project` | text `nothing to review: <dir> matches <base>`, or text `reviewing N change(s)…` then `{status, outputs?, failure?, metrics}` |
| `prune` | `--older-than <days>` default 0, `--apply`, `--project` | `{dryRun?, tasksPruned, events, commands, tasks, skipped, remaining}` |
| `workflow list` | `--json`, `--project` | text health list, or `WorkflowBrowser` JSON |
| `workflow lint` | `--json`, `--project` | text health list, or `{errors, unreadable, unreachable}` |
| `workflow check [<description.md>]` | `--workflow <root>` repeatable, `--model <id>`, `--json`, `--fake`, `--repair-turns`, `--project` | text conformance report, or `{description, workflows, verdict, requirements, findings, extras, cost}`; with no file, `./workflow.md` then `.jaira/workflows/workflow.md` |
| `functions list` | `--json`, `--project` | text `<state> <file>` lines, or `[{file, hash, current, state}]` where `state` is `approved`, `CHANGED` or `missing` |
| `functions approve <file>...` | `--all`, `--project` | text `first approval: <file>` or `re-approval (content changed): <file>` per file, then `approved N file(s)` |
| `functions revoke <file>...` | `--project` | text `revoked N file(s)` |
| `help`, `--help` | none | usage, exit 0 |

The `--fake` and `--interactions` documents are [fake-rules-format](fake-rules-format.md) and [interactions-script-format](interactions-script-format.md).

## Every error is a message on stderr and an exit code, and the message names the next step

| Condition | Response | Caller does |
| --- | --- | --- |
| The directory has no `.jaira/` | exit 1, `error: <dir> is not a JaiRA project (no .jaira/ — run 'jaira init')` | `jaira init` |
| A missing required flag or positional, an unknown command or subcommand, `--home` with no directory, a bad `--repair-turns` or `--older-than`, `functions approve` with no file and no `--all` | exit 2 with usage | fix the command line |
| Another live process owns the task | exit 1, `task '<id>' is already running in another process` | wait, or `task cancel` |
| The task's status cannot start, or it holds for a dependency | exit 1 with the refusal from [refusal-errors](refusal-errors.md) | resume or re-run it in the app, or complete the dependency |
| Unapproved js/ts modules and nobody to ask, or the answer is no | exit 1, the files listed and `jaira functions approve <files>` appended | run the printed command, or pass `--approve-functions` |
| A resume finds blocked or unreadable history | exit 1, `task '<id>' cannot be resumed: <reason>` | re-run as a new task |
| The project's policy can escalate | exit 1, the state and reason, then advice to use the app or set `policy.builtins` to false | use the app |
| `changeset review` with no TTY and no `--interactions` | exit 1, `nothing can answer the gate: attach a terminal, or script it with --interactions`, before any work | attach a TTY or script it |
| `workflow check` finds no description | exit 1 naming both places it looked | write one, or name it |
| `workflow check --workflow` names an unknown root | exit 1, `unknown workflow '<root>'` with the known roots | name a known root |
| `worktree remove` meets uncommitted work | exit 1 with `reason`, and a stderr hint to re-run with `--force` | commit, or `--force` |
| `task cancel` on a task already ended | exit 1, `task '<id>' is already <status>` | nothing |
| `task move` refused | exit 1, the `TaskConnectResult` on stdout and `refused: <message>` on stderr | `--skip` for a forward move, `--workflow` for an ambiguous one, or supply what is missing another way |

## A renamed flag, a reshaped report or a changed exit code breaks scripts at once, and no deprecation path exists

- Scripts parse the JSON reports and CI gates on exit codes, so any rename, removed field or changed code is breaking. Adding an optional field is not.
- No flag is versioned, aliased or warned about before removal.

## Several commands do less, or more, than their names say

- A `parseArgs` error, such as an unknown `--flag`, a stray positional or a string flag with no value, exits 1 with `error:` and no usage.
- `functions approve --all` with no files approves nothing and prints `approved 0 file(s)`.
- `functions list` lists only files approved on this machine, not every module on the search path.
- `task status --events` with a value that is not a positive number prints no `events` key and no error.
- `run --workflows` records nothing: no task, journal or artifacts.
- Repeating `run` without `--workflows` creates a new task each time.
- `task start` on a `completed` task deletes its unconsumed failed records and revived failure events before the start is refused.
- The text `board` omits `finished`, whose cards already stand in their columns.
- Every project command also opens the shared root's database to read module approvals.
- `task cancel` on a task no live process owns writes `canceled` directly, even if the row says `running`.
