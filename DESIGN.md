# JaiRA Implementation Design

Status: Draft v1 — 2026-07-17
Companion to [SPEC.md](SPEC.md). Where this document and the spec conflict, the
spec wins unless the conflict is listed in §15 (Resolved Open Questions).

## 1. Decisions Summary

These were confirmed with the project owner and anchor everything below:

| Decision | Choice |
| --- | --- |
| Platform | Electron + TypeScript (React renderer) |
| Persistence | Hybrid: SQLite for execution state/history, JSON files for task metadata |
| Agent runtimes | Pluggable adapter layer: Claude Agent SDK, Claude Code headless CLI, opencode, codex CLI, plus a lightweight `llm_api` adapter (OpenRouter/Anthropic direct API calls) |
| Execution environment | Per-project: Windows-native or WSL2 (distro-selectable) |
| Safety enforcement | Per-adapter translation of one canonical policy into each provider's native mechanism, with capability flags for what each adapter can actually enforce |
| Structured outputs | Engine-derived output contract per state; channel chosen per adapter capability; engine-side validation with a bounded repair loop |
| Artifact location | Reserved Git-tracked `jaira-artifacts/` directory, overridable per project |

## 1a. Status Update — 2026-07-17

> **Superseded in part by §1c (2026-07-24):** the shared library has since been
> renamed **declarative-ai** and its API redesigned around a typed operation
> model. Package names below (`@ai-exec/*`) and the `InteractionPort` are
> historical; see §1c for the current shape.

The shared library was implemented first: the **ai-exec repo**
(`C:\UbuntuCode\ai-exec`) now contains `@ai-exec/core` (execution contract, error
classification, hashing/memo keys), `@ai-exec/services` (Ajv validation, retry,
AIMD rate limiting, deadline), `@ai-exec/llm` (the `llm-call` executor extracted
from findmyprompt), and `@ai-exec/hw` (the complete hierarchical-workflow engine
and executor per SPEC §3–§10) — typecheck-clean with 296 passing tests, including
this spec's worked examples (§7.3, §9, §10.4) as golden tests. Canonical docs:
`ai-exec/DESIGN.md` and `ai-exec/SPEC.md`.

**Nothing in this repo is implemented yet.** JaiRA is the app on top of ai-exec:

- It consumes `@ai-exec/hw` for all engine semantics (§5–§6 below remain the
  specification that engine satisfies — they are no longer a build plan for this
  repo).
- It implements the engine's ports: the durable SQLite `Persistence`
  implementation, the renderer-backed `InteractionPort`, a `SkillResolver` over
  `.jaira/skills/`, and provider bindings from project config.
- It keeps everything app-side from §2: Electron shell + renderer, task/board
  model, policy authoring, approvals UI, Git worktrees, WSL exec layer.

Deviations from this document as originally drafted, discovered in implementation:

1. **Durability (Δ to §4.3/§6.1).** The v1 hw engine executes a workflow run
   in-process and emits a complete `EngineEvent` stream through the `Persistence`
   port; it does not itself resume mid-run from persisted state
   (`sessionResume: false`). JaiRA v1 therefore records the stream in SQLite for
   audit/UI/history, and on restart re-runs interrupted tasks from the workflow
   start — workflow-level, not step-level, resume. (Memoized `llm-call` results
   can make such re-runs cheap once a memo layer is added.) Step-level durable
   resume is future `@ai-exec/hw` work, not a JaiRA blocker.
