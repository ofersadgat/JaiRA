---
id: engineering/contracts/uri-read
type: engineering-contract
status: shipped
updated: 2026-09-13
visibility: internal
kind: api
owned_by: [engineering/units/uri-and-artifact-reads]
consumers: ["@jaira/app renderer chatPane.tsx, for the artifacts strip and the composer's @ mentions", "@jaira/app renderer changesetReview.tsx rendererServices and readCurrent, for a change's current side and its drift", "@jaira/app main service.ts readUri, which answers it"]
siblings: [engineering/contracts/artifact-frame-protocol, engineering/contracts/artifact-destination-template, engineering/contracts/ipc-channels]
---

# URI read

The `uri:read` channel: one address in, the text it names out, for the path anchors, artifacts, git blobs, recorded values and pinned files a project owns.

## A renderer reaches for this channel to read an address a run or a changeset handed it

**Use when.** Reading the value behind an address a producer carries: the `uri` a produced artifact returns, a changeset's `git:`, `db://` or `file:` source, a `$PROJECT/` path the composer mentions, or the current text of a change under review.

**Do not use when.** Opening a file to edit it, which goes by layer and path through `file:read` in [workflow-authoring](../units/workflow-authoring.md). Showing an artifact that may run script, which needs a grant from [artifact-frame-protocol](artifact-frame-protocol.md). Listing a task's artifacts, which is `artifact:list`. Reading a whole conversation: [conversation-lookup](../units/conversation-lookup.md).

## The shape is a URI with its scope in, one text out, and six address forms

### The request names the address and the scope it resolves in

`ReadUriRequest` in `packages/shared/src/ipc.ts`.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `uri` | string | yes | the address; trimmed before it is matched |
| `project` | `ProjectRef` | no | the open project to read in; absent resolves only when exactly one user project is open |
| `taskId` | string | no | resolves `$WORKTREE` and adds that task's worktree as a `file:` anchor; scopes a `db://` read to records that task wrote |

### The response is the text and its type

`UriContent` in `packages/shared/src/ipc.ts`.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `uri` | string | yes | the address as matched, trimmed |
| `mime` | string | yes | the type the form below gives |
| `text` | string | yes | the content, decoded as UTF-8 |
| `drifted` | `true` | no | set only when a `file:` URI's `#sha256=` pin no longer matches `text` |

### Each address form resolves in one place and sets its own type

Forms are tried in this order; the first whose prefix matches decides.

| Form | Resolves | `mime` | Refused unless |
| --- | --- | --- | --- |
| `$PROJECT/<rel>`, `$JAIRA/<rel>`, `$WORKTREE/<rel>` | `withinWorkspace` under the checkout, the project's `.jaira`, or the `taskId`'s worktree | `mimeOfPath(rel)` | it stays under its anchor, its type is text, and it names a file |
| `artifact://<taskId>/<logicalPath>` | the artifact record for `decodeURIComponent(taskId)` and the path verbatim: its `content`, else the bytes at its `physicalPath` | the record's `format`, else `mimeOfPath(logicalPath)` | the record exists and its bytes are where they were placed |
| `git:<rev>:<path>` | `git show <rev>:<path>` in the checkout; `rev` is 4 to 64 hex digits | `mimeOfPath(path)` | a path follows the rev and git resolves the object |
| `db://operation_records/<session>@<seq>[.<pointer>]` | the row at that conversation position, rooted as `{result: <row value>}` | `application/json` | a record claimed the position and the pointer resolves |
| `db://operation_records/<recordId>[.<pointer>]` | the record by id, rooted as `{recordId, status, request?, result?, error?, startedAt?, endedAt?}` | `application/json` | the record was written under the request's task and the pointer resolves |
| `file:<absolute path>[#sha256=<64 hex>]` | the path, which must lie under the checkout, the project's `.jaira`, or the `taskId`'s worktree, then read as an anchored path | `mimeOfPath` of the path under its anchor | it lies under an anchor, its type is text, and it names a file |

