# JaiRA — known gaps

Deliberate omissions and deferred work, tracked so they are not mistaken for
oversights. **Open items only** — what has landed is recorded in git history and in
[DESIGN.md](DESIGN.md) §1a–§1j's status updates, not here. Phase numbers refer to
DESIGN §14, which is complete.

## Gaps inside completed phases

These live in phases marked ✅. They are real, and each one is a bug the moment its
assumption breaks.

- [ ] **Nothing offers to kill a reported orphan.** Child processes are recorded
      through an `ExecObserver`, and orphans of a dead session are *reported* at
      project open — reported, never killed, since a pid alone is not identity. The
      warning names the command and pid; acting on it is manual. Killing safely needs
      pid + start time, so this wants a deliberate design rather than a `process.kill`.
- [ ] **The SDK agent's subprocess is untracked.** `claude-cli` is observed through
      JaiRA's own spawn; `claude-code` runs in-process via the SDK, which has no spawn
      seam to hook.
- [ ] **The app has no "what is running" view.** `jobs.live()` answers it and nothing
      renders it.
- [ ] **Parked requests are process-local.** The interaction hub and the approval hub
      live in the process driving the run, so a gate the CLI parked on cannot be
      answered from the app. Answering means routing a *value* back, so unlike cancel
      this genuinely needs a channel.
- [ ] **No project-open UI.** The `project:open` IPC channel and the store's
      `openProject` action both exist and are unused: the app opens whatever
      `JAIRA_PROJECT` / argv / cwd supplies, with no folder picker.
- [ ] **No worktree removal in the app.** CLI-only (`jaira worktree remove`).
      DESIGN §9.2's "removed when the task completes and the user confirms" has no UI,
      so the confirmation flow exists only as a CLI flag (`--force`).
- [ ] **Subtasks are a link only** (§12, §15 Q9/Q10 — the MVP position).
      `TaskMeta.parentTaskId` is stored and nothing reads it: no board grouping, no
      `waiting_for_event` state, no parent/child rollup.
- [ ] **§4.2 tables are partly deferred** (§1b item 2). `command_log` landed with
      phase 6, `artifacts` with §7.6 and `jobs` with §4.2a; `instances`, `operations`,
      `transitions` and `conversations` still do not exist — the board and detail views
      are projected from the `events` journal instead. They land with step-level
      resume, which needs `@declarative-ai/hw` support.
- [ ] **Workflow migration for a running task is out of scope** (§5.3). The escape
      hatch is "restart the task on current workflows"; there is no UI for it, and
      nothing detects a task pinned to a snapshot the current format cannot read —
      `loadSnapshot` just fails its content-address check.

## Specified but never built

Surfaces DESIGN describes that no phase claimed. They are not regressions — no status
update says they landed — but §14 is complete, so nothing is scheduled to pick them up
either.

