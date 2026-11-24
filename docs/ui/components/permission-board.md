---
id: ui/components/permission-board
type: ui-component
status: shipped
updated: 2026-11-23
realizes: [ux/patterns/inherited-unless-set-here]
serves: []
surfaces: [ui/surfaces/chat-view]
reuses: [ui/components/icon]
implemented_by: [packages/universal/src/components/chat/PermissionBoard.tsx, packages/app/src/renderer/permissionBoard.ts, packages/app/src/renderer/permissionBoardHost.ts, packages/universal/src/components/settings/ToolMappingSection.tsx, packages/app/src/renderer/toolMappingModel.ts, packages/universal/src/components/settings/PlaceSetsSection.tsx, packages/app/src/renderer/placeSetsModel.ts, packages/shared/src/placeSets.ts]
verified_by: [packages/app/test/permissionBoard.test.ts, packages/app/test/toolMapping.test.ts, packages/app/shots/permission-board.mts]
mockups: [ui/assets/permission-layers/editor-play.html, ui/assets/permission-layers/editor-layers.html]
siblings: [ui/components/composer-setting-chip]
---

# Permission board

A grid of place chips: a row per resource, access and tool, a column per answer, each permission layer a group of answer columns beside the Result.

## It is the right view for what a conversation may do, and where each answer comes from

**Use when.** Reading or changing what a conversation may do to a resource, and which layer says so.

**Do not use when.** Editing a permission set's file as such — that is Settings → Tools → Permission sets.

## The person sees the resources first, and the layers beside them

- Resources are bands in their kind's colour, with a tile and their accesses under the name. Pressing one
  opens it into its accesses; pressing an access opens it into its tools.
- From the shield, the column groups run from the root set to this conversation, then the Result, frozen
  on the right. From the bar's tools segment, the Result alone, frozen on the left, with "Show the source
  permission sets" and "Tool list…".
- A column no chip is in is not drawn, but This conversation's five always are.
- An open row holds what every row under it says alike; the rows under it show only where they differ.
- A place set (`credentials 8`, `project files`) is one chip; a closed resource's chips carry the icons
  of the accesses they hold for.

## Every state, and what occupies the space in each

| State | Rendered as | Mockup |
| --- | --- | --- |
| reading | "Reading the stack…" | — |
| resting | rows by resource, Files open | [editor-layers](../assets/permission-layers/editor-layers.html) |
| a chip inspected | the chip ringed in the accent; the inspector beside the grid: where it is, who answered (or each tool's answer, for MIXED), the five answers, a set's places, the layers to keep or move it in, the tools it sets | — |
| asking | a warn strip: what the move does, "This changes <set> for every conversation that uses it", Cancel, Change it | — |
| refused | the foot says why (a read-only layer, Off for a place) | — |
| a layer act waiting | a strip under the bar: Replace or Merge; removing a layer's lines; a set's name and where to keep it | [layer-bar](../assets/permission-layers/layer-bar.html) |

## Interactions

| Gesture | Result |
| --- | --- |
| press a resource or access | opens or folds it |
| press a layer's head | folds it to one column, its chips dotted with their answer |
| drag a chip to a column in its row (web) | moves it there |
| press a chip | opens it in the inspector; pressed again, closes it |
| an answer in the inspector | moves the chip there, as a drag would |
| a set's place in the inspector | looks at that place alone, to answer it apart from the set |
| a layer's name | its swap menu: every set, findable by name; an unsaved layer with lines asks Replace or Merge |
| a layer's swatch, dragged onto another head (web) | moves the layer to just before it (onto This conversation: last) |
| the + on a head's left edge (hover) | a new, empty unsaved layer just before it |
| a layer's ⋯ | Add a layer before it, Move earlier/later, Save as a set…, Clear its lines, Forget this run's answers, Unpin, Remove |

## Copy

| Where | Words |
| --- | --- |
| the bar, shield | Permissions · the root set, each layer on top of it, then what the conversation has |
| the bar, Tools | Tools · what this conversation may do |
| a MIXED chip | MIXED — "its tools disagree here" |
| an overruled chip | struck through — "overruled by <layer>" |
