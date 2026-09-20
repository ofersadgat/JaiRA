---
id: engineering/decisions/0004-remote-review
type: decision
status: proposed
updated: 2026-09-19
decides_for: [engineering/contracts/gate-components, engineering/units/interaction-hub, engineering/units/secret-chain]
---

# 0004. Integrations, and a review that is also a merge request

## Context

Everything a run waits on today is on this machine: a person at the gate, a
board drag (`on_user_event`), a child task. Review is where that stops being
enough. The people whose opinion a changeset needs are often not the person
running JaiRA, and the place they already review is the forge.

What is wanted:

1. **Integrations** — a named connection to a remote system that can act on
   it and turn what happens there into something a run can wait on.
2. **Functions over them**, the first being `review_artifacts` with a
   `remote` option: create a branch, push it, open a merge request, and then
   wait for comments or a resolution from the forge **as well as** from the
   gate in the conversation. Whichever settles first answers the state.
3. The merge request has to **survive a loop**. A `revise` round pushes to
   the same branch and the same request; it never opens a second one.

Nothing exists to build on: no file under `packages/*/src` mentions a forge,
a push, or a merge request. Three pieces of machinery do exist, and the
decision is mostly their composition:

- **Durable gates** (`pending_interactions`, `RequestFate`,
  `InteractionHub.seed`): a parked gate outlives the process, and an answer
  that arrives later resumes the run. A remote review takes days; this is
  the property it needs.
- **Deferred calls** (`on_user_event`, `HostCapabilities.deferred`): a
  transition guard can wait on something outside the run, with a timeout,
  and a taken transition cancels the waits it did not answer.
- **Session scoping** (`hw/src/session.ts`): a name qualified by the scope it
  was written in, inherited through `environment`, stable across loop passes
  above the loop and distinct per `each` element below it.

The word used throughout is **merge request**. On GitHub it is a pull
request; the difference is the provider's business and no workflow says it.

### What the forges offer a desktop app

Researched 2026-09-19 against the vendors' docs and GitLab's source. Short
form: **no vendor-supported push channel reaches a client with no public
address**, so the design is polling that is cheap by construction, behind a
seam an evented source can take over later.

| | GitHub | GitLab |
| --- | --- | --- |
| Webhooks | need a URL the forge can reach | the same, and a hook is auto-disabled after 4 failed deliveries — hostile to an app that is closed for a weekend |
| Outbound stream | `gh webhook forward` is documented as testing-only, needs repo admin, one forwarder per repo | GraphQL subscriptions over ActionCable accept a PAT and cover approval and merge status, but **not notes or thread resolution**, and are documented only for GitLab's own frontend |
| A free "anything new?" | **yes** — an authenticated conditional request answered `304` does not count against the rate limit | **no** — a `304` still counts (measured); it saves bandwidth only |
| One probe for many requests | `GET /notifications` (`since`, `If-Modified-Since`) — classic PAT only, and it says *that* a thread moved, not what | `GET /merge_requests?scope=created_by_me&updated_after=…` — one call covers every request JaiRA opened on that host |
| Full state in one call | GraphQL `pullRequest { reviewThreads { isResolved … } reviews comments merged state }` — REST has no thread resolution | REST: the request, `/discussions`, `/approvals` |
| Create without an API token | no | **yes** — `git push -o merge_request.create -o merge_request.target=…`; the URL comes back in the push output |
| Poll floor | `X-Poll-Interval` (usually 60 s) must be obeyed | 2,000 requests/min per user on gitlab.com; self-hosted is the admin's |

A vendor-run relay (a GitHub App plus per-project GitLab hooks, queueing for
offline clients) is the only production-grade evented design, and it is a
service somebody has to run. It is not built here; the seam for it is.

Not verified, and therefore not relied on: whether a GitLab approval or a
thread resolution alone moves `updated_at`, and whether a GitHub thread
resolution alone moves the pull request's ETag. The slow backstop below
exists because of these.

## Options

| Option | For | Against |
| --- | --- | --- |
| A. `remote` is a flag inside `review_artifacts` and nothing else | Smallest build | The second function that needs a forge (a CI wait, an issue comment) rebuilds push, auth and watching. "Integrations" would be one component's private detail. |
| B. Only primitives; the author wires push → open → wait → map in every review state | No component change | Every workflow re-derives the comment-to-decision mapping, and the gate in the conversation and the wait on the forge are two states that cannot race. |
| C. Three layers, each written in the one below (**chosen**) | The component option is one line for the common case; the primitives are there for the uncommon one; the provider is the only code that knows a forge | Three surfaces to document. Rests on NAMES.md for how a request keeps its identity. |
| D. Shell out to `gh` / `glab` | The person is already logged in | Two optional binaries, uneven JSON, no conditional requests — which is the whole polling budget on GitHub |

## Decision

