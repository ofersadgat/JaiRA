---
id: engineering/units/uri-and-artifact-reads
type: engineering-unit
status: shipped
updated: 2026-09-13
implements: [product/read-what-work-produced, product/review-changes-before-they-land, ui/components/value-view, ui/components/artifact-pane, ui/components/produced-artifacts, ui/components/review-artifact-gate, ui/components/edit-artifact-gate, ui/components/changeset-review, ui/components/composer]
layer: service
owns_contracts: [engineering/contracts/uri-read, engineering/contracts/artifact-frame-protocol]
requires: [engineering/units/project-sessions, engineering/units/artifact-placement, engineering/units/git-cli, engineering/units/operation-record-store, engineering/units/changesets, engineering/units/document-types]
implemented_by: [packages/app/src/main/service.ts]
verified_by: [packages/app/test/uriRead.test.ts, packages/app/test/artifactServe.test.ts]
siblings: [engineering/units/app-shell, engineering/units/artifact-placement, engineering/units/workflow-authoring, engineering/units/changesets]
---

# URI and artifact reads

## The unit resolves one addressed value for the renderer and grants a frame one artifact, and stores neither

Three `AppService` methods in `service.ts`:

- `readUri` resolves `$PROJECT/`, `$JAIRA/` and `$WORKTREE/` paths under their anchor, `artifact://<taskId>/<logicalPath>` through the artifact map, a `git:<rev>:<path>` blob in the project's repository, a `db://operation_records/` value, and an absolute `file:` URI confined to the project's anchors, with drift reported against a `#sha256=` pin. The schemes, answers and refusals are [uri-read](../contracts/uri-read.md).
- `listArtifacts` lists a task's artifact records oldest first as metadata, with `mediaType` the record's `format` or the path's type.
- `serveArtifact` resolves one `(taskId, path)` record, copies its body, and mints a `randomUUID` token into the `served` map; `servedArtifact(token)` is what the scheme handler serves. `interactive` is the record's, never the request's. The grant and the response are [artifact-frame-protocol](../contracts/artifact-frame-protocol.md).

It deliberately does not own:

- The artifact map, where bytes are placed, and `withinWorkspace`: [artifact-placement](artifact-placement.md).
- Registering `jaira-artifact:`, its handler, its headers and the window's `frame-src`: [app-shell](app-shell.md).
- The source grammar `parseChangesetSource` and building a changeset's before-side: [changesets](changesets.md).
- Records, positions and session aliases: [operation-record-store](operation-record-store.md). `git show`: [git-cli](git-cli.md).
- The sandboxed frame and the message it may post, which the renderer's `valueView.tsx` hosts.
- Reading files by layer and path for editing: [workflow-authoring](workflow-authoring.md).

## The unit is main-process code on the renderer boundary, and it is the only door from a model's page to project data

- Layer `service`, in `packages/app/src/main`. It calls `sessionOf` from [project-sessions](project-sessions.md), `project.artifacts`, `withinWorkspace`, `gitFor`, `sessionStoreFor`, `parseChangesetSource`, `mimeOfPath` and `isTextMime`.
- No upstream seam.
- Boundary: renderer and main. Channels `uri:read`, `artifact:list` and `artifact:serve`. A frame never names a path: it loads a token main minted for a record the renderer named, so the handler resolves nothing itself.
- A request's `project` resolves through `sessionOf`: a named project that is open, or the one user project when exactly one is open. Anything else refuses with `no project is open`.
- Callers: the chat artifacts strip and the composer's `@` mentions in `chatPane.tsx`, the reviewer's current side and drift check in `changesetReview.tsx`, and artifact gates in `components.tsx` through `valueView.tsx`.

## The only data the unit holds is the grant map, and every read goes to its owner's store

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| `served`, token to `{body, mediaType, interactive}` | set by `serveArtifact`; read by `servedArtifact`; the oldest evicted past 64 | process memory; the body is a copy taken at grant time | the `jaira-artifact:` handler in [app-shell](app-shell.md) |
| Artifact records: `content`, `physicalPath`, `format`, `interactive`, `bytes`, `createdAt` | read by `get(taskId, path)` and `list(taskId)` | the `artifacts` table and the bytes where they were placed | written by [artifact-placement](artifact-placement.md) |
| Files under the checkout, `.jaira` or a task's worktree | read whole as UTF-8 | the files | agents and editors |
| Git blobs | read by `git show <rev>:<path>` in the checkout | the repository | [git-cli](git-cli.md) |
| Operation records and positions | read by `store.record(id)` and `store.at(session, seq)` | `operation_records` | [operation-record-store](operation-record-store.md) |

