# JaiRA — known gaps

Deliberate omissions and deferred work, tracked so they are not mistaken for
oversights. Phase numbers refer to [DESIGN.md](DESIGN.md) §14; status updates
§1a–§1i record the decisions behind each entry.

## Gaps inside completed phases

These live in phases marked ✅. They are real, and each one is a bug the moment
its assumption breaks.

- [x] **Liveness on a `running` run — fixed (DESIGN §4.2a).** Built 2026-07-28:
      a `jobs` table records process claims, `recoverInterrupted` asks "is there a
      live job?" instead of assuming there is not, and a second process is refused
      rather than taking a task over. Cross-process cancel came with it, as a polled
      `cancel_requested_at` flag. Child processes (git, `wsl.exe`, `claude`, bash
      commands, generic-cli agents) are recorded through an `ExecObserver` on the one
      seam they all pass through, and orphans of a dead session are reported at
      project open — reported, never killed, since a pid alone is not identity.
      Still open inside it:
  - [ ] **Nothing offers to kill a reported orphan.** The warning names the command
        and pid; acting on it is manual. Killing safely needs pid + start time, so
        this wants a deliberate design rather than a `process.kill`.
  - [ ] **The SDK agent's subprocess is untracked.** `claude-cli` is observed
        through JaiRA's own spawn; `claude-code` runs in-process via the SDK, which
        has no spawn seam to hook.
  - [ ] **The app has no "what is running" view.** `jobs.live()` answers it and
        nothing renders it.
- [ ] **Parked requests are process-local.** The interaction hub and the approval
      hub live in the process driving the run, so a gate the CLI parked on cannot be
      answered from the app. Answering means routing a *value* back, so unlike
      cancel this genuinely needs a channel.
- [ ] **No project-open UI.** The `project:open` IPC channel and the store's
      `openProject` action both exist and are unused: the app opens whatever
      `JAIRA_PROJECT` / argv / cwd supplies, with no folder picker.
- [ ] **No worktree removal in the app.** CLI-only (`jaira worktree remove`).
      DESIGN §9.2's "removed when the task completes and the user confirms" has no
      UI, so the confirmation flow exists only as a CLI flag (`--force`).
- [ ] **Subtasks are a link only** (§12, §15 Q9/Q10 — the MVP position).
      `TaskMeta.parentTaskId` is stored and nothing reads it: no board grouping, no
      `waiting_for_event` state, no parent/child rollup.
- [ ] **§4.2 tables are partly deferred** (§1b item 2). `command_log` landed with
      phase 6, `artifacts` with §7.6 and `jobs` with §4.2a; `instances`,
      `operations`, `transitions` and `conversations` still do not exist — the board
      and detail views are projected from the `events` journal instead. They land
      with step-level resume, which needs `@declarative-ai/hw` support.
- [ ] **Workflow migration for a running task is out of scope** (§5.3). The escape
      hatch is "restart the task on current workflows"; there is no UI for it.

## Specified but never built

Surfaces DESIGN describes that no phase claimed. They are not regressions — no
status update says they landed — but §14 is complete, so nothing is scheduled to
pick them up either.

