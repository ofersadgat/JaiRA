---
id: engineering/decisions/0006-built-in-layer
type: decision
status: proposed
updated: 2026-09-20
decides_for: [engineering/units/project-layout, engineering/units/workflow-snapshots, engineering/units/workflow-browser, engineering/units/tool-policy, engineering/units/chat-turns]
---

# 0006. A built-in layer: what JaiRA ships is the bottom of the search path, not files it writes

## Context

JaiRA needs a few states to exist on every machine: the conversations the
Chat view starts, the self-test, and — with [0005](0005-connect.md) — the
conversation that controls a dynamic workflow. Today it gets them by
**writing files into the shared root**: `chatWorkflowFiles` and
`workflow:write`, a `chat.installed` flag, an "install what is missing"
step before the first message, and the same again for `debug/hello_world`.

That has three costs. A file JaiRA wrote and a file a person wrote are
indistinguishable afterwards, so an upgrade cannot improve the first
without risking the second. A machine with a repointed or read-only shared
root cannot start a conversation. And every new built-in needs its own
install step.

0005 adds more of the same kind: two conversation states and the
**toolset** each runs under ([0007](0007-toolsets.md)) — all things a
person must be able to change, per machine and per project.

Two layers already exist and already do the right thing: a bare id or a
`$/…` reference is searched along `paths.roots` — the project's `.jaira/`,
then `~/.jaira/` — first match wins, shadowing is the override
(`workflowRefs.ts`). Host *functions* already have a third source beneath
both: the registry is "a contributor on the search path, consulted where
the path finds nothing", so `on_user_event` resolves with no file anybody
created, and a project's own file of that name still wins.

## Options

| Option | For | Against |
| --- | --- | --- |
| A. Keep installing files into `~/.jaira` | Built | The three costs above, once per built-in, growing with 0005 |
| B. Hard-code the built-ins (states as TypeScript constants the host special-cases) | No files at all | Nothing to open, read or override; the Chat view's states stop being workflows |
| C. A third, read-only layer at the end of the search path, shipped inside the app (**chosen**) | Override is the mechanism that already exists; an upgrade changes the bottom layer and nothing a person wrote; nothing is installed | A third place a reference can resolve from; the pane and the editor must say which |
| D. Settings keys that point each role at a state id | Explicit | A second override mechanism beside shadowing, for the same job |

## Decision

**C.** `paths.roots` becomes three: the project's `.jaira/`, the shared
`~/.jaira/`, and **`$SYSTEM`** — a directory inside the installed app with
the same shape as the other two (`workflows/`, `prompts/`, `functions/`,
`toolsets/`). It is last, always, and configuration cannot
move or remove it.

```text
.jaira/workflows/chat/control.json       ← wins here
~/.jaira/workflows/chat/control.json     ← wins on this machine
$SYSTEM/workflows/chat/control.json      ← what ships
```

- **Same id, same file format, same resolution.** Nothing about a state
  file changes between layers. `$SYSTEM/…` names the shipped copy for an
  author who means exactly that, as `$BASE/…` and `$JAIRA/…` do theirs.
- **Read-only.** The app never writes there and the editor will not save
  there. "Override" copies the file up a layer, as it does today from
  shared to project — now with a choice of which.
- **A role is a well-known id.** The Chat view starts `chat/session`; a
  dynamic workflow made from a task is given `chat/control`; the self-test
  is `debug/hello_world`. Which file answers is the search path's
  business. There is no settings key per role (option D).
- **Trusted.** A `.ts` function in `$SYSTEM/functions` is not subject to
  the module approval gate: it is the app's own code. One shadowed by a
  person's copy is that person's module, and gated like any other.
- **Pinned like anything else.** A snapshot's closure copies what it
  resolved from whichever layer supplied it, so a running task keeps the
  built-in it started with across an app upgrade.
- **The install steps go.** `chatWorkflowFiles`, `chat.installed` and the
  self-test's write are removed. A file they already wrote to `~/.jaira`
  stays, and now reads as what it is: an override. The app offers to delete
  one that is byte-identical to a version it once shipped.

### Toolsets are fragments in the layers

What an agent may do is a **toolset**, and what a toolset *is* — a map
from a subject to a mode, in buckets — is [0007](0007-toolsets.md)'s
decision. What this one decides is where they live: they are ordinary
layered fragments, `toolsets/<bucket>/<name>.json`, and a state names one
with the reference form that already exists (WORKFLOWS.md §2.2):

```jsonc
// $SYSTEM/workflows/chat/control.json
"environment": { "kind": "prompt", "tools": "$/toolsets/chat_control/ask-first" }
```

Drop a file at the same path in `~/.jaira/` or `.jaira/` and it wins — for
every state that refers to it, which is the point: "on this project the
control conversation may start work without asking" is one file, not an
edit to every state.

### Settings shows the third layer