- [ ] **Skills (§7.4, §15 Q11) — DEFERRED, not scheduled. The spec is obsolete and the
      research is done; this entry records what was found so the next attempt starts
      from it. Recommended path when picked up: the tool pair, then projection; treat
      `container.skills` as an Anthropic-only optimization.**
      `jaira init` creates `.jaira/skills/` and nothing reads it. But §7.4's mechanism
      is *gone upstream*, not unbuilt: `prompt.skill` and `registry.skills` were
      deleted and replaced by a file REFERENCE resolved at load time
      (`prompt: {"$ref": "$/prompts/review.md"}`, REFERENCES §7.1 —
      `hw/format.ts`'s `OperationFields.prompt`, `hw/engine.ts`'s
      `runPromptOp`). `registry.skills` survives only as a vestigial field on
      `CapabilityRegistry` that nobody populates. That covers the AUTHOR-INVOKED
      reading of a skill entirely — a reusable prompt is an import, and since calls
      landed (EXPRESSIONS §3) an expression can invoke one: `review(inputs.diff)`.
      What is NOT covered is the MODEL-INVOKED reading — a catalog of
      name+description in context that the model itself chooses to pull the body from,
      the way Claude Code's `.claude/skills` works. An import cannot express that: the
      author decides, not the model.
      The FORMAT is settled even though the mechanism is not: Anthropic's `SKILL.md` +
      YAML frontmatter (`name` ≤64 chars, lowercase/numbers/hyphens, may not contain
      "anthropic"/"claude"; `description` ≤1024) is the SAME layout `.claude/skills/`
      uses. So `.jaira/skills/<name>/SKILL.md` is one local format serving all three
      consumers below.
  - [ ] **Delegated agents — projection.** Point `claude-code`/`claude-cli` at
        `.jaira/skills/` so its native filesystem mechanism finds them. Config + path
        work, no loader. Cheapest of the three.
  - [ ] **Anthropic prompt ops — publish + reference.** `@ai-sdk/anthropic` exposes
        `container.skills` (`{type: 'anthropic'|'custom', skillId, version}`) in provider
        options, `llmConfig`'s `providerOptions` passthrough parses it, and `generate.ts`
        forwards it to `streamText` — so a HOSTED skill (`xlsx`, `pptx`, …) works today
        with config alone. A CUSTOM skill cannot: content is never inline, it must be
        uploaded first via `POST /v1/skills` (multipart `files[]`, zip or path-qualified
        files, <30MB, beta `skills-2025-10-02`), which returns `skill_id` +
        `latest_version`. So this needs a publish step keyed on a content hash of the
        skill directory, so a new version is cut only when the files change — the
        content-addressed store artifacts use is the natural home for that map. Note the
        upload is `client.beta.skills.create` on `@anthropic-ai/sdk`, a control-plane
        dependency the inference path does not otherwise have. Two hard limits: the API
        sandbox has NO network access and NO runtime package installation, and the skill
        runs in Anthropic's container, outside the policy engine.
        The provider DOES export the code-execution tool the skill body runs in
        (`anthropic.tools.codeExecution_20260120`), so the path is complete apart from
        publishing — but that tool is a server-side executor absent from `registry.tools`,
        so enabling skills enables code execution the policy engine cannot gate.
        The AI SDK is REFERENCE-ONLY: `skillId` is the sole handle, there is no content
        field and no `skills.create`, so publishing never meets inference.
  - [ ] **Every other provider — a tool pair. Build this FIRST; it is the only portable
        mechanism.** `list_skills` / `load_skill` registered in `registry.tools`,
        returning the body as tool output. Provider-neutral, policy-gated like any other
        tool, reads local files, no upload step.
        `@openrouter/ai-sdk-provider` has NO `skill` or `container` field at all — skills
        are an Anthropic-direct feature, not something the router can offer uniformly.
        And the failure is SILENT: `providerOptions` is keyed by provider id and each
        provider reads only its own key, so a workflow setting
        `providerOptions.anthropic.container.skills` that resolves to an OpenRouter model
        does not error — the skill just never loads and the model answers without it.
        Since the router picks a provider by model name, a config change can move a
        workflow across that line. `container.skills` is therefore an Anthropic-only
        optimization (worth it for the pre-built `xlsx`/`pptx` skills), not the base.
- [ ] **No Playwright E2E (§13, "E2E (thin)").** Board navigation, one UI-component
      round-trip and one approval flow were to be covered end to end through the real
      Electron app. What exists instead is `JAIRA_CAPTURE` screenshots (manual, by eye)
      plus headless `AppService` tests, so nothing exercises the actual preload/IPC
      boundary in CI.

### Left open inside artifact storage (§7.6)

The destination is a configurable URI/path template, JaiRA owns the agent's write
tool, and both producers go through one placement rule. What that left behind:

