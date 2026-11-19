# The built-in layer (`$SYSTEM`)

What JaiRA ships, as the **last** layer of the search path (decision
[0006](../../../docs/engineering/decisions/0006-built-in-layer.md)):

```text
<project>/.jaira/    wins here
~/.jaira/            wins on this machine
$SYSTEM/             what ships          <- this directory
```

It has the authored half of a layer root's shape and none of the generated half:

```text
workflows/   state files, by id
prompts/     fragments a state refers to as $/prompts/...
functions/   operation documents and .ts callees
permission-sets/    permission-sets/[<bucket>/]<name>.json (decision 0007)
settings.json       the configuration layer under ~/.jaira/settings.json
```

Rules that hold for everything in here:

- **Read-only.** Nothing in JaiRA writes to this directory, and every write
  surface that takes a layer refuses this one. A person changes a built-in by
  putting a file with the same id in `~/.jaira/` or in the project.
- **Trusted.** A `.ts` module under this directory is not put to the module
  approval gate - it is the app's own code. A person's copy that shadows one is
  gated like any other module.
- **Pinned like anything else.** A task's snapshot stores the resolved
  definition, whichever layer supplied it, so an app upgrade that changes a file
  here does not change a task that already started.

## Where it lives at run time

This directory is the source of truth. `packages/cli/build.mjs` and
`packages/app/build.mjs` copy it to `dist/builtin/` beside their bundles, and
`defaultBuiltInDir()` in `../src/paths.ts` finds it: `<resources>/builtin` in a
packaged Electron app, `builtin/` beside a bundle, or this directory when running
from source (tsx, vitest).

## What is in it

