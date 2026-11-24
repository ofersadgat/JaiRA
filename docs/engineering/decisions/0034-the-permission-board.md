---
id: engineering/decisions/0034-the-permission-board
type: decision
status: built
updated: 2026-11-23
decides_for: [engineering/decisions/0023-overlays-and-scopes, ui/components/permission-board, ui/components/composer-setting-chip]
---

# 0034. The permission board: a conversation's permissions as a grid of places, by resource, with each layer a set of answer columns

## The person's words

The person, 2026-11-23, over rounds of mockups (`docs/ui/assets/permission-layers/editor-*.html`):

> The grid should be: scopes on the left (i.e. what resource the access governs), access type on the top,
> and then individual scopes are chips that you can move in the grid to change the access of that scope.

> we might want to add the mapping from tool -> resource permission so that if the ui is showing resource
> permissions, we can find the tools that need those resource permissions and assign the tool permission
> correctly. we should make sure that if the tool doesnt have a resource permission mapping that we show
> the tool itself in the chart. lastly, this UI view should be a visualization of the runtime layer.

> the tool to permission map belongs in settings [...] one tool might map to multiple resources.

> i think that the way we do layers is: each layer is a set of columns where the column is a value of the
> permission.

> the view you're showing now makes sense for if you start from the tool view and you press a button to
> expand to show the source permission sets. from the shield, we should show the inverse of this: i.e. the
> root permission set first with the layers on top after.

Then "A, bands and threads" for the rows, "ok, build this", and, asked: a move on the Result goes to
**this conversation**; a move inside a set's layer **edits the set, asking first**; built in stays read-only.

## Context

The composer's shield showed a conversation's layers as segments and its Tools card as one list per tool
(decision 0023 §4.1, §7.4). A person asking "what may this conversation do to my files?" had to read
every tool's line, and every layer's, to find out — and nothing showed which layer an answer came from
beside the answer itself.

## Decision

1. **Resources and accesses.** A RESOURCE has ACCESSES and KINDS of place, in
   `shared/src/resourceVocabulary.ts`: Files (Read; Search: `glob`, `grep`; Write; Artifacts:
   `show_artifact`; Skills: `list_skills`, `load_skill` — an artifact and a skill are files), Sites
   (Search, Fetch), Repositories (Read, Write, Push, Merge — a branch is a repository's), Programs (See:
   processes, windows, services and installed software; Run: the shell, `script`, the runners and every
   command line — a command run is a program run, its places the folders it runs in; Open: `open_app`,
   an app launched or a file or link opened in its app, its places the apps; Control: processes, input
   and services; Install: `install_program`; Screen), Machine (Read, Change, Power, Clipboard),
   Workflows (See: `list_workflows`, `list_tasks`, `wait_for_event`; Start; Move; Control: answer, hold,
   release, stop). A service is a program the machine keeps running, and installed software is programs,
   so neither is a resource of its own (2026-11-23: "arent services effectively programs?"), and the
   tools are named so: `list_software` is `list_programs` and `install_software` is `install_program`
   ("Rename with aliases"). The old names still read: a line, a setting or a state that writes one means
   the new tool (`TOOL_ALIASES`, through `normalizeSubject` and `TOOL_SPEC_BY_NAME`), and a set that uses
   one is warned. Every tool JaiRA ships is under exactly one resource (a test says
   so); Other holds only an MCP tool no setting maps, and `other`, once. It is the board's grouping, not
   the engine's: a call is still decided by its tool's line (0023).
