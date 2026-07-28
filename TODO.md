# JaiRA — known gaps

Deliberate omissions and deferred work, tracked so they are not mistaken for
oversights. Phase numbers refer to [DESIGN.md](DESIGN.md) §14; status updates
§1a–§1i record the decisions behind each entry.

## Gaps inside completed phases

These live in phases marked ✅. They are real, and each one is a bug the moment
its assumption breaks.

- [ ] **No liveness signal on a `running` run** (§1b item 4 said phase 3 would add
      ownership; it did not). SQLite is *not* the constraint — WAL handles
      concurrent processes. The constraint is that at project open, "the writer
      crashed" and "the writer is another live process" are indistinguishable, so
      recovery must choose a failure mode; v1 chose assume-crashed, which falsely
      interrupts a live run when a second process opens the project. **Cheap fix:**
      record an owner (pid + heartbeat) on the run row and only interrupt runs whose
      owner is provably gone.
- [ ] **Cancel and parked requests are process-local** — the expensive half of the
      same problem, and the reason a lock alone is not enough. The abort controller,
      the interaction hub and the approval hub all live in the process driving the
      run, so a gate the CLI parked on cannot be answered from the app however the
      ownership question is settled. Real multi-process use needs a routing channel.
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
      phase 6, but `instances`, `operations`, `transitions`, `artifacts` and
      `conversations` still do not exist — the board and detail views are projected
      from the `events` journal instead. They land with step-level resume (which
      needs `@declarative-ai/hw` support) and with artifacts.
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
- [ ] **Artifacts are never written to disk.** `config.artifactDir` is parsed and
      used nowhere; §15 Q1's reserved `jaira-artifacts/` is empty by construction.
      A blob-kind output travels **inline** in the journal today, so §7.5's
      pre-assigned `jaira-artifacts/<taskId>/<instanceId>-<name>.<ext>` path, the
      "write X to path P" prompt injection, and the post-run existence/format check
      are all absent. Consequences: large outputs bloat `events`, there is no
      content hash, and the §11.1 detail panel has no **artifacts list with
      markdown preview** and no **conversation viewer** (the transcript exists in
      the session store but is not a view).
- [ ] **No Playwright E2E (§13, "E2E (thin)").** Board navigation, one UI-component
      round-trip and one approval flow were to be covered end to end through the
      real Electron app. What exists instead is `JAIRA_CAPTURE` screenshots (manual,
      by eye) plus headless `AppService` tests, so nothing exercises the actual
      preload/IPC boundary in CI.

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
- [ ] **Consider rotating the keys in `.env.local`.** They sat untracked in the
      repo while `.gitignore` did not cover `.env*` (fixed in §1h). Verified that
      nothing ever reached a commit, but the exposure window to a careless
      `git add -A` was real.