A `db://` pointer is the dot-separated path after the address, empty segments dropped, walked one key at a time; `text` is the value as `JSON.stringify(value, null, 2)`. A form with no `@` is the record-id form.

## Every refusal names the address, and a malformed one is a plain error

| Condition | Response | Caller does |
| --- | --- | --- |
| No project resolves: none open, several open with none named, or the named one not open | `Refusal` `no project is open`, before the form is matched | name an open project |
| An anchored path climbs out of its anchor | `Refusal` `'<uri>' escapes its anchor — refused` | nothing; the address is wrong |
| An anchored or `file:` path's type is not text | `Refusal` `'<uri>' is <mime>, which is not text` | none; binary content has no read here |
| An anchored or `file:` path is missing or a directory | `Refusal` `'<uri>' does not name a readable file` | try the next anchor, as `readCurrent` does |
| `$WORKTREE/` without a task that has a worktree | `Refusal` `'$WORKTREE' needs a task with a worktree — pass taskId` | pass the reviewed task's id |
| An `artifact://` record does not exist for that task | `Refusal` `'<uri>' names no artifact this project produced` | none |
| An artifact's placed bytes are gone | `Refusal` `the bytes for '<uri>' are no longer where they were placed` | none |
| `git:<rev>` with no path | `Refusal` `'<uri>' names a commit, not a blob — read git:<sha>:<path>` | add the path |
| git cannot resolve the object | `Refusal` `'<uri>' does not resolve in this project's repository` | none |
| A `db://` table other than `operation_records` | `Refusal` `'<uri>' addresses table '<table>' — only operation_records is addressable` | none |
| No record claimed the position | `Refusal` `'<uri>' names a position no record has claimed` | none |
| No record with that id under the request's task | `Refusal` `'<uri>' names a record this scope has not written` | pass the `taskId` that wrote it |
| The pointer walks off the value | `Refusal` `'<uri>' resolves a record, but '<pointer>' is not in it` | fix the pointer |
| A `file:` path outside every anchor | `Refusal` `'<uri>' is outside every anchor this project owns — refused` | none |
| A `git:` rev that is not hex, a `db://` URI with no table or no integer after `@`, or a `file:` fragment other than `sha256=` with 64 hex digits | plain `Error` from `parseChangesetSource`, logged at `error` by `recordIpcFailure` | fix the URI |
| Any other prefix | `Refusal` `unrecognised uri '<uri>' — expected $PROJECT/, $JAIRA/, $WORKTREE/, file:, git: or db:// (refused rather than guessed at)` | none |

## A new form or a changed root breaks stored addresses, and no deprecation path exists

- Addresses are stored inside changesets, tool results and gate requests in journals and records. Renaming a prefix, a root shape or the pointer syntax breaks every address already written, and nothing migrates them.
- Adding a form is compatible when its prefix matches no existing form before it in the order above.
- The refusal texts are read by people and matched by `uriRead.test.ts` and `artifactServe.test.ts`, never by code.

## The two record roots, the anchors and the decoding work differently than the addresses suggest

- The two `db://` forms root their pointer differently. A position form's pointer starts at `result`, and a record-id form's at the whole record, so `.result.value` reaches the same value in both but `.request` exists only in the record-id form.
- A position form is not scoped to the task the way the record-id form is: a session id resolves without `taskId`, and only a session name needs the task's aliases.
- No anchor names `~/.jaira`. A base-layer path read through `$JAIRA/` reads the project's `.jaira` copy, and with no project open every form refuses.
- `artifact://` and `git:` skip the text-type refusal, so a binary artifact or blob comes back with its invalid bytes replaced, and `git:<rev>:<directory>` answers git's tree listing as text.
- The `#sha256=` pin is compared against the decoded text re-encoded as UTF-8, so a file holding invalid UTF-8 always reads as drifted.
- `artifact://` decodes the task id and not the logical path, so a percent-encoded logical path names no record.
- No read has a size cap.
