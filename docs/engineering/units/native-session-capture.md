---
id: engineering/units/native-session-capture
type: engineering-unit
status: shipped
updated: 2026-09-13
implements: [product/complete-record-of-every-run]
layer: core
owns_contracts: []
requires: []
implemented_by: [packages/runtime/src/nativeCapture.ts]
verified_by: [packages/runtime/test/nativeCapture.test.ts, packages/app/test/crashRecovery.test.ts]
siblings: [engineering/units/operation-record-store, engineering/units/live-turns, engineering/units/conversation-lookup, engineering/units/chat-turns]
---

# Native session capture

## Native session capture folds a coding agent's own session file into the record's entries, and never stores it beside them

`nativeCapture.ts` in `@jaira/runtime`:

- `withNativeCapture(inner, {cwd, onError, read, readSidechains})` wraps a `RecordStore`. Its `finish` reads the agent's files when the settled call carries `sessionOutcome.providerSessionId`, keeps only lines stamped at or after `metrics.startMs`, and hands `inner.finish` the enriched value. `append` passes through, and `update` and `bySession` exist only when the inner store has them.
- `captureNativeSession(providerSessionId, {cwd, sinceMs})` reads the main file and every subagent file. Each subagent is keyed by the spawning `toolUseId` from its meta file, or `agent-<agentId>` when the meta file names none.
- `foldIntoEntries(value, captured)` merges a capture into `value.entries`:
  - a message line annotates the entry it pairs with, by tool call id when the line names one, otherwise the next entry of the same role after the last one paired; a user line with no call id and no `toolUseResult` is the prompt and pairs with nothing;
  - a line's `toolUseResult` lands as `data` on the matching `tool_result` block, whose text `content` is removed only when `renderToolResult` reproduces it exactly;
  - every other line except `last-prompt` becomes a `kind: "event"` entry, and each subagent adds one `sidechain` event; these are appended after every streamed entry, not placed between the turns they came between;
  - streamed entries tagged with a subagent's spawning call get the marker `{id: agentId, parentToolUseId: call}`;
  - `capturedAt` and the file's per-session fields are set on the value.
- A result value that is an object, as a prompt record's `LlmOutput` is, is folded directly. A delegated function op that settles with bare text has its `sessionOutcome.messages` converted to entries first. Any other payload is stored untouched.
- `isEmptyCapture` says a capture found nothing, and an empty capture is never folded.

The app uses it in three places. `startRun` and `runChatMessage` in `service.ts` wrap their record stores with `cwd` set to the run's workspace root. `recoverNativeSessions` in `service.ts` runs after an open that recovered tasks, and for each row `SqliteSessionStore.recoverable(taskId)` returns it calls `captureNativeSession` with the row's start time, then `foldNativeCapture` with `foldIntoEntries`.

It deliberately does not own:

- Where the agent keeps its files, their format and the line reduction. Those are upstream `@declarative-ai/agents-api`: `readNativeSession`, `readNativeSidechains` and `nativeLinesOf`, under `${CLAUDE_CONFIG_DIR ?? ~/.claude}/projects/<encoded cwd>/`.
- Which rows a recovery reads and the write of a recovered fold: `recoverable` and `foldNativeCapture` in [operation-record-store](operation-record-store.md). Settling a crashed task's open records as `interrupted` at open: [project-store](project-store.md).
- Reading the folded events back as native lines for the transcript: `nativeOf` in `service.ts`, beside [conversation-lookup](conversation-lookup.md).
- The streamed partial a crash leaves on the row: [live-turns](live-turns.md).

## The capture is a record-store decorator in the core layer, and it only reads outside the project

- Layer `core`. It imports upstream `@declarative-ai/agents-api`, `@declarative-ai/exec` and `@declarative-ai/llm`, and no JaiRA package.
- Upstream seam: `RecordStore.finish(ref, settled)` from `@declarative-ai/exec`, the one point where a settled call and its provider session id meet, on the prompt path and the delegated-function path alike.
- Boundary: the project and the machine. It reads files the agent wrote under its own config directory, found by the working directory it is handed, and never writes there.
- The CLI does not wrap its record store, so a `jaira` run's records hold only what streamed.

## The record row is the truth, and the agent's file is a source that may already be gone

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| `<providerSessionId>.jsonl` and `<providerSessionId>/subagents/agent-<agentId>.jsonl` with its `.meta.json` | read at close and at recovery | the agent, which appends across resumes and prunes on its own schedule | the agent and its resumed sessions |
| Annotations on `value.entries`: `uuid`, `parentUuid`, `timestamp`, `tool_result.data`, `sidechain {id, parentToolUseId}` | written into the settled value before `inner.finish`, or by `foldNativeCapture` at recovery | the record row | [live-turns](live-turns.md) writes the partial entries a recovery annotates; transcript readers |
| Event entries `{kind: "event", provider: "anthropic", timestamp, uuid, event: {type, data}, sidechain}` with `uuid`, `data` and `sidechain` optional | appended after every streamed entry | the record row | `nativeOf` rebuilds them as native lines |
| `value.capturedAt`, an ISO time | set by every fold of a non-empty capture | the record row | `recoverable` skips any row whose `result_json` contains the text `"capturedAt"` |
| `value.session {sessionId, cwd, version, gitBranch, entrypoint, userType}` | the first value of each field across the files, merged over an existing `session` | the record row | none |

