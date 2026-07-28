# JaiRA — known gaps

Deliberate omissions and deferred work, tracked so they are not mistaken for
oversights. Phase numbers refer to [DESIGN.md](DESIGN.md) §14; status updates
§1a–§1i record the decisions behind each entry.

## Gaps inside completed phases

These live in phases marked ✅. They are real, and each one is a bug the moment
its assumption breaks.

- [ ] **No project ownership or locking** (§1b item 4 said phase 3 would add it;
      it did not). Recovery marks every `running` task `interrupted` at project
      open, because v1 assumes one process owns `.jaira/` at a time. Two processes
      on the same project — the app plus a CLI, or two app windows — means the
      second falsely interrupts the first's live run. Needs a lock file (or a
      single owning process the CLI defers to) before concurrent use is safe.
- [ ] **Cancel is in-process only** (§1b item 5). `AppService.cancelTask` aborts a
      run *this* process is driving; a run started by the CLI cannot be stopped
      from the app, and vice versa. A cross-process cancel channel was deferred
      with the ownership work above.
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
- [ ] **Phase 7 — breadth.** `claude-cli` (hook loopback) and `generic-cli`
      executors; conversation `summary` mode (§1a item 3 — it currently degrades to
      `full_history`, and §1h measured why that matters: context grew
      232 → 42,828 tokens across one real run); history pruning (§12) and its UI;
      the workflow browser / lint surface (§11.1).

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