| Id | Is |
| --- | --- |
| `session` | what the Chat view starts — a conversation written as a PROGRAM (decision 0029 §2), in this one file (`session.ts`): a loop over `input()` that replies in one session, every tool call asking first; from the second message on, when `improve`, a strict `simple`-preset read of the person's message that starts `improve/lesson` on a clear correction; and when the conversation sits idle (4 h — counted from when its wait first asked) or the person Ends it from the Chat list (its `input()` answered `null`), `improve/conversation`, handed what the strict read noted as a "maybe". Written in again after it ended, it is taken up where it ended. Inputs `message`, `improve` (default true), `approval` (default `propose`) and `settings` (the first message's composer settings; every later message's arrive through `input()`). A typed message answers its `input()`, and its waiting is never listed as asking the person. Work it starts is a task of its own, filed under it. Its `input()` is where a running conversation takes a newer, approved `session` (decision 0029 §3). Was `chat/session`, which a root's own copy is renamed from at open |
| `improve/lesson` | one lesson into one change (decision 0029 §5): reads the conversation (`conversation_digest`), the workflow that ran (`workflow_source`) and the lessons on record, has a model author whole files with the lever the lesson needs, TRIES them first (`simulate`, on by default when `context` names where in the conversation the correction was made: `simulate_change` forks the conversation at the message whose reply was corrected, hands the fork the files as if written — written nowhere — and sends that message again for one pass in a throwaway copy of the workspace under `permission-sets/improve/simulation`, with nobody to ask; a judge says whether the person would still have had to say it, and if so the files are written again), puts them to the person on a `choose_option` (apply, revise, discard) with how the trial went under `approval: "propose"`, skips that under `auto` (but never applies a change the trial says does not hold), hands them back under `return` — and `apply_change` writes them: only under `workflows/`, `prompts/`, `skills/`, `functions/`, `permission-sets/`, `lessons/` or `instructions.md`, re-validated, everything restored if what it wrote does not load, and the lesson recorded in `lessons/<slug>.md`; a change turned down at its review is recorded there too (`decline_change`), with what the person said, and a lesson that comes back says whether an earlier fix of it was in effect — what `jaira lessons` measures |
| `improve/conversation` | the end-of-conversation review (decision 0029 §6): finds a conversation's lessons — with the "maybe" notes its strict read kept, and the lessons this machine's other projects have learned — authors a change for each (`improve/author.ts`, shared with `improve/lesson`), tries each at the message the person corrected — found by their words (`simulate`, default true) — and applies them on ONE review, or records them turned down. A lesson another project learned too is written for every project, in the Shared layer (§7) |
| `improve/author.ts` | a helper module, not a workflow: the authoring prompt and how a proposal is shown |
| `system/events` | the events workflow (decision 0010 §4): a root with no spine, no automations and no children. Run as one unattended task named `events` per project (and one in Shared) whenever the copy a project resolves has at least one automation — a named `on_event` line into an `async` child whose state, `system/events/<name>`, is written beside it by the Automations editor in the layer that holds the line: an operation LIST of `start_task` and `notify` calls (hw SPEC §7.1d). JaiRA ships no automation, so no such state. Its `description` holds the shape the Automations editor writes, Shared's copy (a `$ref` to this with `transitions` and `children` spelled out) and a project's (a `$ref` to Shared's with the `...filter(…)` splice) |
| `debug/hello_world`, `/say`, `/check` | the Debug view's self-test. Its scripted replies are in `packages/app/src/renderer/debugWorkflow.ts` and match these prompts by text |
| `permission-sets/{ask-first, read-only, read-only-scratch, auto, full}` | at the top level, the sets a conversation picks from: the composer's four permission presets, written down, and `read-only-scratch` (read-only, but Claude may write in its own folder, decision 0007 amended 2026-11-05): every tool a conversation can be handed, a mode on each, and `other`. Each refuses writing the project's and the worktree's `.jaira/` — `$PROJECT/.jaira`, `$PROJECT/.jaira/**/*`, `$WORKTREE/.jaira` and `$WORKTREE/.jaira/**/*` at `deny` on `write_file`, `edit`, `shell`, `script` and `runner:*` — and the key that signs this machine's approvals (`~/.jaira/system/machine.key`) on those and on `read_file`, `glob` and `grep`: defaults a layer above can change, since nothing in the code refuses `.jaira/` (2026-11-17). `packages/shared/test/permissionPresets.test.ts` holds them to the maps the presets wrote, and the Git tools to decision 0010's table (readers allowed from `read-only` up; `git_merge` and `close_merge_request` still asked under `auto`), the CI tools of decision 0016 like the readers, and `wait_for_event` with the task tools |
| `permission-sets/improve/simulation` | what a simulation's pass may do (decision 0029 §5 step 5): it stands over the conversation's own set as its newest layer while `improve/lesson` tries a change on a fork of it. A line here that says where it stops (`**`) FENCES its line — what the conversation's set said of it elsewhere goes — so `edit`, `write_file`, `shell`, `script` and `runner:*` act only in the throwaway workspace (`$WORKTREE`) and the agent's own folder, and never in its `.jaira/`; the reads gain those places and keep the conversation's own elsewhere. Pushing, merging, publishing and deploying (`git push`, `gh`, `npm publish`, `git_merge`, the merge-request tools, `show_artifact`, …) and starting or steering other work (`start_task`, …) are refused. Whether a tool is offered, and whose code runs it, stay the conversation's. Nobody is asked anything during a pass: what would be asked is refused, saying so |
| `artifact-types/design/` | the instructions Claude Code gives the model for `/design`, word for word (decision 0020; its README says from where and what is still missing) |
| `settings.json` | the bottom CONFIGURATION layer, merged under the shared root's `settings.json` (and so under the project's): the presets `simple`, `coder` and `planner` — each a model candidate list chosen from when a session starts — `agent`, the coding agent a workflow script's `agent()` runs on (the Claude Code routes, then Codex, then an OpenCode CLI, `first-available`), the agent CLIs Gemini (`gemini-cli`), Antigravity (`antigravity-cli`), Muse Code (`muse-code`) and OpenCode (`opencode`) — each an `agents.genericCli` entry, merged by name, so a layer above turns one off or changes its arguments — `functions.smart.model: "simple"`, and every event switched on (`events.<name>.enabled: true`, decision 0010 §2) — a layer above turns one off. It must pass `parseConfig` on its own (`packages/shared/test/presetModels.test.ts`). Settings edits a preset from here in place, writing the copy into the layer being edited |

`list_skills` and `load_skill` (decision 0029 §10) are in the five top-level sets — asked under
`ask-first`, allowed elsewhere — and not in `control`, which reads nothing of the project.

A permission set file is a map from a subject to a mode and nothing else, so what a
shipped one is called on the composer's Permissions card, and the sentence under
it, live in `../src/permissionSetBuckets.ts`. When a tool is added to the standard
list, add it to the four `chat` files, or it answers to their `other`.

Nothing installs these anywhere. A copy of one in `~/.jaira` or a project's
`.jaira/` is an override, and wins as any override does.
