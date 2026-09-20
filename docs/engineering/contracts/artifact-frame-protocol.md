---
id: engineering/contracts/artifact-frame-protocol
type: engineering-contract
status: shipped
updated: 2026-09-13
visibility: internal
kind: format
owned_by: [engineering/units/uri-and-artifact-reads, engineering/units/app-shell]
consumers: ["@jaira/app renderer valueView.tsx InteractiveArtifact, which frames a grant and listens for its message", "@jaira/app renderer components.tsx and chatPane.tsx, which request grants for artifact gates and the chat artifacts strip", "@jaira/app main index.ts registerArtifactProtocol, which serves a token", "@jaira/app renderer index.html, whose frame-src names the scheme", "pages a model writes as interactive artifacts, which post a prompt to the window"]
siblings: [engineering/contracts/uri-read, engineering/contracts/host-tool-vocabulary, engineering/contracts/ipc-channels]
---

# Artifact frame protocol

The grant `artifact:serve` mints for one artifact, the `jaira-artifact:` response a sandboxed frame loads from it, and the one message that frame may post back to the window.

## A renderer asks for a grant only to show an artifact that may run its own script

**Use when.** Showing an HTML artifact whose value claims `interactive`: request a grant, and frame its `url` only when the grant's `interactive` is `true`. Writing a page that should offer a person a next message: post a `prompt` message to the parent.

**Do not use when.** Reading an artifact's text, which is `artifact://` through [uri-read](uri-read.md). Listing a task's artifacts, which is `artifact:list` in [ipc-channels](ipc-channels.md). Showing static HTML, which the renderer draws in a `srcdoc` frame with an empty `sandbox`. Deciding whether an artifact may run, which the producing tool records: [host-tool-vocabulary](host-tool-vocabulary.md).

## The shape is a grant, a response, the frame's sandbox, and one message

### The grant request names one artifact a task produced

`ServeArtifactRequest` in `packages/shared/src/ipc.ts`.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `taskId` | string | yes | the task whose artifact map holds it |
| `path` | string | yes | the logical path, as the producer addressed it |
| `project` | `ProjectRef` | no | the open project; absent resolves only when exactly one user project is open |
| `mediaType` | string | no | overrides the record's type for this grant; no renderer caller sends it |

### The grant answers with an address and the record's verdict

`ServedArtifact` in `packages/shared/src/ipc.ts`.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `url` | string | yes | `jaira-artifact://frame/<token>`, where `token` is a fresh `randomUUID` |
| `mediaType` | string | yes | the request's `mediaType`, else the record's `format`, else `mimeOfPath(path)` |
| `bytes` | number | yes | the UTF-8 length of the body as read |
| `interactive` | boolean | yes | `true` only when the record says so |

### The scheme serves a granted token's body under its own policy

The handler takes the URL path with leading slashes stripped as the token. The scheme is registered `standard` and `secure`, with no fetch API and no CORS.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| status | 200 or 404 | yes | 404 with body `no such artifact` when no grant holds the token |
| `Content-Type` | header | on 200 | `<mediaType>; charset=utf-8` |
| `Content-Security-Policy` | header | on 200 | `default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; frame-src 'none'; base-uri 'none'`, with `script-src 'unsafe-inline'; ` after `default-src 'none'; ` when the grant is interactive |
| `X-Content-Type-Options` | header | on 200 | `nosniff` |
| body | text | on 200 | the record's `content`, else the file at its `physicalPath` read as UTF-8, as copied at grant time |

### The renderer frames a grant with scripts and without same-origin

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| frame | `<iframe sandbox="allow-scripts" src={url}>` | yes | the frame has an opaque origin, so it reaches neither the window's DOM nor its storage |
| framed when | condition | yes | the value's `view` is `html`, the value carries `artifact.interactive: true` and an `artifact.path`, a `serve` callback exists, and the grant answered `interactive: true`; otherwise the static `srcdoc` rendering |
| `frame-src` | window policy | yes | `jaira-artifact:` in `renderer/index.html`, without which the frame is refused |

### A frame posts one message, which fills the composer and never sends

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `type` | `"prompt"` | yes | any other value is ignored |
| `text` | string | yes | non-empty after trimming; the first 4000 characters become the composer's draft |
| sender | the frame's `contentWindow` | yes | matched by `event.source`, never by `event.origin`, which every sandboxed frame reports as `"null"` |

A page posts it with `parent.postMessage({type: "prompt", text}, "*")`. It is heard only where the host passes `onPrompt`, as the chat view does; elsewhere it is ignored.

## A refused grant leaves the static rendering, and an unknown token is a 404

| Condition | Response | Caller does |
| --- | --- | --- |
| No project resolves | `Refusal` `no project is open` | the renderer catches it and draws the static rendering |
| No record for `(taskId, path)` | `Refusal` `no artifact at '<path>' for task <taskId>` | the same |
| The record's bytes are gone from `physicalPath` | `Refusal` `the bytes for '<path>' are no longer where they were placed` | the same |
| The grant answers `interactive: false` | the renderer frames nothing and draws the static rendering | none |
| A token was never minted or has been evicted | 404, body `no such artifact` | request a new grant |
| A message is not from the frame, has another `type`, or has empty `text` | ignored | none |

## Widening the policy or the message changes what model-written code can do, and no deprecation path exists

- The policy header, the sandbox flags and the `event.source` check together are what keep a model's page from the network, the window and the run. Loosening any one of them is a security change, not a compatible one.
- Adding `allow-same-origin` beside `allow-scripts` lets the frame remove its own sandbox.
- Changing the message's `type` or `text` breaks every interactive artifact already written, and nothing rewrites stored artifacts.
- Tokens are process memory, so a change to the grant shape reaches old frames only as 404s.

## Tokens, bodies and verdicts behave differently than an address suggests

- A token is reusable until evicted, not single-use. Only the 64 newest grants are live; minting the 65th evicts the oldest.
- The body is copied when the grant is minted, so a frame shows the artifact as it was then until a new grant is requested.
- The body is always read and served as UTF-8, so a binary artifact reaches the frame with its invalid bytes replaced.
- The policy is a response header, so markup inside the artifact cannot widen it with a `<meta>` tag.
- `interactive` comes from the record alone. A request's `mediaType`, the value's own claim and the artifact's type never make a grant scriptable, and an artifact recorded before the field existed never is.
- A message fills the composer through `setDraft`, replacing any draft there.
