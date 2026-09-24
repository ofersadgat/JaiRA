---
id: engineering/decisions/0008-side-panels
type: decision
status: built
updated: 2026-09-24
decides_for: [engineering/contracts/ipc-channels]
---

# 0008. One side panel per room, from a stack

## Context

The right-hand column was chosen by four rules, one per room, and each had its own idea of "back":

- **Files.** It described the last crumb of the address. That meant a run inspector (whose ← deselected
  the task), a task inspector reached by asking (whose ← restored one level), a state inspector that had
  a ← only sometimes, a folder inspector, and a file inspector.
- **Tasks.** A column click showed the state, and a card click showed the task's conversation. Details
  sat behind a toggle, with a "Live events" dump of event types.
- **Chat.** No column until a value was pinned. Then there was a column for the one value, with a ✕.
- **Debug.** Its own copy of the task panel.

A pinned value outranked everything until its ✕. Nothing had a history, so every link inside the panel
threw away what the panel had been showing. The same conversation could be on screen twice: in the
middle column, and in the task panel beside it.

The person ruled over eight rounds of mockups (2026-09-24, the panel-views artifact).

## Decision

**One panel per room, drawn from a stack** (`panelStack.ts`, `sidePanel.tsx`).

- **The root is the room's rule.** It is recomputed from what the room stands on (`App.tsx`, `ruleOf`):
  - A card is its task.
  - A column is its state.
  - A state file in Files is that state.
  - A walked-into run is its task, or its conversation's context when the conversation is in the main
    view.
  - A chat is its context.
  - The Debug room shows its self-test's task.
  - A plain file or folder has no panel. Its facts are behind an ⓘ on the address.
- **Links push.** A link inside the panel pushes an entry: the configuration as it ran, a value, a
  subagent's conversation, a re-run with changes, New task. ‹ pops. A crumb in the head pops to its
  level.
- **The middle replaces.** Choosing something in the middle replaces the stack.
- **Pin.** A pinned stack belongs to the whole window. It is immune to every selection and room change
  (ruling of 2026-09-24, round 2), and push, pop and tabs work on it as on any stack.
  - It shows in every room that has a panel.
  - Each room keeps reconciling its own stack underneath. A room standing on something else offers it
    on the offer bar ("*X* is selected · Show it here").
  - Unpinning, taking the offer or closing hands the column back to the room.
  - The routing is `routeChange` and `shownStack` in `panelStack.ts`.
- **Fold.** Folding collapses the panel to a 48px rail. The rail shows the root's tabs as icons, each
  with its name under it and its badge. Pin and unfold sit at the foot. Fold is remembered per room,
  and Chat starts folded.
- **Close.** ✕ closes the panel until the room stands on something else.
- **Width.** It is remembered per **kind** of thing on top (`panel.task`, `panel.state`,
  `panel.config`, `panel.preview`), not per room. It tweens when the kind changes.
- **Motion.** A push slides in from the right, a pop from the left, a replace fades.

**Every entry has a face** (`panelFaces.tsx`): a glyph, a name, a line of facts, verbs as icons on the
name's line, and tabs.

| Entry | Tabs |
|---|---|
| task | Conversation · Steps · Changes · Outputs · Configuration |
| convo (beside its conversation in the main view) | Steps · Produced · Changes · Held |
| chat | Produced · Changes · Held |
| state | Run (form over history) · Checks · Configuration. Configuration is hidden while the Files editor has the file. |

- **Tab labels.** As many labels as fit: the open tab's first, then from the left (`panelTabs.ts`).
- **Never twice.** The same conversation is never on screen twice. ⇤ moves a task's conversation into
  the main view, and the panel becomes its context. ⇥ gives it back.
- **Steps** is the run index in a box that **fits** (`stepCompaction.ts`). The compaction happens in
  three levels:
  1. Fold what is off screen.
  2. Replace the farthest runs with `⋯ N steps` rows, which draw dots on the rail and name what they
     pass over.
  3. Fold the parents into one breadcrumb row.

  Hand folds stick. They open while the current step is inside them, and fold again when it leaves. A
  folded state is B's stacked knot with D's tile.
- **The step card.**
  - Selecting a step opens its card under the box: inputs and output first, then how it ran.
  - A step is selected from the list, or from a letterhead's name in either conversation
    (`PickStepContext`).
  - The card closes when the step being viewed moves on. Only the conversation's travel to the pick
    itself is exempt.
- **Current step.** "Current" is the step being viewed: the live step while the conversation follows
  the bottom, and the sheet at the centre when scrolled up (`RunConversation`'s `onHere`).
- **Settings shape.** Panels use the settings shape: a section is a heading over one card of rows.

**Files editor.** A slot's default is its binding box's placeholder. A file opens on Form, including
composites.

**Copy-on-edit for built-in states.**
- A shipped state is mounted live.
- Its first change copies it into Shared (`~/.jaira`) and opens the copy. Every keystroke up to then
  becomes the copy's unsaved draft (`moveWorkflow`'s `draft`).
- It stays read-only when Shared already has a copy, because that copy is the one that runs.

**⇤ from a state** opens the file and no run of it (`selectState(id, { run: false })`).

**Re-run with changes** starts either from the beginning with edited inputs, or before any state the
task entered. The second is a fork at that state's entry, so it keeps the inputs the task ran with.

**New channel.** `task:changes` returns a task's worktree edits as a changeset, read only, for the
Changes tab.

**Removed.**

- Components: `StateInspector`, `RunInspector`, `TaskInspector`, `TaskContext`, `TaskPanel`,
  `TaskHead`, `TaskDetailSections` (and its Live events), `PinnedPane`, and the chat's Produced
  disclosure.
- Pane widths: `files.inspector`, `tasks.panel`, `chat.panel`.
- Store state: `editorTabLast`.

## Consequences

- The store holds one selected task's run. A panel entry about another task loads that task's run
  itself (`taskRun.ts`, shared with `AdoptedHistory`): its tree, conversation, sessions, records, live
  tail and gate. So a pinned panel works fully, conversation included.
- A state the store isn't holding is read with `state:view`, and its run form is built the way a board
  column's is.
- `shots/panels.mts` photographs every room's panel in the real app.