## The invariants keep every read inside what the project owns and every script decision on the record

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | An anchored path reads as text under its anchor, and one that climbs out of it is refused | `uriRead.test.ts` "resolves $PROJECT and $JAIRA relative paths", `"refuses an escape from its anchor — the artifact-destination rule, on the read side"` |
| 2 | A `file:` URI outside the checkout, `.jaira` and the task's worktree is refused | `uriRead.test.ts` "confines an absolute file: URI to the anchors the project owns" |
| 3 | A `file:` URI whose pinned hash no longer matches answers the current text with `drifted: true` | `uriRead.test.ts` "reports drift when a file: URI's content hash no longer matches (§3.2)" |
| 4 | A scheme the channel does not name is refused, never guessed at | `uriRead.test.ts` "refuses an unrecognised scheme rather than guessing" |
| 5 | A `git:` read answers the blob at the named commit, not the working tree, and a commit with no path is refused | `uriRead.test.ts` "reads a blob at a pinned commit from the project's own repository" |
| 6 | A `db://` position reads the value its record returned, and an unclaimed position or another table is refused | `uriRead.test.ts` "resolves a recorded value through session_positions, pointer and all" |
| 7 | An `artifact://` read resolves through the map, a virtual artifact included, and never reads another task's record | `artifactServe.test.ts` "resolves through the MAP, so a virtual artifact reads back at all", "reads the address a produced artifact actually carries", "refuses one that names no record, including another task's" |
| 8 | A grant exists only for a record in the map under that task, and every grant is a new token | `artifactServe.test.ts` "grants an address for an artifact the caller named", "refuses an artifact that is not in the map at all", "mints a distinct grant each time, so one address is not a handle on the map" |
| 9 | Whether a frame may run script comes from the record, never from the request or the media type | `artifactServe.test.ts` "lets the RECORD decide whether anything may run, not the request or the type" |
| 10 | A token nobody was granted serves nothing | `artifactServe.test.ts` "serves nothing for a token nobody was granted" |
| 11 | A list and a grant give one artifact the same media type, and a list never carries content | `artifactServe.test.ts` "falls back to the path's type when the record kept none", "collects what a task produced, oldest first", `"carries no content, however small — the list is a list"`, "is empty for a task that produced nothing, rather than an error" |
| 12 | A `db://` record id reads the whole record, scoped to the request's task | unasserted |
| 13 | No more than 64 grants are live at once | unasserted |

## Every failure is a refused or corrupted read, and nothing is written that could need recovering

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| Several projects are open and the request names none, or names one that is not open | refused with `no project is open` | name an open project | an error notice; a frame falls back to the static rendering |
| An artifact's placed bytes were moved or deleted | refused with `the bytes for '<path>' are no longer where they were placed` | none | the artifact does not open |
| An artifact holds binary bytes | the body is read as UTF-8, invalid bytes are replaced, and the frame is served `charset=utf-8`; `bytes` counts the decoded text | none | a broken image or document in the frame |
| A 65th grant is minted | the oldest token is evicted, and a frame still showing it gets `404 no such artifact` on reload | reopen the artifact, which mints a new grant | the frame reads `no such artifact` |
| An artifact changes after its grant | the token keeps the body copied at grant time | reopen the artifact | the frame shows the older content |
| A base-layer sync review checks a file's current side | no anchor names `~/.jaira`, so `$JAIRA/<path>` reads the project's `.jaira` copy, and with no project open every anchor refuses | none | a wrong drift badge, or none |
| A `git:` rev is not 4 to 64 hex digits, or a `db://` or `file:` URI is malformed | `parseChangesetSource` throws a plain `Error`, which the IPC boundary logs at `error` | fix the URI | an error notice |
| Two writers | cannot occur: the unit writes nothing to disk, and `served` is touched only on the main thread | none needed | none |
| The process is killed | grants are lost with the process; nothing durable is written | reopen the artifact | frames go blank with the window |
| A read lands while a file is being written | the text is whatever bytes are there, and a `#sha256=` pin reports drift | read again | the reviewer's current side shows partial text |
| A read or a grant is retried | a read answers again; a grant mints another token and may evict an older one | none needed | none |

## Budgets are the grant cap and the commit id length

- 64 live grants, in `serveArtifact` in `service.ts`.
- A `git:` rev of 4 to 64 hex digits, in `parseChangesetSource` in `packages/shared/src/changeset.ts`.
- No read has a size cap.

## Granting by token departs from resolving an address on the request, so a page can reach only what was handed to it

- The scheme handler serves a token main minted rather than parsing `<taskId>/<path>` from the URL, because a handler that resolved paths would be a second unauthenticated door into project data that any page could reach by contriving a URL.