- [ ] **Skills (§7.4, §15 Q11) do not exist.** `jaira init` creates
      `.jaira/skills/` and nothing ever reads it: no `skill.json` + `prompt.md`
      loader, and `registry.skills` is never populated. The engine *does* support
      the reference (`prompt: { skill: "x" }` lowers to a `skill:` marker in the
      op's `user` slot), so a workflow authoring one fails at run time on an
      unresolved skill rather than at lint. The work is a loader plus registration
      — the adapter machinery is already there, which is the whole point of §7.4.
- [x] **Artifacts are written to disk (DESIGN §7.6).** Built 2026-07-28: the
      destination is a configurable URI/path template, JaiRA owns the agent's write
      tool, and both producers (tool writes and returned blob content) go through
      one placement rule. What landed:
  - [x] `write_file` / `read_file` registered — the interception point, since
        upstream injects each tool as `run: (input) => tool.run(input, ctx)`.
  - [x] Durable logical → physical map (the §4.2 `artifacts` table), so a path
        resolves in a later state, a later run, and after a restart.
  - [x] `config.artifacts` — `destination` / `dir` / `inlineMaxBytes`, with
        `$DEFAULT`, `$CENTRAL`, `$CENTRAL_FLAT` aliases; the legacy `artifactDir`
        still parses and seeds `artifacts.dir`.
  - [x] Content hash + `inlineMaxBytes`, so a large artifact stops riding inline
        in the journal.
  - [x] `persistEngineArtifacts` for states that *return* blob content, so a
        workflow with no agent in it produces files too.
  - [ ] **Native-write reconciliation** via `git status --porcelain` on the task
        worktree when an operation ends, for agents using their own write tool
        (`nativeTools`, `injectTools: false`, `generic-cli`, `bash` redirection).
        Best-effort by construction (§7.6's stated leak) — a native re-read of a
        moved file will still miss.
  - [ ] **Prune follows the destination**: `$JAIRA`-rooted artifacts are derived
        state and should prune with their run; `$WORKTREE`-rooted ones are the
        user's work product and never should. `pruneHistory` does not touch
        `artifacts` at all yet.
  - [ ] **Detail-panel artifacts list + markdown preview, and a conversation
        viewer** (§11.1). The data exists now; the views do not.
  - [ ] **`jaira init` does not gitignore the artifact directory.** With the default
        `$DEFAULT` destination artifacts land in the worktree, which is intended
        (git versions them per SPEC §4.6) — but a project choosing `$CENTRAL` may
        want `jaira-artifacts/` ignored, and nothing offers that.
- [ ] **No Playwright E2E (§13, "E2E (thin)").** Board navigation, one UI-component
      round-trip and one approval flow were to be covered end to end through the
      real Electron app. What exists instead is `JAIRA_CAPTURE` screenshots (manual,
      by eye) plus headless `AppService` tests, so nothing exercises the actual
      preload/IPC boundary in CI.

## Designed, not yet built

[EXPRESSIONS.md](EXPRESSIONS.md) — an expression becomes a tree of producer edges, the
operator set becomes a registry, and a callee becomes an ordinary reference resolved
along a `path`.

Most of it now ships: the loader restructure (§9), snapshotting the resolved definition
(§11), the operator set (§2), the expression→tree flip (§1), `path` end to end (§4),
failures as data (§5), the built-in operation library, and CALLING an operation from an
expression — prompt or function — resolved along the path and memoized (§3).

Higher-order operations now ship too (§3.5): `map`, `filter` and `flatMap` apply an
operation per element, memoized per element by the same content-addressed key.

What remains: generalized laziness (§6, deferred by agreement) and SUPPLYING the two
seams hw exposes — the plumbing for a durable call cache and a composed executor reaches
JaiRA, but nothing hands one over. That last one is a persistence decision about where
call results live, not more wiring.
Entries below are in dependency order; `[x]` means built and verified, with anything
still open nested under it.

- [x] **The loader is merge-after-resolve and has to become merge-before-resolve**
      (EXPRESSIONS §9). Ordering half done in `@declarative-ai/hw`: `desugarState`
      computes the environment before it desugars anything, and
      `resolutionEnvironment(inherited, own)` is the one definition of the chain,
      shared by a state's effective operation and by what its children inherit.
      Unifying the two sites fixed a bug they had drifted into — `loadBundle` read the
      **raw** document where `desugarState` read the **expanded** one, so a transcluded
      `environment` reached the declaring state and never its children, and what the
      children inherited was the reference string spread character by character.
      Regression test in `inheritance.test.ts`. Still open inside it:
  - [x] **Threading it into reference resolution.** Landed with `path` (EXPRESSIONS
        §4): `expandFor` takes the inherited search path, read off the state's RAW
        `environment` — which is where §9's cycle breaks, since a reference cannot be
        resolved with a path that has not been loaded yet.
- [ ] **Laziness is a correctness debt, not an optimization** (EXPRESSIONS §6).
      Resolving an op's inputs resolves *every* bound parameter and returns `PENDING`
      if any one is, so lowering `&&`/`||`/`?:` to plain two-input ops turns
      `false && PENDING` from `false` into `PENDING` — a guard that fires today parks
      forever — and makes the untaken branch of a conditional actually run once
      arbitrary callees are admitted. Interim: `op.and` / `op.or` / `op.cond` stay hw
      resolver ops, defined with the names and signatures they would have as registry
      entries so migration is deletion. The general fix needs `Parameter.lazy` in
      `ops` plus a thunk in `exec`'s `resolveLiteralInputs`, which today rejects
      anything unresolved as a wiring bug.
- [x] **Registry entries can declare a signature.** `EntrySignature` on every variant
      (`pure`/`host`/`runtime`), surfaced through the `FunctionCapabilities` view the
      validator reads. It buys the one check a name lookup cannot: a callee DOCUMENT
      declares the parameters a call binds to, the implementation lives in the registry,
      and without a signature the document is the sole authority — a renamed parameter
      surfaces as an argument nothing reads, at run time. The check is on parameter
      NAMES first, because comparing schemas alone misses it entirely: JSON Schema
      objects are open, so an impl declaring `body` validates `{text: …}` quite happily.
      Where both sides declare a type, the types must agree too. An entry declaring no
      signature constrains nothing.
- [x] **The snapshot pinned the input to definition evaluation, not its output**
      (EXPRESSIONS §11). Done, as a hard cutover — **snapshots written before this are
      unreadable, and a task pinned to one must restart on current workflows** (DESIGN
      §5.3's escape hatch; nothing detects it, `loadSnapshot` just fails its
      content-address check). `snapshotHash` now covers the resolved states,
      `ensureSnapshot` stores them, and `loadSnapshot` deserializes instead of
      re-running the loader. The referenced-file machinery is gone — a fragment is
      inlined, so it is in the identity by construction. Two things the design missed:
      the loader re-run was also in hw's `WorkflowExecutor`/`workflowIdentify`, so
      `HierarchicalWorkflowDefinition` is now the resolved bundle; and three call sites
      read `bundle.source` because that is what a snapshot used to store — two of them
      the §8.2 capability gate, which would have gated every pinned run against `{}`.
      Prerequisite fixed first: `LoadedState.fanOut` was a `Set` and serialized to
      `{}`, silently. Still open inside it:
  - [ ] **The snapshot directory is no longer human-legible.** Same layout, but
        desugared bindings, inlined fragments and derived schemas. Storing the authored
        files alongside would fix it; deferred rather than decided (EXPRESSIONS §11.4).
- [x] **Property lookup on data reached the prototype** (EXPRESSIONS §12). Fixed in
      `@declarative-ai/hw` ahead of call syntax, since `x.constructor(…)` is the
      standard route out of a sandbox and §3 adds the call form. Seven read sites
      (`expr.ts`, `inferExpr.ts`, `resolve.ts`, `reference.ts`, `validate.ts`,
      `shape.ts`, `engine.ts`'s permission lookup) each handed a **function** on where
      a JSON value, a schema, or a permission mode was expected. Plus the write-side
      variant: `JSON.parse` makes `__proto__` an own property, so an authored layer
      could replace the merged operation's prototype — harmless only because every
      consumer re-spreads, and due to stop being harmless at §4, where an inherited
      `path` is read off that object directly. Regression tests in `expr.test.ts`,
      `references.test.ts`, `resolve.test.ts`, `inheritance.test.ts`.
- [x] **The expression→tree flip** (EXPRESSIONS §1). Done: `{ expr }` lowers to a tree
      of operator producer edges, parsed once at load, and `expr.eval` is deleted —
      there is no interpreter left to invoke at resolution time. `fanout.ts` recognizes
      a child read structurally instead of re-parsing source, preserving the three
      distinctions that decide blob materialization (a specific output, a coarser read
      of every output, and `children.P.outcome` reading none). `validate.ts` types a
      leaf with the new `inferRef` over the tree and checks reachability over
      `referencePathsOf`. Two differential suites hold it in place: value semantics
      against the interpreter (42 expressions × 2 contexts, including a child that has
      not started, one still running, and an empty context) and inference against
      `inferExpression`. The first caught a real bug on its first run — the engine
      seeds the context with the PENDING sentinel as a *value* for a running child, so
      `children.running.outcome === 'success'` answered `false` instead of parking.
      Still open inside it:
  - [x] **Guards and `{{...}}` template holes lower too.** The last two runtime uses
        of the interpreter are gone: both resolve the lowered tree against a scope,
        with lowering cached per source string exactly as parsing was. `evaluate` now
        has no caller outside its own module and is kept deliberately — it is the
        reference semantics the differential test compares against, so deleting it
        would remove the oracle that proves lowering correct. The validator still
        reads the authored `when` string, which is the right layer for static analysis
        of what the author wrote.
  - [x] **Threading the environment into reference resolution.** Landed with `path`
        (EXPRESSIONS §4): `expandFor` takes the inherited search path, read off the
        state's **raw** `environment` — which is where §9's cycle breaks, since a
        reference cannot be resolved with a path that has not been loaded yet.
- [ ] **Errors as values — routing works for bindings; guards untouched**
      (EXPRESSIONS §5). A failure is a value with a TYPE — always; kinds differ in
      SHAPE, not in whether they are data — so routing is ordinary type checking
      against what the consumer declared, and terminating is the implicit unwrap.
      Built: `Failure<D>` and `FAILURE_SCHEMA` in `json` (with `ERROR_CLASSES` hoisted
      out of `encodedError.ts`, where the closed set was a private duplicate);
      `hw/errorValue.ts`; and `resolveInputs` binding a failure into any slot that
      declares it accepts one. `admitsError` needs BOTH a declared failure branch and
      an `isSubschema` match — the subschema check alone is far too permissive, since
      JSON Schema objects are OPEN and `{type:"object", properties:{plan}}` accepts a
      failure having never required `plan`. Still open:
  - [x] **A failed `{result}` routes — in hw, where it actually arises.** `exec`'s
        refusal is a defensive check on the dispatch contract, and could not consult
        `admitsError` anyway: `validate` depends on `exec`, so `exec` cannot import
        `isSubschema`. hw's `resolveRef` is where a `{result}` binding is really
        resolved, and it now carries the RECORDED failure whole instead of flattening
        it to its reason — which was losing the classification, so a
        `network-retriable` provider error arrived indistinguishable from a wiring
        mistake. Acceptance is checked against THAT failure's shape
        (`errorValueSchemaFor`), so a slot declaring it handles `policy-denied`
        accepts a denial and refuses a timeout.
  - [x] **Guards do NOT gain a fourth outcome** — a correction to §5.2. A lowered
        expression cannot error on DATA: every operator's failure case is "producer is
        missing X", which the loader cannot emit, and a missing namespace or property
        yields `undefined` rather than refusing. So the transition loop needs no error
        path; a non-value simply does not take the transition. The claim assumed guards
        would resolve the kind of reference that can fail, and they do not — an
        expression lowers entirely through `context.get`.
  - [x] **The unconstrained-slot exception is gone.** The value is WRAPPED
        (`{error: <failure>}`), so "any value, or an error" is writable as
        `{"anyOf": [{}, "$/types/failure"]}` and `{}` simply declares no error branch —
        the ordinary reading of what the author wrote, not a carve-out. Wrapping also
        stops ordinary data being mistaken for a failure: a classifier op returning
        `{classification, reason}` is plausible, and sniffing those fields would read
        its output as an error.
- [x] **`path` — the search list for bare references** (EXPRESSIONS §4). hw side done:
      an ordered `defaultRoot`, first-match-wins search, identity anchored to the FIRST
      entry only (so two files at two entries cannot collide on one bare id), `path` as
      an inherited `environment` field spliced with `$INHERITED` rather than exempted
      from the array-replace rule, and the loader threading it into expansion. The
      shadowing warning landed with it rather than being deferred — `PATH` semantics
      without a `which -a` is the hazard without the diagnostic. Still open:
  - [x] **JaiRA's half.** `config.workflows.path` (default
        `["$JAIRA/workflows", "$JAIRA/functions"]`), expanded against the same roots a
        reference uses and passed at every load site; the parser refuses a bare entry,
        since that would need the path to resolve itself. The workflows dir is forced
        FIRST whatever the config says — configuration decides what comes after, because
        only the first entry produces bare ids. Still to come: the `Vfs` overlay serving
        BUILT-IN op documents under `$/functions` (§4.3). A project can already put its
        own there; the default path already lists the directory, which is harmless while
        it is empty.
  - [ ] **`children[].state` does not search the path.** It resolves through `ref.ts`'s
        `resolveStateRef`, which does path arithmetic with no filesystem, so it cannot
        test a candidate's existence and would always take the first entry. Needs an
        existence oracle (the bundle's file map, or the vfs) — a separate decision.

- [ ] **Calling an operation from an expression — WORKS; two lint gaps remain**
      (EXPRESSIONS §3). `classify(inputs.issue)` and `shout(x)` resolve along the
      path, run (prompt ops and function ops alike, memoized by the resolved op's
      hash), and bind their results. `classify(x)`, `lib.review(a, b)` and `f(g(h(1)))` parse and
      compose; lowering refuses a call with a message naming what is missing. Three
      things the grammar settles: a callee is a dotted PATH (`(a ? f : g)(x)` is
      refused — an operation is NAMED, there is no function value to apply); the
      callee is not in the data scope (or `classify(x)` reads as an undeclared
      namespace and the validator rejects it); and `evaluate` refuses a call, since it
      is the reference semantics lowering is checked against, not a second execution
      path. Remaining, in order:
  - [x] **Callee resolution in the loader.** A name that is not a built-in resolves
        along the `path` to an operation DOCUMENT — the same `OperationFields` an
        `operation` block is written in — which is desugared and embedded in the edge,
        so `classify(inputs.issue)` lowers to `{op: <the operation>, parameters: {...}}`.
        §3.2's "a local name beats the path" is REFUSED rather than silently violated:
        naming a declared child throws, because resolving one needs the child's merged
        environment, which the loader does not have at that point.
  - [x] **Positional → named.** One mechanism for built-ins and user callees alike:
        `OPERATOR_PARAMS` gives a built-in's parameter order, a document's own `index`
        (else declaration order) gives a callee's. An operator is not special — its
        signature just ships with the language.
  - [x] **Engine dispatch for an author-embedded op — function ops run.**
        `shout(inputs.issue)` resolves, runs and binds its result. A LIGHTWEIGHT run
        path, not `runFunctionOp`: that one emits events against an instance id, reads
        the environment off `instance.def`, and hands its result to `acceptOpOutputs`,
        which writes the INSTANCE's outputs — none of which a call wants. It borrows
        the enclosing instance's environment (session, tools, permissions in force
        where the call is written) and returns its value to the binding, with no
        identity in the run record.
        Resolution stayed SYNCHRONOUS: the engine runs embedded ops first and
        `resolveProducer` reads the result, exactly as it reads `scope.childOutputs`,
        with PENDING covering not-yet-run. Both places bindings resolve are covered —
        operation inputs, and output bindings via `finishSuccess` (a derived output
        resolves at termination, and `finish` is sync).
        The memo is `hashOperation` of the op WITH ITS ARGUMENTS BOUND, so a call named
        twice is one execution and a call whose argument changed is a different call.
        That identity rule is `resolveEmbedded`, shared by the runner and the reader —
        two copies of it hash differently and the memo never hits, which is exactly the
        bug the first cut had.
  - [x] **Prompt ops as callees.** A prompt callee renders its OWN template with the
        call's arguments and keeps its OWN output contract (a state's prompt op has its
        output replaced by the state's produced outputs — right for a state, wrong for
        a call whose result belongs to one binding). Deliberately no conversation
        preamble and no transcript append: a call is a computation embedded in a
        binding, not a turn in the enclosing state's conversation, and appending would
        make that state's own prompt read back a call it never asked about. It still
        runs under the session in force where it is written, so tools and permissions
        are the ones the author expects. **Revisit if a call should be conversational.**
        Fixing this exposed a latent bug: `resolveProducer` treated `producer.kind !==
        "function"` as the higher-order case, so EVERY prompt operation in a binding was
        read as "pass the definition through" — a prompt callee returned its own
        definition instead of running. A call carries `parameters` and a higher-order
        slot does not, which distinguishes them without threading the consuming
        parameter's `kind` through a recursive resolver.
  - [x] **The static passes see a call's ARGUMENTS.** They live in the edge's
        `parameters`, not the callee's `input`, so `fanout.ts`'s `collect` and
        `referencePathsOf` both walked straight past them — two silent failures: an
        under-counted blob is never materialized and two readers race one stream
        (§1.3), and the reachability obligation was simply not applied to a call.
  - [x] **The validator no longer rejects an embedded operation.** "binds an embedded
        operation, which no binding can run" was the honest half of a pair while
        nothing could run one; now the engine does, and leaving it would have failed
        every workflow that calls anything at `beginTaskRun`.
  - [x] **An unregistered callee is reported at lint.** The registry check ran over a
        state's own `operation.functionRef` only, so `shout(x)` with nothing registered
        passed lint and then failed mid-run — the one place a missing function is fatal
        to the whole run. Every binding a state carries (guards included) is now walked
        for the callees it names. A PROMPT callee needs no entry; it dispatches to the
        prompt executor.
  - [x] **Reachability of call ARGUMENTS is checked.** Rather than widen the generic
        checker's hook to pass the whole ref, the reference and reachability checks
        moved OUT of the expression branch and run once per binding. That is more
        correct anyway: inside `resolverSchema` they depended on which node happened to
        be the ROOT, so `shout(children.c.outputs.x) === 'y'` was checked and
        `shout(children.c.outputs.x)` was not.
  - [x] **The child-shadowing refusal is removed.** A callee is always a REFERENCE, so
        children and callees are separate namespaces: a child named `classify` and a
        callee `classify` coexist without interacting.
  - [x] **A rooted reference works as a callee.** `$JAIRA/prompts/review('x')` and
        `$/functions/classify(a)` parse and resolve, alongside the bare and dotted
        forms. `/` did not lex at all before, so only bare/dotted names were callable.
        It is unambiguous here precisely because the language has NO arithmetic — `/`
        can never be division — and a rooted path that is not called is refused, since
        reading data uses the leading-dot runtime form and a file path is only ever an
        operation.
  - [x] **Calling a declared child: dropped, not deferred.** A child is a STATE (with
        its own children, sequence, transitions, limits), and "calling" one would
        duplicate what `children[].inputs` + `.children.k.outputs.x` already do, with
        unclear re-entry and cursor semantics. A callee is always a REFERENCE, so
        children and callees are different namespaces that do not interact and a child
        named `classify` simply coexists with a callee `classify`. The shadowing
        refusal built for §3.2's local-name-wins rule should be REMOVED.
  - [x] **Calls work inside GUARDS.** Two bugs, both live: guards were lowered by the
        ENGINE, which has no callee resolver (resolving one is load-time knowledge), so
        any call in a guard threw `'x' is not a known operation` at run time — and even
        lowered, nothing ran a guard's calls. Guards now lower at LOAD, into
        `LoadedTransition.whenRef`, and their calls run before the (synchronous)
        evaluation reads the result; the memo means a guard re-evaluated over many
        rounds pays for its call once. A guard that fails to lower is carried as
        `whenError` rather than thrown — the rule `operationError` already follows, so
        the validator still reports every authoring error at once instead of the load
        aborting at the first — and such a transition NEVER fires, since reading a
        typo as unconditional would be the worst available interpretation.
  - [x] **The built-in operation library — first-order set built** (`builtins.ts`).
        ~40 operations as a TABLE (name → ordered params + pure impl) rather than
        switch cases, computed inline by the resolver exactly as the comparison
        operators are — which is §2's "the operator set is a registry" cashed out:
        `add(a, b)` and `a === b` differ only in spelling. Arithmetic
        (`add`/`sub`/`mul`/`div`/`mod`/`min`/`max`/`abs`/`round`/`floor`/`ceil`),
        dynamic access (`get`/`at` — member access takes a LITERAL name, so a computed
        key had no spelling), arrays, strings, objects, `parse_json`/`to_json`,
        `typeof`/`isArray`/`isNull`, `coalesce`. Every entry is PURE (resolution runs
        every round), TOTAL (a synchronous resolver runs inside the scheduling loop,
        where a throw has nowhere to go — `div(1,0)`, `at(xs,99)` and `parse_json('{')`
        all have answers) and NON-MUTATING (`append`, never `push`). `range` is bounded
        so a typo cannot exhaust memory; `fromEntries` uses `defineProperty` so a
        `__proto__` key cannot re-parent its result. A built-in name WINS over a path
        lookup, so a project cannot silently shadow `add`.
  - [x] **Negative number literals.** `-1` did not parse at all: no unary minus, no
        subtraction operator. `at(xs, -1)` — the natural way to index from the end —
        was a lex error. A leading `-` is unambiguous precisely because the language has
        no arithmetic syntax, so it can only ever be a sign.
  - [x] **The call memo is injectable and content-addressed.** `EngineConfig.callCache`
        takes a `CallCache` keyed by `hashOperation` of the RESOLVED op — which, because
        a resolved op embeds its argument values, IS "this callee with these arguments".
        The default is an in-run `Map`, which answers "would someone else reuse this
        answer?" only within one run; a host supplying a durable store gets reuse across
        runs, tasks and processes. `CallResult` is deliberately serializable (a value or
        a failure, both DATA per §5) and PENDING is excluded — a scheduling state is
        not an answer. Tested both ways: two runs sharing a cache make ONE call, two
        runs without it make two.
  - [ ] **JaiRA supplies no durable `callCache`.** The seam exists; nothing backs it, so
        an identical call still costs money once per run. A natural home is the same
        content-addressed storage artifacts use.
  - [x] **A call can dispatch through the composed executor.** `EngineConfig.operations`
        takes one, and it covers BOTH callee kinds — dispatch is by op kind, so one
        stack brings retry, rate limiting, budget and a content-addressed `withMemoize`
        to a function callee and a prompt callee alike. Without it the engine invokes
        the registry entry directly, which runs the operation but skips every wrapper.
  - [x] **Both call seams are REACHABLE from a host.** The engine is constructed inside
        `WorkflowExecutor`, so `callCache` and `operations` existed and nothing outside
        hw could supply them; both now forward through `WorkflowExecutorOptions`, and
        `callCache` threads on through JaiRA's `WorkflowRunConfig`/`executeWorkflow`.
  - [ ] **Nothing SUPPLIES them yet.** JaiRA passes `callCache` only if a caller hands
        one over, and no caller does — so a call is still remembered per-run and still
        runs unwrapped. What is left is a store (the content-addressed one artifacts
        use is the natural home) and a composed executor stack.
  - [x] **Higher-order operations — `map`, `filter`, `flatMap`.** The shape no other
        machinery had: how many operations run is not known until the array resolves, so
        it cannot be the static walk `embeddedOpsOf` is. The engine resolves the array,
        runs one bound application per element (`Promise.all`), and resolution reads
        them back by rebuilding the same per-element identities — `bindElement` shared
        by both sides, the same discipline `resolveEmbedded` follows for a plain call.
        Passing the operation needed no new mechanism: `map`'s `op` position takes an
        operation REFERENCE, which lowers to a bare `{op}` edge, and the model already
        says such an edge yields the DEFINITION rather than running it.
        Per-element memoization falls out of the content-addressed key — and a bug found
        by testing it: identical elements must be deduped BY HASH before dispatch, since
        both miss the cache while neither has run and filtering alone runs the same
        application twice. `filter` keeps the ELEMENT, not the test's result.
  - [x] **`reduce` too.** A FOLD, so its applications cannot be built up front — each
        step consumes the previous result. Both sides rebuild the same CHAIN (the engine
        to run it, resolution to read it), which works because every step is recorded
        under its own content hash: two identical folds cost one set of steps, and the
        operation takes the accumulator first and the element second.
  - [ ] **Built-in op documents** under `$JAIRA/functions`, which §4 already put on
        the path.
## Deferred by design (later phases)

- [x] **Phase 6 — process executors + policy.** Done (§1i): agent runtimes
      registered, the policy engine + command parser compiled onto
      `@declarative-ai/permissions`, per-command approvals with the `command_log`
      audit trail, and §8.2 capability gating. Open inside it:
  - [x] **Approvals dialog.** Done: the inbox lists command approvals alongside
        workflow gates (approvals first, since an agent's tool loop is blocked), and
        the dialog shows the command, the policy's reason, and scope choices
        (once / this run / always) plus deny. Verified by screenshot against a real
        policy escalation.
  - [x] **CLI agent verified against the real `claude` binary** (v2.1.142): a
        delegated run returned its text with a provider-reported cost. Kept
        repeatable as an opt-in live test (`JAIRA_LIVE_AGENT=1`), which skips by
        default because it spends money.
  - [ ] **SDK agent (`agents-api`) unverified.** It lazily imports
        `@anthropic-ai/claude-agent-sdk`, which is not installed here, so only the
        CLI variant has run for real.
  - [ ] **Tool injection over MCP is untested.** The live run used the adapter's
        default; whether our injected `bash` reaches the agent over the MCP bridge
        (and is therefore policy-gated *inside* an agent loop) has not been observed
        end to end — only the gate itself is tested, directly.
  - [ ] **Path policy is only the `.jaira/**` deny rule.** DESIGN §10.1's broader
        idea — an allow-list of the worktree root plus authored path rules — is not
        an authored surface yet.
  - [ ] **`smart` mode is inferred from a fixed tool-name list**
        (`bash`, `shell`, `run_command`, …). A tool that runs commands under an
        unrecognized name gets the baseline mode instead of command parsing.
- [x] **Phase 7 — breadth.** Done (§1j): history pruning (§12/SPEC §13) with
      `jaira prune` and a pruning panel; the workflow browser + lint surface (§11.1)
      with a live re-lint watcher; conversation `summary` mode as a summarizing
      `SessionStore`; the `generic-cli` runtime. Open inside it:
  - [x] **`claude-cli` hook loopback** needed no JaiRA work: upstream's adapter
        already routes each gated tool-use back through the MCP bridge
        (`--permission-prompt-tool`), which is why it declares
        `policyEnforcement: "callback"`. Phase 6 registered it; phase 7 only
        confirmed the mechanism is the loopback DESIGN §16 sequenced last.
  - [ ] **No `generic-cli` verified against a real binary.** The runtime is tested
        against a stand-in node script end to end, but no actual opencode/codex run
        has happened, so their argv conventions are assumed rather than observed.
  - [ ] **A generic agent cannot run under the default policy, by design.** Its
        `policyEnforcement: "none"` plus SPEC §11.3's built-in approval classes means
        §8.2 refuses it unless the project sets `policy.builtins: false`. That is the
        honest outcome, but a middle ground (deny-by-default for the agent's own
        tools) does not exist.
  - [ ] **Summary mode compacts per SESSION, not per state.** One session has one
        transcript, so a session mixing `summary` and `full_history` is summarized
        for both; the workflow browser warns, and nothing finer is possible without
        an engine change.
  - [ ] **Pruning does not touch artifacts or conversations.** DESIGN §12 lists
        "conversation artifacts"; there are no such tables yet (see the §4.2 entry
        above), so pruning covers `runs`, `events` and `command_log` only.

## Bugs found and fixed in phase 7

Recorded because each was silent, and the shape of the mistake is worth
remembering.

- [x] **`gateCapabilities` was a no-op at every real call site.** It read
      `operation.functionRef`, but both callers pass `bundle.source`, where the
      authored field is spelled `function` — so DESIGN §8.2's capability gate matched
      nothing and every run "passed" it. Now reads either spelling, with a regression
      test. A check that never fires is worse than no check.
- [x] **The CLI never registered agent runtimes.** A workflow with a `claude-code`
      state ran in the app and failed as "unregistered function" under `jaira run` /
      `jaira task start` — on the surface DESIGN §14 calls the permanent fastest
      debugging path. The CLI now registers the agent runtimes and runs the §8.2 gate
      (`unattended: true`, since it has no approvals inbox).
- [x] **A capability refusal left the task `running`.** The gate runs after
      `beginTaskRun`, so throwing left an open run row that the next project open
      would call `interrupted`. It now closes the run as failed first.

## Environment (not code)

- [x] **Rename `C:\UbuntuCode\ai-exec` → `declarative-ai`.** Done by hand
      (2026-07-28), junction gone. Its fallout is worth remembering if the directory
      ever moves again: the *library's own* workspace links still pointed at the old
      path and were dangling, which broke `@declarative-ai/ops` resolution for every
      JaiRA package until `npm install` was re-run **inside** declarative-ai.
- [x] **`.env.local` keys — no rotation needed.** They sat untracked while
      `.gitignore` did not cover `.env*` (fixed in §1h), but nothing ever reached a
      commit — verified across all history. Closed on the user's call.
