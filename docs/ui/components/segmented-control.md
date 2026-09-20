---
id: ui/components/segmented-control
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/one-document-several-readings]
serves: [product/complete-record-of-every-run, product/watch-agents-work-live, product/keep-track-of-everything]
surfaces: [ui/surfaces/files-view, ui/surfaces/tasks-view, ui/surfaces/run-view]
reuses: []
implemented_by: [packages/app/src/renderer/runViews.tsx]
verified_by: []
mockups: [ui/assets/segmented-control/chosen.html]
siblings: [ui/components/address-bar, ui/components/value-view, ui/components/workflow-editor]
---

# Segmented control

A small outlined pair of words, `Tasks` and `Conversation`, at the right end of the address bar, with the chosen word on a `--panel-2` ground in `--text` and the other in `--dim`.

## The control switches a run between its board and its conversation

**Use when.** The middle column shows a run or a state with children, which has two readings: its passes as a board of cards, and what it said as a conversation. The control sits in the tools of the [address-bar](address-bar.md).

**Do not use when.** The run or state has no children, so its conversation is its only reading: no control is drawn. A produced value's readings switch in the value's own header, drawn by [value-view](value-view.md). A process file's form, source and picture switch in [workflow-editor](workflow-editor.md). The task panel's `Conversation` and `Details` are single ghost buttons in its head.

## Two words in one outline, and the chosen one carries the ground

- **Outline.** One 1px `--line` border with 6px corners around both words; no divider between them.
- **Words.** App face at the small size, 4px by 11px inset, no border of their own.
- **Chosen.** `--panel-2` ground and `--text`. **Other.** No ground and `--dim`.

## Only which word is chosen changes

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | Cannot occur: both words are always drawn, and where a run has one reading the control is not drawn at all. | |
| loading | Cannot occur: the switch is immediate, and the column under it shows its own loading. | |
| partial | Cannot occur: the control has exactly two fixed words. | |
| error | Cannot occur: choosing a reading cannot fail. | |
| chosen | `Tasks` or `Conversation` on `--panel-2`, the other word dim. Both variants are drawn. | [chosen.html](../assets/segmented-control/chosen.html) |

## A click moves the ground and swaps the column

| On | Does | Feedback |
| --- | --- | --- |
| Pointer over the other word | Nothing | Its ground turns `--panel-3` |
| Click a word | Shows the run's board for `Tasks` or its conversation for `Conversation` | The ground moves to that word and the middle column redraws |

The choice is one for the whole window. It holds across the Files and Tasks views and across runs while the app is open, and it starts on `Tasks` at launch.

## The copy names the two readings

| Where | String |
| --- | --- |
| First word | `Tasks` |
| Second word | `Conversation` |

## The control keeps its width and is reached by Tab

- It never shrinks or wraps; the address bar's segments give up width first.
- Theme: ground, outline and text are tokens.
- Focus: each word is a native button in the tab order with the app's focus outline. It has no arrow-key movement and no shortcut, and neither word announces that it is the chosen one.