**C.** Three layers.

### 1. The integration: a provider and a connection

A **provider** is code: `github`, `gitlab`. It implements one interface and
is the only place that knows an endpoint.

```ts
interface ForgeProvider {
  open(req: OpenRequest): Promise<RemoteHandle>;         // create or find the merge request for a branch
  probe(handles: RemoteHandle[], cursor): Promise<Probe>; // cheap: which of these moved?
  read(handle: RemoteHandle): Promise<RemoteState>;       // full: threads, reviews, approvals, state, head
  comment(handle, body, anchor?): Promise<void>;
  reply(handle, threadId, body, resolve?): Promise<void>;
  merge(handle): Promise<void>;
  close(handle): Promise<void>;
}
```

A **connection** is configuration: `{ provider, host, token }`, one per host,
edited in Settings through `SchemaForm` and validated the way an executor is
(a `GET /user` that names who the token is). The token goes through the
secret chain and is never read back. A project's git remote picks the
connection by host, so a repo with `origin → github.com` and
`gitlab → gitlab.com` needs no per-project setup beyond naming the remote.

**Identity** is never configured in JaiRA. A commit is authored by
`git config user.name/email`, as a `ReviewNote`'s author already is; the
merge request and every comment JaiRA posts belong to whoever owns the
token. GitLab with no connection configured still works for the push and
the open (push options need only git credentials) but cannot watch, so
`remote` refuses to start there rather than opening a request nobody hears.

**Publishing is a policy decision, not a side effect.** A push and a merge
request leave the machine. Both go through the existing policy layer as one
capability, `remote.publish`, granted per project in Settings or approved
once per task at the gate. A `remote` in a workflow file is a request,
never the authorization.

### 2. The primitives

Host functions, registered like the six components' neighbours:

| Function | Does | Returns |
| --- | --- | --- |
| `remote_push` | commits the task's worktree state (or materializes a `tree: "base"` changeset onto a fresh branch) and pushes | `{ remote }` |
| `remote_open` | opens the merge request for the handle's branch, or finds the one already open | `{ remote }` |
| `remote_comment` | posts a comment or a reply; optionally resolves the thread | `{}` |
| `remote_merge`, `remote_close` | what they say | `{ remote }` |

And one deferred call, the sibling of `on_user_event`, on the same engine
machinery and with the same park semantics:

```
on_remote_event('merge_request', { events: ['settled'], settle_after: '10m', timeout: '7d' })
```

It resolves with the same `RemoteSettlement` the component uses (below), so
a workflow that wants a forge wait with no gate at all has one.

### 3. `review_artifacts` with `remote`

`remote` is an ordinary object parameter of `review_artifacts`. Nothing about
it is special to the format; every mechanism below is [NAMES.md](../../../NAMES.md).

```jsonc
// ~/.jaira/remotes.json — the one place remotes are defined; a project layers over it
{ "origin": { "to": "origin", "target": "main", "settle_after": "10m", "draft": false } }

// a root state makes one the default for every review below it (NAMES.md §7)
"environment": { "functions": { "review_artifacts": {
  "args": { "remote": { "$ref": "$/remotes.origin" } }
} } }

// a review state says nothing, overrides a field, or opts out
"args": { "prompt": "Review the implementation", "options": ["approve", "revise", "cut"] }
"args": { "remote": { "$ref": "$/remotes.origin", "draft": true } }
"args": { "remote": null }
```

| Field | Default | Meaning |
| --- | --- | --- |
| `to` | the project's only git remote, else required | which git remote to push to; its host picks the connection |
| `target` | the task's base branch | the branch the request asks to merge into |
| `settle_after` | Settings → Integrations | the quiet window after a comment (below) |
| `draft` | `false` | open the request as a draft |
| `title`, `description` | the task title; the prompt and the changeset summary | what the request says |
| `workspace` | the state's own | which worktree is pushed |

With no `remote` — none written, none inherited — the gate is local only, as
today. With one, the gate parks exactly as it does today and the same
request row also carries the handle. Two doors, one answer:
the hub settles the request once, from whichever side gets there first, and
the other side is told — the gate in the conversation redraws as answered
"on the forge, by <who>", and a gate answered in JaiRA posts one closing
comment saying what was decided.

Comments travel both ways while the gate is open. A note written in JaiRA's
reviewer is posted as an inline thread; a thread on the forge appears in
the reviewer as a `ReviewNote` with its replies. The shapes already agree:

| Forge | JaiRA |
| --- | --- |
| inline thread on `path:line` (+ replies, resolved) | `ReviewNote { artifact: change id, quote: that line's text, side, body, author, at, replies }` on that change's decision |
| comment on a file, or on a binary / renamed file | `ChangeDecision.comment` |
| general comment on the request | a note on the review as a whole, shown above the changes |
| approval / "request changes" / merge / close | the settlement, below |

