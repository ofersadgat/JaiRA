---
id: ui/components/splitter
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/the-window-remembers-its-arrangement]
serves: []
surfaces: [ui/surfaces/app-window, ui/surfaces/files-view, ui/surfaces/tasks-view, ui/surfaces/chat-view, ui/surfaces/context-panel]
reuses: []
implemented_by: [packages/app/src/renderer/splitter.tsx, packages/app/src/renderer/uiState.ts, packages/app/src/renderer/App.tsx]
verified_by: [packages/app/test/uiState.test.ts]
mockups: [ui/assets/splitter/idle.html, ui/assets/splitter/absent.html]
siblings: [ui/components/file-panel, ui/components/schema-json-editor]
---

# Splitter

A 2px `--line` stripe standing in a 6px strip between two panes side by side, or between a viewer above and an editor below, that turns `--accent` under the pointer or with keyboard focus.

## A splitter is the divider wherever one pane's size is the person's to set

**Use when.** Two panes share a row or a column and the size of one of them is a remembered preference: the sidebar against the window's body, the context panel against the board or the file, the viewer against the editor, the field reference against a JSON editor.

**Do not use when.** The panes have a fixed relationship, or the choice is whether a pane shows at all: a fold is a toggle, and the divider is not how a pane is hidden. A rule that only separates two areas is a border on one of them.

## The line is all the person sees, and the grab zone is wider than the line

- **Line.** 2px in `--line`, centred in the 6px strip and running its full length. Nothing else is drawn: no grip dots, no arrows, no label.
- **Grab zone.** The whole 6px strip. The pointer becomes a column-resize cursor over a vertical divider and a row-resize cursor over a horizontal one.
- **Orientation.** A vertical divider sits between columns and is as tall as the row it divides. A horizontal divider sits between the viewer and the editor in a file's middle column and is as wide as the column.
- **Which pane it sizes.** The side pane, never the main one: the main pane always takes what remains, so dragging one edge never starves the pane on the far side.

## The divider has two looks and is not drawn where there is nothing to resize

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | Cannot occur: a divider holds no content. | |
| loading | Cannot occur: a pane opens at its remembered size, or its default, before the window appears. | |
| partial | Cannot occur: the divider is whole or absent. | |
| error | Cannot occur: a size that cannot be written is kept for the session and not reported. | |
| idle | The `--line` stripe between the panes. The Files view shows both orientations at once: the viewer over the editor, and the inspector beside them. At a limit the stripe stays where the pane stopped. | [idle.html](../assets/splitter/idle.html) |
| absent | No strip at all. The sidebar has no divider while it is collapsed to its strip, and a file's middle column has none while the editor is folded to its bar or fills the whole column. | [absent.html](../assets/splitter/absent.html) |

## Dragging resizes live, arrows step it, and a double click puts it back

| On | Does | Feedback |
| --- | --- | --- |
| Pointer over | Nothing | Stripe turns `--accent`; resize cursor |
| Press with the left button and drag | Sizes the pane from where the drag began, within the pane's limits | The pane follows the pointer every frame; the stripe stays under it |
| Press with any other button | Nothing | None |
| Tab onto it | Takes focus | Stripe turns `--accent`, with no focus ring |
| Left or Right arrow on a vertical divider, Up or Down on a horizontal one | Moves the divider 12px toward that arrow | The pane resizes at once |
| Shift with an arrow | Moves the divider 48px | The pane resizes at once |
| Double-click | Returns the pane to its default size | The pane snaps back |
| Arrows across the axis | Nothing | None |

Every size is recorded a moment after it changes and comes back when the app opens.

## The copy is only the name a screen reader announces

| Where | String |
| --- | --- |
| Sidebar edge | `Resize the sidebar` |
| Files view, inspector edge | `Resize the inspector` |
| Files view, between viewer and editor | `Resize the viewer` |
| Tasks view, panel edge | `Resize the task panel` |
| Chat view, panel edge | `Resize the context panel` |
| JSON editor, field reference edge | `Resize the field reference` |

Each is announced as a separator with its orientation. Its size is not announced.

## Each pane has fixed limits that do not follow the window's width

| Pane | Smallest | Largest | Default |
| --- | --- | --- | --- |
| Sidebar | 180px | 520px | 250px |
| Files inspector | 220px | 680px, or 1200px while a value is pinned | 300px |
| Tasks panel | 260px | 760px, or 1200px while a value is pinned | 360px |
| Chat context panel | 280px | 1200px | 420px |
| Viewer above the editor | 80px | the column's height less 200px | 320px |
| Field reference | 200px | 620px | 300px |

- Resize: only the viewer's limit is measured against its column, at the moment of the gesture. A side pane dragged wide stays wide when the window narrows, and the main pane is crowded instead.
- Theme: the stripe is `--line` and `--accent` in both themes.
- Focus order: each divider is one tab stop, in document order between the panes it divides.
- Long or missing content: none, because the divider carries no text.