2. **Missing interaction port is run-fatal.** A UI state reached with no
   `InteractionPort` configured aborts the whole run rather than failing one
   state (a state-level failure could be re-entered forever by transitions like
   §7.3's `blocked → human_review`). A port that *rejects* remains a state-level
   failure. The hw executor also offers `interactionPolicy: "eager"` to refuse
   interactive definitions up front (search contexts).
3. **Conversation mode `summary` currently degrades to `full_history`** (no
   summarizer wired yet); the schema accepts all four modes per SPEC §4.7.

## 1b. Status Update — 2026-07-17 (phases 1–2 implemented)

§14 phases 1–2 are built and tested (typecheck-clean, 32 passing tests incl. a
CLI end-to-end suite against temp projects): npm-workspaces monorepo
(`shared/`, `persistence/`, `cli/`, `app/` stub), the headless `jaira` CLI
(`init`, `run`, `task create|start|list|status|cancel`), the `.jaira/` layout,
task JSON files + SQLite recording the engine's `EngineEvent` stream,
content-addressed snapshots via `@ai-exec/hw` `snapshotHash`, and
workflow-level crash recovery. Deviations from this document as drafted:

1. **Tooling: npm workspaces, not pnpm** (§2.1) — matches ai-exec. Cross-repo
   consumption works as designed: all four `@ai-exec/*` packages are declared
   as `file:../../../ai-exec/packages/*` deps (npm links them as junctions;
   declaring every one keeps the linked packages' internal `"*"` ranges from
   ever resolving to the npm registry). Vitest at the root transpiles the
   linked TS sources like any workspace package. The dev-mode `jaira` bin runs
   through `tsx`; an esbuild-bundled bin comes with the app packaging.
2. **A `runs` table was added to the §4.2 schema.** Workflow-level recovery
   (§1a item 1) means one task accumulates several execution attempts
   (initial run, interruption, re-runs), so each attempt is a `runs` row
   (snapshot_hash, outcome, outputs/failure JSON) and `events` rows carry a
   `run_id`. The remaining §4.2 tables (`instances`, `operations`,
   `transitions`, `artifacts`, `conversations`, `command_log`) are deferred to
   the phases that need them (step-level resume, agent operations, policy).
3. **Task files carry root workflow `inputs`.** §12 said title/description
   (+ optional issue artifact); generalized: `.jaira/tasks/<id>.json` stores an
   `inputs` object fixed at creation and passed to the workflow root on every
   run (the §9 planning workflow's `issue` input rides in it).
4. **Single-owner recovery.** Recovery runs on every project open: any task
   `running` at open time is marked `interrupted` (its open runs closed),
   since v1 assumes exactly one process owns a project's `.jaira/` at a time.
   A second process opening while a run is live would falsely interrupt it —
   acceptable headless; phase 3 must add ownership (app holds the project, CLI
   defers or locks).
5. **Cancel is in-process only for live runs.** `jaira task cancel` records a
   terminal `canceled` for queued/interrupted/stale-running tasks; a live run
   is canceled by SIGINT in the owning process (engine abort → `canceled`
   recorded on the way out). A cross-process cancel channel arrives with the
   app (phase 3).
6. **Snapshot format** (§5.3): `.jaira/snapshots/<hash>/` holds the bundle's
   transitive closure as authored state files (loader-derived `id` stripped —
   hash-neutral) plus a `.meta.json` carrying the root id; written to a
   staging dir and renamed (crash-safe); re-hashed and verified against the
   directory name on load.
7. **The scripted fake executor and scripted InteractionPort are shipped CLI
   features** (`--fake <rules>`, `--interactions <responses>`), mirroring
   ai-exec's test fakes — not test-only code. This is the permanent headless
   debugging surface (§14 closing note). Real providers use `config.json`'s
   `providers` map via `llmCallBinding` + `@ai-exec/llm`.
8. **Output repair default**: the CLI passes `repairTurns: 2` (§7.5) unless
   overridden with `--repair-turns`.
9. **JSON reads are BOM-tolerant** everywhere (config, task files, workflow
   states, `@file` CLI args) — PowerShell's `utf8` encoding writes a BOM that
   plain `JSON.parse` rejects.
10. **CI on GitLab + GitHub.** `.gitlab-ci.yml` and
    `.github/workflows/ci.yml` both check out the sibling library repo,
    install it (its `file:` links are symlinks, so the linked packages resolve
    their own deps from its `node_modules`), install JaiRA, and run
    `npm run typecheck` + `npm test`. Validated from a clean checkout
    (fresh sibling installs → tests green). JaiRA is GPLv3; the library is MIT.

## 1c. Status Update — 2026-07-24 (declarative-ai rename + ops redesign)

The shared library was renamed **ai-exec → declarative-ai**
(`@ai-exec/*` → `@declarative-ai/*`, now eleven packages) and its API redesigned
around a typed **operation model**. JaiRA phases 1–2 are migrated onto it:
typecheck-clean, 33 tests green, and the `jaira` CLI verified end-to-end against
a temp project (happy path, scripted human gate, unregistered-gate failure,
crash recovery). What changed here, and why:

1. **Dependencies.** `@ai-exec/core` + `@ai-exec/services` are replaced by
   `@declarative-ai/exec` (which re-exports `ops` → `json`, so one import site
   supplies the contract, op model, `Failure`, and `JsonValue`),
   `@declarative-ai/validate` (`SchemaValidator`), `@declarative-ai/promptop` +
   `@declarative-ai/llm` (prompt execution), and `@declarative-ai/hw` (the
   engine). The sibling checkout must be named `declarative-ai` — `file:` paths
   and both CI configs assume it.
2. **No `ExecutionSpec`; a run is an operation.** `createWorkflowExecutor` holds
   the bundle at *construction* (a workflow's identity is its snapshot), and a run
   starts from a `FunctionOp` whose bound inputs are the workflow's inputs.
   `handle.outcome` → `handle.result`; `Outcome` → `ExecResult`.
3. **Providers → a registry + a prompt executor.** The `providers` map and
   `llmCallBinding` are gone. A state's `PromptOp` dispatches to one injected
   prompt `Executor`; everything else is a `FunctionOp` resolved through
   `registry.functions`. Project config accordingly drops `providers` for
   `models.default` (route-prefixed, e.g. `anthropic/claude-sonnet-5`), and the
   bounded repair loop (§7.5) is now `withRetry({ validation: … })` composed
   around the prompt executor rather than a `repairTurns` field.
4. **`InteractionPort` is gone — a UI state is an interactive function.** This
   supersedes §1a item 2 (missing-port-is-run-fatal) and §7.1's port sketch: an
   interactive state is an ordinary `FunctionOp` whose `function` resolves to a
   registry entry marked `interactive`. Consequences: `--interactions` keys
   responses by **function name**, not state id; a never-registered function is a
   *state-level* failure only if that state is actually reached (so declining to
   register a gate is how a headless/search context refuses human input); and
   JaiRA's renderer-backed implementation in phase 4 becomes a registered host
   function rather than a port. The approval-gate guarantee (SPEC §11.4) is
   unchanged — the registry is caller-supplied and unreachable from inside a run.
5. **State-file format.** A state's work is ONE `operation` (`prompt` |
   `function`) — `agent`/`ui`/`skill` blocks are gone; params are unified into
   `inputs`; slots carry JSON Schemas instead of `type:`, with an *artifact*
   being a `blob`-kind slot derived from `contentMediaType` (no bespoke marker);
   and wiring is authored binding sugar (`{ input }`, `{ child, output }`,
   `{ expr }`) that the loader lowers to base refs. A `passthrough` output is
   just an unconstrained slot bound to a producer. Session/tool/conversation/
   permission concerns move to a sibling `environment` block.
6. **Snapshots store the bundle's `source`.** `loadBundle` now returns desugared
   `states` *plus* the states as authored (`source`), and `snapshotHash` hashes
   the authored form. `ensureSnapshot` therefore writes `source`, so improving the
   lowering never invalidates a stored snapshot and a reloaded snapshot re-hashes
   to its own directory name.
7. **Validation takes the registry.** `validateBundle(bundle, { functions })`
   resolves `functionRef`s, so `beginTaskRun` accepts the registry's `functions`
   facet and a missing interactive function is caught at task start.
8. **Metrics.** `cost` → `costUsd` (+ `costSource`, `childLlmCalls`,
   `childCostUsd`); token counts belong to the model payload (`LlmOutput`), which
   stops at the prompt executor, so they no longer appear in workflow metrics.
   There is also no `artifacts` side channel on a result — a produced artifact is
   an output *slot*, so artifact content rides in the outputs.
9. **Task inputs are typed as JSON.** `TaskMeta.inputs` is
   `Record<string, JsonValue>` (from `@declarative-ai/json`) rather than
   `unknown`, since they are read from a JSON file and bound as operation inputs.
10. **Local-directory caveat.** The library's working copy is still at
    `C:\UbuntuCode\ai-exec` (a lock held by another process blocked the rename);
    a directory junction `C:\UbuntuCode\declarative-ai` → `ai-exec` bridges it so
    the repo can reference the correct name. Renaming the real directory and
    deleting the junction is a no-op for this repo.

## 1d. Status Update — 2026-07-24 (phase 3 foundation)

The headless half of §14 phase 3 is built and tested (66 tests): the board
projection, the view/IPC contract, the app service, and a `jaira board` command.
The Electron shell and React renderer are the remaining phase-3 work.

1. **The board is a projection of the event journal, not a second state machine**
   (`persistence/src/projection.ts`). Folding `EngineEvent`s yields the instance
   tree, each instance's status, and the active path; a card's column is simply
   where its active path enters that level. This is what makes §12's "the board
   never disagrees with the engine" structural rather than aspirational. Two
   event shapes needed care: `child.superseded` carries the **parent's**
   instance id (so a sequence reset marks that parent's children superseded,
   preserving history per §4.2), and `instance.blocked` carries an
   `instanceId: -1` sentinel — an input-wiring failure means no instance ever
   existed, so it is recorded as a blocked child rather than a phantom node.
2. **`waiting_for_user` needs the registry, not just the document.** The journal
   records `operation.started { op: "function" }` without saying whether that
   function is a human gate, so the projection takes the set of interactive
   function names from its caller (the app passes what it routes to the
   renderer). Without it a parked gate would read as plain `running`.
3. **A new `runtime/` package** (Δ to §2.1) holds the engine harness — provider
   defaults, the capability registry, the prompt executor, the scripted
   fake/interaction doubles, and the demo workflow — shared by the CLI and the
   Electron main process. The alternative was the app depending on the CLI, which
   inverts the dependency; and the read models (`persistence/src/views.ts`) are
   shared the same way, so the CLI and the app render the *same* board.
4. **Interactive states reach the UI through an `InteractionHub`** (§7.1, and the
   §1c item 4 replacement for `InteractionPort`). It registers interactive
   functions that park the call and emit a request; only `submit` resolves one,
   and only the IPC layer calls `submit` — so SPEC §11.4's guarantee (an agent
   cannot fabricate a human decision) is preserved by construction. A scripted
   answer takes precedence over the hub, so demo runs never block.
5. **`AppService.close()` is async, deliberately.** An aborted run keeps
   journaling for a beat and still has a `finishTaskRun` to write, so closing the
   database first threw "database connection is not open" from inside the engine's
   event tee and left the task row `running`. Close now awaits in-flight runs.
6. **`jaira board [--level] [--json]`** renders the same projection headlessly,
   so the phase-3 milestone is observable (and testable) without the GUI: an
   interrupted task shows in the column it died in, a completed one moves to
   *finished*.

## 1e. Status Update — 2026-07-24 (phase 3 complete)

The Electron shell and React renderer are built and verified: the app launches,
opens a project, and renders the board (columns from the workflow, cards placed by
active path), the task-detail panel (instance tree, run history, live event
stream, outputs) and a dialog for interactive states. Verified by screenshotting
a real run's window, not only by typecheck.

1. **Main is a thin IPC adapter.** `app/src/main/index.ts` owns windows and maps
   each contract channel to an `AppService` method; the service stays
   Electron-free, which is what makes the app surface testable headlessly (11
   service tests, including the live human gate).
2. **The renderer's only capability is the preload bridge.** `contextIsolation`
   on, `nodeIntegration` off, an explicit channel whitelist in the preload, and a
   CSP that allows no remote code. The renderer receives *pre-projected* views, so
   it cannot disagree with the engine — and cannot reach the interaction hub
   except through `interaction:submit` (SPEC §11.4).
3. **Board state is a subscription, not a poll** (§11.2): main pushes
   `engine:event` / `store:invalidate` / `interaction:*` / `run:finished`, and the
   store refetches only the affected view. Plain React state rather than Zustand,
   and no dnd-kit: cards move because the *engine* advances, so dragging one would
   mean forcing a transition — out of scope here (Δ to §2.1 tooling).
4. **Native-module ABI is a two-runtime problem** (a real trap, now scripted).
   `better-sqlite3` is a V8-ABI addon, so a single build cannot serve Node 22
   (`NODE_MODULE_VERSION` 127) and Electron 33 (130); `scripts/nativeAbi.mjs`
   swaps the prebuilt binary and `npm run app` calls it, with `npm run abi:node`
   to go back for tests and the CLI. (Prebuilds are downloaded, so no compiler is
   needed.)
5. **`JAIRA_CAPTURE` screenshots the window and exits** — a debug affordance that
   makes the UI verifiable from a script and, later, in CI.
6. **CI now also builds the app** (esbuild main/preload + Vite renderer) so a
   broken bundle fails the pipeline; the app itself is not launched there.
7. **Remaining phase-4 work:** the five typed UI components (§7.1). The dialog
   today renders `choose_option`-shaped gates generically from the state's
   authored `config`, which is enough for the critique workflow's review gate.

## 1f. Status Update — 2026-07-24 (phase 4: interaction + approvals)

The five built-in components (SPEC §8.1) and the approvals-inbox scaffolding are
built and verified — driven through a real run in the app, screenshot by
screenshot, plus 83 tests. What that phase settled:

1. **Component contracts live in `shared`, and main re-validates every answer.**
   `parseComponentConfig` reads the *authored* config (a malformed state file fails
   with a path-shaped message instead of rendering an empty dialog);
   `validateComponentResult` checks what the *user* submitted. The second half is
   the load-bearing one: the renderer is the untrusted side of the IPC boundary, so
   an undeclared decision or a missing required field is refused in the main
   process before it can become a workflow output (DESIGN §7.1). The engine's own
   output-schema check remains a second, independent gate.
2. **Result shapes are chosen to land on declared outputs** — `choose_option` and
   `review_artifact` return `{ decision, comments? }`, `edit_markdown`
   `{ content }`, `confirm_action` `{ confirmed }`, and `fill_form` a flat object
   of its fields. So a UI state's outputs are ordinary state outputs, with no
   adapter layer in between.
3. **`fill_form` reads a JSON-Schema *subset*** (`string`/`number`/`boolean`/`enum`
   with `optional`, `default`, `multiline`) rather than arbitrary schemas, which is
   what §7.1 allows and what a form can honestly render.
4. **A `sequence` is a cursor, not a barrier** (discovered while building the
   component tour, and worth knowing when authoring). The engine enters the next
   sequence member as soon as the previous one has a *record*, so children with no
   data dependency between them run concurrently — five independent gates all park
   at once. Ordering is dataflow-driven (SPEC §10.4): a child whose inputs
   reference an unresolved sibling parks until they resolve. The components demo
   therefore threads each gate's output into the next, which is the same mechanism
   SPEC §9's planning workflow relies on (context needs goals).
5. **The renderer imports `@jaira/shared/browser`, never the package root.** The
   root barrel also exports Node-only helpers (`readJsonFile`, the `.jaira/` path
   layout); pulling those into the renderer's graph breaks the Vite build outright
   (`node:fs` has no meaning in Chromium). A separate browser entry makes that a
   build-time impossibility rather than a warning — the failure mode it prevents is
   nasty, because a *stale* bundle keeps loading and the app looks fine while
   running old code.
6. **Failures report their root cause.** A composite failure reads "child 'goals'
   terminated with error and no transition handled it", which hides what broke;
   `runCauses` pulls the operation-level reasons out of the journal, and
   `jaira task start` prints them as `causes`. This is what turned a real-provider
   run's opaque failure into "Anthropic API key is missing".
7. **A model is only required when a workflow actually calls one.** `modelDefaults`
   used to refuse any run without a configured model, which wrongly rejected a
   workflow made entirely of function states (host code, UI gates, agents).
8. **Real-provider status — verified 2026-07-28** (see §1h). The path is
   `models.default` (or a state's `operation.config.model`) →
   `@declarative-ai/promptop` → `@declarative-ai/llm` → the Anthropic SDK. Note a
   state's model must be route-prefixed for a real run
   (`anthropic/claude-sonnet-5`); the demo workflow's role names
   (`planner`/`critic`/`fixer`) are fake-executor labels, and
   `specPlanningFiles({ model })` swaps in a real id.
9. **The approvals inbox lists pending human gates across tasks** — which is the
   whole inbox today. Per-command `require_approval` decisions (§10.2) are
   provider-initiated and arrive with the policy engine and process executors in
   phase 6, so they are absent rather than mocked.

## 1g. Status Update — 2026-07-28 (phase 5: git isolation + WSL)

The Exec/WSL layer, the path mapper, the git wrapper and the worktree lifecycle are
built and tested (149 tests) — including **real WSL execution** against
Ubuntu-22.04 and a full bound-task run whose worktree was created by the distro's
own git. What phase 5 settled:

1. **One Exec seam, and no shell.** `Exec.run(command, argv, { execEnv })` spawns
   natively or wraps as `wsl.exe -d <distro> --cd <linuxCwd> -- <cmd …>`, so WSL is
   a configuration of one layer (§9.1). Arguments are always an argv array with
   `shell: false`: nothing in a branch name or task title can become shell syntax,
   and there are no quoting rules to get wrong. `wsl.exe` itself gets no cwd — the
   distro-side directory is `--cd`, and `--` terminates its option parsing.
2. **Path mapping lives in exactly one module** (§9.1, the §16 mitigation), with 27
   table-driven cases. Two decisions worth recording: a bare `C:` is
   drive-*relative* in Windows with no WSL equivalent, so it maps to the drive root
   as a documented approximation; and both UNC spellings
   (`\\wsl.localhost\<distro>\…`, legacy `\\wsl$\…`) are accepted while the modern
   one is produced.
3. **Comparing paths needs a normalizing key, not string equality** — a real bug
   found by running it: `git worktree list` prints forward slashes (and, for a WSL
   project, the *distro's* `/mnt/c/…` view) while JaiRA records Windows paths, so
   the worktree ↔ task join silently matched nothing. `hostPathFor` maps git's
   output back to the host view and `samePath` ignores separator and case.
4. **The workspace is decided before the task is marked running.** `ensureWorkspace`
   materializes the worktree first, so a git failure leaves the task startable
   rather than `running` with nowhere to run. It is idempotent (a re-run reuses the
   worktree, preserving in-progress work) and prunes git's administrative record
   when a worktree directory has been deleted behind git's back. The resulting
   `{ root, treeHash }` is passed as the run's `Workspace`, giving a
   workspace-mutating op the identity it must be memoized under; the phase-6
   process executors translate `root` for their execution environment via `pathFor`.
5. **A worktree usually *does* contain `.jaira/` — DESIGN §10.1's aside was wrong**
   (now corrected there). A worktree is a checkout of the branch, and
   `.jaira/workflows/` is *source* that should be committed, so it comes along.
   Keeping agents out of it is therefore a policy job (the `.jaira/**` deny rule),
   not a layout accident. `jaira init` now writes `.jaira/.gitignore` for the
   derived half (`jaira.db*`, `snapshots/`) so per-machine run history is neither
   committed nor copied into every worktree.
6. **Removal never destroys work silently.** `git worktree remove` refuses a dirty
   worktree; that refusal is *returned* rather than thrown, so the CLI/UI can offer
   `--force` as an explicit choice (§9.2's "when the user confirms"). Removing a
   worktree keeps its branch — the work is still there to merge.
7. **Surfaces:** `jaira worktree list` (joined with tasks) and
   `jaira worktree remove <taskId> [--force]`; `task start` logs the worktree and
   branch; the app's detail panel shows both. `execEnvironment` is project config.

## 1h. Status Update — 2026-07-28 (real Claude verified; a cost characteristic)

The phase-4 milestone's remaining half is done: the SPEC §9 planning workflow ran
against **real Claude** (`anthropic/claude-sonnet-5`) end to end, with the human
review gate answered through the normal channel. The journal is the evidence —
`critique → address_weaknesses (i1)`, `critique → terminate.success (i2)`,
`plan → goals (i1)`, then the same again for `i2`, with six `child.superseded`
events, i.e. SPEC §3.3's sequence resets clearing `goals`/`context`/`critique` on
each re-plan. Killing the process mid-run also exercised recovery: the task came
back `interrupted`, re-runnable from its pinned snapshot.

Two things worth knowing before pointing this at real work:

1. **`full_history` + a re-plan loop grows context geometrically.** Measured input
   tokens per call across one run: 232 → 317 → 1,396 → 3,975 → 10,598 → 21,033 →
   42,828. The critique state carries the whole conversation, and the parent's
   `needs_changes` transition re-runs the pass up to `limits.max_iterations` (3),
   so each iteration re-sends everything before it. That run reached **$0.25 in
   seven calls** and was still climbing, which is why it looks like a hang next to
   the sub-second scripted runs. Nothing is wrong — but a workflow with this shape
   wants a `summary` conversation mode (phase 7) or a lower iteration cap before it
   is routine.
2. **Real critique output is not the scripted `clean`.** Sonnet returned
   `needs_changes` on every pass, so the loop ran to its cap rather than
   terminating early — a reminder that the fake-executor scripts encode the *happy*
   path, and only a real run exercises the loop the SPEC was designed around.

Also fixed here: **`.gitignore` did not cover `.env*`.** A `.env.local` holding
real provider keys (and unrelated secrets) was sitting untracked in the repo while
`git add -A` was being used routinely. Nothing ever reached a commit — verified
across all history — and `.env`/`.env.*` are now ignored. Keys belong in the
environment, never in the tree.

## 1i. Status Update — 2026-07-28 (phase 6: process executors + policy)

The safety model stops being design and starts being enforcement. 232 tests. What
phase 6 settled:

1. **Policy matches parsed intent, not strings.** `runtime/command.ts` turns a
   command line into `ParsedCommand`s so `git reset --hard`,
   `git -C dir reset --hard`, `git -c k=v reset --hard`, `sh -c "git reset --hard"`
   and `env FOO=1 git reset --hard` are *one* decision (SPEC §11.2's explicit
   requirement). It unwraps shell and prefix wrappers, and splits chained lines so
   a destructive command hidden after a benign one is still judged.
2. **Unparsable always escalates.** An unterminated quote, or PowerShell
   expression syntax the heuristic refuses to model (`$(…)`, backticks,
   `Invoke-Expression`), yields `unparsed` → `require_approval`. The failure
   direction is the point: an unreadable command must never become an allowed one
   (DESIGN §10.1, §16).
3. **Ordered rules compile to upstream's `smart` mode.** DESIGN §10.1's
   `{ match, action }` list is not a second enforcement mechanism: command-running
   tools get `PermissionMode: "smart"`, and the approver parses the call and
   answers `allow`/`deny`/`ask`. Authored rules win over the SPEC §11.2/§11.3
   built-ins, first match first, and the strictest verdict on a line wins.
4. **`.jaira/**` is denied by path** — the enforcement §1g item 5 said it had to be,
   since a worktree normally contains `.jaira/`. Screening happens per *parsed
   word*: a path matcher applied to a whole command line never matches, because the
   path is preceded by a space.
5. **Approvals are a separate channel from workflow gates** (§10.2). Both surface
   in one inbox, but a gate is an authored UI state while an approval is
   provider-initiated and unpredictable. The hub carries a `PermissionScope`, so
   "allow for this run" is a real answer rather than the same question forty times —
   and with no listener attached it **denies** rather than hanging an agent's tool
   loop.
6. **`command_log` lands** (the first deferred §4.2 table, because policy is what
   needs it): every requested, allowed, blocked, approved and denied command with
   its parsed intent, reason, decider and scope. `summary()` is a run's safety story
   at a glance.
7. **Agent runtimes register as `runtime` entries** — `claude-code` over the SDK
   (`agents-api`) and `claude-cli` over a subprocess (`agents-cli`), a WSL project's
   CLI adapter wrapped through `wsl.exe`. They are verified with a fake
   `AgentQuery`, the seam upstream exposes for exactly that: registration,
   workspace/policy/approve plumbing and failure-as-data are all tested with no SDK,
   no `claude` binary and no network.
8. **Capability gating refuses rather than degrading** (§8.2): a policy that can
   escalate, run against an adapter whose `policyEnforcement` is `"none"`, fails the
   task with a message naming the state — it does not run unguarded. `policyCanEscalate`
   is the honest predicate (built-ins always can, since §11.3's classes are all
   approvals).

Remaining for phase 7: the `claude-cli` hook-loopback variant, `generic-cli`,
conversation `summary` mode, history pruning, and the workflow browser.

## 2. Architecture Overview

```text
┌─────────────────────────── Electron ───────────────────────────┐
│  Renderer (React)                Main process                  │
│  ┌──────────────────┐  typed    ┌───────────────────────────┐  │
│  │ Board / sub-board │◄─ IPC ──►│ App shell (windows, IPC)  │  │
│  │ Task detail view  │          │ ┌───────────────────────┐ │  │
│  │ UI components     │          │ │ @jaira/engine         │ │  │
│  │ Approvals inbox   │          │ │  scheduler/evaluator  │ │  │
│  └──────────────────┘          │ │  expression language  │ │  │
│                                 │ │  workflow loader      │ │  │
│                                 │ │  persistence (SQLite) │ │  │
│                                 │ └───────────┬───────────┘ │  │
│                                 │ ┌───────────▼───────────┐ │  │
│                                 │ │ @jaira/runners        │ │  │
│                                 │ │  agent-sdk │ cc-cli   │ │  │
│                                 │ │  llm-api   │ generic  │ │  │
│                                 │ └───────────┬───────────┘ │  │
│                                 └─────────────┼─────────────┘  │
└───────────────────────────────────────────────┼────────────────┘
                                    Exec layer (spawn | wsl.exe)
                                                │
                              worktrees, git, agent processes
```

Key properties:

- **The engine is a pure TypeScript package with no Electron dependency.** It
  talks to the world through three injected interfaces: `Persistence`,
  `RunnerRegistry`, and `UiBridge`. This makes the whole state-machine core
  testable with fakes and usable from a headless CLI (`jaira` command) for
  scripting and integration tests.
- **The renderer never touches the engine directly.** All interaction goes
  through a typed IPC contract in the main process. This is also what makes the
  spec's approval-gate guarantee (§11.4) true by construction: UI-state outputs
  can only enter the engine through the renderer IPC channel, which no agent
  process can reach.
- **All process spawning goes through an Exec abstraction** that targets either
  native Windows or `wsl.exe -d <distro>`, so WSL support is a configuration of
  one layer, not a fork of the codebase.

### 2.1 Repository Layout

```text
packages/
  shared/     types, state-file schema types, expression AST, IPC contract types
  engine/     loader, validator, evaluator, persistence, policy model, snapshots
  runners/    RunnerAdapter interface + adapters (agent-sdk, claude-cli, llm-api, generic-cli)
  app/        Electron main + React renderer
  cli/        headless `jaira` CLI (engine harness, workflow lint, task ops)
```

> **Layout revision (see §1a, §1c):** `engine/` exists as `@declarative-ai/hw`
> and `runners/` as `@declarative-ai/promptop` + `@declarative-ai/llm` (with
> delegated agents in `@declarative-ai/agents-api` / `agents-cli`), all
> implemented in the sibling `declarative-ai` repo and consumed via `file:`
> links. This repo builds: `shared/` (IPC/task types), `app/` (Electron main +
> renderer), `persistence/` (durable SQLite implementation of the engine's
> `Persistence` port + task store), and `cli/` for JaiRA-specific concerns (task
> ops, worktrees); workflow lint/execution harnesses ship with the engine.

Tooling: npm workspaces (revised from pnpm — see §1b item 1), Vite (renderer),
esbuild (main/CLI), Vitest, better-sqlite3, Ajv (schema validation), React +
dnd-kit (board).

## 3. Project Directory Layout

For a JaiRA project rooted at `<project>/`:

```text
<project>/
  .jaira/                     engine-owned; agents denied all access
    config.json               project config (runners, exec env, policy, artifact dir)
    workflows/                state files (authoritative, user-edited)
      feature.json
      feature/plan.json
      feature/plan/critique.json
    snapshots/<hash>/         immutable pinned copies of workflow trees (§9)
    tasks/<taskId>.json       task metadata (human-readable half of hybrid storage)
    jaira.db                  SQLite: all execution state and history
    skills/                   project skill library (§7.4)
  jaira-artifacts/            default artifact root; Git-tracked; agent-writable
    <taskId>/...
```

Worktrees live **outside** the project directory (agents are scoped to a
worktree that must not contain `.jaira/`):

```text
<project-parent>/.jaira-worktrees/<projectName>/<taskId>/
```

The engine maintains the worktree ↔ task mapping in SQLite. `jaira-artifacts/`
exists inside each worktree like any other tracked directory; artifact merges
across branches are ordinary Git merges.

State files use plain `.json` extension; the state ID is derived from the path
(§15, Q2/Q3).

## 4. Persistence (Hybrid Model)

### 4.1 Source-of-Truth Split

- **Task metadata → JSON file** `.jaira/tasks/<taskId>.json`: title,
  description, labels, workflow root state ID, branch binding, parent task,
  created date. Human-readable and hand-editable while the task is not running.
  The engine reloads task files on startup and on file change; edits to a
  running task's execution-relevant fields (workflow, branch) are rejected with
  a UI warning.
- **Execution state → SQLite** `.jaira/jaira.db` (WAL mode): everything the
  evaluation loop reads or writes. The DB references tasks by ID only and never
  duplicates metadata fields.

Rule: if the evaluator needs it to make a decision, it lives in SQLite. If a
human needs to read or edit it casually, it lives in the JSON file.

### 4.2 SQLite Schema (core tables)

```sql
task_runtime   (task_id PK, status, snapshot_hash, branch, worktree_path,
                root_instance_id, created_at, updated_at)
instances      (id PK, task_id, state_id, child_key, parent_instance_id,
                status, superseded, iteration, sequence_cursor,
                inputs_json, outputs_json, outcome,
                started_at, ended_at)
operations     (id PK, instance_id, kind,            -- ui | agent | skill
                status, provider, attempt,           -- attempt = repair-loop counter
                request_json, result_json, error_json,
                provider_session_id, started_at, ended_at)
transitions    (id PK, instance_id, iteration, to_target, when_expr, taken_at)
events         (seq PK AUTOINCREMENT, task_id, instance_id, type,
                payload_json, created_at)            -- append-only journal
artifacts      (id PK, task_id, rel_path, format, content_hash,
                produced_by_operation, created_at)
conversations  (id PK, task_id, provider, provider_session_id, mode,
                transcript_artifact_id, created_at)
command_log    (id PK, operation_id, raw_command, parsed_intent_json,
                decision,                            -- allowed | blocked | approved | denied
                decided_by, created_at)              -- policy | user
```

Notes:

- `instances.child_key` is the key in the parent's `children` map, distinct
  from `state_id` — the same state file can be mounted under multiple keys
  (spec §10.4 fan-out example).
- `children.<key>.outputs` resolution = most recent non-`superseded` instance
  with that `child_key` under the current parent instance.
- **Sequence-reset clearing (spec §3.3) marks instances `superseded` rather
  than deleting them.** History is preserved (spec §13); expression resolution
  ignores superseded instances, which implements "clears the recorded results."
- The `events` journal is the audit trail and debugging record. The
  materialized tables (`instances`, `operations`, …) are the resume source;
  every engine step appends its events and updates materialized rows in **one
  transaction**, so they can never disagree.

### 4.3 Crash Recovery

> **Revised by §1a item 1:** the engine no longer steps through SQLite
> transactions itself; JaiRA persists the engine's `EngineEvent` stream and
> task-level status. v1 recovery is workflow-level (re-run interrupted tasks
> from the workflow start); the step-level protocol below is the target state
> once `@declarative-ai/hw` gains durable mid-run resume, and the schema in §4.2
> should be built to accommodate it.

On startup, for every task with `status = running`:

1. Load the instance tree from `instances`.
2. Operations in status `running` were interrupted. For agent operations: if
   the adapter supports session resume and `provider_session_id` is recorded,
   attempt resume; otherwise mark the attempt `interrupted` and start a fresh
   attempt (same instance, `attempt + 1`, conversation per the state's
   configured mode). UI operations are simply re-presented — they are pull-based
   (§7.1) and lose nothing.
3. Re-run transition evaluation for any instance whose last event was an
   unprocessed child completion (the completion event is in the journal, so
   "did a transition already occur" is answerable exactly, per spec §10.3).

Side effects (spawning an agent) always happen **after** the transaction that
records the intent (`operations` row in status `starting`), so a crash between
record and spawn is detected and retried, never duplicated silently.

## 5. Workflow Loading, Validation, and Snapshots

### 5.1 Loader

Loads a state tree from a snapshot directory (never from live `workflows/`
during execution). Parsing produces typed `StateDef` objects from
`@jaira/shared`.

### 5.2 Validator

Runs at three moments (§15, Q7): live-lint in the workflow editor UI, on save,
and **enforced** at task start (snapshot creation fails on errors). Checks:

- `id`, when present, matches the file path; otherwise derived.
- Every `children.<key>.state` resolves to an existing file that is a
  descendant path of this state.
- `sequence` entries name declared children; no duplicates.
- Transition targets are declared child keys or `terminate.*` outcomes.
- All expressions (transitions, input wiring, output `from`) parse.
- Input/output/param declarations are valid against the supported JSON-Schema
  subset (type, enum, items, format, optional, default, `type: "artifact"`,
  `type: "passthrough"`).
- Cycle-prone shapes (a transition targeting a sequence member earlier than
  itself) without any `limits.max_iterations` produce a warning.
- Static reference check: expressions referencing undeclared children or
  undeclared inputs/outputs/params are errors.

### 5.3 Snapshots and Version Pinning (spec §12)

At task start the engine collects the transitive closure of state files from
the root state, computes `snapshot_hash = sha256(sorted [(relPath, contentHash)])`,
and copies the files into `.jaira/snapshots/<hash>/` if not already present
(content-addressed, deduplicated across tasks). The task pins `snapshot_hash`;
the Git commit hash of the project at start time is recorded alongside when
available. Execution always reads from the snapshot. Migration of a running
task to a newer version is out of MVP scope; the UI offers "restart task on
current workflows" as the escape hatch.

## 6. Engine Core

### 6.1 Evaluation Model

The engine is a **single-threaded, event-driven reducer** per task. All
concurrency (async children, agent processes) lives at the edges; the decision
core processes one event at a time from a per-task queue, which makes spec §3.3
implementable exactly and deterministically testable.

Event types: `task.start`, `operation.completed`, `operation.failed`,
`child.terminated`, `ui.submitted`, `timer.fired`, `task.cancel`.

Each event is processed as: **(begin tx) append event → apply spec §3.3 loop →
update rows → (commit) → dispatch side effects**. The §3.3 loop in code:

```text
onEvent(instance, event):
  record event results (outputs / child result / failure)
  if unhandled failure per spec §3.3      → terminate(error)
  loop:
    t = first transition whose `when` is true (in declared order,
        skipping transitions touching PENDING references)
    if t → take it (enter child | terminate) and stop
    op = next unrun operation in priority order (ui, agent, skill, sequence-next-child)
    if op is async child → start it, continue loop      # no evaluation trigger
    if op → start it and stop (wait for its completion event)
    if any child still running → stop (wait)
    else → terminate(success)
```

Entering a child: create a fresh `instances` row, resolve + validate input
wiring against the parent context (validation failure → child `blocked`,
surfaced in UI), then recurse. If the transition target is a sequence member,
set the parent's `sequence_cursor` to it and mark it and all later sequence
members' instances `superseded` (spec §3.3 reset rule). `iteration` increments
on every taken transition.

Termination: resolve the instance's declared outputs (evaluating `from`
expressions), validate against the output schema (failure ⇒ outcome becomes
`error`), cancel still-running descendants (spec §10.4), write outcome, emit
`child.terminated` to the parent's queue.

### 6.2 Expression Language

Hand-written lexer + Pratt parser + tree-walking evaluator in
`@jaira/shared` (~500 LOC, zero dependencies — deliberately **not** a sandboxed
`eval` or a third-party expression lib, so the "pure and limited" guarantee of
spec §6 is enforced by the grammar itself).

Grammar: literals (string/number/boolean/null), identifiers, `.` property
access, `(…)`, `!`, the spec's binary/comparison/boolean operators, `?:`, and
`.length`. No calls, no indexing in MVP (add `[n]` later if needed).

Evaluation context is a read-only object graph assembled per instance:
`inputs`, `outputs`, `params`, `ui`, `children.<key>` (`outputs`, `outcome`),
`run` (`iteration`), `limits`, `artifacts`, `conversations`.

Two non-JS semantics from spec §6, implemented in the evaluator:

- Property access on `undefined`/missing → `undefined` (implicit optional
  chaining).
- **PENDING propagation**: a child that has started but not terminated resolves
  to a `PENDING` sentinel. Any operator or property access touching `PENDING`
  yields `PENDING`. A transition whose `when` evaluates to `PENDING` is skipped
  this round; input wiring that evaluates to `PENDING` parks the child until
  the referenced child resolves (the dataflow join of spec §10.4). Short-circuit
  operators only short-circuit on determinate values (`false && PENDING` is
  `false`; `PENDING && x` is `PENDING`).

### 6.3 Async Children and Dataflow Join

`"async": true` children start without pausing the loop (§6.1). A parked child
(inputs referencing PENDING outputs) registers a dependency; each
`child.terminated` event re-attempts parked children before transition
evaluation. Deadlock detection: if the state has nothing running, nothing
startable, and parked children whose dependencies can no longer resolve
(dependency terminated without the referenced output), the parked child is
`blocked` and the state follows the unhandled-failure path.

### 6.4 Timers and Limits

`limits.timeout` (per state, seconds) arms a durable timer (row in `events`
scheduling + in-memory setTimeout, re-armed on restart from `started_at`).
Firing terminates the state with `terminate.timeout`. `limits.max_iterations`
is data for expressions only, per the spec's examples — the engine does not
auto-enforce it, but the validator warns on unguarded cycles (§5.2).

## 7. Operations

### 7.1 UI Operations

A `ui` operation writes a row to a `pending_ui` view (operations in status
`waiting_for_user`) and sets the instance status `waiting_for_user`. The
renderer pulls pending components over IPC, renders the built-in component with
the instance's resolved inputs, and submits structured data back. The main
process validates the payload against the component's contract **and** the
state's output schema, then enqueues `ui.submitted`. Because this path is
renderer-IPC-only, agents cannot fabricate UI outputs (spec §11.4).

MVP component set (§15, Q4): `choose_option`, `review_artifact`,
`edit_markdown`, `fill_form`, `confirm_action`. Each is a React component with
a typed props/result contract in `@jaira/shared`. `review_artifact` renders
markdown artifacts with the decision buttons supplied by the state config;
`fill_form` renders from a JSON-Schema subset.

### 7.2 Agent Operations

Delegated to a `RunnerAdapter` (§8) with a fully-resolved `RunSpec`:

```ts
interface RunSpec {
  taskId: string; operationId: string;
  cwd: string;                    // task worktree (or project dir if unbound)
  execEnv: ExecEnv;               // windows | { wsl: distro }
  prompt: string;                 // rendered template + injected contract text
  conversation: ConversationRef;  // mode + provider session / transcript refs
  outputContract: OutputContract; // §7.5
  policy: CompiledPolicy;         // §10
  env: Record<string, string>;    // provider auth etc., from project config
}
```

Prompt templates come from `agent.prompt.template` with `{{inputs.*}}` /
`{{params.*}}` interpolation; artifact-typed inputs interpolate as worktree-
relative paths plus an instruction line telling the agent to read the file.

### 7.3 Conversation Modes (spec §4.7)

- `full_history` (default): reuse the provider session when the adapter
  supports resume (Agent SDK, Claude Code `--resume`); otherwise replay the
  stored transcript artifact as prompt preamble.
- `summary`: a stored summary artifact is injected as preamble. Summaries are
  produced lazily by the `llm_api` adapter when a state first requests this
  mode, and cached per conversation.
- `fresh`: no context.
- `selected_artifacts`: listed artifacts injected as preamble.

Every agent operation appends its transcript to a conversation artifact
(`jaira-artifacts/<taskId>/conversations/…`), so conversations are ordinary
artifacts per the spec.

### 7.4 Skill Operations

MVP skill = a directory under `.jaira/skills/<name>/` containing `skill.json`
(params schema, expected outputs schema, provider requirements) and
`prompt.md`. A `skill` operation is executed as an agent operation whose prompt
is the skill's rendered template — it reuses the entire adapter/contract
machinery and adds only registration and parameter binding (§15, Q11).

### 7.5 Output Contract and Repair Loop

Derived from the state's output schema at operation start:

- **Artifact outputs** (`type: "artifact"`): the engine pre-assigns a target
  path `jaira-artifacts/<taskId>/<instanceId>-<name>.<ext>` and injects it into
  the prompt ("write X to path P"). After the run, the engine verifies
  existence and format, records the artifact row + content hash.
- **Data outputs** (everything else): compiled into one JSON Schema. Delivery
  channel is chosen by adapter capability, best first: native structured output
  (Agent SDK, `llm_api`) → final-message fenced ```json block → an
  `outputs.json` file at an engine-given path (fallback for generic CLI
  runners).
- **Passthrough outputs** are resolved engine-side from `from` expressions and
  never appear in the contract.

Validation is always engine-side (Ajv), regardless of channel. On failure
(missing artifact, unparsable payload, schema violation): the adapter re-invokes
the **same conversation** with the concrete validation errors and the original
contract — at most **2 repair turns** (recorded as `operations.attempt`), then
the operation fails and the state terminates with `terminate.error`. This is
the confirmed "ask it to correct itself" strategy, bounded and audited.

## 8. Runner Adapter Layer

> **Superseded — implemented in declarative-ai:** the contract below shipped as
> the `@declarative-ai/exec` `Executor`/`Operation`/`ExecHandle` contract (same
> role, redesigned around a typed operation model — see §1c), consumed by both
> JaiRA and findmyprompt. The `llm_api` adapter exists as
> `@declarative-ai/promptop` over `@declarative-ai/llm`; the process adapters
> below shipped as `@declarative-ai/agents-api` / `agents-cli`; the engine plus
> its workflow executor exist as `@declarative-ai/hw` (§2.1 note).
> Semantics in this section (adapter list, capability gating, output contract)
> remain accurate as requirements for the agent adapters.

```ts
interface RunnerAdapter {
  readonly id: string;                       // "agent-sdk", "claude-cli", "llm-api", ...
  readonly capabilities: RunnerCapabilities;
  start(spec: RunSpec): RunHandle;
}
interface RunnerCapabilities {
  structuredOutput: boolean;     // native schema-constrained output
  sessionResume: boolean;
  streaming: boolean;
  policyEnforcement: "callback" | "config" | "none";
  fileAccess: boolean;           // can read/write worktree files (llm_api: false)
}
interface RunHandle {
  events: AsyncIterable<RunnerEvent>;  // progress | message | command_request
                                       // | command_result | output | done | error
  cancel(): Promise<void>;
}
```

Normalized `RunnerEvent`s feed three consumers: the run record (spec §10.2),
the live task-detail stream in the UI, and the policy auditor (`command_log`).
This is the answer to spec open question #6 (partial progress): adapters map
whatever their provider emits (stream-json lines, SDK message events, raw
stdout) into this one event vocabulary.

### 8.1 Adapters (MVP build order)

1. **`agent-sdk`** — Claude Agent SDK in-process. `canUseTool` callback calls
   the policy engine directly (`policyEnforcement: "callback"`); native
   structured output; session resume; richest streaming. Reference adapter.
2. **`llm-api`** — direct chat-completion calls (OpenRouter/Anthropic) with
   native structured output. No filesystem, no commands — trivially safe.
   Used for cheap non-agent states: summarization, classification, output
   extraction, conversation summaries.
3. **`claude-cli`** — Claude Code headless (`claude -p --output-format
   stream-json`). Policy via a generated per-run settings file (permission
   rules) plus a PreToolUse hook script that calls the engine over a local
   loopback HTTP endpoint (auth token per run) for approval decisions —
   `policyEnforcement: "callback"` with extra plumbing.
4. **`generic-cli`** — configurable command adapter (command template, prompt
   delivery via arg/stdin/file, output via `outputs.json` contract). opencode
   and codex ship as configurations of this base, specialized later if their
   native policy hooks are worth wiring (`policyEnforcement: "config"` or
   `"none"` until then).

### 8.2 Capability Gating

A state may declare requirements (e.g. its policy includes approval-required
commands ⇒ requires `policyEnforcement !== "none"`). At task start the
validator cross-checks each state's provider choice against the registered
adapter's capabilities; violations block the task with a clear error rather
than degrading silently. Provider selection itself follows the spec: the state
names a provider; project config maps provider names to adapter configurations
(model, API keys, CLI path, per-provider defaults).

## 9. Git Integration, Worktrees, and WSL

### 9.1 Exec Abstraction

All child processes (git, agents, hooks) go through:

```ts
interface Exec { spawn(cmd, args, opts: { cwd, env, execEnv }): Child }
```

`execEnv: "windows"` uses native spawn; `{ wsl: "Ubuntu" }` wraps as
`wsl.exe -d Ubuntu --cd <linuxCwd> -- <cmd …>`. A `PathMapper` converts
between Windows and WSL views (`C:\…` ↔ `/mnt/c/…`, `\\wsl$\<distro>\…` ↔
`/…`). Projects declare `execEnvironment` in `.jaira/config.json`; a WSL
project is stored on the WSL filesystem, the engine reads its files for
display via `\\wsl$` UNC paths, and runs all git/agent commands inside the
distro (running git against `\\wsl$` from Windows is slow and
permission-fragile — avoided entirely).

### 9.2 Branch Binding and Worktrees (spec §10.5)

Branch binding happens **at task creation by the user** (§15, Q12): a task is
created unbound (runs against the project directory read-mostly workflows) or
bound to a new/existing branch. On first activation of a bound task, the
engine creates `git worktree add <worktreePath> <branch>` under
`.jaira-worktrees/` (§3). Subtasks inherit the parent's branch and worktree by
default (the spec's shared-branch collaboration pattern); write coordination
within it is the workflow author's problem in MVP, per spec. Worktrees are
removed (`git worktree remove`) when the task completes and the user confirms.

## 10. Safety Policy

### 10.1 Canonical Policy Model

One project-level policy in `.jaira/config.json`, compiled per run:

```ts
interface Policy {
  rules: PolicyRule[];  // ordered; first match wins
}
interface PolicyRule {
  match: CommandMatcher;          // parsed-intent matcher, not regex-on-string
  action: "allow" | "deny" | "require_approval";
}
```

A command parser (POSIX shell via a shell-words parser for WSL/bash; a
best-effort PowerShell/cmd tokenizer for Windows) produces a
`ParsedCommand { program, subcommand, flags, args }`. Git destructive
operations (spec §11.2 list) ship as built-in deny matchers keyed on parsed
git subcommand + flags (`push --force`, `reset --hard`, `rebase`, …), so
`git -c x reset --hard` and `git reset --hard` both match. Built-in
`require_approval` classifiers cover spec §11.3: push/merge, network access
(curl/wget/npm publish/pip install…), global config, secret paths, remote
script execution. Unparsable commands default to `require_approval`.

Path policy: adapters receive an allowlist of the worktree root and deny rules
for `.jaira/**` — **not** because it is outside the worktree (it usually is not;
see §1g item 5) but because the deny rule is the actual enforcement — enforced natively
where possible (SDK permission callback on file tools; Claude Code permission
rules) and by prompt-level instruction elsewhere, honestly reflected in the
adapter's capability flags.

### 10.2 Approval Flow

`require_approval` decisions surface as engine-level approval requests in the
UI approvals inbox — deliberately **not** workflow UI states (they are
per-command, provider-initiated, and unpredictable), while workflow-level
gates (merge/deploy decisions) are ordinary UI states per spec §11.4. The
agent run stays `running` with the tool call suspended (SDK callback pending /
hook awaiting the loopback response) until the user decides. Every requested,
executed, blocked, and approved command lands in `command_log`, satisfying the
run-record requirements of spec §10.2.

## 11. UI Design

### 11.1 Views

- **Board**: columns = visible child states of the current level, cards =
  tasks whose active path passes through that level. Root board shows
  top-level workflow states. Double-click a card whose active state has
  children → sub-board (breadcrumb navigation back up). Card badges: status
  (running/waiting_for_user/blocked/failed), pending-approval indicator.
- **Task detail** (side panel): active path, instance tree with statuses,
  live runner event stream, artifacts list (markdown preview), conversation
  viewer, run history timeline (from `events`), cancel/retry controls.
- **Pending-input surfaces**: UI-component modal/panel rendering §7.1
  components; approvals inbox for §10.2 command approvals.
- **Workflow browser** (MVP-minimal): read-only tree of state files with lint
  results; editing happens in the user's editor, JaiRA watches and re-lints.

### 11.2 IPC Contract

Hand-rolled typed contract in `@jaira/shared` over `ipcMain.handle` /
`invoke` + a push channel (`webContents.send`) for engine events. Zod-validated
at the boundary on both sides. Board state is a subscription: the renderer
subscribes to task/instance change events and maintains a local store
(Zustand); no polling.

## 12. Task Lifecycle and Board Semantics

- Task creation: title/description (+ optional issue artifact), workflow root
  state, optional branch binding → `.jaira/tasks/<id>.json` + `task_runtime`
  row, status `queued`.
- Start: snapshot workflows (§5.3), materialize worktree if bound (§9.2),
  create root instance, enqueue `task.start`.
- Task status is derived from its instance tree (running > waiting_for_user >
  blocked > failed …) so the board never disagrees with the engine.
- Subtasks (spec open Qs #9/#10, MVP position): spawning a subtask is an
  engine API a UI state or user action can trigger; subtasks are independent
  tasks with a `parent_task_id` link and **do not block parent completion by
  default**. A parent workflow that wants to wait models it explicitly with a
  `waiting_for_event` state keyed on subtask completion (post-MVP; MVP ships
  the link + board grouping only).
- Cancel: `task.cancel` cancels all running operations (adapter `cancel()`),
  marks instances `canceled`, terminates the root with `terminate.canceled`.
- Pruning (spec §13): a prune job deletes `events`/`operations`/`transitions`
  rows and conversation artifacts older than a cutoff, **skipping** any row
  reachable from a non-terminal task's active instances (the resume-safety
  rule, enforced by query, with FK integrity checks in tests).

## 13. Testing Strategy

- **Expression language**: exhaustive unit tests including PENDING propagation
  and undefined-access semantics.
- **Engine**: golden scenario tests driving the reducer with a `FakeRunner`
  and scripted UI submissions against fixture workflows — including the three
  spec examples (§7.3 critique, §9 planning loop with sequence reset, §10.4
  fan-out join) as executable acceptance tests. Determinism of the reducer
  makes these stable.
- **Crash recovery**: kill-and-restart tests around each transaction boundary
  (property: post-restart state ≡ pre-crash state or one committed step ahead).
- **Adapters**: contract test suite every adapter must pass (structured output
  channels, repair loop, cancel, policy events) using a stub provider; the
  Claude CLI adapter additionally tested against a fake `claude` executable.
- **Policy**: table-driven tests of the command parser vs. the spec §11.2/§11.3
  lists, including evasion shapes (`git -C x reset --hard`, `sh -c "…"`).
- **E2E** (thin): Playwright against the Electron app for board navigation,
  one UI component round-trip, and one approval flow.

## 14. Implementation Phases

> Revised per §1a — the original phases 1–4 (expression language, loader,
> engine core, `llm_api` runner) are complete in the declarative-ai repo. JaiRA's
> build starts here:

1. **Adopt declarative-ai + scaffold** — ✅ done (§1b, migrated §1c) — monorepo
   (`shared/`, `app/`, `persistence/`, `cli/`), `file:` links to the sibling
   `declarative-ai` packages, typecheck + vitest. *Milestone met: the spec §9
   planning workflow runs headless via `jaira run` through
   `@declarative-ai/hw` with a fake prompt executor and scripted interactive
   functions.*
2. **Task model + durable persistence** — ✅ done (§1b, migrated §1c) —
   `.jaira/` layout (§3), task JSON files + SQLite (§4) recording `EngineEvent`
   streams, snapshots via `@declarative-ai/hw` `snapshotHash`, task lifecycle
   (create/start/cancel/status/list), workflow-level crash recovery (§4.3
   note).
3. **Electron app** — ✅ done (§1d, §1e) — board/sub-board projection, task detail
   with live event stream, task creation. *Milestone met: the planning workflow's
   tasks appear in the column their active path runs through, on the board and via
   `jaira board`.*
4. **Interaction + approvals** — ✅ done (§1f) — the five UI components (§7.1) as
   renderer-backed **interactive host functions** in the capability registry
   (§1c item 4); approvals inbox scaffolding (§10.2). *Milestone met in full: the
   critique workflow's human review gate runs end-to-end in the app, and the
   workflow was verified against real Claude (§1h).*
5. **Git isolation + WSL** — ✅ done (§1g) — worktrees, branch binding, Exec/WSL
   layer (§9). *Verified against a real WSL distro and real git repositories.*
6. **Process executors + policy** — ✅ done (§1i) — `@declarative-ai/agents-api` /
   `agents-cli` registered as runtime entries; the policy engine and command parser
   (§10.1) compiled onto `@declarative-ai/permissions`; per-command approvals with
   the `command_log` audit trail; capability gating (§8.2). *Agents are verified
   against a fake `AgentQuery`; a run against the real SDK or `claude` binary, and
   the approvals dialog, remain open (TODO.md).*
7. **Breadth** — `claude-cli` (hook loopback) and `generic-cli` executors,
   conversation `summary` mode (summarizer via `llm-call`), pruning UI,
   workflow browser/lint surface.

Phases 1→3→4 each end in a demoable milestone; the phase-1 headless CLI path
remains the fastest debugging surface permanently.

## 15. Resolved Open Questions (spec §15)

| # | Question | Resolution |
| --- | --- | --- |
| 1 | Artifact location | Reserved `jaira-artifacts/`, overridable in project config |
| 2 | State file extension | `.json` inside `.jaira/workflows/` (directory already scopes meaning) |
| 3 | Omit `id`? | Yes — derived from path; if present it must match (validator error otherwise) |
| 4 | Minimum UI components | The spec's five: choose_option, review_artifact, edit_markdown, fill_form, confirm_action |
| 5 | First agent provider | Claude Agent SDK, then llm_api, then Claude Code CLI, then generic CLI (opencode/codex) |
| 6 | Partial progress | Normalized `RunnerEvent` stream per adapter (§8) |
| 7 | Validation timing | Live lint + on save (advisory); enforced at task start (§5.2) |
| 8 | Task DB format | Hybrid: SQLite for execution, JSON files for task metadata (§4) |
| 9 | Subtasks vs parent completion | Linked but independent; explicit wait states post-MVP (§12) |
| 10 | Subtasks block parent? | No, by default (§12) |
| 11 | Skill format | `.jaira/skills/<name>/` with `skill.json` + `prompt.md`, executed through agent runtime (§7.4) |
| 12 | Branch binding | At task creation, by the user (§9.2) |

## 16. Risks

- **Policy fidelity varies by runner.** Mitigated by capability flags +
  gating (§8.2) — the system is honest about enforcement strength rather than
  pretending uniformity. `generic-cli` runners start policy-weak by design.
- **PowerShell command parsing is heuristic.** Unparsable ⇒ require_approval
  is the safe default; WSL projects get the robust POSIX parser.
- **Claude Code hook loopback (approval flow) is the most intricate adapter
  plumbing.** Sequenced last among the Claude adapters (phase 7); the SDK
  adapter covers the same provider with a clean callback in phase 4.
- **PENDING semantics are novel.** Confined to one evaluator module with
  exhaustive tests; the spec's §10.4 example is an acceptance test.
- **WSL path mapping edge cases.** All mapping through one `PathMapper` with
  table-driven tests; WSL support lands in phase 6 after the engine is stable.