- [ ] **Native-write reconciliation** via `git status --porcelain` on the task worktree
      when an operation ends, for agents using their own write tool (`nativeTools`,
      `injectTools: false`, `generic-cli`, `bash` redirection). Best-effort by
      construction (§7.6's stated leak) — a native re-read of a moved file will still
      miss.
- [ ] **Prune follows the destination**: `$JAIRA`-rooted artifacts are derived state
      and should prune with their run; `$WORKTREE`-rooted ones are the user's work
      product and never should. `pruneHistory` does not touch `artifacts` at all yet.
- [ ] **Detail-panel artifacts list + markdown preview, and a conversation viewer**
      (§11.1). The data exists now; the views do not.
- [ ] **`jaira init` does not gitignore the artifact directory.** With the default
      `$DEFAULT` destination artifacts land in the worktree, which is intended (git
      versions them per SPEC §4.6) — but a project choosing `$CENTRAL` may want
      `jaira-artifacts/` ignored, and nothing offers that.

## Designed, not yet built

[EXPRESSIONS.md](EXPRESSIONS.md) — an expression is a tree of producer edges, the
operator set is a registry, and a callee is an ordinary reference resolved along a
`path`. Most of it ships: the loader restructure (§9), snapshotting the resolved
definition (§11), the operator set (§2), the expression→tree flip (§1), `path` end to
end (§4), failures as data (§5), the built-in operation library, calls from an
expression (§3), and higher-order operations (§3.5).

What remains:

- [ ] **Laziness is a correctness debt, not an optimization** (EXPRESSIONS §6,
      deferred by agreement). Resolving an op's inputs resolves *every* bound parameter
      and returns `PENDING` if any one is, so lowering `&&`/`||`/`?:` to plain two-input
      ops turns `false && PENDING` from `false` into `PENDING` — a guard that fires
      today parks forever — and makes the untaken branch of a conditional actually run
      once arbitrary callees are admitted. Interim: `op.and` / `op.or` / `op.cond` stay
      hw resolver ops, defined with the names and signatures they would have as registry
      entries so migration is deletion. The general fix needs `Parameter.lazy` in `ops`
      plus a thunk in `exec`'s `resolveLiteralInputs`, which today rejects anything
      unresolved as a wiring bug.
- [ ] **hw's engine bypasses the dispatching executor — a layering violation, and the
      root of several other entries.** `@declarative-ai/exec` already implements the
      intended architecture: `OperationExecutor` IS the dispatching `Executor` (prompt →
      the prompt executor, function → a registry lookup), and its header states the point
      — "because this is an ordinary `Executor`, wrapper composition reaches FUNCTION ops
      too — memoize, retry, and deadline previously stopped at the registry boundary."
      A bare `runFunction` call belongs ONLY inside `OperationExecutor`, which is exactly
      where `exec` puts it. hw's engine instead calls `runFunction` directly in BOTH
      `runFunctionOp` (a state's function op) and `runEmbeddedOp`'s fallback (a function
      callee). `EngineConfig.operations` is the retrofitted seam and is consulted ONLY in
      `runEmbeddedOp`, so supplying one today still leaves every state dispatching raw.
      Dispatch should also own NESTED resolution: given an op whose parameters are bound
      to embedded operations, `OperationExecutor` resolves them recursively and dispatches
      a copy with the results bound in. The rule is just "an op handed to an executor is
      READY TO RUN" — it contains only literals and embedded operations. A `{refs}` tree
      or a local child NAME is not ready to run: it names hw's instance scope, so hw binds
      those to literals first. Today `resolveLiteralInputs` refuses both alike.
      hw does NOT split an operation up and dispatch the pieces — it resolves, then hands
      the whole tree over. PENDING exists because a CHILD STATE may not have produced in
      this round; an embedded op is a computation dispatch simply awaits, so it never
      parks. The two sides still share one resolve-and-bind helper: `resolveLiteralInputs`
      (exec) reads what `resolveEmbedded` (hw) writes, and them being two copies is what
      made the memo miss in the first cut.
  - [x] **Route `runFunctionOp` through `config.operations`.** Done: an `operations`
        accessor returns the host's executor or builds a plain `OperationExecutor` from the
        registry + prompt executor, so there is one path rather than a wrapped one and a raw
        one. `resolve.ts` gained `bindInputs` — the state-operation counterpart to
        `resolveEmbedded` — because the executor reads inputs off the op and cannot see the
        instance they were resolved against. Two things the change surfaced: `bindInputs`
        must ADD a slot for a name the op does not declare, or a function impl reading a
        state input its operation never declared stops receiving it (preserved, not
        decided); and the cost rollup needed `?? 0`, because the dispatcher frames every
        execution with its own timing and so always reports metrics, where a directly-called
        impl reported none — `WorkflowMetrics` types `costUsd` required, which is true of a
        record an impl BUILDS and not of one framed around it, and adding `undefined` made
        the run total NaN.
  - [x] **Recursive resolution of embedded-operation edges in `OperationExecutor`.** Done
        in `exec`: `start` runs any input bound to a whole operation on a data kind — through
        ITSELF, so the nested op reaches the right executor by its own kind — substitutes the
        outputs, then dispatches. Nested failures travel whole (classification intact, so the
        retry wrapper above still has something to act on), nested metrics roll up, and an op
        with no embedded edges takes the old path untouched. Higher-order edges
        (`kind: prompt`/`function`) still pass the definition through.
  - [x] **Retire hw's duplicated DISPATCH.** Done: `runEmbeddedOp` was three branches — a
        composed stack if the host wired one, else a prompt path, else a registry call —
        which is dispatch-by-op-kind written a second time in the layer above the executor
        that exists to do it. Now one call through `this.operations`. hw imports
        `runFunction` nowhere; every operation in the engine reaches an impl through the
        executor. Collapsing settled two ways the branches had drifted: the composed branch
        passed `delegates: false` unconditionally, so a delegated agent reached through a
        CALL got policy-gated tools where the same adapter reached as a state's operation got
        raw ones; and the registry branch merged `instance.inputs` into a callee's inputs
        where the composed branch did not — the op's own bindings win, because the memo key
        is `hashOperation` of exactly that op and a merged input the key never saw could
        return a result computed under different values.
  - [ ] **"Hand the whole binding tree to dispatch" — possible, but gated on registering
        the operators.** An expression lowers to one `FunctionOp` per node:
        `shout(inputs.x) === 'y'` becomes `strictEq(shout(context("inputs.x")), 'y')`, where
        `strictEq` and `context` are `RESOLVER_REFS` computed inline and `shout` is a real
        callee. The scope leaves are NOT an obstacle — under the rule hw already follows,
        `context(...)` resolves to a literal before anything dispatches, and what is left is
        operators and callees only. The single blocker is that operator names have no
        registry entries: recursion reaches `shout` fine and then fails `functions.get
        ("strictEq")`. Registering the built-in set fixes it and is EXPRESSIONS §2's stated
        direction ("`add(a, b)` and `a === b` differ only in spelling"). What that needs:
    - [x] **The compiled representation** (`exec/src/compile.ts`). `CompiledOperation` is the
          document PLUS the entries its names resolve to: `op` stays serializable (memo keys,
          snapshots) and `entry` rides alongside, so reaching an impl is a property access
          rather than a registry lookup per node per round. Not a field on `Operation` — that
          would make an operation unhashable and a snapshot unreadable; not a side table
          either — a lookup keyed by identity puts back the cost the hoist removes.
          `tryRunPureSync` evaluates a wholly-pure tree with no handle, no `AbortController`,
          no metrics frame and no microtask, and declines (having run nothing) as soon as a
          node needs the environment. The line is drawn on `entry.kind === "pure"` — a pure
          impl takes no `ctx` at all — so a user's registered pure function gets the same fast
          path as `eq`, which is EXPRESSIONS §2's claim made true of the mechanism and not
          just the spelling. `compileOperation` also reports an unknown name at COMPILE time,
          where today a missing function surfaces mid-run and has to be treated as run-fatal.
          **No consumer yet** — nothing in hw or JaiRA compiles anything. That is the next step
          and the load-bearing one.
    - [ ] A substitute-leaves pass. `resolveInputs` evaluates a tree to a VALUE; nothing
          rewrites scope leaves to literals and returns the tree as structure.
    - [ ] An executor reachable from inside a registry impl (via `ExecServices`), because
          `map`/`filter`/`flatMap`/`reduce` must dispatch N applications built per element —
          registering them as functions is not sufficient on its own. This is the only piece
          that is new machinery rather than a decision.
    - [ ] A judgement on cost. Operators are computed inline and synchronously today,
          re-evaluated per guard per scheduling round; dispatching each node means a
          capability lookup, handle construction, abort linking and a metrics frame for
          `a === b`. Keeping PURE operators inline while dispatching CALLEES — what the code
          does now — is a defensible end state, and if chosen, the substitute-leaves pass is
          not needed either.
  - [ ] Compose the stack in JaiRA and pass it. The wrapper LEVEL is a real choice, not
        an accident: llm-aware wrappers (`withRateLimit`/`withBudget`/`withSession`, which
        live in `promptop`) belong on the prompt executor at the leaf, where `withRetry`
        already is; op-level wrappers go above dispatch. **Memoize at the prompt leaf** —
        that is where the cost and the latency are, and it keys on the RENDERED prompt op,
        which is the identity worth reusing. Memoizing over the dispatcher instead would
        key the whole composite; legitimate, but a bigger claim. Known gap either way: a
        delegated agent is a FUNCTION op billing inside its own loop, so a prompt-leaf
        memo never sees it — and memoizing one needs workspace identity (`treeHash`,
        declarative-ai DESIGN §3.4) to be correct at all.
        Deleting the engine's `callCache` is a CORRECTNESS fix, not just a relocation: it
        keys on `hashOperation` with no capability check, where `withMemoize` reads the
        DISPATCHED entry's record (`if (!caps.memoizable) return innerExec.start(...)`)
        and refuses a `mutatesWorkspace` entry outright unless `ctx.workspace.treeHash`
        pins the snapshot. `memoizable` is required per variant — `PURE`/`HOST` declare
        `true`, `RUNTIME` (the agent adapters) declares `false` — so the engine cache
        currently memoizes ops their own entries say must not be.
        Consequence to expect, and to accept: a function callee re-runs where it used to
        be remembered — per scheduling round in a guard, which re-evaluates each round.
        That is fine. Anything reachable from an expression is `pure` or `readOnly` host
        code by declaration, resolution is synchronous, and built-in operators never
        dispatch at all. The one case that gets genuinely more expensive is a guard
        calling a `memoizable: false` runtime adapter — which the engine cache was
        memoizing incorrectly, and which the validator (it already walks guards) is the
        right place to refuse.
  - [ ] **Durable `callCache` — probably NOT its own feature.** `EngineConfig.callCache`
        forwards through `WorkflowExecutorOptions` and JaiRA's `WorkflowRunConfig`, and
        nobody supplies one, so an identical call is paid for once per run. But if
        dispatch owns nested resolution, this collapses into `withMemoize({cache})` at the
        chosen level and the bespoke seam goes away. What survives either way is the
        need for a durable `MemoCache` — the content-addressed store artifacts use.
- [ ] **Built-in op documents under `$JAIRA/functions`**, which §4 already put on the
      path — the `Vfs` overlay serving them under `$/functions` (EXPRESSIONS §4.3). A
      project can already put its own there; the default path lists the directory, which
      is harmless while it is empty.
- [ ] **`children[].state` does not search the path.** It resolves through `ref.ts`'s
      `resolveStateRef`, which does path arithmetic with no filesystem, so it cannot
      test a candidate's existence and would always take the first entry. Needs an
      existence oracle (the bundle's file map, or the vfs) — a separate decision.
- [ ] **The snapshot directory is no longer human-legible** (EXPRESSIONS §11.4). Same
      layout, but desugared bindings, inlined fragments and derived schemas. Storing the
      authored files alongside would fix it; deferred rather than decided.
- [ ] **Should a prompt call be conversational?** A prompt callee renders its own
      template, keeps its own output contract, and deliberately gets no conversation
      preamble and no transcript append — a call is a computation embedded in a binding,
      not a turn in the enclosing state's conversation. Worth revisiting if authoring
      practice wants the other reading.

## Open inside phase 6 (process executors + policy)

- [ ] **SDK agent (`agents-api`) unverified.** It lazily imports
      `@anthropic-ai/claude-agent-sdk`, which is not installed here, so only the CLI
      variant has run for real (`claude` v2.1.142, kept repeatable as the opt-in
      `JAIRA_LIVE_AGENT=1` test).
- [ ] **Tool injection over MCP is untested.** The live run used the adapter's default;
      whether our injected `bash` reaches the agent over the MCP bridge (and is
      therefore policy-gated *inside* an agent loop) has not been observed end to end —
      only the gate itself is tested, directly.
- [ ] **Path policy is only the `.jaira/**` deny rule.** DESIGN §10.1's broader idea —
      an allow-list of the worktree root plus authored path rules — is not an authored
      surface yet.
- [ ] **`smart` mode is inferred from a fixed tool-name list** (`bash`, `shell`,
      `run_command`, …). A tool that runs commands under an unrecognized name gets the
      baseline mode instead of command parsing.

## Open inside phase 7 (breadth)

- [ ] **No `generic-cli` verified against a real binary.** The runtime is tested
      against a stand-in node script end to end, but no actual opencode/codex run has
      happened, so their argv conventions are assumed rather than observed.
- [ ] **A generic agent cannot run under the default policy, by design.** Its
      `policyEnforcement: "none"` plus SPEC §11.3's built-in approval classes means §8.2
      refuses it unless the project sets `policy.builtins: false`. That is the honest
      outcome, but a middle ground (deny-by-default for the agent's own tools) does not
      exist.
- [ ] **Summary mode compacts per SESSION, not per state.** One session has one
      transcript, so a session mixing `summary` and `full_history` is summarized for
      both; the workflow browser warns, and nothing finer is possible without an engine
      change.
- [ ] **Pruning does not touch artifacts or conversations.** DESIGN §12 lists
      "conversation artifacts"; there are no such tables yet (see the §4.2 entry above),
      so pruning covers `runs`, `events` and `command_log` only.