The layer picker gains a third segment, **Built in**, everywhere it
appears. It is read-only: it shows what ships and offers "Override for all
projects" and "Override here", which write the copy and switch to that
layer. "Reset to built in" deletes an override; "Compare with what ships"
diffs the two. The pane that edits toolsets is 0007's.

### What ships

| Id | Is |
| --- | --- |
| `chat/session` | what the Chat view starts: a person began a conversation, and it may do anything — work in the project, start a workflow, neither. Toolset `chat/ask-first`. It takes `chat/agent`'s place in the Chat view |
| `chat/control` | what a task gets when a person moves it and the move makes a dynamic workflow (0005 §3). It exists to steer work and nothing else: toolset `chat_control/ask-first`, which holds the task and workflow tools and nothing of the project |
| `chat/assistant`, `chat/agent` | unchanged, so conversations already started as one keep running |
| `debug/hello_world` | the self-test |
| `toolsets/chat/*`, `toolsets/chat_control/*` | ask-first, read-only, auto and full, in each bucket (0007 §2) |

### What draws

Mockups: [0006-assets/](0006-assets/), and with the others at
<https://claude.ai/artifact/QSSuGXa9XPVuZdTgauzAqT>.

- **The editor's top bar** already says "shared copy". A built-in says
  "built in · read-only" and offers the two places it can be overridden.

## Consequences

**Easy.** A new built-in is a file in the app. An upgrade improves every
machine that has not overridden it, and cannot touch one that has. A
locked-down shared root still gets a working Chat view.

**Hard.** "Why did this resolve to that?" has three answers, so every
surface that shows a state has to say which layer supplied it. A person
who overrode a built-in a year ago does not get its improvements, and
nothing tells them unless the pane does.

**Foreclosed.** Built-ins as code (B), and the app writing into a root a
person owns.

## Build order

1. `$SYSTEM` in `paths.roots` and the reference roots; the vfs over the
   app's resources; the approval gate's exemption; lint and snapshot tests
   across three layers.
2. Move `chat/assistant`, `chat/agent` and `debug/hello_world` into it;
   delete the install steps; the identical-copy cleanup offer.
3. `toolsets/` as referenced fragments; the linter resolving them; the
   third segment of the layer picker.
4. The editor bar, the Workflows pane's layer mark, the Tools chip.
5. With 0005 step 6 and 0007 step 4: `chat/session`, `chat/control`, and
   the toolsets they name.

## Built

**Step 1 (2026-09-21).** `packages/shared/src/paths.ts` holds the layer (`JairaBuiltInPaths`,
`paths.builtIn`, `roots` ending with it); `packages/persistence/src/workflowRefs.ts` adds `SYSTEM`
to the reference roots and forces the layer's two directories to the end of the search path;
`userModules.ts` holds the exemption (`trustingBuiltIn`); `WorkflowLayer` gained `"system"`.
Tests: `packages/persistence/test/builtInLayer.test.ts`, `packages/app/test/builtInLayer.test.ts`.
What the build settled that the text above left open:

- **Where the directory lives.** Its source is `packages/shared/builtin/`, and both bundlers copy
  it to `dist/builtin/` beside their output, so the published CLI ships it through the `dist` it
  already publishes. `defaultBuiltInDir()` looks in `<resources>/builtin` (a packaged app), then
  beside the running module (a bundle), then one level up (source under tsx and vitest). It is a
  real directory and not something inside an asar, because worker threads and the TypeScript
  compiler host read it with plain `node:fs`; so "the vfs over the app's resources" is the
  ordinary `nodeVfs`.
- **Nothing a person configures can name it.** `setBuiltInDir` is a call a host makes at startup
  and a test makes for a fixture. There is no environment variable and no settings key, because
  whatever names the directory names code that runs unapproved.
- **`workflows.path` cannot drop it.** A configured path replaces the generated list, so the
  layer's directories are appended after it and lifted out of it if it named them earlier.
- **The exemption covers the whole layer, not `functions/` alone**, so a shipped function that
  imports a helper from beside it does not prompt. It is decided by location: a byte-identical copy
  elsewhere is gated.
- **`$SYSTEM/…` pins a document and not a state.** A state reference under any search directory
  folds to its bare id upstream, as `$BASE/workflows/…` always has, so shadowing applies to it.
- **`$SYSTEM` was already a word in artifact destinations** (a root's generated `system/`). The two
  vocabularies never meet, and the code says `builtIn` for the layer and `systemDir` for the other.
- **The write refusal is one guard.** `AppService.writable` is called by every surface that takes
  a layer and changes a file; before it, a `system` layer fell through each
  `layer === "base" ? … : …` as `project`. A copy OUT of the layer is allowed — it is the override.
- **The Files tree does not draw the third root yet.** The workflow listing and lint see three
  layers; the tree is where files are made, and its read-only root belongs with steps 3–4.
- The layer ships holding only a `README.md`. The install steps are untouched (step 2).

## Revisit when

Overrides of built-ins go stale often enough that people are running old
conversations without knowing — at which point an override wants to be a
*patch* over the shipped file rather than a copy of it.
