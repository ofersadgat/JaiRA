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
| Artifact location | `.jaira/system/artifacts/`, overridable per project |

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
3. **Conversation mode `summary` degrades to `full_history` IN HW** — the engine has
   no summarizer of its own and says so. JaiRA supplies one as a `SessionStore`
   decorator (§1k); the schema accepts all four modes per SPEC §4.7.

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
   (+ optional issue artifact); generalized: `.jaira/system/tasks/<id>.json` stores an
   `inputs` object fixed at creation and passed to the workflow root on every
   run (the §9 planning workflow's `issue` input rides in it).
4. **Single-owner recovery.** Recovery runs on every project open: any task
   `running` at open time is marked `interrupted` (its open runs closed),
   since v1 assumes exactly one process owns a project's `.jaira/` at a time.
   A second process opening while a run is live would falsely interrupt it —
   acceptable headless; phase 3 must add ownership (app holds the project, CLI
   defers or locks).

   > **Fixed 2026-07-28 by §4.2a — the reasoning is kept because it explains the
   > shape of the fix.**
   > SQLite is not the constraint — WAL handles concurrent processes fine. The
   > constraint is that a `running` row carries **no liveness signal**, so at open
   > time "the writer crashed" and "the writer is another live process" are
   > indistinguishable. Given that ambiguity, recovery must pick a failure mode:
   > assume-crashed (a live run is falsely interrupted) or assume-alive (a genuinely
   > crashed task is stuck `running` forever, with no path back). v1 picked the
   > recoverable one.
   >
   > That half is now fixed, though not the way this note proposed: the claim lives
   > in a separate `jobs` table rather than as columns on the run row (§4.2a
   > explains why), and identity is a per-process token rather than a pid.
   >
   > Of the "expensive half", **cancel also fell out of it** — `cancel_requested_at`
   > is a flag the owning process polls, so no channel is needed. What remains is
   > **parked requests**: the interaction and approval hubs live in the process
   > driving the run, and answering a gate means routing a *value* back, not raising
   > a flag (TODO.md).
5. **Cancel is in-process only for live runs.** `jaira task cancel` records a
   terminal `canceled` for queued/interrupted/stale-running tasks; a live run
   is canceled by SIGINT in the owning process (engine abort → `canceled`
   recorded on the way out). A cross-process cancel channel arrives with the
   app (phase 3).
6. **Snapshot format** (§5.3): `.jaira/system/snapshots/<hash>/` holds the bundle's
   transitive closure as authored state files (loader-derived `id` stripped —
   hash-neutral) plus a `.meta.json` carrying the root id; written to a
   staging dir and renamed (crash-safe); re-hashed and verified against the
   directory name on load.
7. **The scripted fake executor and scripted InteractionPort are shipped CLI
   features** (`--fake <rules>`, `--interactions <responses>`), mirroring
   ai-exec's test fakes — not test-only code. This is the permanent headless
   debugging surface (§14 closing note). Real providers use `settings.json`'s
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
   permission concerns are fields of `operation` — every one of them is a
   per-call decision, and a sibling block bought only a second place to look.
   `environment` is then the DEFAULTS layer: an `operation` with every field
   optional, inherited by this state and every descendant, nearest layer winning
   (WORKFLOWS.md §5). A state id is a path reference with `$JAIRA/workflows` as
   its default root (§2.1), and `sequence` is optional — absent means the order
   the children were declared in (§6). [REFERENCES.md](REFERENCES.md) settles the
   next step: one reference type covering ids, bindings, expressions and prompt
   variables, with document references resolved as load-time transclusion.
   Designed, not implemented.
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
4. **Native-module ABI is a two-runtime problem** (a real trap, now removed).
   `better-sqlite3` is a V8-ABI addon, so a single build cannot serve Node 22
   (`NODE_MODULE_VERSION` 127) and Electron 33 (130). It was swapped per runtime,
   which meant remembering to swap before every switch between the tests and the
   app — and finding out you had not from a stack trace. Both builds are now kept
   at once (`scripts/nativeAbi.mjs` caches them under the package's own
   `build/abi/<abi>/`, prebuilt, so no compiler is needed) and `openDb` names the
   one matching `process.versions.modules` through better-sqlite3's
   `nativeBinding` option. Nothing is swapped, so the two runtimes stop contending
   for one file and can run concurrently. A miss falls back to the package's own
   binary, which is what an installed copy of the CLI has and all it needs.
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
   `review_artifact` return `{ decision, comments? }`, `edit_artifact`
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
   at once. This is why the derived sequence needed the jump-hold: once EVERY state
   with children has a sequence, a state whose children are alternatives would
   otherwise start all of them the moment a transition entered one. Ordering is dataflow-driven (SPEC §10.4): a child whose inputs
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
7. **A model is only required when a workflow actually calls one** — and even then
   it is CHOSEN rather than demanded (§8.3). `modelDefaults` used to refuse any run
   without a configured model, which wrongly rejected a workflow made entirely of
   function states (host code, UI gates, agents); it then went on wrongly rejecting
   a prompt workflow on a machine with a working `claude` and no API key, which is
   the setup an agent exists for. It now picks a usable provider route, else an
   enabled agent, and refuses only when neither exists.
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

9. **A tool set is what makes policy apply to an agent at all.** An agent calling
   its *own* built-in shell is invisible to us, so JaiRA registers `bash` in
   `registry.tools`: an injected tool call goes through `withPermission` → the
   compiled policy → the parser → allow/deny/ask. The tool runs commands through the
   same `Exec` seam as git, and names its interpreter explicitly (`bash -lc` for
   WSL, `powershell -Command` otherwise) rather than letting Exec spawn a shell —
   which also keeps the interpreter consistent with the dialect the policy *parsed*
   the command with. It declares `readOnly: false`, so `read-only`/`plan` profiles
   exclude it outright.
10. **`run_command` lets a state run a command without an agent** (a build, a test
    suite) and **gates itself**: the engine wraps registered *tools*, but a host
    function is called directly, so a command runner that skipped the policy would be
    a hole straight through it. It reuses upstream's `withPermission` rather than
    re-deriving the decision.
11. **Verified live where it counts.** The approval dialog was driven by a real
    policy escalation (`git push --dry-run` → "pushes publish work") and
    screenshotted; the `claude-cli` adapter ran against the real binary (v2.1.142),
    returning its text with a provider-reported cost — which also confirms upstream's
    `cliQuery` flags and stream-json shape, still marked "UNVERIFIED against a live
    CLI" there. That run is preserved as an opt-in test (`JAIRA_LIVE_AGENT=1`) that
    skips by default because it spends money.

Still unverified in phase 6: the SDK agent adapter (needs
`@anthropic-ai/claude-agent-sdk` installed) and tool injection over the MCP bridge
(TODO.md).

## 1j. Status Update — 2026-07-28 (phase 7: breadth)

The last of §14. 313 tests. What phase 7 settled:

1. **History pruning is enforced by the query, not by the caller** (§12, SPEC §13).
   `pruneHistory` only ever considers runs that have *ended*, belonging to tasks in a
   *terminal* status, and keeps each task's latest run by default. That is stricter
   than §12's "skipping any row reachable from a non-terminal task's active
   instances" — deliberately, because the `events` journal **is** JaiRA's resume and
   projection source (§1b item 2), so a `running` or `interrupted` task's history is
   load-bearing in full, at any age. Refusals are returned as data (`skippedTasks`
   with a reason) rather than silently omitted, and every surface is **dry-run
   first**: `jaira prune` needs `--apply`, and the app's panel previews before it
   deletes. Deleted history does not come back.
2. **The workflow browser is built to describe a broken directory** (§11.1). The
   author edits state files in another window, so at any instant one may be
   half-saved or reference a state that does not exist yet. Every failure comes back
   as data — a per-file parse error, a per-workflow `loadError`, lint issues from
   `validateBundle` with `strict: true` (the mode its own docs reserve for a lint
   surface). Roots are *derived* (a state no other state names as a child), and
   states that no root reaches are reported rather than vanishing, which is what
   makes a reference cycle visible. `AppService` watches `.jaira/workflows/` and
   pushes a `workflows` invalidation, so §11.1's "JaiRA watches and re-lints" is
   real; recursive watching is unavailable on some platforms, so a watch failure
   degrades to on-demand browsing rather than breaking the app.
3. **Conversation `summary` mode needed no engine change.** The engine reads a
   session's transcript from `ctx.services.sessions` and notes that "an app store
   wins", so JaiRA supplies a `SummarizingSessionStore`: once a conversation passes a
   budget, its older turns are replaced with one summary turn produced through the
   run's *own* prompt executor (so a scripted run stays scripted). Three properties
   are load-bearing — only sessions whose states declare `summary` are compacted (a
   `full_history` state means it), a failed summarization keeps the full conversation
   (an expensive run beats a run that forgot what it was doing), and the most recent
   turns stay verbatim. This is the fix for §1h item 1's measured 232 → 42,828 token
   growth. **Compaction is per session, not per state**: one session has one
   conversation, so a session mixing the two modes is summarized for both, and the
   workflow browser warns about it. ⚠️ Rebuilt on the position model — see §1k.
4. **`generic-cli` is registered honestly, and therefore usually refused.** A
   non-Claude binary (opencode, others) reaches JaiRA through the same normalized
   `AgentQuery` seam, driven by JaiRA's own Exec layer so a WSL project runs it inside
   the distro. Its capabilities declare `policyEnforcement: "none"`, because no
   callback reaches `ctx.approve` and there is no flag vocabulary to translate a deny
   list into — which means §8.2's gate refuses it under any policy that can escalate,
   and SPEC §11.3's built-in classes all can. Running one is therefore an explicit
   `policy.builtins: false` decision. That is §16's "generic-cli runners start
   policy-weak by design" turned into enforcement instead of a caveat.

   **Codex is the exception, and it is why the honest record pays off.** `codex-cli`
   is its own adapter upstream (`@declarative-ai/agents-cli`), not a `generic-cli`
   configuration, because it can do something a generic binary cannot: pin a sandbox
   (`sandbox_mode = read-only | workspace-write | danger-full-access`) on every run,
   whatever `~/.codex/config.toml` says. So it declares `policyEnforcement: "config"`
   — weaker than `callback`, real all the same — and §8.2 lets it run. What it cannot
   honour it REFUSES: a per-tool deny list and a native allow-list have no expression
   in `codex exec`, and dropping either would leave a workflow believing in a floor
   that is not there. **Injected tools are refused too**, on evidence rather than
   caution: codex reaches the same MCP bridge the `claude` adapter uses, is offered
   the tool, and then auto-denies the call, handing the agent the string `user
   cancelled MCP tool call` — which it would report as its answer, successfully. That
   is what keeps the `config` claim narrow: codex works from its own built-ins under
   the sandbox, and JaiRA's policy-gated tools are not in its reach. It also splits
   `sessionResume` from `sessionFork`: `codex exec resume <id>` appends server-side and
   there is no fork primitive, so a branch is replayed. See SESSIONS.md §6.
5. **`claude-cli`'s hook loopback was already there.** §16 sequenced it last as "the
   most intricate adapter plumbing", but upstream's CLI adapter routes each gated
   tool-use back over the MCP bridge via `--permission-prompt-tool` — that *is* the
   loopback, and it is why the entry declares `policyEnforcement: "callback"`. Phase 6
   registered it; phase 7 only confirmed the mechanism.

Three silent bugs surfaced while wiring this, all recorded in TODO.md. The one worth
repeating here: **`gateCapabilities` matched nothing at either call site**, because it
read the loaded `operation.functionRef` while both callers pass `bundle.source`, where
the authored field is `function`. §8.2's capability gate had been passing every run by
never firing. It now reads either spelling. The other two: the CLI never registered
agent runtimes at all (so an agent workflow ran in the app and failed headlessly), and
a capability refusal after `beginTaskRun` left the task `running`.

Two authoring facts this phase pinned, both easy to get wrong and both silent:

- An **operation input is a parameter with a `binding` field** (`{ kind: "text",
  binding: ".inputs.x" }`), whereas `children.<key>.inputs` values are *bare*
  bindings. Authored the child way, an operation input resolves to empty — an agent
  runs with no instruction and reports success.
- A delegated agent returns **one string**, so its output slot must be `blob`-kind.
  The engine fills exactly one produced slot from a whole-value blob output; a `json`
  output is read as a record of named outputs, and the state fails with "did not
  produce required output".

## 1k. Status Update — 2026-08-01 (one grammar; sessions as positions; compat removed)

Four changes that turned out to be one change, plus the gap the last of them exposed.
427 tests green; declarative-ai at 1334.

1. **One grammar: a leading dot is data, a bare name is a document.** An expression
   needed an `{ expr }` wrapper to be a binding, while `".inputs.issue"` did not —
   for no reason a reader could name. Both facts came from the same gap: a dotted
   path is legal in either grammar and nothing said which one it was. One rule now
   settles it at every depth, so a binding string and an expression string are the
   same language:

   ```jsonc
   "binding": "add(.children.a.outputs.n, 1)"
   ```

   This REVERSES REFERENCES.md §5, which made the dot optional inside `{ expr }`
   because "an expression can only ever address runtime space" — true when written,
   untrue since a call gained a callee resolved along the `path`. See
   EXPRESSIONS.md §14 for the design, including the false dichotomy the first two
   attempts shared.

   The cost was ~260 sites and the discipline is worth recording: `.inputs.n` lowers
   to precisely the tree `inputs.n` used to, so **the dataflow analysis did not
   move**. A syntax change that reaches fan-out or reachability has gone wrong.

2. **Compatibility spellings removed** — nothing has released, so they were pure
   cost. The four tagged binding forms (`{child}`, `{input}`, `{artifact}`,
   `{conversation}`) are gone; `{expr}` stays as emphasis, not as a second
   mechanism. `sessionId` as a synonym for `session` is REFUSED rather than
   dropped, because it is not in `OPERATION_OWN_FIELDS`: ignoring it would ship the
   author's session declaration to the model as a call parameter while the operation
   quietly started a fresh conversation.

3. **JaiRA never composed a session layer, so conversations did not exist.** The
   engine stopped writing transcripts when a session became a position — "a run with
   no session layer composed records nothing, and the transcript stays empty."
   Nothing in JaiRA composed one, so every preamble was empty, every conversation
   read was empty, and summary mode was inert. `executeWorkflow` now wraps the
   prompt executor in `withSessionPosition(withRecord(...))`, and composes it THERE
   rather than in each caller because the two halves must be one store.

   `withSessionPosition` (exec) rather than `withSession` (promptop): the engine
   states a REQUEST on `ctx.sessionRequest` rather than putting a session id in the
   op's config, since it cannot know where a conversation currently is. `withSession`
   reads the op config, so composed here it would find nothing and do nothing.

   `ScriptedFakeExecutor` reports its delta on the declared `session` channel. A real
   prompt executor's payload already carries the messages; a fake's does not, and
   without it a scripted run records positions holding nothing — silent in exactly
   the runs meant to exercise conversations.

4. **Summary mode rebuilt on positions.** There is no `put` any more, so compaction
   moved to `resolve` — not a workaround: resolve decides which conversation a call
   will use, which is what compaction answers. It also runs on `messages`, and that
   is what makes the feature do anything, because the engine builds its preamble
   from `messages()` BEFORE dispatch; compacting only at resolve would inline the
   full transcript and compact immediately after, paying the cost and missing the
   saving. Compaction MINTS a conversation rather than rewriting one, per the
   store's own contract.

   The per-lineage chain records what each compaction went FROM as well as TO.
   Serializing alone is not enough: two calls racing on one ref must land on a single
   compacted conversation, while a LATER call arrives further along that lineage and
   must compact from its own position rather than be dragged back to a stale one.

5. **`.conversations.<name>` was already dead, and read as working.** The engine
   mirrors transcripts under the session's ID — a position, `planning@3` — while the
   namespace looked up the literal name. That matches only before any call has
   happened, so from the first call the lookup missed and the resolver refused with
   "conversation 'planning' is not available". A conversation is now read by REF:

   ```jsonc
   "when": "at(messages(.operation.output.session), -1).content === 'continue'"
   ```

   Reading a SIBLING's conversation flows as data — the parent wires
   `.children.plan.operation.output.session` into a child's input — because there
   is no name to look one up by. That is the point rather than a cost: an operation
   that declared no session never had a name, and was unreadable.

**Open.** `conversationModesOf` still maps a state that declares no session to the
name `"default"`, which nothing produces now — an undeclared session is a fresh
per-instance stream. Summary mode therefore never fires for one, which is the case
that grows fastest. The opt-in has to key on something other than an authored name;
`sessionRequest.seed` carries `<stateId>:<session.id>`, which is the available hook.

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
    settings.json           how this project runs (models, exec env, policy, artifacts)
    workflows/                state files (authoritative, user-edited)
      feature.json
      feature/plan.json
      feature/plan/critique.json
    skills/                   project skill library (§7.4)
    system/                   everything JaiRA generates — see below
      jaira.db                SQLite: all execution state and history
      snapshots/<hash>/       immutable pinned copies of workflow trees (§9)
      tasks/<taskId>.json     task metadata (human-readable half of hybrid storage)
      logs/                   the app's own diagnostics
      artifacts/<taskId>/...  default artifact root (§7.6)
      sync.json               the last agreed document ↔ workflow state (§11.2)
```

**One line runs through `.jaira/`, and `system/` draws it.** Beside it —
`workflows/`, `functions/`, `skills/`, `prompts/`, `settings.json` — is what a
person authors: hand-edited, versioned, and the thing a root is *for*. Inside it
is what JaiRA writes for itself: nobody authors it and nobody should have to look
at it. The two used to be interleaved, so a root showed a person three authored
directories next to a database, a WAL file, a snapshot cache and a pile of run
logs, with nothing in the layout saying which were theirs.

Most of `system/` is derived per-checkout state and is gitignored by name —
`jaira.db*`, `snapshots/`, `logs/`, `artifacts/`, `approvals.local.json`. Two
things in it are *not*, for different reasons. `sync.json` holds content hashes of
the description and the state files, so it means the same thing on a teammate's
machine as on this one — a genuinely shared record. `tasks/` is left unignored
only because it is small and hand-editable; it is **not** usefully committed,
since `taskSummaries` walks `task_runtime` and decorates from the file, so a task
file arriving through a pull with no row beside it is invisible. That is why the
ignore file names entries rather than the directory.

Worktrees live **outside** the project directory (agents are scoped to a
worktree that must not contain `.jaira/`):

```text
<project-parent>/.jaira-worktrees/<projectName>/<taskId>/
```

The engine maintains the worktree ↔ task mapping in SQLite. Artifacts anchor on
the **project's** `system/artifacts`, not the worktree's, so `git worktree
remove` does not take a run's output with it.

State files use plain `.json` extension; the state ID is derived from the path
(§15, Q2/Q3).

### 3.1 The shared base root

Behind every project on a machine sits one **base root**, `~/.jaira` by default
(`JAIRA_HOME` relocates it, and the app can save a different location in its
settings):

```text
~/.jaira/                     the shared layer; the same shape as a project's
  settings.json               defaults every project inherits (same file, layered under)
  user-settings.json          this person's theme, fonts and layout — NOT project settings
  workflows/                  state files every project can reach
  functions/                  operation documents every project can reach
  skills/                     shared skill library
  .env / .env.local           machine-local credentials (see §8.1); a project's
                              own pair sits in <project>/.jaira, ahead of these
  system/                     everything JaiRA generates for this root
    jaira.db                  the root's runs (see below)
    snapshots/                pinned versions of the workflows they ran
    tasks/                    their task files
    logs/                     the app's own diagnostics
    artifacts/                what those runs produced ($ARTIFACT_DIR under $SYSTEM)
    sync.json                 the last agreed document ↔ workflow state
    approvals.local.json      what this disk has agreed to run (§7.5.5)
```

The base has no `.jaira/` inside it — it *is* one — so `system/` sits directly
under the root, which is what makes the two layouts the same shape one level
down.

It holds the **authored** things every project can reach and, since JaiRA gained
workflows of its own, a database beside them. This amends the rule that stood here. It read: *"There is no database and no
snapshot cache here: runs belong to a project, and putting one machine's history
behind every project would be a shared mutable pile with no owner."* The
reasoning is still right; the conclusion stopped following. JaiRA runs workflows
of its own — the description sync (§11.2), summarization, the conformance check
— and **those runs have an owner. It is this root.** Their alternatives were a
user's project, where they appear on a board nobody put them on and take
worktrees nobody asked for, or nowhere at all, which is what they had, and why a
failed sync could not be read back afterwards.

So it is a pile with an owner, and the ownership is enforced rather than
asserted:

- **A task created here may not name a branch.** `createTask` refuses one, so a
  run recorded here can never take a worktree. `worktreesDir` is the single field
  `baseAsProjectPaths` still fabricates, and nothing resolves it.
- **It is never the focused project.** A window with no project open answers
  "list the tasks" with nothing, not with one of these — which is the whole point
  of separating them. Each is reachable only by naming it.
- **It opens on first use, not at startup.** Someone who never runs a sync never
  gets a database. The failure of that open is reported rather than fatal.

**One owner, not two.** This pile briefly had two, on the argument that it was
holding two kinds of run with different lifetimes: `"shared"`, the selected root
as a project, whose runs a root switch is *supposed* to leave behind; and
`"system"`, JaiRA's own, pinned to the installation so that a description sync's
history survived exactly that switch. The lifetimes really are different. The
split still cost more than it bought — two databases inside one root, two boards
in the Tasks view, and a `system/` directory that meant "JaiRA's project" in one
breath and "JaiRA's generated files" in the next.

So: **one root, one project.** `"shared"` is the only reserved project ref, it
holds both kinds of run, and `system/` means only the second thing. It refuses a
branch, because the directory is not a checkout. It appears in the Tasks view as
its own group, after the checkout you are working in.

Everything derives from one list — the **layer roots**,
`[<project>/.jaira, ~/.jaira]` (`jairaPaths().roots`):

- **`$` searches the layers.** `$/lib/review` resolves to `<root>/lib/review`
  for each root in turn, first match wins. This is what makes the *fragments* a
  state is assembled from — prompts, types, guards, operation documents — layer
  exactly as whole states do; without it an override model would cover state
  files and nothing inside them. A *named* root still pins one place:
  `$JAIRA/lib/review` is this project's, `$BASE/lib/review` is the shared one.
- **Bare state ids search the generated path.** `<root>/workflows` then
  `<root>/functions`, per root, in root order — so `config.workflows.path` is
  absent by default and adding a layer is one entry in `roots` and nothing else.
  A match at *any* entry keeps its bare spelling, so the project's
  `feature/plan` and the base's are one id, the project's shadowing the base's.
  That is what makes a project file an **override** rather than a
  differently-named second state. See EXPRESSIONS.md §4.1 for the identity rule
  this replaced and why.
Configuration layers separately, by **document merge**: `~/.jaira/settings.json` is
merged *under* `.jaira/settings.json` before parsing, so validation sees exactly
what a run will use. Objects merge key by key (a project setting only
`models.default` keeps the base's `agents` and `policy`); arrays replace
(concatenating `workflows.path` would leave a project no way to remove an entry);
and `agents.genericCli` merges by name, since it is really a keyed map.

An absent base root is an empty layer, so a machine that has never had one
behaves exactly as it did before this existed.

## 4. Persistence (Hybrid Model)

### 4.1 Source-of-Truth Split

- **Task metadata → JSON file** `.jaira/system/tasks/<taskId>.json`: title,
  description, labels, workflow root state ID, branch binding, parent task,
  created date. Human-readable and hand-editable while the task is not running.
  There is no watcher and none is needed — `tryRead` reads the file on every
  summary, so an edit appears on the next refresh.
  **Not built:** rejecting edits to a running task's execution-relevant fields
  (workflow, branch) with a UI warning.
  **The db is the index, not the directory.** `taskSummaries` walks
  `task_runtime` and decorates each row from its file, so a file with no row is
  invisible and `TaskFileStore.list()` is called from nowhere. The file buys
  hand-editing; it does not buy a task that survives being copied somewhere else.
- **Execution state → SQLite** `.jaira/system/jaira.db` (WAL mode): everything the
  evaluation loop reads or writes. The DB references tasks by ID only and never
  duplicates metadata fields.

Rule: if the evaluator needs it to make a decision, it lives in SQLite. If a
human needs to read or edit it casually, it lives in the JSON file.

> **Superseded as a fixed rule by §4.4.** The split above is the DEFAULT, not the
> law: which concerns live in files and which in tables became configuration, on
> the argument that git cannot merge SQLite and the right answer therefore differs
> between a shared base root and a checked-in project. §4.4 also retires the two
> justifications this section leaned on — neither survived checking.

### 4.2 SQLite Schema (core tables)

> **Rewritten 2026-08-12 (CHANGESETS.md §5.1) to journal-as-truth.** The system
> has an irreducible pair — the journal records *that* operations ran, a payload
> store records *what they returned* — and everything else is a projection of
> those two. The earlier claim here that "the materialized tables are the resume
> source" said the opposite of what is true and is reversed below.

```sql
task_runtime         (task_id PK, status, snapshot_hash, branch, worktree_path,
                      root_instance_id, created_at, updated_at)
state_machine_events (seq PK AUTOINCREMENT, task_id, run_id, instance_id, type,
                      payload_json, created_at)
                      -- BUILT (rename of 'events', CHANGESETS.md §5.1): the append-only
                      -- EngineEvent journal. LIFECYCLE TRUTH, and nothing else rides in it:
                      -- instance.*, operation.* (metrics, no payload), transition.taken,
                      -- child.superseded.
operation_records    (id PK AUTOINCREMENT, record_id, task_id, run_id, attempt,
                      status,                       -- open | completed | failed
                      request_json, result_json, error_json, metrics_json,
                      session_outcome_json, provider_session_id,
                      started_at, ended_at)
                      -- BUILT: the per-attempt operation record this section always promised,
                      -- finally under the name. One row per attempt, EVERY operation — the
                      -- dispatcher records unconditionally (CHANGESETS.md §5.2).
session_positions    (session_id, seq, operation_record_id,
                      PRIMARY KEY (session_id, seq))
                      -- BUILT: conversation membership. The primary key IS the position claim;
                      -- a duplicate insert is PositionTaken → fork, never a race.
artifacts            (id PK, task_id, run_id, logical_path, physical_path, content,
                      hash, bytes, format, instance_id, state_id, slot, created_at)
                      -- BUILT (§7.6): logical_path is what the producer said it wrote,
                      -- physical_path where the bytes went. UNIQUE(task_id, logical_path).
jobs                 (id PK, kind, task_id, run_id, parent_job_id, owner_token, pid,
                      command, started_at, heartbeat_at, cancel_requested_at,
                      ended_at, outcome)   -- BUILT (§4.2a): process claims + children
command_log          (id PK, task_id, run_id, tool, command, parsed_json,
                      decision,                     -- allowed | blocked | approved | denied
                      decided_by, reason, scope, session_id, created_at)  -- policy | user
```

Notes:

- **The journal is the truth; projections are views.** The instance tree the
  board draws, transitions, sequence cursors — all recomputed from
  `state_machine_events` (`projection.ts`). `instances` and `transitions` as
  TABLES are demoted to *possible future caches* for step-level resume, not
  schema: adding them back would be an optimization, and they would be derived,
  never authoritative.
- **Neither table is derivable from the other.** `operation.completed` carries
  metrics and no payload, so the journal cannot answer "what did it return";
  the record store does not order lifecycle, so it cannot answer "what happened
  around it".
- `conversations` is **struck** — superseded by the sessions model
  (SESSIONS.md): a conversation IS the records claiming positions under one
  `session_id`, ordered by `seq`, with lineage in the `sessions` table. A
  separate conversations table would be a second store of the same truth.
- A record with no `session_positions` row is an UNPLACED call — a pure helper,
  an embedded expression call. It pollutes no transcript; retention is the
  pruning surface's question (CHANGESETS.md §10.5).
- Sequence-reset clearing (spec §3.3) is `child.superseded` in the journal;
  expression resolution ignores superseded instances, which implements "clears
  the recorded results." History is preserved (spec §13).

### 4.2a The `jobs` Table — Process Claims and Liveness (decided and built 2026-07-28)

Replaces the "put a pid + heartbeat on the run row" sketch in §1a item 4. A run
and a *claim on* a run are different things and belong in different tables:

- a **run** is history — durable, meaningful long after the process is gone,
  read by the board and the detail view, pruned on its own schedule;
- a **job** is a live process's claim — meaningful only while that process
  breathes, and worthless the moment it doesn't.

Columns on `runs` would mix a fact about the past with a fact about *now*, leave
dead pid/heartbeat fields on every historical row, and overwrite the previous
claim each time a task is re-run.

```sql
jobs (id PK AUTOINCREMENT,
      kind,               -- 'run' | 'process'
      run_id      → runs(id),      -- the run this job serves
      task_id,
      parent_job_id → jobs(id),    -- a child process points at its owning run job
      owner_token,        -- random per PROCESS: identity without pid semantics
      pid,                -- for reporting and (carefully) killing orphans
      command,            -- what a 'process' job actually is
      started_at, heartbeat_at,
      cancel_requested_at,
      ended_at, outcome)
```

**Liveness is a query, not a rule.** A `run` job whose `heartbeat_at` is older
than the stale threshold has no live owner. Recovery becomes: for each `running`
task, is there a live job? No ⇒ interrupt it. Yes ⇒ leave it alone. That is the
whole fix for the false-interrupt problem, and it lives in one place instead of
being an assumption baked into `recoverInterrupted`.

**Identity is a token, not a pid.** A pid is not an identity — after a reboot or
enough churn, pid 1234 is some other program. A random per-process `owner_token`
plus a heartbeat answers "is the owner alive?" without pid semantics at all. `pid`
is recorded only for the two things that genuinely need it: telling a human what
is running, and killing an orphan — and killing needs pid **plus** start time to
be safe, which is why v1 should *report* orphans and offer to kill rather than
auto-killing.

**Child processes are the strong argument, and were the thing missing entirely.**
JaiRA spawns real OS children — git, `wsl.exe`, `claude`, a `generic-cli` agent, a
`bash` command — and tracks none of them. If the app dies mid-run, an orphaned
agent keeps running, keeps spending money, and keeps writing to the worktree,
invisibly. Every child already goes through one seam (`runtime/exec.ts`), so
recording them is a change in a single place.

> **Layering:** `@jaira/runtime` must not import `@jaira/persistence` — the
> dependency runs the other way. `Exec` therefore takes an optional
> `onSpawn`/`onExit` observer that the app and CLI wire to the jobs store, rather
> than writing rows itself.

**It also buys most of cross-process cancel.** `cancel_requested_at` is a flag the
owning process polls: no socket, no daemon. That downgrades the "expensive half"
of §1a item 4 — *cancel* stops needing a routing channel; only **parked gates**
still do, because answering one means routing a value back, not just raising a
flag.

Cost, stated plainly: a heartbeat timer per owning process, and a stale threshold
that trades crash-detection latency against falsely reclaiming a live run (~5s
beat, ~30s stale is the sane starting point). Clock skew is ignored — v1 is one
machine.

**As built.** `RunOwner` (persistence) is the whole lifecycle in one place — claim,
beat, observe children, release — because the app and CLI have already drifted once
(§1j) and a claim only one of them takes would make recovery's answer depend on
which program started the run. `openProject` reads orphans *before* reaping, since
those rows are the only record the processes existed. Child tracking rides
`ExecObserver`, a hook on the one seam every child already passes through; the
`claude` subprocess needed JaiRA's own `SpawnProcess` because upstream's is
module-private, and that copy preserves two hard-won details — stderr **ignored**
rather than piped (an unread pipe fills at ~64 KB and the child blocks forever),
and an `error` listener (an unhandled one throws, and ENOENT on a missing binary is
the likeliest first run).

Verified across processes: with a live claim, a second `openProject` recovers
nothing and the task stays `running`; once the owner's heartbeat goes stale, the
next open recovers it to `interrupted`.

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

### 4.4 Storage Policy — files, tables, or both (built 2026-08-24)

§4.1 drew the file/table line **once, in code, for everyone**: task metadata is a
file because a human might edit it, everything else is a table. Two arguments
retired that as a fixed rule.

The first is that the reasons given for the file half did not survive checking.
"A snapshot must be reachable without the database" is false — the pointer is
`task_runtime.snapshot_hash`, so a lost database loses the snapshot too. "Task
files are meant to be committed" is false — `taskSummaries` walks `task_runtime`
and only decorates from the file, so a task file arriving through a pull with no
row beside it is invisible. What survived was thin: hand-editing, and one
baseline (`sync.json`) that genuinely means the same thing after a pull.

The second is that the choice is not the same for every root or every deployment.
A shared base root is one person's machine and wants a database. A project
checked into git wants files, because **git cannot merge SQLite** — and that, not
readability, is the whole argument. Sessions want files for a third reason
entirely: every other agent tool writes JSONL, and matching them makes JaiRA's
transcripts readable by things JaiRA did not write.

So it becomes configuration, in `settings.json`, and because that file is layered
the base can answer `db` while a project answers `file` with nothing extra.

**The file is the truth; the table is an index.** This is the load-bearing
inversion, and the reason is durability. If the table were a *cache* of the file,
something would have to flush it back, and every deferred flush policy loses the
journal on a crash — which is precisely the property `state_machine_events`
exists to have, since §4.3 replays it. Instead: a write appends to the file
synchronously **and** mirrors into the table in the same call; startup replays the
file into a `TEMP` table; nothing is ever flushed because nothing is ever only in
memory.

**The table half is built** (`persistence/src/shadow.ts`, applied in `openAt`
before any store is constructed). A `TEMP` table of the same name is created and
SQLite's name resolution does the rest — an unqualified name resolves to `temp`
before `main` — so the runtime has one read source and **not one query was
edited**. The DDL is copied out of `sqlite_master` rather than restated here, so
it tracks migrations and brings the generated columns and their indexes with it;
`main.<name>` still reaches the real table, which is what the seed reads.

Two things are dropped and one is not. **Foreign keys go**, because SQLite
resolves a parent within the child's own database, so a `TEMP` child pointing at
a `main` parent is not a weaker constraint but an error on every insert — the
honest statement is that choosing `file` gives up the referential integrity
SQLite was enforcing, which nothing could preserve once half the rows live in a
file git may have merged. **Nothing else goes**: primary keys, uniqueness,
defaults and `NOT NULL` are statements about a single row and survive, so
`session_positions`'s primary key is still the position claim — per connection
rather than across processes, which is exactly the trade above and the reason
`jobs` may never be file-backed.

Seeding the shadow from `main` when no file exists is the **flip path**, not a
stopgap: turning a concern from `db` to `file` has to start from the rows already
in the database, or the first open after the change would look like the history
had been deleted. Rowids come across explicitly, so a seed changes no identity — a
replay from a file is the case that cannot promise that, which is why nothing
points at a rowid any more.

```jsonc
// settings.json — layered, so the base and a project can answer differently
"storage": {
  "journal":       "file",   // state_machine_events
  "conversations": "file",   // operation_records + session_positions
  "tasks":         "file",   // task_runtime + the task metadata files
  "artifacts":     "db",     // the artifact map
  "format":        "claude"  // the session line shape: claude | codex
}
```

**Concerns, not tables.** A per-table map would let someone put
`state_machine_events` in a file and `operation_records` in the database, which
splits one run's truth across two stores with different durability and different
merge behaviour, and nothing would catch it. Four concerns, each mapping to its
tables internally.

**The allowlist is closed, and the omissions are refusals.** A `TEMP` table is
**per-connection**, so anything whose value is cross-process coordination cannot
be file-backed:

- **`jobs`** — owner tokens, PIDs, heartbeats. Cross-process liveness is its
  entire purpose (§4.2a), and it means nothing past a single run.
- **`job_output`** — debounced chunks of a child's stdout, written on the main
  thread. Nothing wants it in git.

`session_positions` was on this list and came off it. It does three jobs —
membership, fork lineage, and the position claim — and only the third is a
mechanism. The claim's cross-process guarantee is already provided *in front of
it* by the `jobs` claim, under the one-owner-per-project rule; and an append-only
session file expresses the claim at LOAD time anyway, because two lines claiming
`seq` 14 is exactly what a git merge produces and exactly the case the design
already answers by forking. The check moves from write-time to load-time and
keeps its meaning. It rests on `jobs` staying a table, which is why that one is
not negotiable.

**One file per run.** `system/journal/<taskId>/<runId>.jsonl`. This is what makes
"clean merges" and "shared history" stop being a trade: two people running tasks
write different filenames, so appends never conflict; and after a pull their run
files replay into the same journal table, so their runs appear on the board.
Pruning becomes a file delete rather than a rewrite.

**Built for the journal** (`persistence/src/journalFile.ts`): the recorder appends
the line and then inserts the row, in that order and synchronously — an event that
reached the table and not the disk would be an event a replay does not have, which
is the loss the whole inversion exists to refuse. A line is `type`, an ISO
`timestamp`, the run coordinates and the event verbatim; `seq` is deliberately
**not** in it, because it is `AUTOINCREMENT` and a file outlives the database that
assigned it. Line order is the order, replay re-mints, and files are read task then
run so a re-minted `seq` still orders a run's events in sequence and a task's runs
in the order they happened. A line that will not parse is skipped rather than
thrown — a git merge can leave a conflict marker mid-file, and one unmergeable line
should cost one event, not the history.

The journal keeps **JaiRA's own line shape** rather than an agent's, and `format`
does not apply to it. `instance.entered` and `transition.taken` are the state
machine talking to itself; dressing them as `{type: "assistant"}` to fit somebody
else's schema would be a lie told for a reader that would make nothing of them
anyway. `format` governs CONVERSATIONS, which is what those formats are for.

**Two formats, one reader.** Claude Code's line shape is the default —
`@declarative-ai/agents-api` already models it (`NativeLine`) and
`nativeCapture.ts` already reads it — with JaiRA's own fields carried under a
namespaced key that their reader ignores. `format: "codex"` selects Codex's
instead. **Reading accepts either regardless of the setting**, detected per LINE
rather than per file, because a project that changes `format` keeps appending to
the run files it already had and a merge can interleave two people who disagreed.

**Built** (`persistence/src/conversationFile.ts`), with one thing claimed and one
not. Claimed: every line carries the right envelope, so those readers walk the
file and keep JaiRA's rows whole (`nativeLinesOf` keeps unknown line types by
design). Not claimed: Claude Code's UI will not RENDER these as a conversation —
that needs each turn emitted as its own `{type: "user" | "assistant", message}`
line, which is a further step and one worth doing against a real session file
rather than from memory. The codex envelope is the right shape family and has not
been checked against a real rollout either. Both are in TODO.

The update problem is what makes this concern harder than the journal, and the
answer is that a line is the row's **current state, whole**, with replay keeping
the last line per key. No deltas and no in-place edits: a record that opens,
streams ten partials and settles writes twelve lines and replays as the twelfth.
It costs size and buys the property that matters — a file only ever grows, so two
people appending to one run conflict on nothing. Compaction, if it is ever wanted,
is a rewrite of a file nobody is appending to and needs no change to the reader.

**`both` keeps its index across a close, and checks it.** The file is still the
truth; the table copy simply persists so startup can skip the replay. It shipped
with no staleness check at all — a `git pull` moved the files under a persisted
index and nothing noticed — and now records a FINGERPRINT of what it was built
from: size and mtime per file, deliberately not a content hash, because the point
is to cost less than the replay it avoids and a checkout that changes a file's
bytes without changing either is not a thing git does. Wrong in the safe direction
either way: a fingerprint that fails to match costs one replay, which is what
would have happened without it.

So a file-backed concern picks one of three outcomes at open, in order: **reuse**
(`both`, and the fingerprint matches), **replay** (there are files — and under
`both` the result is written back with a new fingerprint), **seed** (there are no
files, so the concern has just been switched on and the history is still in the
database). The write-back empties children before parents: `main` keeps its
foreign keys even though the shadow drops them.

**Pruning deletes the files.** Not "drops them from the index" — the file goes. If
it was committed, removing it from git is the user's action, and JaiRA does not
touch the index on their behalf. The alternative (prune locally, file survives in
git) means a pruned run returns on the next pull, which is a prune that does not
prune. Built: `prune` removes each pruned run's file and `deleteTask` removes the
task's directory, both AFTER the rows and outside the transaction — a filesystem
does not roll back, and a journal file with no run row is recoverable noise where a
run row with no journal is a run whose history silently reads as empty.

**`system/` stops being gitignored**, which is the point of all of it: once files
are the truth there is nothing derived left to hide. Two exceptions survive, and
they are the two that motivated ignoring the directory in the first place —
`jaira.db`, now a rebuildable index and still an unmergeable binary, and `logs/`,
which is machine noise that conflicts on every line.

**The prerequisite is built (migration 8).**
`session_positions.operation_record_id` was a foreign key to `operation_records.id`,
an `INTEGER PRIMARY KEY AUTOINCREMENT` — db-assigned, and therefore re-minted on
every replay, pointing every position row at the wrong record, silently, because
the ids would all still be valid. It references the stable id now. That id already
existed: upstream's `withRecord` stamps `<sessionId>:<seq>` on a record that claims
a position and `hashOperation(op)` on one that does not, and both are stable
because operations are immutable. It is not unique on its own — an identical
operation dispatched twice hashes identically, which is why `attempt` exists — so
the key is `(task_id, run_id, record_id, attempt)`, carried as four columns on the
position row and enforced by `operation_records_natural`. The tuple rather than a
string built from it, because a delimiter-joined key would have to claim
`record_id` never contains the delimiter and nothing enforces that.

Three things fell out of it. For a PLACED record `record_id` is literally
`session_id:seq`, so those rows were carrying a rowid that duplicated the pair the
position table already keys on. The two DELETEs that used to reach through
`operation_record_id` with a subquery are now a `WHERE task_id = ?` and a
`WHERE run_id = ?`. And `derive` — which inserted its record with no `attempt` at
all and so always wrote 1 — now counts like every other writer; that was invisible
until the natural key became a key.

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
and copies the files into `.jaira/system/snapshots/<hash>/` if not already present
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
`inputs`, `outputs`, `children.<key>` (`outputs`, `outcome`), `artifacts`,
`conversations`, plus the guard-only scalars `run` (`iteration`) and `limits`.

> Revised (§1c): `params` and `ui` are gone from the context. Parameters folded
> into `inputs`, and a UI component's result is an ordinary state output — so
> guards read `outputs.*` uniformly, whatever produced them.

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

> **§7 as built.** A state has ONE `operation`, `prompt` or `function` (§1c item 1).
> The three subsections below were written when `ui`, `agent` and `skill` were
> separate operation kinds; each now describes a *shape of function*, not a shape
> of state file. WORKFLOWS.md is the authoring reference.

### 7.1 UI Operations

**As built:** a UI state is a `function` operation whose registered
implementation is *interactive* (§1c item 4). No `pending_ui` table exists — the
function is registered by the process that can answer it, and calling it parks the
state until a human replies. `@jaira/runtime`'s `InteractionHub` backs it in the
app; a headless run scripts the same function names with `--interactions`.

The renderer receives the parked request over IPC with the instance's resolved
inputs, renders the component, and submits structured data back. The main process
validates the payload against the component's contract **and** the engine
validates it against the state's output schema — two independent gates, because
the renderer is the untrusted half of the boundary. Because this path is
renderer-IPC-only, agents cannot fabricate UI outputs (spec §11.4).

The projection cannot tell a gate from any other function by reading the journal
(it records `op: "function"` either way), so the caller supplies the interactive
function names — which is why `waiting_for_user` is a JaiRA-side fact rather than
an engine one.

MVP component set (§15, Q4): `choose_option`, `review_artifact`,
`edit_artifact`, `fill_form`, `confirm_action`. Each is a React component with
a typed props/result contract in `@jaira/shared`. `review_artifact` renders
markdown artifacts with the decision buttons supplied by the state config;
`fill_form` renders from a JSON-Schema subset.

### 7.2 Agent Operations

**As built:** an agent state is a `function` operation naming a runtime adapter
(`claude-code`, `claude-cli`, `generic-cli`). The `RunSpec` below never existed in
JaiRA — the adapters live upstream in `@declarative-ai/agents-api` / `agents-cli`,
take their instruction from the op's `prompt` input and their surface from its
`config` input, and read `ctx.workspace` / `ctx.policy` / `ctx.approve` from the
engine. JaiRA's job is to name them and pass the exec environment (§1i item 7).
The sketch is kept because the *fields* are still the right list of what an
adapter needs:

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

Prompt templates come from `operation.prompt.template` with `{{.inputs.*}}`
interpolation (there is no `params` namespace). Artifact-typed inputs were to
interpolate as worktree-relative paths plus an instruction to read the file —
**not built**: an artifact travels inline as content today (§7.5, TODO.md).

### 7.3 Conversation Modes (spec §4.7)

- `full_history` (default): reuse the provider session when the adapter
  supports resume (Agent SDK, Claude Code `--resume`); otherwise replay the
  stored transcript artifact as prompt preamble.
- `summary`: **as built (§1j item 3, rebuilt in §1k)**, summarization is a
  `SessionStore` decorator, not an artifact. Once a conversation passes a budget its
  older turns are replaced by one summary turn produced through the run's own prompt
  executor — into a NEWLY MINTED conversation, since rewriting in place would change
  what every existing ref refers to. It is scoped **per session**, so a session
  mixing `summary` and `full_history` is summarized for both (the lint surface
  warns).
- `fresh`: no context.
- `selected_artifacts`: listed artifacts injected as preamble.

Transcripts live in the run's session store, keyed by logical session id, and are
readable as data through a `{ conversation }` binding. They are **not** written to
`.jaira/system/artifacts/…` — no artifact file is written at all yet (§7.5).

### 7.4 Skill Operations

MVP skill = a directory under `.jaira/skills/<name>/` containing `skill.json`
(params schema, expected outputs schema, provider requirements) and
`prompt.md`. A skill is **not a separate operation kind**: it is a `prompt`
operation whose `prompt.skill` names a template resolved through
`registry.skills` at render time (§15, Q11).

**Not built.** `jaira init` creates `.jaira/skills/` and nothing reads it;
`registry.skills` is never populated, so `prompt.skill` parses and lints but fails
at run time. The remaining work is a loader plus registration — the prompt
machinery it would reuse already exists (TODO.md).

### 7.5 Output Contract and Repair Loop

Derived from the state's output schema at operation start:

- **Artifact outputs** — a slot whose schema carries a `contentMediaType`, which
  the loader lowers to the `blob` kind (there is no `type: "artifact"`).
  **As built:** the value travels *inline* and the engine registers an
  `ArtifactRef` — `{ artifact: true, name: "<state>#<instance>.<slot>", format,
  content }` — held in memory for the run. A blob operation output fills exactly
  one produced slot.
  **Not built:** the pre-assigned `system/artifacts/<taskId>/<instanceId>-<name>.<ext>`
  path, the "write X to path P" prompt injection, the post-run existence/format
  check, and the content hash. `config.artifactDir` is parsed and unused. §7.6 is
  the design that replaces this bullet.
- **Data outputs** (everything else): compiled into one JSON Schema. Delivery
  channel is chosen by adapter capability, best first: native structured output →
  final-message fenced ```json block → an `outputs.json` file at an engine-given
  path (fallback for generic CLI runners).
- **Derived outputs** (a slot with a `binding`) are resolved engine-side on
  termination and never appear in the contract.

Validation is always engine-side, regardless of channel. On failure (unparsable
payload, schema violation): the prompt executor is re-invoked with the concrete
validation errors and the original contract — at most **2 repair turns**
(`DEFAULT_REPAIR_TURNS`, `withRetry({ validation: { turns, feedback: true } })`),
then the operation fails and the state terminates with `terminate.error`. This is
the confirmed "ask it to correct itself" strategy, bounded and audited.

### 7.6 Artifact Storage (decided and built 2026-07-28)

Resolves SPEC §15 Q1 properly. Two decisions drive everything else:

**1. Where an artifact lands is configuration, expressed as a destination URI —
not a fixed set of modes.**

An enumeration of modes conflates two orthogonal things: the **storage backend**
(memory or filesystem) and the **path derivation** (does the physical path keep
the agent's relative path, or is it derived from task/instance/slot?). Three of
the four scenarios differ *only* in derivation. A scheme plus a path template
separates them, and one string then expresses all four — plus combinations no
enumeration would have listed:

```jsonc
// .jaira/settings.json — replaces the flat `artifactDir` string
"artifacts": {
  "destination": "$DEFAULT",    // or "$CENTRAL", "$SYSTEM/out/$TASK_ID/$RELPATH", "virtual:", …
  "dir": "artifacts",           // what $ARTIFACT_DIR expands to, under $SYSTEM
  "inlineMaxBytes": 65536       // below this, keep content inline for cheap bindings
}
```

| Scenario | `destination` |
| --- | --- |
| As written — wherever the agent asked | `$DEFAULT` |
| Central, relative path preserved | `$CENTRAL` |
| Central, flat and derived | `$CENTRAL_FLAT` |
| Out of the tree entirely | `/var/artifacts/$TASK_ID/$RELPATH` |
| Virtual — memory only (today's behaviour) | `virtual:` |

**Scheme = backend.** `virtual:` is memory; `file:` is the filesystem and is
**implicit when omitted**, so the common case reads as a plain path. Adding a
backend later (an object store, git-lfs) adds a scheme rather than multiplying
modes.

**Variables = derivation**, from a closed vocabulary — unknown variables are a
config error, not an empty string, on the same principle as the expression DSL.

*Aliases*, so the ordinary choices are one word and the composite ones stay
editable:

| Alias | Expands to |
| --- | --- |
| `$DEFAULT` | `$WORKTREE/$RELPATH` |
| `$CENTRAL` | `$SYSTEM/$ARTIFACT_DIR/$TASK_ID/$RELPATH` |
| `$CENTRAL_FLAT` | `$SYSTEM/$ARTIFACT_DIR/$TASK_ID/$INSTANCE_ID-$SLOT.$EXT` |

The central placements anchor on `$SYSTEM` — the **project's** generated-state
directory — rather than on the worktree. Artifacts are what a run produced, not
what a person authored, so they belong with the rest of what JaiRA writes for
itself; and anchoring on the project rather than the worktree means `git worktree
remove` does not take them with it.

*Base variables:*

| Variable | Meaning |
| --- | --- |
| `$WORKTREE` | the task's worktree root (project dir if the task is unbound) |
| `$PROJECT` | the project root |
| `$JAIRA` | `<project>/.jaira` |
| `$SYSTEM` | `<project>/.jaira/system` — everything JaiRA generates (§3) |
| `$ARTIFACT_DIR` | `artifacts.dir`, default `artifacts`; a name under `$SYSTEM` |
| `$TASK_ID`, `$RUN_ID`, `$INSTANCE_ID`, `$STATE_ID`, `$SLOT` | run coordinates |
| `$RELPATH` | the logical path the agent used, relative to the workspace |
| `$BASENAME`, `$EXT` | decomposition of `$RELPATH` |

Three rules keep it safe and portable:

- **`$RELPATH` is agent-controlled**, so the *resolved* path is asserted to be
  inside the template's root. This check is needed by the central-relative case
  regardless of how the config is spelled, and it composes with the existing
  `.jaira/**` deny rule rather than replacing it.
- **Templates are POSIX-shaped and resolved late**, through `runtime/paths.ts`.
  `$WORKTREE` is not one string: a WSL project's agent sees `/mnt/c/…` where the
  host sees `C:\…`, so substitution happens *after* choosing the view.
- **Anchor on variables, not a leading slash.** A leading `/` is ambiguous on
  Windows; `$WORKTREE`/`$PROJECT`/`$JAIRA`/`$SYSTEM` say exactly what is meant. A
  template with no anchor variable is relative to the workspace root.

`$JAIRA` remains viable only because of decision 2: agents are policy-denied from
`.jaira/**`, so nothing but JaiRA could write there.

One thing this adds over an enum: a parser and a validation surface. It is worth
it — the traversal check exists either way, the substitution is `$NAME` against a
fixed table, and `jaira workflow lint` can check the template at config-load time
rather than at first write.

**2. JaiRA owns the write tool, so JaiRA controls the write.** This is the part
that makes the modes possible rather than aspirational.

The engine hands a delegated agent our registered tools over MCP — upstream
injects each one as `{ …, run: (input) => tool.run(input, ctx) }`, so **our
implementation is called with the agent's raw arguments**. Registering
`write_file` / `read_file` (JaiRA registers only `bash` today) turns every agent
write into a call we service:

```text
agent: write_file({ path: "docs/plan.md", content })
  ↓  policy check on the LOGICAL path (what a human would be asked to approve)
  ↓  resolve logical → physical, per mode
  ↓  write physical; record logical → physical in the run's artifact map
  ↓  return success, naming the logical path
agent: read_file({ path: "docs/plan.md" })  →  map hit  →  read physical
```

**The agent must never learn the file moved.** A write to `P` followed by a read
of `P` returns the content, whatever the configured mode did with the bytes. A
read that misses the map falls through to the real workspace path, so ordinary
source files are unaffected.

Consequences worth stating:

- **Policy applies to the logical path**, before mapping. That is the path the
  author wrote rules against and the path an approval dialog shows; mapping must
  never move a write outside the configured root, and `../` escapes and
  `.jaira/**` are refused as they are today.
- **The map is durable, not per-process.** A later state in the run — and a later
  run reading a previous artifact — resolves through it, so it is a table (the
  deferred §4.2 `artifacts`), keyed by `(taskId, logicalPath)` → physical path,
  hash, format, producing instance and slot.
- **Not every intercepted write is an artifact.** Every write is recorded so reads
  resolve; an *artifact record* is created when the write fills a declared
  `blob` output slot — because the engine pre-assigned that path and told the
  agent, or because the state returned that path as the slot's value.
- **`ArtifactRef` gains `path` and `hash`; `content` becomes optional**, inlined
  only below a size threshold. That is what stops artifact bytes bloating the
  `events` journal, which is the concrete cost of the current inline-only model.
- **Pruning follows the root.** Artifacts under `.jaira/` are derived state and
  prune with their run; artifacts in the worktree are the user's work product and
  are never pruned. No special case — the rule reads the configured root.

**The leak, stated honestly.** Interception only covers tools we serve. An agent
using its own native write (`nativeTools`, `injectTools: false`, a `generic-cli`
runner, or `bash` with a redirection) writes wherever it likes and never consults
our read path. For those, reconciliation is *after the fact*: the workspace is a
git worktree, so `git status --porcelain` names exactly the files an operation
created or modified, and the configured mode is applied to them when the operation
ends. When the template is `$WORKTREE/$RELPATH` that is a no-op — the agent already
put it where the config wanted it. When the template relocates, the file is moved
and recorded — but an agent that later re-reads its own path through its own tool
will miss, because that read never reaches us either.

So the guarantee is tiered, and the tiers are the same ones §8.2 already grades
runtimes by: **injected tools ⇒ the invariant holds; native tools ⇒ best-effort
reconciliation.** This is one more reason to prefer injected tools, alongside the
policy argument — the same choice buys enforcement and artifact fidelity together.

**Two containment levels, both found by tests rather than by reasoning:**

1. *The final path must stay under the root* — where "root" is the template's
   **author-fixed prefix**, truncated to the last directory boundary, not the
   worktree. Anchoring on `$WORKTREE` let `$CENTRAL` plus `../../src/index.ts`
   climb out of the artifact directory and overwrite source while still being
   "inside the worktree" — technically true, entirely wrong.
2. *The root itself must stay under its anchor.* The fixed prefix interpolates
   config (`$ARTIFACT_DIR`), so `"dir": "../../escape"` placed the whole artifact
   tree outside the project. Author-supplied, but a typo with filesystem-wide
   reach. An explicitly **absolute** template is exempt — writing
   `/var/artifacts/$RELPATH` is unambiguous intent, whereas `..` climbing out of an
   anchor is not.

**Two producers, one placement rule.** `write_file` covers an agent's writes; a
state that *returns* blob content (a prompt writing a plan) never touches a tool,
so `persistEngineArtifacts` walks the finished run's outputs for the engine's
inline `ArtifactRef`s and applies the same destination. It runs **after** the run
and reports rather than throws: the work is already done, and an unwritable file
must not turn a completed run into a failed one.

**Still open** (TODO.md): native-write reconciliation via `git status`, the
detail-panel artifacts list, and pruning that follows the destination root.

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

#### An executor's settings are its KIND's settings

There is no generic executor block, and the attempt to have one is what produced
a settings screen asking for an Anthropic API key in order to run a binary that
signs itself in and would have ignored it. `EXECUTOR_KINDS` is the single table
— read by the config parser, the probe, and the form — and the four kinds
deliberately disagree:

| kind      | binary  | credential   | what it is                                    |
| --------- | ------- | ------------ | --------------------------------------------- |
| `sdk`     | —       | **required** | an API client, in process; no binary to point at |
| `cli`     | yes     | **none**     | `claude`, on the subscription its user signed into |
| `codex`   | yes     | optional     | `codex`, which signs itself in *or* takes a key |
| `generic` | yes     | optional     | any other agent binary, driven by an argv template |

`credential: "none"` is a claim about the **runtime**, not a UI preference: the
parser refuses `agents.claudeCli.credential` outright, and the pane offers no key
entry, because a stored secret nothing ever reads is worse than a missing field —
it leaves someone believing the executor is configured. Symmetrically,
`agents.claudeCode.command` is refused: the SDK adapter has no process to point
at.

Every executor still carries `enabled` and `models` in common (`config.agents.*`):

- **`enabled`.** Defaults to true, so a project that configures nothing gets
  everything. `false` leaves the runtime **out of the registry entirely**, which
  is deliberately louder than registering a stub that refuses when called: a
  workflow that cannot run here fails at start as an unregistered function
  rather than halfway through a run.
- **`models`.** Which models this executor may be asked for, and with what — see
  "Constraining an executor" in §8.3.

And where a kind takes one:

- **`credential`.** *Names* a secret; it never holds one. `settings.json` is
  committed source, so a key written there is a key in everyone's checkout and
  in the history forever. The parser refuses a value containing whitespace with
  that reason spelled out, because it is the single easiest way to leak one.

The value is resolved when it is needed, first hit wins:

```text
  1. the OS keychain              Electron safeStorage, encrypted at rest — app only
  2. <project>/.jaira/.env.local  this checkout's JaiRA config, not committed
  3. <project>/.jaira/.env        this checkout's JaiRA config, possibly committed
  4. <project>/.env.local         this checkout, not committed
  5. <project>/.env               this checkout, possibly committed
  6. <base>/.env.local            the machine, for every project
  7. <base>/.env                  the machine, for every project
  8. the process environment      CI, a shell that exported it, a wrapper script
```

Narrowest to widest, which is the only order that lets a project-specific key
beat a machine-wide default. The keychain leads because it is the one link that
is not plaintext on disk; the environment trails because it is the one JaiRA
cannot see the provenance of. **The CLI has no keychain** — `safeStorage` is
Electron's — and that is why links 2–8 exist: the app must never be the only
place a credential can live, or a workflow would run in the app and fail on the
command line for reasons nothing reports.

**A checkout has two places, and `.jaira/` is the narrower.** The base root's
pair sits in `~/.jaira`, so the same pair in a project belongs in
`<project>/.jaira` — that is what makes the two layouts read the same. The
repository root keeps its links because that is where a `.env` a project already
had for its own tooling actually is, and asking someone to move theirs in order
to be found would be the wrong way round. `.jaira/` wins between them: a key put
there was put there *for JaiRA*, where one at the repository root may be shared
with everything else the project runs. `jaira init` gitignores
`.jaira/.env.local` and deliberately not `.jaira/.env` — the `.local` suffix is
the whole convention for "this machine's".

`probeExecutor` health-checks one without running it: `--version` (the one
invocation these binaries all support, that exits immediately, and that cannot
be talked into doing work) plus, **for the kinds that use one**, a credential
lookup. It reports `not-checked` as a distinct outcome from `ok`, because calling
an unverified executor healthy is the failure the check exists to prevent. Only
the credential's **origin** ever leaves the main process; the value does not
cross IPC.

The kind decides what a missing key means, and both directions were wrong before:

- `cli` is never asked about a key at all. It used to be, so `claude-cli` on a
  machine with no `ANTHROPIC_API_KEY` reported *failed* — the one executor that
  works with no API key, marked as the broken one.
- `sdk` fails when the package is installed but **no** key can be found, even
  when config names none. It used to pass in exactly that state, because with no
  `credential` field there was nothing to look up: the check succeeded by having
  asked no question, and the adapter could not have made a single call.

A failed probe also carries a **`fix`** — one imperative line saying what would
change the answer. A health check that concludes "unavailable" and stops has told
you the less useful half of what it knows.

#### Configuring one from the app

Three screens, and the split is the thing about them worth stating:
**Providers** is *what can run here and how do I set it up*; **Executors** is
*what actually gets used*. They were one tab, which is why it answered neither
well — "Anthropic has a key" and "prompts go to Anthropic" are different facts,
and one row with one checkbox was being asked to mean both.

**Providers** lists everything that can answer a prompt — the four serving routes
and every agent runtime, in one list, because a model provider and an agent
provider differ in their settings and not in their purpose. Each row's form is
**its kind's form**, laid out as the type hierarchy rather than flattened: the
level every provider shares, then the level that makes it an API provider or a
CLI agent, then the level that makes it codex. That is what lets a reader see
which settings every CLI has and which are codex's alone, instead of one pile of
boxes. New agent CLIs are declared here and removed here; a built-in is only ever
turned off, because it is not declared anywhere to begin with.

A row's state is a **pill, not a checkbox**, and it has four values: ready, not
working, not set up, turned off. A checkbox can say only on or off, so an
unavailable provider rendered as a ticked box — which is how the screen came to
claim four working providers on a machine configured for none. "Enabled" is an
intention and "ready" is an observation; they disagree constantly, and the UI has
to be able to say so. A row that is not working also carries its `fix`.

**Executors** holds the default model (with what it currently resolves to), each
executor's `models` rules, and the named presets. Every LLM configuration on it —
an executor's call defaults, a preset — is edited with the same element: a rail
of categories, each carrying a live one-line summary, beside a detail pane. It
replaced a JSON textarea, which made the user the parser: you had to already know
the field is `maxOutputTokens` and not `maxTokens`, and that a model is sampling
XOR reasoning — neither of which the box told you, and both of which it would
accept and then fail on at run time. Unknown keys survive in a JSON escape hatch,
so the form is never lossy.

**Configuration** is the rest of `settings.json` — artifacts, where commands run,
the safety policy, memoization, workflow lookup — and it is a FORM. It was a raw
JSON editor, which is the same failure the LLM config box had: it makes the user
the parser. You had to already know the field is `inlineMaxBytes` and not
`maxInlineBytes`, that `execEnvironment` is `"windows" | { wsl }`, and that a
destination is a template over a closed variable set. Two things get bespoke
controls because their shape carries meaning a property walk cannot: the exec
environment (a union spelled as a string or an object) and the policy (an ORDERED
rule list over parsed command intent, first match wins — so a list with move
controls, exactly as the function rules are). The raw document stays behind a
disclosure, because the policy block is `Record<string, JsonValue>` and a project
may carry a field newer than the form.

Two rules make any of these forms safe against a layered configuration. It patches the
**layer's own document**, never the merged one: saving the effective config into a
project would copy every inherited value out of the shared root and freeze it
there. And an **emptied field removes the key** rather than pinning the value that
was showing, which is how a project goes back to inheriting.

**With no project open there is no project layer**, so the switch is absent rather
than disabled and the screens edit the shared root — actually, not just in the
wording. Left pointed at `project`, every control rendered disabled with no
visible reason, which is what a screen that says one thing and does another looks
like.

Storing a key does both halves of the job at once — the value goes to the secret
target chosen (keychain, project `.env.local`, base `.env.local`), and the *name*
is written into the layer being edited, because a stored secret that no config
names is one nothing will ever look up. The value still never crosses back: the
pane learns only the origin, from the probe. A provider whose kind uses no key is
offered no key entry at all.

### 8.2 Capability Gating

A state may declare requirements (e.g. its policy includes approval-required
commands ⇒ requires `policyEnforcement !== "none"`). At task start the
validator cross-checks each state's provider choice against the registered
adapter's capabilities; violations block the task with a clear error rather
than degrading silently. Provider selection itself follows the spec: the state
names a provider; project config maps provider names to adapter configurations
(model, API keys, CLI path, per-provider defaults).

### 8.3 Who answers a prompt state

A model id names its serving route as a prefix — `anthropic/claude-sonnet-5` — and since the
declarative-ai executor split that prefix can name an **executor** rather than a provider:
`claude-cli/sonnet` sends the call to the CLI agent, which runs on its own subscription and needs no
API key. One namespace covers both, because what a prefix answers is a single question — *who runs
this?* — and splitting it across two vocabularies would mean a settings screen that has to explain the
difference before anyone can configure anything.

That is the whole of the mechanism. `PromptRouterExecutor` reads the prefix and hands the op to the
matching executor with the id untouched; every prefix it does not recognise falls through to the
provider path, which owns them and produces the authoritative error for a typo. Selecting an agent is
therefore not a mode — it is a model id, so an automatic choice and an explicit one are the same kind
of thing and equally visible in a record.

**`config.models` is prefix-keyed to match:**

```jsonc
"models": {
  "default": "claude-cli/sonnet",          // absent ⇒ chosen; see below
  "routes": {                              // HOW each prefix is reached
    "anthropic":  { "credential": "ANTHROPIC_API_KEY" },
    "openrouter": { "credential": "OPENROUTER_API_KEY" },
    "local":      { "baseURL": "http://localhost:11434/v1", "serve": { "command": "ollama", "args": ["serve"] } },
    "embedded":   { "weights": { "qwen2.5-7b": { "modelPath": "/models/qwen.gguf" } } }
  },
  "presets": { "fast": { "model": "anthropic/claude-haiku-4-5", "temperature": 0 } }
}
```

`credential` NAMES a secret and never holds one, resolved through the same chain an executor's is (OS
keychain → the `.env.local`/`.env` pair in the project's `.jaira/`, then the pair at its root → the
same two in the base root → the process environment). That chain is the point: before this existed `createModelRouter()` was called with no
options at all, so the provider SDKs read `process.env` and a key kept anywhere else never reached
them. `presets` feed declarative-ai's named-config registry, which a state selects with
`operation.configRef` — a mechanism that predates this block and only lacked somewhere to write the
presets down.

Four rules worth stating, each of which was a wrong answer at some point:

1. **A missing model is a CHOICE, not a refusal.** `modelDefaults` used to reject any prompt-bearing
   workflow whose config named no `models.default`. It was right that a prompt op needs something to
   dispatch on and wrong that the something must be a provider — an installed agent needs no key, no
   endpoint and no configuration, so the one setup that obviously worked was being turned away. It now
   picks: a usable provider route first (someone who set up a key meant to use it), then an agent that
   a check has shown to WORK. It refuses only when nothing at all can answer, and names both fixes.
2. **"Usable" is checked cheaply on every run, and thoroughly in the background.** These are two
   different checks and conflating them was the mistake:
   - `routeUsable` runs on every workflow start and must stay free — a resolvable credential, a
     configured endpoint, a weights file that exists. It opens no socket and spawns no process,
     because launching a workflow must not pay for a health check nobody asked for.
   - `probeModelRoutes` / `probeExecutor` are the real observation, and they run **by themselves**:
     at startup, at project open, and after every configuration write. They connect to a local
     server, stat the GGUF, resolve the loader package, and run `--version`. Neither ever generates,
     so neither ever spends money.

   The result is one `AvailabilitySnapshot` — routes, executors, the chosen default, and the *time of
   the check* — cached in the main process and read by the settings screen over `availability:read`.
   Nothing has to be pressed. The button that remains says **Re-check**, and exists only for a world
   that changed since: a server started, a key installed in another window.

   `checkedAt: 0` is a first-class value and the UI renders it as "not checked yet". "No check has
   run" and "everything is fine" are different statements, and rendering the second for the first is
   the whole failure this replaced — every provider used to show as enabled, on a machine configured
   for none of them, because nothing had ever looked.
3. **The route prefix is stripped before the transport sees it.** `claude-cli/sonnet` reaches `claude`
   as `sonnet`, which is a model it knows. A transport that cannot honour a specific model must
   REFUSE rather than drop it — running a different model than the one asked for is silent, wrong, and
   an order of magnitude off in price. JaiRA's generic CLI does exactly that unless its argv template
   carries a `{model}` placeholder.
4. **The placeholder id means "your own default".** An agent asked for no particular model is given
   `agent/default`, which is inert: it satisfies the lowering (which requires a model to route a
   *provider* call) and is never forwarded, because a binary asked for a model literally named
   `default` would refuse — and that is precisely the zero-configuration case that has to work.

   This only held for the transport's *own* placeholder. `claude-cli/default` — which is exactly what
   `defaultModelId` produces on a fresh machine — is a NAMED id, so the placeholder branch never
   fired and the prefix-stripping handed `claude` `--model default`. `constrainRoute` normalises it,
   which is why every agent route is wrapped and not only a configured one.

#### An executor is a TREE, and there is always a default one

An executor in declarative-ai is a composition, not an object:

```text
operation   → OperationExecutor      dispatch on op.kind
├─ function → FunctionExecutor       the run's registry, optionally narrowed
└─ prompt   → PromptRouterExecutor   dispatch on the model id's prefix
     ├─ anthropic  → PromptExecutor      via ModelRouter
     ├─ claude-cli → AgentCliExecutor
     └─ …
```

`config.executors.<name>` is that tree, at every level, and **`default` is the one
every UI-initiated operation uses** — starting a task, proposing workflow changes,
summarizing a conversation. Those three used to assemble their own from the same
ingredients, which is a coincidence rather than a guarantee.

Two rules make it usable, and they are the whole design:

1. **Absent means DERIVED, not empty.** What is stored is a sparse OVERLAY;
   `resolveExecutorTree` builds the whole tree from what is actually available and
   lays the overlay on top. With an empty config the default executor is still
   complete — an operation executor over a function executor and a router across
   every usable provider and every working agent.
2. **A change pins only what changed.** Writing a rate limit onto the `anthropic`
   route stores exactly that, so an agent installed tomorrow still gets a route by
   itself. Materializing the resolved tree into `settings.json` on first edit would
   freeze today's answer into everyone's configuration, and they would never pick
   up a better one.

So the settings screen shows the whole tree EXPANDED while the file stays a few
lines, and every value is marked as one of two things: **derived** (adaptive) or
**pinned** (stated here, and it will not move again).

```jsonc
"executors": {
  "default": {
    "prompt": {
      "defaults": { "model": "claude-cli/sonnet" },     // applied BEFORE dispatch
      "routes": { "claude-cli": { "model": "opus", "steps": { "retry": { "transient": 3 } } } }
    }
  }
}
```

**`models.default` is gone**, and it could never have worked. `PromptRouterExecutor`
dispatches on `op.config.model`, while a leaf's `defaults` are applied inside its
own lowering — *after* routing. A default naming an agent was therefore invisible
to the routing that had to happen first: a state naming no model fell through to
the provider path and was asked for `claude-cli/default` there, which `ModelRouter`
cannot serve. The router node's `defaults` are applied on the way IN, which is what
makes a default executor able to route at all. The parser refuses the old field
rather than dropping it, because a config carrying it was relying on it.

Each node carries its own `steps`, so "a rate limit on this one route" and "a
deadline on the whole tree" are different statements — which one `steps` block at
the top could not make.

**The function half takes RULES, not an allow list**: an ordered
`["everything", "-run_command"]`, walked top to bottom with the last match
winning. The useful statements are subtractive — "everything this workflow
registers, except the one that runs commands" is one rule after a baseline, where
an allow list would have to name every function that exists and be edited again
whenever a workflow gains a state. A list of only `+` rules reads as an allow
list, because otherwise `+read_file` would be a no-op. The form offers
`BUILTIN_FUNCTIONS` in a dropdown beside a free-text box: the list cannot be
exhaustive (a workflow registers a sub-workflow under its own state id), so
offering only the known names would make the common case easy and the real case
impossible.

**Which models a route may run belongs to the ROUTE.** It used to also live at
`config.agents.<executor>.models`, and two homes for one setting meant two
screens, two parsers, and a question with no good answer — does this limit apply
to the tree's route or to the agent underneath it? The agent block is now only
what the runtime IS. All that survives there is `normaliseAgentModel`, which is a
fix rather than a setting: `<agent>/default` is a NAMED id, so a transport's own
placeholder branch never fires and it forwards the word, asking `claude` for
`--model default`.

#### The steps a node is wrapped in

Every node of the tree can be wrapped in cross-cutting layers.
`@declarative-ai/exec`'s `hydrate.ts` states the shape:

```ts
compose(leaf)
  .with(withRateLimit(...))   // a concurrency slot and rate headroom
  .with(withRetry(...))       // transient re-attempts, schema repair
  .with(withMemoize(...))     // a durable answer cache
```

JaiRA hardcoded exactly one instance of it — two repair turns and an on/off memo —
so the stack was a fact about the program rather than a choice. Any node's `steps`
makes it a choice:

```jsonc
"steps": {
  "memoize":   { "namespace": "review" },
  "retry":     { "transient": 3, "validation": { "turns": 2, "feedback": true } },
  "rateLimit": { "maxConcurrency": 4, "rpm": 60 },
  "deadline":  { "maxDurationMs": 300000 }
}
```

Three rules, each the opposite of a worse answer:

1. **The steps are a SET; the ORDER is JaiRA's.** Order is load-bearing —
   memoize outermost so a hit skips everything, rate limiting INSIDE retry so a
   re-attempt after a 429 waits for headroom again rather than holding one slot
   across the whole loop and its backoff. Those are correctness properties, not
   preferences, and a drag-to-reorder list would be an invitation to build a
   stack that is quietly wrong. `EXECUTOR_STEP_ORDER` is the list, and the screen
   NUMBERS the steps rather than implying they can be moved.
2. **Each step carries its own JSON Schema**, in `@jaira/shared`'s
   `executorStack.ts`. The config parser validates against it, the settings form
   is GENERATED from it, and `composeExecutorStack` applies it — so a step that
   gains a field gains a control, a label, a hint and validation at once. The
   alternative is three hand-written descriptions of one shape, drifting. This is
   findmyprompt's signature-driven form, whose `SchemaForm`/`registry`/
   `presentation` split is ported into `renderer/schemaForm/`.
3. **A step that is off is not in the stack at all** — not a layer that does
   nothing. `composeExecutorStack` returns the core UNCHANGED for a definition
   with no steps, and reports what it applied and what it could not (a `memoize`
   with no project has no store, and is reported rather than silently dropped).

One honest limit the screen states rather than hides: an AGENT declares
`memoizable: false` — it mutates the workspace and runs its own non-deterministic
loop — so `withMemoize` declines to key its calls. A `memoize` step on an
agent-backed node is applied and does nothing, and the form says so beside the
step. Budget (`withBudget`) is not offered at all, because it needs a
`BudgetMeter` wallet JaiRA does not yet have; offering a control that silently did
nothing is the failure this whole section is about.

#### Constraining a provider, wherever it is reached

A node's `model` / `allow` / `defaults` constrain it in the tree. The same three
settings also live on `config.agents.<executor>.models`, and that is not a
duplicate: they apply to that runtime **however it is reached** — through the
default executor's derived route, through a route someone pinned, or through a
second executor entirely. A tree node says "this route runs opus"; the provider
block says "this agent may only ever run opus".

```jsonc
"claudeCli": {
  "models": {
    "default": "opus",                    // what `claude-cli/default` resolves to
    "allow":   ["opus", "sonnet"],        // patterns; `*` matches any run of characters
    "config":  { "temperature": 0 }       // merged UNDER a state's own config
  }
}
```

Patterns are matched against the id **without** this executor's prefix — what the transport is
actually handed — which is what lets one vocabulary express both *only opus* (`opus`) and *only this
provider* (`openrouter/*`, for a generic CLI whose model ids name one). `constrainRoute` applies all
three above the transport rather than inside each adapter, because the question is identical for an
SDK, a subprocess and an argv template, and answering it three times is how three answers drift.

Two rules it does not bend:

- **A disallowed model is REFUSED, never substituted.** Rule 3's objection applies with more force
  here: quietly running a permitted model in place of a forbidden one is invisible and can be an
  order of magnitude off in price. The state fails permanently, quoting the rule that refused it.
- **"Your own default" cannot satisfy an allow list.** With `allow` set and no `models.default`, a
  state asking for the placeholder is refused rather than let through — a limit that a caller can
  step around by declining to name anything is not a limit.

## 9. Git Integration, Worktrees, and WSL

### 9.1 Exec Abstraction

All child processes (git, agents, hooks) go through:

```ts
interface Exec { spawn(cmd, args, opts: { cwd, env, execEnv }): Child }
```

`execEnv: "windows"` uses native spawn; `{ wsl: "Ubuntu" }` wraps as
`wsl.exe -d Ubuntu --cd <linuxCwd> -- <cmd …>`. A `PathMapper` converts
between Windows and WSL views (`C:\…` ↔ `/mnt/c/…`, `\\wsl$\<distro>\…` ↔
`/…`). Projects declare `execEnvironment` in `.jaira/settings.json`; a WSL
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

One project-level policy in `.jaira/settings.json`, compiled per run:

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

- **One sidebar, and no chrome above it**: the window has no title bar and no
  menu bar. The menu was Electron's stock File/Edit/View, none of whose items
  this app defines, and the title bar repeated a project name the app already
  shows — between them they took the top of the window, which is where the
  sidebar wants to start. The frame is `titleBarStyle: "hidden"` rather than
  `frame: false`, because minimise/maximise/close still have to work and
  reimplementing them per platform is how an app comes to look like an app that
  reimplemented them; the OS keeps drawing those three, and the layout reserves
  the band they land in through the `titlebar-area-*` CSS environment variables
  (`--wco-left`, `--wco-right`, `--wco-height`), whose fallbacks resolve to no
  inset at all so the same stylesheet lays out in a plain browser.
  **The top row of the window is the ADDRESS BAR.** The document's path used to
  be the first child of the middle column, which put it a title bar and a strip
  of chrome down the page — a path bar with two things above it, neither of them
  a path. It now spans everything right of the sidebar, the inspector included,
  which is why it is assembled by the shell rather than by the panel that used to
  own it. There is no caption beside it: "no project · workflows/plan.json" named
  the project the sidebar names and the path the bar states properly, and a title
  that restates its neighbours is a title nobody reads twice. What survives of it
  is `document.title`, which the taskbar reads and no frame supplies any more.
  The left column is now ONE column. It was two: a 46px strip of glyphs for
  switching views, and beside it a second column that existed in two views only
  — the file tree in Files, the section list in Settings — so the window had two
  left edges and a width dragged in one view said nothing about the other. The
  sidebar carries, top to bottom: the collapse button, the app's name and the
  open project's (that row is the window's drag handle, and the only one on that
  side; the project name is the menu that opens another); the views as named rows
  rather than as bare glyphs; and theme and Settings pinned to the bottom,
  because neither is navigation.
  **A row IS the accordion for what it browses** — the file tree opens under
  *Files*, the sections under *Settings*, indented under the row and hanging off
  a rule. Not a separate headed section further down the column: that put the
  word "Files" on screen twice, once as the button that goes there and once as
  the heading over what it holds, and left the tree reading as a thing beside the
  views rather than the inside of one. Clicking a row you are not on goes there
  and opens it; clicking the row you are on folds it, which is the only meaning
  left for that click. Tasks and Logs have no drawer and no caret — their content
  IS the view, and a twisty over an empty drawer is worse than no twisty.
  COLLAPSED it is the old rail again — glyphs only, in 46px — and deliberately
  not gone. Every view is reached from this column, so a sidebar that closed to
  nothing would leave one button on screen that still did anything. The divider
  goes with it, for the reason the Files editor's does: a handle that widened a
  collapsed column would undo the collapse without saying so.
- **Board**: columns = visible child states of the current level, cards =
  tasks whose active path passes through that level. Root board shows
  top-level workflow states. Double-click a card whose active state has
  children → sub-board (breadcrumb navigation back up). Card badges: status
  (running/waiting_for_user/blocked/failed), pending-approval indicator.
- **A card's verbs are on its right-click** (Tasks view): Open — the double-click,
  named — then Re-run, Cancel, Copy task id, Delete. Cards multi-select with the
  gestures a file explorer taught everyone: shift-click extends from the anchor
  through everything between (in the order the board draws — columns left to right,
  lanes within each, the tray last, from the same `lanesOf` the render uses, so the
  range cannot disagree with the screen), ctrl/cmd-click toggles one card in or out,
  and right-clicking inside the set offers it the same verbs, each labelled with the
  count it will actually touch — an ineligible member is skipped and the note says
  so. The set is view-local and scoped to one project, because a task id is a rowid
  in one database and every verb takes a project; the store's `selected` stays the
  single task the panel describes, always the last card touched. Two of the verbs
  are IPC verbs of their own rather than sugar over `task:start`:
  - `task:rerun` starts a startable task (queued/interrupted/failed, §4.3's set — the
    engine's rule, not the UI's) and DUPLICATES a finished one: same title, workflow,
    inputs and branch under a fresh id, because a completed lifecycle cannot restart
    and "Re-run" quietly meaning "make another task" is worth saying out loud — the
    menu labels it "Re-run as a new task", and the response names the task that
    actually ran.
  - `task:delete` removes a task outright — every run's journal rows, its jobs and
    artifacts, its worktree (forced: the human confirmed, and this is the one caller
    for whom uncommitted work is not a reason to stop), and its JSON file. Refused
    while the task runs anywhere, found the same way cancel finds it (a live engine
    here, or the job table's heartbeat). Distinct from §13's pruning, which trims old
    runs while keeping the task; delete appears only in this menu and behind a typed
    confirmation, because destroying history is not a verb that belongs one mis-click
    from a card's face.
- **Task detail** (side panel): active path, instance tree with statuses,
  live runner event stream, artifacts list (markdown preview), conversation
  viewer, run history timeline (from `events`), cancel/retry controls.
- **Pending-input surfaces**: UI-component modal/panel rendering §7.1
  components; approvals inbox for §10.2 command approvals.
- **Workflow browser** (MVP-minimal): read-only tree of state files with lint
  results; editing happens in the user's editor, JaiRA watches and re-lints.
  Shipped in §1j: roots are derived (a state nothing declares as a child), every
  failure is a diagnostic rather than an exception, and drifted tasks (pinned to an
  older snapshot than disk) are surfaced because execution reads the pin (§5.3).
  Lint results are joined onto the **file tree** as well, not only the inspector:
  a state file is coloured by its worst diagnostic and a directory carries the
  totals below it, so a fault is visible with the branch collapsed. A state no
  root reaches is marked `unchecked` rather than left looking clean — nothing
  validated it, and zero errors there means nobody looked.
  **The shared root is linted with no project open.** It is browsable and
  authorable on its own, so it has to be validated on its own; the browse runs
  over synthesized paths in which the base root is the single layer, and a
  workflow written there is checked before any project has ever referenced it.
  Skipping this left the one mode people author shared workflows in as the one
  mode that never reported anything wrong.
- **Run it from the file you are looking at**: the Files inspector opens with a
  **Run** section — one box per input the selected state declares — over a
  **History** section of what running it has produced. Before this, the loop
  "change a state, try it, read what happened" left the view: a task was created
  in Tasks against a state id typed from memory, and the inputs went into a
  single free-text box regardless of what the state actually asked for. Five
  decisions hold it together:
  - **Every state, not only a root.** Any state id can be loaded as a bundle root,
    so a child runs standalone; there is nothing to gain by refusing. Non-state
    files have no Run section at all — a prompt declares no inputs and starts
    nothing.
  - **The LAYER decides which project records the run.** A state under
    `<root>/workflows` belongs to the shared library, so it runs in the root opened
    as a project of its own (`project: "shared"` on `task:create`/`task:start`); a
    project-layer state runs in the open checkout. Anything else gets both halves
    wrong: a shared workflow would clutter one checkout's board, and the shared
    root would be unrunnable in the mode it is most often authored in — with no
    checkout open at all. That mode now works end to end, which is why
    `StateView.fileOnly` is not a refusal: it means the VIEW was read without a
    checkout, and only the things that genuinely need one (dependants, tasks that
    passed through) are marked unknown. The panel names the target above the
    button, because the trade is real — a shared run's workspace is the root, not
    your repo, and a shared workflow expecting a checkout will not find one.
  - **The boxes come from the slot's `schema`**, through the same vocabulary the
    slot table uses, and make the same refusal: a schema richer than the
    vocabulary (`properties`, an `enum`, a bound) gets a JSON box rather than a
    control that could only round the value down. A string slot takes its text
    VERBATIM — a helpful JSON parse there would send the number `123` into a slot
    declared as a string, and the mismatch would surface mid-run.
  - **Empty is absent, never `""`.** A slot with a `default` is therefore
    satisfied by an empty box (§4.1), and a required one is refused here rather
    than at the first state of the run.
  - **The SAVED file runs.** Fields are read from disk, never from the draft,
    because a run pins a snapshot (§5.3). Unsaved edits are announced, not
    refused — comparing what you last saved against what you are about to write is
    most of why the button is there.
  - **History is two groups**, because they are two questions. *Started here* is
    every task whose workflow IS this state, read out of the TARGET project — the
    database the button writes to, which for a shared file is JaiRA's own. *Also
    passed through* is every task that entered it inside some larger workflow,
    projected from the state view and therefore the focused project's. For a root
    the second is usually empty and for a child the first is, and conflating them
    would make the section say nothing on either. Each group carries its project
    through to the click, because a task id is a rowid in one database.
  - **A list is refetched when you LOOK, not only when a push says so.** The
    history was the first reader `state.tasks` ever had — every other surface
    reads the per-project boards from `project:list` — and it inherited a bug that
    had therefore never been visible: `refreshTasks` guarded on
    `ref.current.projectDir`, and `ref.current` is assigned during RENDER, so a
    caller that patched the project and refreshed in the same tick read the value
    from before the patch, concluded there was no project, and wrote `tasks: []`.
    Nothing retried, because nothing had failed. The guard is gone (main's refusal
    is the answer, read as "none"), a `tasks` invalidate now also refreshes the
    open `StateView` — which carries the second group — and opening a state
    refetches both lists outright. One round trip per navigation buys the property
    that looking at a state always reads a list fetched after you looked, which no
    amount of push plumbing can guarantee on its own: a run that fails before
    emitting anything sends no push at all. The empty state names what it searched
    rather than asserting "never run", so a wrong empty can be told from a right
    one without a debugger.
  Run sits ABOVE validation in the column: the validation that would have gone
  first is what disables the button, said on the button itself. Warnings do not
  disable it — a warning that refused would just be an error.
- **With no checkout open, a shared state gets the FULL view, not a degraded
  one**: it used to fall back to reading the file alone, whose task lists are
  empty by construction — so history appeared on a shared workflow's root (whose
  own runs come from the task list) and on none of its substates (whose runs come
  from the state view). Now that the root is a project, the view is projected from
  it: boards, dependants, drift, and the tasks that passed through each state. The
  browser stays the BASE one even so, because it is what decides the LAYER and
  every file here is the base layer — reading that off the project would call
  these files `project`, and the Files view routes a run by that layer, so it
  would send them to whichever checkout was open. The project supplies the runs;
  the browser supplies the layer. The browse surfaces open the shared project only
  when the root already EXISTS: opening it creates directories and a database,
  which is the cost of running something and not of looking, and materializing it
  would also turn the tree's "not created yet — adding a state here will create
  it" into a lie about what you had already done.
- **A cost with nothing beside it is a number you can only believe**: the task
  panel shows what a run consumed — started, time in calls, tokens in/out, cache
  read and written, thinking — because that is what makes the money checkable.
  `$0.21` beside 40k cached input tokens is an agent session doing ordinary work
  and beside 300 tokens it is a bug, and those two used to look identical. JaiRA
  computes no cost: it records what the executor reported, and `costSource` is
  shown whenever that is anything other than the provider's own charge, because a
  silent estimate is the one that gets quoted back as a fact. Tokens are split the
  way they are BILLED rather than into one input figure — a cache read costs about
  a tenth of the base rate — since a single number cannot be priced or checked.
- **One transcript, not two stacked panels**: a run is described by two records
  and neither is sufficient. The SESSION holds every model call verbatim; the
  JOURNAL holds what happened around those calls — a policy escalation, a gate, a
  failure, a transition — which appear in no conversation because nobody said
  them. Showing both by stacking two components left the reader to interleave them
  by eye, and the lower one was scoped to the TASK rather than to the state, so
  opening one state showed its words above the whole run's events. That is what
  read as "it is showing all the sessions". They are now normalised into one
  time-ordered list, filtered to the state, and the journal's `operation`, `tool`
  and `output` turns are DROPPED — they are the session's own material told worse,
  and keeping them printed every model call twice.
- **Chrome marks a child boundary, and nothing else.** A leaf renders its
  transcript bare. A composite renders its OWN operation bare, in exactly the same
  way — it is this state speaking, not a child — and then one card per child RUN
  beneath it. So there is no leaf mode and composite mode; there is content, and
  there are cards around children, and a leaf simply has no children. A state that
  ran three times is three sibling cards rather than one card that has to explain
  itself, because a single card cannot be clicked into three transcripts.
- **A run names itself**: `label` is an expression, evaluated against that run's
  resolved inputs (`.inputs.description`), so four `design` runs that share a state
  id, a child key and a state name are still told apart by what each was called
  with. **The leading dot is what makes it a reference** — not "does it parse",
  because a bare word parses perfectly well as an identifier and reading it that
  way would turn every label already written into a lookup of a variable that does
  not exist. With no label, the card lists its parameters instead: something has to
  distinguish them. Only a literal and a `.inputs.<name>` path resolve; richer
  expressions are a producer tree only the engine can evaluate, and a second
  half-evaluator is how the two come to disagree about what an expression means.
  The values were already on `instance.entered` and projected nowhere, so the cards
  cost no new plumbing.
- **Two boards, one set of chrome**: the Tasks view's board and a run's board
  disagree about what a card IS — a task there, one EXECUTION of a declared child
  here, which is what makes a loop legible (three passes, three cards). That
  difference is real and it is why there are two. Everything around it — the
  column track, the sticky header and its count, the raised card with a status
  stripe, the footer under a rule — is identical, and was duplicated rather than
  shared, so restyling one of them left the other looking like the app it used to
  be. `Tile` and `Column` are that shared chrome; each board supplies what goes
  inside, which for a run is the inputs it was called with.
- **A composite has two honest readings, so they are a toggle**: the board answers
  *where is everything* (a column per declared child, the workflow's shape); the
  conversation answers *what did it say* (the state's own operation, then its
  children's runs in the order they happened, one task's shape). Neither is a view
  of the other. With a run selected the board's columns hold one card per
  EXECUTION rather than one per task, and clicking one opens its transcript — the
  same object seen twice, which is why the collapsed card and the board card are
  one component. Transcripts are fetched on expand: rendering eight folded headers
  must not cost eight round trips before anyone has asked to read one.
- **The toggle belongs to the panel, not to the viewer inside it**: it says what
  the whole middle column is showing, so it sits on the top bar with the path and
  the file's chips rather than on a strip inside the board it switches. The mode
  therefore lives in the shell — a viewer that owned it would lose it every time
  another file was clicked — and the viewer falls back to its own state when it
  is rendered somewhere with no bar. Session-scoped, unlike the layout beside it:
  it says what you are currently reading about one run, not how you like the
  window arranged.
- **The panel's head is an ADDRESS BAR**: a state id is a path, and its segments
  are the workflow hierarchy the open state sits in. Drawn as crumbs, every level
  above the one you are on is one click; drawn as a title and a subtitle, which is
  what it was, the same information offered nowhere to go. A crumb is a link only
  when a file with that id exists — an id is a naming convention, not a
  containment rule, so `plan/draft` can exist with no `plan`, and a crumb that
  opens nothing is worse than one that is plainly not a link.
- **The BASE run crumb names the TASK; deeper ones carry their own name**:
  `~/.jaira › debug › hello_world › #3 › Say hello`. The rule is positional, and
  it has to be. The first step is the open file's own state, and that state is the
  crumb immediately before it by construction — so whatever the run is *called*
  there is another word for a level the path already has. `hello_world ›
  Hello-world self-test` spends a segment saying one thing twice, and the second
  reads as a state of its own. What is new about that crumb is WHICH RUN, and a
  run is identified by its task. It is emphatically NOT the instance id: instance
  ids restart at 1 on every run, so the root instance of every task is `#1`, and a
  base crumb built from one read `#1` whichever run you picked out of the chevron
  — identical before and after, which is indistinguishable from a selection that
  did not happen. A task's name is shortened by the state id it starts with,
  because the Run panel names tasks `<state> #<n>` and the path already says the
  state; a name somebody chose (`Fix the parser`) is left alone, since shortening
  it would be inventing an abbreviation. The instance id survives as the fallback
  when there is no task to name, and in the tooltip, where it is precise and not
  alone. Below the base the state is not in
  the path at all, so the run's name is the only thing saying which of the
  parent's children it is. (Comparing the name against the previous crumb's text
  is not enough: a label and a state id are different strings for the same state.)
  The run's identity goes in the PATH rather than in a strip below it — the bar
  under the board naming the selected task is gone, since "which run is this" is
  what an address answers, and saying it in two places is how the two come to
  disagree. The task itself is named only in the context panel; putting it on the
  bar after the crumbs, with no `›` in front, made it read as one more segment.
- **A walk is seeded from the INSTANCE TREE, never from the session history**: a
  composite orchestrates and says nothing itself, so it has no conversation and no
  session row — and seeding a path from the sessions meant exactly the states with
  children, the only ones you can walk into, showed no run on the path at all. The
  instance tree has a node for every state entered, whether or not it spoke. The
  same read is what the board draws, so it is fetched on opening a file rather than
  only on a click: without it the bar said no run was open while the panel below was
  showing one.
- **The address continues past the file, one crumb per run walked into**, and the
  viewer shows the LAST element. Clicking a run appends it; clicking a child of
  that run appends that; clicking a crumb truncates back to it. The alternative —
  select a run, and let the panel replace itself — is what the board did, and it
  answers "what is inside this" while forgetting the question that got you there:
  four levels in, there was no record of the three above and no way back but to
  re-open the file and drill again. A list keeps every level, and the crumb IS the
  way back. Two consequences follow. The trail is scoped to ONE task, because an
  instance id is unique only within a run of one — so selecting another task
  restarts it rather than extending it, and a retry (which restarts instance ids)
  truncates it at the first step that no longer resolves; a path with a hole in it
  is not a shorter path, it is a claim about a descent that did not happen. And a
  step deeper is a different STATE, so the board below it takes its columns from
  that state's declared children rather than the open file's — fetched for the
  tail, and falling back to the child keys that actually ran, which is fewer
  columns than the truth but never a wrong one.
- **The bar shows the WHOLE address, in three families**, and every member of a
  family looks identical to every other: FOLDERS (grey) are the real path on disk,
  the layer root included; STATES (blue) are the segments under `workflows/`, where
  a path stops being directories and becomes the workflow hierarchy; RUNS are where
  you went from there. The root used to be a bordered pill and the directories
  above `workflows/` were not drawn at all, which made the one segment styled
  differently also the only one you could not click. A segment under `workflows/`
  is a state whether or not a file sits at that id — `plan/` with no `plan.json` is
  still the first half of `plan/draft`, and what the file's existence decides is
  where clicking it goes: to the state, or to the folder that is all there is.
- **A folder is a place you can stand**, and standing on one shows its contents the
  way a file explorer does — one level, folders first, `..` as a real row rather
  than a reliance on the bar. Without it the address bar's folder crumbs led
  nowhere, which is to say it was not an address bar: every segment but the last
  was a word. The listing is not a second tree — the tree beside it answers "where
  is everything", this answers "what is in the place I navigated to".
- **A chevron drops down the alternatives at that level**, as a file explorer's
  does. A separator is not punctuation: it is the join between two levels, and the
  question it can answer is "what else is in the one on the left". Before a path
  segment that is the containing directory's entries — folders to enter, states by
  their ID rather than their filename (the extension is a fact about storage and
  the bar speaks state ids), other files by name. Before the ROOT it is the other
  roots, plus the way to a project this window has not got open, which is the only
  navigation in the bar that is not already on disk. Before the base run it is the
  state's other runs, which are other tasks, since one task's newest pass is what
  the base stands for. Below the base it is the sibling runs under the same parent,
  which is the board one level up without going back to it — and picking one
  REPLACES that level rather than appending, because a sibling is not a step
  deeper and the levels below it described a descent through the run you just
  left. The menu always contains where you are, marked, so the list does not have
  to be counted against the path; it is absent entirely when that is the ONLY
  entry, since a chevron opening to tell you what the crumb beside it already says
  is a control that does nothing.
- **The context panel describes the last element too, ALWAYS**: standing on a run
  it is that run — what it was called with, how it went, what that one pass cost.
  Those are per-EXECUTION facts and the task panel cannot carry them: a task that
  looped four times has one status and four runs, and averaging them is how a
  failed pass disappears. With no run on the path it is the open file. The rule is
  the whole mechanism, not a default: the panel is a function of the bar, so there
  is no mode to get stuck in and no way for the two to disagree — which they did,
  the panel describing a file while the path beside it stood on a run, because the
  subject was tracked separately and only some navigations updated it. Every move
  that changes the bar returns to the rule. The TASK is the one exception, and it
  is reached only by asking for it on the run's own panel: a run belongs to a task,
  but a task is not a level of an address and cannot be navigated to. It follows
  that a state's Run button and lint results are behind the state's own crumb
  whenever a run is on the path — one click out, which is what "up a level" costs
  in any address bar.
- **The configuration folds to a bottom bar**: both halves at once is right while
  authoring and wrong while watching, and a state's form is what you edit for a
  minute and then want out of the way for ten. Folded, the label row IS the lower
  half — a strip across the bottom saying what is behind it — and the divider goes
  with it, because a handle that resizes something invisible is a handle that moves
  a number nobody can see. It carries the unsaved-edits dot: an editor you cannot
  see holding a change is the one thing the fold could cost you.
- **A state's transcript is what it ADDED, not what the session holds**: a session
  is append-only and shared, so a state resuming one is handed everything said
  before it and its call answers with the whole conversation. Rendered verbatim,
  every state after the first showed its predecessors' words as its own — the
  deeper into a workflow you looked, the more of somebody else's transcript you
  read. The record is now diffed against what the position below it materializes,
  and the inherited prefix must match ENTIRELY before anything is dropped: a
  record carrying only its own delta does not begin with the prefix, and a partial
  match is most likely two states that open with the same system prompt.
- **The transcript is a chat, and its parts are read as what they are**: what the
  workflow sent goes right, what came back goes left, and only MESSAGES take
  sides — a tool call, a thinking block and a journal event are not things anybody
  said, so they stay full width, which is also what a payload needs. Parts are
  classified rather than assumed: the old rule was "anything that is not text is a
  tool call, and its payload is `args`", which is the Vercel spelling — an
  Anthropic-shaped record (`tool_use`/`tool_result`, `name`, `input`, `id`, and
  `thinking` blocks) matched none of it, so every tool line printed `null` and
  every thought became a nameless tool. Both spellings are read now, a call keeps
  BOTH halves when its result arrives, and pairing happens across the whole
  conversation because the call and its result are on different turns.
- **The inspector is a CONTEXT panel, and context has a way back**: the right
  column describes whatever you last clicked, and clicking a task makes the task
  the context. That was already half-true and the missing half was the return
  trip — the way back was a breadcrumb rendered only when a state happened to be
  open, so a task reached from anywhere else held the column until you clicked
  another file. It is now an arrow that is always there, and it RESTORES rather
  than switches: the task's panel links out to every state the run went through,
  and following one moves the open state, so "show the state again" and "go back"
  stopped being the same place. `inspectFrom` records where the context came
  from, and only on the way IN — clicking a second task while already on one must
  not overwrite it, or Back becomes a loop.
- **A state's panel opens on what the state DID**: selecting a state loaded its
  board, its file and its lint results and left the transcript beside them saying
  "select a task", which made the one panel that answers "what did this actually
  say" the one panel you had to go and ask for. It now opens the state's newest
  run — a task parked here NOW before one that merely finished later, because
  "what is happening in this state" beats "what was touched most recently". This
  fires on navigation only, never on the refresh every journaled event triggers,
  or each engine event would yank the selection back mid-read. It does not touch
  `inspect`: opening a file is not clicking a task, and must not take the column
  away from the state.
- **A transcript is chosen by state, not by recency**: a task's latest instance is
  the DEEPEST state it reached, so selecting a task from `feature/plan/goals`
  opened `critique`'s conversation — the right task, the wrong state, and nothing
  on screen saying the two had come apart. The click now carries the state it came
  from, and the newest instance of THAT state is shown; newest rather than first,
  because a loop runs one state several times and the last pass is the one being
  asked about. A task that never reached the state falls back to the latest rather
  than to nothing — the header names the state either way, and a labelled
  conversation beats an empty panel.
- **Operation input checks**: the engine asks whether a state passes its
  operation what the operation's registered implementation requires — the same
  question `children.<key>.inputs` has always been asked ("required child input
  is not wired"). It ran only over embedded calls inside bindings, so the
  operation a state exists to run was the one call nobody checked. JaiRA's
  built-in components declare no signature — their contract is a shape inside
  `config`, not a parameter list — so the same question is asked from
  `parseComponentConfig`, and a `choose_option` with no options is an ERROR on
  the file rather than a gate nobody can answer.
- **Schema detection**: opening a `.json` file selects the schema it already
  satisfies. Validating is not sufficient on its own — `prompt-operation` must
  admit unknown fields, because hw passes anything it does not own into the call
  config — so a match also requires every top-level key to be one the schema
  declares. Ties go to the schema whose `expected` keys the document carries, so
  a prompt state resolves to `state-prompt` rather than `state`. It is a
  suggestion: an explicit choice, including "none", wins from then on.
- **Resizable panes**: every side pane is a grid track driven by a variable that
  a divider writes, with keyboard nudges and double-click-to-reset. Widths are
  per CONTROL — the layout of Files has nothing to say about the layout of
  Tasks — and they OUTLIVE the window; see *Remembered layout* below. The
  same control divides the Files view's two ROWS, the viewer over the editor: a
  board with nine columns and a form with three fields want opposite splits, so
  the 46/54 the stylesheet used to impose was right for neither. Only that one
  is a height, and it may still shrink — the editor below claims a floor first,
  so a split dragged while maximised survives the window being restored.
- **Remembered layout**: how you arranged the window survives closing it. Every
  divider you drag, every fold you close, and every branch of the Files tree or
  the Tasks board you collapse is stored in `~/.jaira/user-settings.json` beside the
  theme — one person, one machine, never a checkout, so a layout preference can
  never arrive through a pull request. What it is NOT is a fourth configuration
  layer: the file holds three maps keyed by an id the renderer owns (a size, a
  disclosure, a folded branch), which is what keeps remembering a new control
  down to one constant rather than a shared type, a parser and a migration.
  Three rules make it behave. An ABSENT id means the control's own default, so a
  settings file written before a pane existed — or hand-edited into nonsense,
  which is parsed entry by entry — opens the app exactly as a fresh install
  does. Collapsed branches are stored NEGATIVELY, as what is shut, because a
  branch created after the file was written must never appear folded. And the
  window OWNS the layout once it has read it: the file seeds it at startup and
  is written back a beat after each gesture (plus once more on the way out), so
  a `user-settings.json` re-read — one happens on every project open — cannot snap a
  divider back to where it was before the drag.
- **One chrome for every editor**: a bar of standing facts on top, the document
  in the middle, Save and Revert underneath. Each editing surface scrolls
  INSIDE itself so the actions never move — the authoring form used to put a
  lone Save at the bottom of a page-long document, where it was reachable only
  by scrolling past everything you had just filled in, and it offered no Revert
  at all. The bar is also sticky, which covers the surfaces that sit inside
  something else that scrolls, such as the settings body.
- **Unsaved edits belong to the file, not to the editor**: every editing surface
  used to keep its draft in component state, so clicking another file in the tree
  — or glancing at the board, which unmounts the whole view — discarded it
  without a word. Drafts now live in the store, keyed by `layer:path`, and the
  surfaces derive their text from that rather than holding any. A draft is a
  DIFFERENCE from disk: an entry equal to the file is dropped, which is what
  makes `dirty` one fact rather than a flag to march in step, and what lets the
  tree mark the rows with something pending — an invisible unsaved edit is one
  that leaves with the window. Renames and deletes take their subtree's drafts
  with them, so a path recreated later does not open showing someone's abandoned
  edit to the file it replaced. Session-scoped, like the schema choice: writing
  them to disk would mean deciding which configuration layer owned a change
  nobody has committed to yet. The state form's tab is remembered the
  same way, per file, so returning to a state you were hand-editing does not put
  you back on the form.
- **Authoring form**: covers WORKFLOWS.md §2–§7 over the parsed document, with a
  JSON tab beside it. Two rules shape what it will and will not touch.
  *A plain reference is editable.* `prompt`/`system` (string position ⇒
  `{"$ref": …}`), the `operation` block and a slot's `schema` (object position ⇒
  bare string) each carry a link control; linking and unlinking are
  non-destructive, because the literal and the reference are held side by side.
  Anything richer — a reference with sibling overrides, a computed binding — is
  still shown read-only and left exactly as written.
  *A child's required inputs are shown as rows.* Mounting a child seeds one blank
  binding row per non-optional, non-defaulted input it declares. The row is a
  PLACEHOLDER and goes into the form model only — never into the document — so
  the file stays byte-identical until a binding is typed. That is what keeps
  validation running off the saved file: seeding through the document would mark
  a state modified the moment it was opened and hand the JSON tab a draft nobody
  authored. The state still fails to lint with "required child input is not
  wired"; what changes is that the sentence is met beside a named empty box in
  the form rather than in the lint panel after a save.
  *A binding is picked, not recalled.* Every binding box completes against the
  paths that exist in this state's scope: `.inputs.<slot>`, `.outputs.<slot>` for
  the outputs the operation PRODUCES, and `.children.<key>.outputs.<slot>` /
  `.children.<key>.outcome` — the latter keyed by the MOUNT key rather than the
  child's state id. A slot name misremembered by one character is not a syntax
  error, it is a binding that resolves to nothing, so the list is the cheapest
  place to catch it.
  *Bindings and guards complete from DIFFERENT lists.* A binding receives what
  the call RETURNED; a guard branches on how it WENT. So `.operation.output.*`
  is offered on bindings, while `.operation.outcome`/`cost`/`model`/`usage` and
  the guard-only `.run.*` and `.limits.*` are offered on transitions and nowhere
  else.
  *The operation's result is bindable* (upstream change, `hw`): `.operation.*`
  became a binding namespace, and `operation.output` became the call's own
  returned value — what the call returned, under the names it returned them, with
  `session` sitting among them as one of a prompt op's outputs rather than an
  envelope beside them. That is what lets an output rename or transform the
  result instead of only receiving it. The implicit fill still works: an output
  with no binding is PRODUCED (§3.3), and the Outputs table says so where the box
  is rather than leaving an empty field that reads as an omission.
- **Graph tab**: the third reading of a state file, beside the form and the JSON.
  It answers the two questions neither of those can — *what runs after what and
  what makes it*, and *where does this value come from* — which are spread across
  the whole document and otherwise have to be assembled in the reader's head.
  Read-only on purpose: the tab beside it already edits, and a control on every
  box would cost the space the picture is made of.

  **The five channels.** Every mark on the drawing belongs to exactly one of
  these, and each answers exactly one question. That is the whole vocabulary; a
  sixth meaning has to displace one of them rather than be added beside it.

  | channel | asks | says |
  | --- | --- | --- |
  | **position** | *when does it run* | columns are run order, left to right; lane 0 is the cursor's own path, lane 1 is everything it reaches only by jumping |
  | **geometry** | *what kind of movement* | a smooth curve between two PORTS is a value moving; an arc between two BOX EDGES, with an arrowhead, is the cursor moving. Nothing else may be a line |
  | **hue** | *which one* | a wire takes the colour of the VALUE it carries — one hue per source port, the same wherever that value goes; an arrow takes the colour of its DIRECTION. Hue never separates data from control: geometry does |
  | **dash** | *how it is written* | solid is the plain case (a bare binding, a rule on the mount); dashed is one-of-several (a read inside an expression, a rule that belongs to no child); dotted is not-written-at-all (the implicit fill, a guard's read, a step that does not wait) |
  | **weight · opacity · depth** | *what am I looking at* | and nothing else — see the attention model below |

  Three directions a move can take, because three things can happen to a run:
  **onward** (nearer the end — a later step, or out), **back** (over ground
  already covered — a loop, or a step re-entered) and **abort** (an ending that
  is not success). Measured by the target's COLUMN against the source's, which is
  what makes it a fact about the drawing rather than a guess about intent. The
  sequence keeps grey to itself: it is not a rule anybody wrote.

  **Every box shows both halves of its surface.** Inputs down the left edge,
  outputs down the right, one dot per slot — a node editor's arrangement, because
  the question is what a child TAKES and GIVES rather than what this file happened
  to fill in. A child's own declaration supplies the slots nothing is wired into
  yet; a slot only a binding claims exists is drawn all the same, ringed in the
  abort hue, since the wire to it is real and the far end may not be. The dot is
  FILLED when a value passes through it and hollow when none does, and carries
  that value's colour, so a dot and the wire leaving it are one statement.

  **A guard is shown whole, and is followable.** Never truncated, never numbered
  — a digit beside a condition reads as part of the condition, so a rule's
  position in its list is said in words on its tooltip. It is split at its
  top-level operators onto one line per clause with the `&&`/`||` in the gutter;
  `&&` binds tighter, so a mixed condition splits at the `||`s and each clause
  holding an `&&` is bracketed, which is the difference between the condition in
  the file and a flat list of alternatives. Every runtime path inside it is a
  TERM with a wire of its own, drawn from the port that produced the value to the
  line of the label that reads it: a condition is dataflow, and it was the one
  place that went unanswered.

  **Click asks, double-click goes.** Clicking a CHILD puts the state it mounts in
  the window's side panel — the same form and the same JSON tab as the middle
  column, over the same channel and the same writer, opening on the form. A box
  draws a mount; what an author wants when they point at one is the state that
  mount runs, and that is another file entirely. Every other box IS part of the
  open file, which the middle column is already showing, so those pin their own
  slice of it as a value. Nothing about the address, the open file or the camera
  moves, which is what makes it safe to click around a graph while reading it; the
  panel arrives through the same mechanism a transcript pins a document with, and
  grows to a width a form can be read at. Double-clicking opens that child's file
  properly, the same move the board's columns make, and it lands on the reading
  you were last using — from a graph you get a graph. The pointer is not CAPTURED
  until a drag has actually travelled a few pixels, because capturing on the way
  down retargets the compatibility mouse events too, which handed the map every
  click and double-click meant for a box.

  **A line is a target, and it says where it ends.** Two pixels of stroke is not
  something a pointer can be expected to find, so every line carries a fat
  invisible twin that answers for it: pointing at a line asks the same question
  its label does. The dot a wire ARRIVES at is filled in that value's colour,
  exactly as the one it leaves is — marked at one end only, a fed slot reads as
  one nobody wired, and hollow-against-filled is how a box says which of its
  slots are actually carrying something.

  **Zooming in costs the answer, and it is given back at the edge.** Close enough
  to read a box, most of what the boxes are joined TO is off the screen, and a
  line running off the edge stops saying anything. So a line that crosses the
  edge gets a pill AT that edge naming what is at its far end, each name in its
  own line's colour. Pills are pinned to the edge they crossed rather than left
  where the curve was last seen, merged into a LIST when they cross within a
  pill's length of each other — and only then, since merging by name instead put
  one pill at the average of two crossings a screen apart, naming a box neither
  line was near — a box near the edge sends four wires the same way, and four pills
  on one crossing is four times the ink for one fact — and then pushed apart along
  the edge until none covers another. A condition whose place on its arc has gone
  off screen slides ALONG the arc to the nearest place it can still be read, and
  then off anything already written there: upwards, since what it most likely
  landed on is the pill naming the far end of its own arc, and downwards only when
  up would leave the pane. All of it is worked out in viewport space, because all
  of it is a question about the camera rather than about the drawing.

  **Attention is depth, not colour.** Hue is spent on which value and which
  direction, so emphasis cannot use it; what is left is weight, opacity and
  order. One model serves all four hovers, so they cannot drift into four ideas
  of what "related" means: the thing under the pointer and the lines that ARE its
  answer are lit and raised, whatever those lines touch stays legible, and
  everything else falls back hard. A box lights its own lines and recedes its
  neighbours; a rule — pointed at by its condition or by the arrow itself —
  lights that arrow and BOTH boxes it joins; a port lights the wires through it
  and the ports at their far ends; a term in a guard lights the one wire it
  reads. Lines are re-ordered rather than only restyled — in SVG the only
  z-index there is is the order they are painted in.

  **Columns are never shared.** An arc runs vertically out of the box it leaves
  before it turns, so a box directly above or below another would have that arc
  pass straight through it. With a column each, every vertical run is over empty
  ground and no transition ever crosses a box. Lane 0 is TOP-aligned rather than
  centred, so the sequence's own line runs level across the headings instead of
  through the ports, where it used to be lost.

  **The canvas is a map.** Drag to pan, wheel to zoom about the pointer, no
  scrollbars: a graph is not a page, and the reader is looking for a region rather
  than a position in a list. It opens fitted and stops fitting the moment anyone
  moves it; fitting has a floor, below which it parks at the entry rather than
  shrinking a nine-child state to an unreadable third.
- **The Files column's lower half has three positions**, not two: the whole
  column, the split, or folded away to the bar that restores it. The middle is
  the default — what the state is DOING above, what it IS below — and the two ends
  are the two things people actually do: watching a run wants the board, and
  authoring a nine-child state wants the editor. One control in one place cycling
  through the three, its glyph showing how much of the column the half currently
  has rather than an arrow that stopped being unambiguous the moment there was a
  third position. Remembered like a pane size, in `ui.modes` — the same map any
  future control with more than two positions uses, since a fold is a boolean and
  a position is a word.
- **A linked property shows what it says.** A reference moves the substance of a
  field into another file — `"prompt": {"$ref": "$/prompts/draft.md"}` — and the
  form is then showing a path where six lines of prompt used to be. The target is
  rendered underneath, read-only, in the same viewer the rest of the app shows
  that kind of file with: a markdown prompt as markdown, a JSON fragment as a
  tree. Open by default, because the reason to look at a linked field is almost
  always to read what is behind it; collapsible, because once you know, it is a
  filename again. The reference is resolved against the file tree the window
  already holds — `refForPath` read backwards, project layer first, the same
  order the loader would search — so it costs no round trip beyond reading the
  one file.
- **Pruning panel** (§12, SPEC §13): stored counts, then preview → delete. Never
  one click, because pruned history is not recoverable.
- **Debug** (§11.3): a two-state workflow this app installs and runs against
  itself, with the files, the instance tree, the events and the transcript all on
  screen. In the sidebar rather than inside Settings — it is what you reach for when
  the app is misbehaving, and burying it behind a configuration screen would make
  it hardest to find in exactly the situation it exists for.

### 11.2 IPC Contract

Hand-rolled typed contract in `@jaira/shared` over `ipcMain.handle` /
`invoke` + a push channel (`webContents.send`) for engine events. Zod-validated
at the boundary on both sides. Board state is a subscription: the renderer
subscribes to task/instance change events and maintains a local store
(Zustand); no polling.

### 11.3 The Debug view — a self-test you can watch

Every screen in this app is downstream of one question: *does a workflow, run
here, actually work?* Until this view there was no way to ask it without first
authoring a workflow, configuring a provider, creating a task and reading a
board — four things that can each be the broken one, so a failure anywhere said
nothing about where.

The Debug view asks it in one click. It installs a two-state workflow, runs it as
an ordinary task, and shows the answer beside the machinery that produced it.

**The workflow is two prompt states, and the second is the point.**
`debug/hello_world/say` is asked to say hello world and publishes the reply as a
typed `string`. `debug/hello_world/check` declares that string as a **required
input**, wired on the mount as `.children.say.outputs.greeting`, and reports
whether it was a hello-world greeting. So a pass proves more than "the provider
answered": the first call's structured output validated, bound, crossed the
sequence, and was interpolated into the second call's prompt. Had the wiring
broken, `check` would be judging an empty string — and its prompt asks it to say
so rather than to guess.

**Nothing about it is a special path.** The files are written through
`workflow:write`, the task through `task:create`, the run through `task:start` —
the same three channels the Files tree and the board use. That is what makes a
pass here mean something about the real thing, and it is why the pane shows the
state files verbatim and links each one into the Files view: what it runs is
inspectable, editable and deletable like anything else.

**Two run modes, and reaching for the second is the diagnostic.** *Scripted*
replaces the model with canned replies (`fake`, the same surface the CLI's
`--fake` exposes) and exercises the engine, the bindings, the journal, the board
and every panel with no provider and no cost. *Live* is the identical run against
whatever `models.default` resolves to. Scripted passing and live failing is a
provider problem; scripted failing is a JaiRA problem. Splitting the two is most
of the value of the view.

**The files live in the shared root** (§3.1), not in the open project: the
self-test is a fact about this installation, and three debug files under a
checkout's `.jaira/` are three files in its next commit. A run installs only what
is MISSING, so a file someone edited to try something is never silently
overwritten — the pane reports the difference and offers the overwrite as its own
button.

**No model is pinned anywhere in the workflow.** Every prompt state inherits
`models.default`, so the self-test asks whatever this machine is actually set up
to ask. Pinning one would make it a test of a model rather than a test of the
installation.

**A pass is a literal `true`.** The verdict comes off a model, so a missing
field, a string `"true"`, or a run that failed before publishing anything all
read as *no verdict* — a truthiness check would turn two of those three into a
green banner. The pane shows the greeting beside the judgement for the same
reason: a verdict without the evidence it judged is one you cannot check.

The rest of the pane is borrowed rather than rebuilt — the task panel, the
session transcript and the journal viewer are the same components Tasks and Files
render. A debug view that drew its own version of the screen it exists to test
would be testing the wrong screen.

#### 11.3.1 The component gallery — every surface, with nothing behind it

The self-test answers *does a workflow run*. The gallery under it answers the
question a run cannot answer cheaply: *what does the thing it parks at look like,
and what does an answer to it return?* A UI state's entire visible behaviour comes
from a config an author writes inside a state file, and the only way to see one
was to author that file, start a run and wait for the engine to reach it.

**One card per surface, and the three kinds are distinguished.** The six built-in
components a state's `operation.function` may name (§7.1) are `interaction`
cards; the raw-JSON fallback for a function that is NOT built in is a seventh,
because a typo in `operation.function` is a thing you should be able to
recognise; and the two dialogs JaiRA raises on its own — a command approval
(§10.2) and a running agent's question — are `approval` and `question`. All three
are things that appear in front of a person, which is what the gallery is a
gallery of; only the first is a component in the engine's sense, and the cards say
so rather than blurring it.

**It renders the real dialog.** Each card parses its config with
`parseComponentConfig` — the call main makes on a live gate — hands the result to
the same `InteractionDialog` the real gate renders, and checks a submitted answer
with `validateComponentResult`, which is what main runs before an answer may enter
the engine. A malformed config therefore produces the authoring error a run would
produce, in the same words. The only thing missing is the engine.

**The config is editable two ways, and it is one document.** A form generated
from the surface's schema, and the app's JSON editor validating against that same
schema — the state editor's Form/JSON switch, meaning the same thing. The schemas
are registered so `schema:validate` can resolve them by id, and registered
*unpickable*: a component config is a fragment of a state file, never a file, so it
must never be an answer to "what schema is this `.json`".

**The changeset gate gets a fixture, not a mock.** Its changeset carries each
change's content inline, so the reviewer reads exactly what it reads in a real
review; the drift check is the one thing it cannot do offline, and a host that
supplies no reader gets no badges rather than wrong ones — the reviewer already
treats an unreadable path as silence.

## 12. Task Lifecycle and Board Semantics

- Task creation: title/description (+ optional issue artifact), workflow root
  state, optional branch binding → `.jaira/system/tasks/<id>.json` + `task_runtime`
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
- Pruning (spec §13): a prune job deletes `events`/`command_log` rows and the
  `runs` they belong to, older than a cutoff, **skipping** anything belonging to a
  non-terminal task (the resume-safety rule, enforced by query, with FK integrity
  checks in tests). Revised by §1j: the rule is *stricter* than "rows reachable
  from active instances" because the journal is the resume source in full, and the
  latest run of a terminal task is kept by default because the detail view is drawn
  from it. `operations`/`transitions`/conversation artifacts are not pruned because
  those tables do not exist yet (§4.2, TODO.md).

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
7. **Breadth** — ✅ done (§1j) — `generic-cli` executor (`claude-cli`'s hook
   loopback was already upstream's MCP-bridge path), conversation `summary` mode as
   a summarizing `SessionStore`, history pruning (§12) with `jaira prune` + a
   pruning panel, and the workflow browser / lint surface (§11.1) with a live
   re-lint watcher.

Phases 1→3→4 each end in a demoable milestone; the phase-1 headless CLI path
remains the fastest debugging surface permanently.

## 15. Resolved Open Questions (spec §15)

| # | Question | Resolution |
| --- | --- | --- |
| 1 | Artifact location | **A configurable destination URI** (§7.6) — `virtual:` or a `file:` path template over a closed variable set (`$DEFAULT`, `$CENTRAL`, `$CENTRAL_FLAT`, `$WORKTREE`, `$TASK_ID`, `$RELPATH`, `$SLOT`, …), so backend and path derivation stay independent. JaiRA owns the agent's write tool, so it controls where bytes land while the agent still sees its own path. Built. |
| 2 | State file extension | `.json` inside `.jaira/workflows/` (directory already scopes meaning) |
| 3 | Omit `id`? | Yes — derived from path; if present it must match (validator error otherwise) |
| 4 | Minimum UI components | The spec's five: choose_option, review_artifact, edit_artifact, fill_form, confirm_action |
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
  pretending uniformity. `generic-cli` runners start policy-weak by design; §1j made
  that concrete by declaring `policyEnforcement: "none"`, which means the gate
  refuses them unless the project turns the built-in approval classes off. The gate
  itself was also found to have been matching nothing (TODO.md) — a reminder that a
  mitigation needs a test proving it *fires*, not only that it compiles.
- **PowerShell command parsing is heuristic.** Unparsable ⇒ require_approval
  is the safe default; WSL projects get the robust POSIX parser.
- **Claude Code hook loopback (approval flow) is the most intricate adapter
  plumbing.** Sequenced last among the Claude adapters (phase 7); the SDK
  adapter covers the same provider with a clean callback in phase 4. Resolved (§1j):
  the plumbing lives upstream — the CLI adapter's MCP bridge plus
  `--permission-prompt-tool` *is* the loopback, which is why it declares
  `policyEnforcement: "callback"`. JaiRA writes none of it.
- **PENDING semantics are novel.** Confined to one evaluator module with
  exhaustive tests; the spec's §10.4 example is an acceptance test.
- **WSL path mapping edge cases.** All mapping through one `PathMapper` with
  table-driven tests; WSL support lands in phase 6 after the engine is stable.