## The invariants keep a capture from ever costing the record, and pair each line with the entry it describes

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | A capture is merged into `entries`, a message line annotates its streamed entry, and no second field holds the file | `nativeCapture.test.ts` "MERGES the captured file into the entries rather than storing it beside them" |
| 2 | A delegated function op's reported messages become entries that the capture folds into | `nativeCapture.test.ts` "folds them into the session report for a delegated function op, whose payload is bare text" |
| 3 | No line stamped before the record's own start is kept | `nativeCapture.test.ts` `"cuts the file at the record's own start — a resumed session's earlier lines belong to earlier records"` |
| 4 | A close without a provider session id reads nothing and stores the record as settled | `nativeCapture.test.ts` "leaves a close without a provider session untouched, and never reads" |
| 5 | An empty capture stores the settled record unchanged | `nativeCapture.test.ts` `"stores an empty capture as NOTHING — a transport with no native file must not stamp records with an empty claim"` |
| 6 | A capture that fails is reported, and the record closes exactly as it settled | `nativeCapture.test.ts` `"tells a failed capture and closes the record exactly as it was — the annotation must not cost the memory"` |
| 7 | A subagent's file folds onto the entries the stream tagged with its spawning call | `nativeCapture.test.ts` "folds each subagent's own file onto the entries the stream tagged with the call that spawned it" |
| 8 | Rendered result text is removed only when a registered renderer reproduces it exactly | `nativeCapture.test.ts` "DROPS the rendered text a registered renderer reproduces, and keeps the structure", `"KEEPS text a renderer does not reproduce — an unrecognized rendering costs bytes, never fidelity"` |
| 9 | A line naming a tool call pairs with the entry naming that call, whatever the order of either, and each result reaches its own block | `nativeCapture.test.ts` `"pairs by the CALL ID, not by order — parallel calls land in the file as they finish, and a result can precede its call"`, "puts one line's result on ITS block when the stream bundled several results into one entry" |
| 10 | A crashed call with a provider handle gets the agent's transcript folded into its record at the next open, asked with the run's workspace and the record's start | `crashRecovery.test.ts` "settles the abandoned record and folds the agent's own transcript into it" |
| 11 | A recovery that cannot read the files leaves the streamed partial as it was | `crashRecovery.test.ts` "keeps the streamed partial when the agent's files are gone" |
| 12 | A row with no provider handle is never read for | `crashRecovery.test.ts` "does not look where there is no handle to look with" |
| 13 | A record that was captured is not read again at a later open | `crashRecovery.test.ts` "re-reads nothing on a second open, having already captured" |

## Every failure closes the record as it settled, so the worst case is a transcript of only what streamed

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| The file is missing, pruned or under a folder the `cwd` does not name, or the transport writes none, such as codex or a scripted fake | upstream reads it as no lines, and the record closes as it settled with no `capturedAt` | none | the transcript shows what streamed |
| A read throws during a close | `onError` logs `native session capture failed: <message>` at `warn`, and the record closes as it settled | none | the transcript shows what streamed |
| The process is killed while a close is capturing | `inner.finish` never runs and the row stays `open` with its last flush | for a task whose status was `running`, the next open settles the row `interrupted` and recovery captures it | the partial turn, then the full transcript once recovery lands |
| A typed turn's process is killed | its task's status is not `running`, so the row is never settled or recovered | none | the flushed partial only |
| Recovery fails for one row | logs `recovering a native session failed: <message>` at `warn` and moves to the next row | none | the streamed partial |
| The agent is still writing its file when it is read | a line that does not parse reaches the fold as a string and is skipped | none | that line's annotation or event is missing |
| A line's partner is absent from the entries | the line annotates nothing | none | its structured result is not shown |
| A model's output contains the text `"capturedAt"` | `recoverable` reads the row as already captured | none | a crashed call keeps only its streamed partial |
| Recovery is asked again | a captured row is not offered; a row whose capture was empty is read again at each open that recovers its task | none needed | none |
| A close and a recovery write one row | cannot occur: a close writes only the record its own call opened, and recovery reads only rows the open's sweep settled | none needed | none |

## Nothing migrates, and the old capture field is left where it lies

- A record captured before the fold wrote into `entries` holds a `nativeLines` field, and nothing reads it: `nativeOf` derives native lines from `entries`.
- There is no migration and nothing to roll back.

## A capture failure is logged rather than raised, which departs from failing fast

- A read that fails never fails the close, because the record is the run's memory and the agent's file is a prunable enrichment of it.