#### What settles the gate from the forge

| On the forge | Review-level `decision` | Every change | The request afterwards |
| --- | --- | --- | --- |
| **merged** | `approve` | `merged` | merged; JaiRA applies nothing, drops its local copy and adopts the forge's history (below) |
| approved (the forge's own approve) | `approve` | `approved` | left open — approving is not merging |
| a comment whose whole body is a decision word | that word | per the word (below) | left open |
| "request changes" review submitted | `revise` | `comment` where a thread touches it, else `approved` | open; the next round pushes to it |
| comments, then quiet for `settle_after` | `revise` | the same | the same |
| closed without merging | `cut` | `denied` | closed |

**Merging the request is merging the changes.** It is the one remote act
that applies; everything else is judgement, and what happens to the request
after a judgement is the workflow's to say (`remote_merge`, `remote_close`).
The same holds from JaiRA's side: Approve at the gate does not merge the
request.

**After a remote merge the forge's history is the history.** The reviewer
may have squashed, rebased, or pushed a fixup of their own, so what landed
is not necessarily what JaiRA pushed, and JaiRA does not try to reconcile
the two. In order:

1. `git fetch <to> <target>`.
2. The task's worktree drops what it holds and moves to the fetched target:
   the task branch is reset to `<to>/<target>`. Later states in the task run
   on the merged tree. Before the reset, the old tip — and a commit of any
   uncommitted drift, if the worktree was edited while the gate was parked —
   is kept under `refs/jaira/dropped/<task>/<n>`, so "drop" never destroys
   the only copy of anything.
3. The local `<target>` is fast-forwarded, and only fast-forwarded. If it is
   checked out somewhere with a dirty tree, or has commits the forge does
   not, it is left alone and the gate's settled line says so; JaiRA never
   merges or rebases a branch the person owns.
4. Every change settles `merged`, `apply-changeset` is a no-op (there is
   nothing left to write), and the result's `remote.head` is the merge
   commit (`merge_commit_sha` / `squash_commit_sha`, or GitHub's
   `mergeCommit`).

**The decision word.** A comment is a decision when its body, trimmed and
case-folded, equals a value in the state's `options` or a `DecisionKind`
(`approved`, `merged`, `denied`, `reverted`, `comment`), or the obvious
verb form of one (`approve`, `deny`). As a general comment it decides the
review; as a reply on a file's thread it decides that change alone and
settles nothing. `merged` as a word means "apply it": JaiRA applies the
changeset locally, as the gate's own Merge does, and leaves the request
open.

**The quiet window.** A comment that is not a decision word starts a timer
of `settle_after`; each further comment restarts it. When it runs out the
gate settles as `revise` with everything said so far. Explicit acts — a
decision word, a submitted review, a merge, a close — settle at once,
window or not. The deadline is stored on the row as a timestamp, so
quitting the app neither loses nor extends it. `settle_after: 0` settles on
the first comment; the global default lives in Settings → Integrations and
the `remote` option overrides it per state.

**Who counts.** Only an account with write access to the project (GitHub
`author_association` of OWNER / MEMBER / COLLABORATOR; GitLab Developer and
up) can settle a gate or start its window. Anyone's comment is *shown*.
Comments by the token's own account are JaiRA's own and are ignored as
events.

**The result** is today's, plus the handle:

```jsonc
{ "decision": "revise", "decisions": [ … ],
  "settled_by": { "via": "remote", "who": "mara", "act": "changes_requested" },
  "remote": { "id": "…", "provider": "gitlab", "host": "gitlab.com", "project": "mistlabs/jaira",
              "branch": "jaira/t-qfr49rm80m/review", "target": "main",
              "number": 41, "url": "https://…/-/merge_requests/41", "head": "9f3c…" } }
```

### The same request on every round

The merge request has to be the same one on the loop's next pass, and two
`each` elements must not share one. That is what a scoped name is
(NAMES.md §3), and `remote` takes one the way any object position does:

```jsonc
// on the loop's parent: every pass below resolves the same (name, scope), so the same request
"environment": {
  "names": { "review": {} },
  "functions": { "review_artifacts": { "args": {
    "remote": { "$ref": "review", "to": "origin", "target": "main" }
  } } }
}
```

The name gives the identity; the plain keys beside `$ref` give the
configuration, which may itself be pasted from the file
(`{ "$ref": "review", … }` over `$/remotes.origin`'s fields). Scoped above
a loop it is one request on every pass; scoped inside an `each` element it
is one per element; written with no name at all it is private to the
instance — one request per pass — and the lint surface warns when it sees
that inside a loop. `args` is an untyped bag, so the explicit
`{ "$ref" }` form is the only spelling (REFERENCES.md §3.1).

**The handle comes back as data.** The function's result carries `remote`
(below), so a later state can also take the request by value —
`"remote": { "$expr": ".children.review.operation.output.remote" }` — which
is how it crosses an `each: "task"` or `"split"` boundary, where a name
does not reach.

Nothing here is a change made for remotes. What NAMES.md asks of upstream —
the scope half of `session.ts` made position-independent,
`environment.names`, `environment.functions` — is asked once, for every
position. The alternative of keying the request on the existing session
`resourceKey` was rejected: it makes "shares a merge request" and "shares a
conversation and a permission ledger" one declaration.

JaiRA's side is a table, `remote_handles`, one row per `(task, key)`:
provider, host, project, branch, target, number, url, pushed head, the
probe cursor, the ETag, the ids of threads already seen, and `settle_at`.
A rerun mints a task and therefore a new request. A fork copies the row's
identity but not the request: the fork's first push opens its own. A rewind
keeps the row — the forge cannot be rewound — and the next push adds
commits; JaiRA never force-pushes.

A revise round, given the handle, commits the revision, pushes to the same
branch, replies on each thread it addressed (and resolves it when the
responder said `fixed`), and parks again. Threads carry over; the window
and the seen-set do not reset the forge's own history.

### Watching: one poller per connection, and events only ever mean "go look"

```ts
interface RemoteEventSource { start(onHint: (hostKey, handleKey?) => void): Disposable }
```

A hint says a handle *may* have moved. Truth is always a `read()`. Polling
is one source; a relay or a webhook receiver is another, later, and changes
nothing downstream — which is also what makes a missed or duplicated hint
harmless.

The poller, in main, owned by the connection and not by any gate:

- **Nothing parked, nothing polled.** The loop exists only while a
  `remote_handles` row is awaiting.
- **One probe per host per tick**, however many requests are open. GitLab:
  the `updated_after` list call. GitHub: a conditional `GET` per watched
  pull request, which costs nothing while the answer is `304`; with a
  classic PAT, `/notifications` first and the per-request probes only when
  it moved.
- **A full `read()` only for a handle the probe says moved**, and then one
  call (GraphQL) or three (GitLab REST).
- **Adaptive cadence.** 60 s while a quiet window is open or the task is on
  screen; doubling to 15 min while nothing moves; back to 60 s on any
  change. `X-Poll-Interval`, `Retry-After` and a `429` always win, and a
  failing host backs off on its own without touching the others.
- **Immediate probes** on app start, on the window regaining focus after
  five minutes away, on the machine waking, and from a "Check now" on the
  gate.
- **A slow backstop**: a full `read()` of each awaiting handle every 30 min,
  because two "does this move `updated_at`?" answers are unverified.
- **Closed for a weekend** is the normal case, not an error: the cursor is
  on the row, the first probe after start sees everything since, and a
  window whose deadline passed while the app was closed settles on that
  first read — after the read, so late comments are in it.

### What draws

The gate says it has a second door: the request's number and link, who has
commented there, the window's deadline when one is running, and "Check
now". A thread from the forge renders as the note it is, with a mark for
where it came from. The board card says "in review on GitLab !41" rather
than "waiting for you" when the forge is where the question is open.
Settings gains an Integrations pane: connections, each validated, the
default `settle_after`, and the per-project `remote.publish` grant.
Mockups (today's gate as the baseline, then each proposed state):
<https://claude.ai/artifact/EyMkJZGsdz9E5BooNx6cmr>.

## Build order

1. **Provider + connection + Settings pane.** `ForgeProvider` for GitLab
   and GitHub against recorded fixtures; the secret-chain token; validate.
2. **Primitives**: `remote_push`, `remote_open`, `remote_comment`,
   `remote_merge`, `remote_close`; the `remote.publish` capability;
   `remote_handles` (migration). By-value handles only — no scoping yet.
3. **The poller and `on_remote_event`**: probe/read, cadence, the settlement
   mapping as a pure function over `RemoteState` + the changeset (every row
   of the table above is a test), the durable window.
4. **`review_artifacts.remote`**: two doors on one request in the hub;
   notes in both directions; `settled_by` and `remote` in the result.
5. **Scoped names (NAMES.md)**, upstream: then `changeset/review-loop`
   carries the request by name instead of by value.
6. **The UI**: the gate's remote strip, forge-sourced notes, the card line.

Each step is usable on its own. Until 5, a loop carries the request by
value through `coalesce(...)`; nothing before it is blocked on it.

## Open

- A `tree: "base"` changeset has no commit to push. Step 2 materializes one
  on a scratch worktree; whether that worktree is kept for the revise rounds
  or rebuilt per push is decided when it is built.
- GitHub fine-grained PATs cannot read `/notifications`. The per-request
  conditional probe is free anyway, so this costs only the cross-repo
  shortcut.
- The two unverified `updated_at` questions get an empirical answer in step
  3; if both move it, the backstop interval can grow.
