# JaiRA — known gaps

Deliberate omissions and deferred work, tracked so they are not mistaken for
oversights. Phase numbers refer to [DESIGN.md](DESIGN.md) §14; status updates
§1a–§1h record the decisions behind each entry.

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
- [ ] **§4.2 tables are partly deferred** (§1b item 2). `instances`, `operations`,
      `transitions`, `artifacts`, `conversations` and `command_log` do not exist;
      the board and detail views are projected from the `events` journal instead.
      They land with step-level resume (needs `@declarative-ai/hw` support),
      artifacts, and policy (`command_log`).
- [ ] **Workflow migration for a running task is out of scope** (§5.3). The escape
      hatch is "restart the task on current workflows"; there is no UI for it.

## Deferred by design (later phases)

- [ ] **Phase 6 — process executors + policy.** Adopt
      `@declarative-ai/agents-api` / `agents-cli`; the policy engine and command
      parser (§10.1) via `@declarative-ai/permissions`; per-command
      `require_approval` decisions feeding the approvals inbox (§10.2, scaffolded
      in §1f item 9); capability gating (§8.2). This is where the `.jaira/**` deny
      rule becomes the real enforcement — §1g item 5 showed a worktree normally
      *does* contain `.jaira/`.
- [ ] **Phase 7 — breadth.** `claude-cli` (hook loopback) and `generic-cli`
      executors; conversation `summary` mode (§1a item 3 — it currently degrades to
      `full_history`, and §1h measured why that matters: context grew
      232 → 42,828 tokens across one real run); history pruning (§12) and its UI;
      the workflow browser / lint surface (§11.1).

## Environment (not code)

- [ ] **Rename `C:\UbuntuCode\ai-exec` → `declarative-ai`.** Blocked by a
      directory handle (reported *Access denied*; no process runs an executable
      from that path — most likely an editor or indexer). A junction bridges it, so
      builds and CI are unaffected. When the handle frees:
      `cmd /c rmdir "C:\UbuntuCode\declarative-ai" && move "C:\UbuntuCode\ai-exec" "C:\UbuntuCode\declarative-ai"`
- [ ] **Consider rotating the keys in `.env.local`.** They sat untracked in the
      repo while `.gitignore` did not cover `.env*` (fixed in §1h). Verified that
      nothing ever reached a commit, but the exposure window to a careless
      `git add -A` was real.