2. **The tool mapping.** Each tool JaiRA ships sits under the ONE resource it acts on
   (`DEFAULT_TOOL_RESOURCES`): `open_app` opens a program, so Programs · Open — the file or link it opens
   in it are places on that row; `write_clipboard` writes the machine's clipboard, so Machine · Clipboard —
   the files it copies are places on that row (2026-11-23, the person: "why is write_clipboard under
   files? [...] the clipboard is a machine resource. why is open_app under site and not programs?"). The
   settings' `permissions.resources.<tool>` (`[]` for none), in any settings layer, edited in Settings →
   Tools → **Tool mapping** right after Permission sets, overrides it per tool, and may name several. A
   tool that touches no resource is drawn as itself, under **Other**, with `other` ("everything not
   listed").
3. **Which resource a place belongs to**, for a tool the settings put under several: the first of them
   whose kinds have the place's kind (`owner=session` → Programs, `path=src/**` → Files), else the first;
   `**` belongs to every one.
4. **The board.** Rows: a resource, its accesses, each access's tools (treatment A of the mockups: a band,
   a pill on a thread, a dim monospaced line). Columns: allow, smart (any function), ask, deny, off. Each
   layer of the conversation's stack (0023 §2.6 — the root set, standing and named layers, the run's
   answers, the conversation's own lines) is a set of those columns, and the **Result**, every layer
   merged as `mergePermissionMode` merges them, is one more. A chip is a place in the cell of its answer.
   A Result chip is edged in the colour of the layer that answered; a layer's chip a newer layer
   overrules at the same place is struck through; where an access's tools disagree at a place, its Result
   chip is **MIXED**, parked at the strictest answer. An OPEN row keeps what every row under it says
   alike — a place with the same answer in each, in a column — and the rows under it show only where they
   differ (2026-11-23: "if a scope is the same across all of the sub rows, it stays in the parent row
   instead of being duplicated"); moving such a chip moves every line under it.
   A column no chip is in is not drawn — but This conversation's five, where a move on the Result lands.
5. **Place sets.** Named groups of places drawn as ONE chip where every place of the set is in a cell with
   one answer (`shared/src/placeSets.ts`): `credentials` (the eight places secrets live), `JaiRA
   settings`, `machine key`, `project files` (`$PROJECT`), `worktree files` (`$WORKTREE`), `agent
   workspace`, `temporary files`, and `root folder` — the machine's projects folder (Settings → Machines),
   where its workspaces and their worktrees go. The settings' `permissions.placeSets.<name>` adds a set or
   replaces one, edited in Settings → Tools → **Place sets**. A set's chip stands for every place in it.
6. **Two orders, two ways to group.** From the shield the board builds up: the root set first, each
   layer on top, oldest to newest, the Result frozen on the right; "Layers and sets…" is the picture the
   shield used to open. From the bar's **tools** segment it starts from the Result alone, frozen on the
   left, with no head of its own and only as wide as its columns; "Show the source permission sets" lays
   the layers beside it, newest first, and "Tool list…" is the Tools card it used to open (ticking a
   tool off is still its). **Resources | Tools** groups the rows by resource, or a row per tool under the
   app's tool categories. The grid is one scroll area: its heads stay on top and its labels on the left.
   An open row keeps what every row under it says alike, judged by the rows whose tools can be placed by
   the place's kind (the skill tools cannot be at a path; `show_artifact` is granted whatever its line says).
7. **The inspector.** Pressing a chip opens it beside the grid: where it is, who answered (or what each
   tool comes to, for MIXED), the five answers to change it with, a set's places (each one pressed to be
   looked at, and answered, alone), the layers it can be kept in or moved to, and the tools it sets.
8. **Moving a chip** writes a layer's lines: on the Result, the conversation's own lines (the tools layer,
   drawn empty until it has a line); within a layer, that layer; onto another layer, the place moves there
   (copied out of a read-only one). A set's layer is written to its file in the settings layer it is in,
   after "This changes <set> for every conversation that uses it". Built in, the run's answers and lines
   written on a state are read-only. Off is the whole line's: only a tool's everywhere answer goes there.
   A chip is dragged (web), or answered from the inspector (everywhere). An open section's row stays
   under the heads while its rows scroll past, until the next section's pushes it away.
9. **The layer heads compose the stack** (2026-11-23). The person: "the purpose of all of this is to
   create the right boundaries to be able to properly compose layers / change them. e.g. what if i want
   the default behavior to be deny? then i set the left most layer to be deny all and a later layer has
   to override it. I can then easily toggle it to ask by switching deny all to ask all and it will only
   ask for things it wasnt given explicit permission to."
   - A layer's **name** swaps it for another set; its **swatch** drags it along the stack (web); a **+**
     on the left edge of a head, on hover, adds a new layer just before it; its **⋯** holds Add a layer
     before it, Move earlier or later, Save as a set…, Clear its lines (This conversation), Forget this
     run's answers, Unpin from this project (a standing layer), and Remove from this conversation.
   - Only **This run** and **This conversation** stay where they are (This conversation is always last);
     a standing layer is the project's, unpinned rather than moved. The root and every named layer move,
     swap and go. None of this changes a set's file: it is the conversation's stack.
   - **+ makes an unsaved layer**, empty, kept only with the conversation: `$unsaved/<key>` in the stack's
     `layers`, its lines under `$unsaved.<key>` (`UNSAVED_LAYERS_KEY`; `permissionStackOf` reads it as a
     layer of its own). This conversation is the same kind of layer, pinned last. **Save as a set…** writes
     its lines to a set file (named, in this project, Shared or Just you) and puts the set in its place.
   - Swapping an unsaved layer that has lines asks **Replace** (the set takes its place, its lines go) or
     **Merge** (it stays, the set's lines copied in, the set's answer winning only where both say one at
     the same place — `mergedLines`); one with no lines is replaced. Removing one with lines asks first.
   - The built-in bases **base/deny-all**, **base/ask-all**, **base/smart-all** and **base/allow-all** (in `base/`, so the top level stays the conversation presets) give every tool that answer
     everywhere, and `other` too: a base to lay exceptions over, or to merge into a new layer and adjust.

## Consequences

- The stack view (`permissionSets:stack`) carries each layer's own lines (`PermissionStackViewLayer.own`).
- The board shows the run's answers ("for this run") as a read-only layer; there is still no "allow for
  this session" in the request dialog — "this conversation" is what a Result move writes.
- The mapping is presentation: a wrong mapping misgroups the board but never changes a decision.

## Revisit when

A person reads a resource's answer on the board and is surprised by what a tool on it then does — the
grouping has hidden a line that matters.
