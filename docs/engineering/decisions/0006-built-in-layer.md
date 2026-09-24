---
id: engineering/decisions/0006-built-in-layer
type: decision
status: built
updated: 2026-09-23
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
**permission set** each runs under ([0007](0007-permissionSets.md)) — all things a
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
`permission-sets/`). It is last, always, and configuration cannot
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
  stays, and now reads as what it is: an override. (The app offered to delete
  one that is byte-identical to a version it once shipped; that offer was
  removed on 2026-09-22 once no such copy remained.)

### Permission sets are fragments in the layers

What an agent may do is a **permission set**, and what a permission set *is* — a map
from a subject to a mode, in buckets — is [0007](0007-permissionSets.md)'s
decision. What this one decides is where they live: they are ordinary
layered fragments, `permission-sets/<bucket>/<name>.json`, and a state names one
with the reference form that already exists (WORKFLOWS.md §2.2):

```jsonc
// $SYSTEM/workflows/chat/control.json
"environment": { "kind": "prompt", "tools": "$/permission-sets/chat_control/ask-first" }
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
diffs the two. The pane that edits permission sets is 0007's.

*In Settings, superseded on 2026-09-23 by copy-on-edit — see "Copy on edit" at the end. The Files
tree and the state editor still offer the two overrides for a state file.*

### What ships

| Id | Is |
| --- | --- |
| `chat/session` | what the Chat view starts: a person began a conversation, and it may do anything — work in the project, start a workflow, neither. Permission set `chat/ask-first`. It takes `chat/agent`'s place in the Chat view |
| `chat/control` | what a task gets when a person moves it and the move makes a dynamic workflow (0005 §3). It exists to steer work and nothing else: permission set `chat_control/ask-first`, which holds the task and workflow tools and nothing of the project |
| `chat/assistant`, `chat/agent` | unchanged, so conversations already started as one keep running. **Removed 2026-09-24** (the person's ruling): neither ships any more, and a task created from one no longer resolves or lists as a conversation |
| `debug/hello_world` | the self-test |
| `permission-sets/chat/*`, `permission-sets/chat_control/*` | ask-first, read-only, auto and full, in each bucket (0007 §2) |
| `settings.json` | added 2026-09-23 (Settings round 5): the configuration layer under the shared root's — the presets `simple`, `coder` and `planner`, each a candidate list chosen from when a session starts, and `functions.smart.model: "simple"` |

### The layer also ships settings (amended 2026-09-23)

`$SYSTEM/settings.json` is the bottom of the configuration layers, as the directory is the bottom of
the search path: `loadLayeredConfig` merges built in, then the shared root, then the project, key by
key; the shared root opened as a project merges built in under its own file. It is found by
`jairaBuiltInPaths().settingsFile`, copied to `dist/builtin/` with the rest of the directory, and
returned to Settings as `ConfigView.system` so a built-in value can be tagged as one. It is read-only
like everything here, but Settings does not make a person "Override" first: a built-in preset is
edited in place, and saving writes it into the layer being edited (a normal layered write, into any
`ConfigLayer`), after which the rail reads "copied from built in" and "Put back the built-in" deletes
the copy. The presets and what a preset's model is: [settings-json](../contracts/settings-json.md)
and [model-routing](../units/model-routing.md).

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
   delete the install steps; the identical-copy cleanup offer (since removed).
3. `permission-sets/` as referenced fragments; the linter resolving them; the
   third segment of the layer picker.
4. The editor bar, the Workflows pane's layer mark, the Tools chip.
5. With 0005 step 6 and 0007 step 4: `chat/session`, `chat/control`, and
   the permission sets they name. *Built 2026-09-21* — see below.

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
- The layer shipped holding only a `README.md`, and the Files tree did not draw it. Both changed
  with the steps below.

**Steps 2 and 4 (2026-09-21).** `chat/assistant`, `chat/agent` and the three `debug/hello_world`
states are files under `packages/shared/builtin/workflows/`. `chatWorkflowFiles`, `selfTestFiles`,
the `chat.installed` flag, the Chat view's write before its first message and the Debug pane's
`Install missing` / `Reinstall` are gone. The tree, the editor bar and the cleanup offer are built;
the layer picker's third segment and "Reset to built in" were not, because no Settings pane held a
value the layer ships (it has no `settings.json`). **Both landed with 0007 step 6 (2026-09-21)**, in
the pane that gave them something to show — see the note at the end of this file. Tests:
`packages/app/test/builtInStates.test.ts`. What the build settled:

- **The cleanup offer is gone (2026-09-22).** It offered to delete a shared-root copy whose parsed
  value equalled a version JaiRA shipped, and kept the old versions by hand in
  `shippedStates.ts` (`SUPERSEDED`). Once no such copy remained in `~/.jaira`, the offer, its
  `builtin:leftovers` / `builtin:cleanup` channels, `BuiltInStanding.identical` and that list were
  removed: backward-compatibility code is not kept once the data it served is gone.
- **The tree's last root is the layer, in every tree.** A project's tree, the shared root's and
  the all-projects tree each end with one `system` root labelled `Built in`. It has no sidebar row
  to be reached by, which is why it is listed where the shared root is not. Its rows offer Open,
  the two overrides, and the ways to copy or reveal a path.
- **Which layer supplied a state is two marks.** A shipped row a person's file shadows is
  `shadowed` and reads `overridden`; the person's row carries `overridesBuiltIn` and reads
  `override`. The second exists because a project's tree does not hold the shared root, so the
  shipped row alone could not say which of them won.
- **A file reports its own standing.** `file:read` and `workflow:read` answer `builtIn`
  (`BuiltInStanding`): every layer holding that state id in search order. The editor bar is a pure
  function of that (`layerBarOf`).
- **What ships is read, not edited.** The panel mounts every editor on a `system` document as the
  reading of its type, the state editor wraps itself in `ReadOnlyContext` and draws no Save, and
  `AppService.writable` refuses the write regardless.
- **A shipped state runs where the person stands**: the open checkout, else the shared root
  (`runTargetOf`). That is the routing the Chat view and the self-test already used.
- **The suite sees an empty layer by default.** `test/setup.ts` registers an absent directory with
  `setBuiltInDir`, so a listing asserted in a test is that test's own; `shippedLayer()` in
  `test/testing.ts` opts one test into the real files.
- **Not changed:** the self-test still records its run in the shared root's own project, so a
  read-only shared root runs a conversation from an open checkout but not the self-test.

**The third segment (2026-09-21), with [0007](0007-permissionSets.md) step 6.** The Permission sets pane is the
first Settings section holding a value the layer ships, so it is where "Settings shows the third
layer" finally had something to show. What the build settled:

- **The segment is a property of the SECTION, not of the layer.** `SECTIONS` in `App.tsx` carries
  `builtIn`, and only Permission sets has it; the other layered sections read `settings.json`, which the
  built-in layer does not have, and would gain a segment that showed an empty file.
- **It is not a `ConfigLayer`.** `configLayer` names a `settings.json` to write and is read as one
  of two everywhere else, so "showing what ships" is a separate boolean beside it and the pane is
  handed a `WorkflowLayer`. `LayerPicker` grew a `layers` prop and a type parameter; with no
  `layers` it is the two-segment switch every other section draws.
- **It is session-scoped**, and leaving the section returns to the layer chosen before: a window that
  reopened on a read-only layer would open looking as though nothing could be changed.
- **With no project open the switch STAYS** on such a section and drops `This project`, where every
  other layered section replaces the whole switch with a sentence. `Built in` is still a choice
  worth making with nothing open.
- **"Reset to built in" is the lower layer's name, not a constant.** A project's override of a
  SHARED permission set resets to the shared one, so the button reads `Reset to shared` and the link beside
  it `Compare with the shared one`. It is offered only where a lower layer holds the file.
- **The two overrides write and then MOVE.** `Override for all projects` / `Override here` write the
  override and switch the pane to that layer, opened on the same permission set — the shipped one is read,
  and the copy is what can be changed.

**Step 5 (2026-09-21).** `chat/session` and `chat/control` are files under
`packages/shared/builtin/workflows/chat/`, each naming its permission set by the
reference form this decision chose — `$/permission-sets/chat/ask-first` and
`$/permission-sets/chat_control/ask-first`. The Chat view starts `chat/session`
(`CHAT_SESSION` in `chatWorkflow.ts`) and `CONNECT_CONVERSATION` is
`chat/control`; `chat/agent` and `chat/assistant` stay, so a conversation
already started as one keeps running. What the build settled:

- **The permission set reference sits on `operation`, not `environment`.** A dynamic
  workflow's root is a state with an operation and children, and `environment`
  is the default for every child it starts ([0005](0005-connect.md) §3, "What
  step 4 settled") — so a control conversation whose tools were written there
  would hand the workflow tools to the states it steers. The loader resolves an
  operation's execution-environment fields into the state's own resolved
  `environment`, so everything downstream reads them exactly as before while
  nothing is inherited. The `$/…` reference is followed at `operation.tools`
  because lowering already visited that block.
- **`chat/control` declares one required string input**, the sentence saying
  what the person did. It is what [0005](0005-connect.md)'s step 5 fills by
  schema and never by name, and it is what makes the generated document lint
  with the conversation as its root. The conversation does not SAY it — a
  control starts idle — but the task records it, with provenance `bound`.
- **Neither names a model**, as `chat/agent` and `chat/assistant` do not: a
  conversation that pinned one would ignore the machine it runs on, and the
  run's start-time route check would refuse it on a machine set up differently.

**Copy on edit (2026-09-23, Settings round 5).** The person's note: "any config is editable, and
editing a built-in copies it to the selected layer first". In Settings the built-in layer is no longer
something a person switches TO: the Tools page's `Built in` segment is gone (and, with it, the page's
session-scoped `permissionSetsBuiltIn` and the pane's `system` layer), and so is `Override here`.
A shipped permission set is shown on every layer that does not state its own, and it is live there.
What the build settled:

- **The first change IS the override, in one write.** The pane sends the map as shown with that one
  change through the existing `permissionSets:write`, and `writePermissionSet` already wrote what
  `Override here` wrote — `{ "$ref": "$SYSTEM/permission-sets/<bucket>/<name>" }` — plus the lines
  that differ. So the copy still FOLLOWS what ships (an upgrade reaches every line the person did not
  change), a change that takes a line out still detaches, and no channel was added: there is never a
  copy on disk that the change did not reach, because they are one `wx` write.
- **"Copied from" is where the files are, not whether the copy follows.** A layer's file over a lower
  one reads `shared · copied from built in` / `this project · copied from built in` / `this project ·
  copied from Shared` (`permissionSetStanding`, `copiedFrom`), and the head counts the lines that
  differ from what it was copied from, on the resolved maps (`copyDifferences`). A detached copy is
  still a copy of what ships.
- **A project over a shared copy copies what is in effect** — the shared one, by `$BASE/…`, as the
  writer always chose the nearest lower layer.
- **"Reset to built in" became "Put back the built-in"**, asked in the page first (`Put back the
  built-in? This deletes {file}.`), because it deletes a file and every change made in it. A
  project's copy of the shared one keeps `Reset to shared`.
- **The personal layer (Just you) cannot hold a permission set**: it is one settings file and a set is
  a file of its own. It reads what the nearest layer that holds files says, and its first change to
  a set asks `Copy to Shared` / `Copy to this project`; the answer replays the change over that
  layer's own view of the set (`rebasePermissionSetChange`), so a nearer layer's lines never ride
  along, and is remembered for that set while the page is open.
- **The Functions sections below the pane take the page's layer**: their defaults were read-only on
  `Built in` and are now always written into the layer being shown.

## Revisit when

Overrides of built-ins go stale often enough that people are running old
conversations without knowing — at which point an override wants to be a
*patch* over the shipped file rather than a copy of it.
