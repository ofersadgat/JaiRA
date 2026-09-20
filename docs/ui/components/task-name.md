---
id: ui/components/task-name
type: ui-component
status: shipped
updated: 2026-09-13
realizes: []
serves: [product/keep-track-of-everything, product/hand-work-to-agents]
surfaces: [ui/surfaces/tasks-view, ui/surfaces/files-view, ui/surfaces/debug-view, ui/surfaces/task-context]
reuses: []
implemented_by: [packages/app/src/renderer/taskName.tsx]
verified_by: []
mockups: [ui/assets/task-name/success.html, ui/assets/task-name/loading.html, ui/assets/task-name/error.html]
siblings: [ui/components/task-card, ui/components/task-panel, ui/components/address-bar]
---

# Task name

A task's name set inline in whatever face its host uses: plain text once settled, italic in `--dim` while the name is still being worked out, and underlined with a `--dim` dotted line when it is a stand-in for a name that could not be worked out.

## Every host that draws a task's name as an element draws it through this

**Use when.** A task is named on a board card, in the head of a task panel, or in the Files view's `TASKS HERE` and `RECENTLY` lists. A process can declare a state that computes the task's name; where one does, that name replaces the title the person gave, and this is what keeps every host agreeing on which name shows and whether it is final.

**Do not use when.** Only a plain string fits: a menu entry shows the same name with no italic and no underline, and the address bar's run segment draws the italic itself, as in [address-bar](address-bar.md). The card around the name is [task-card](task-card.md); the panel head is [task-panel](task-panel.md).

## The name carries no face of its own and changes only its style

- **Face, size and weight.** The host's: mono at the `.data-text` size on a card, rising to 600 when the card is selected; the app face at the panel head's large size in bold; the app face at row size in the Files lists.
- **Settled.** The name in the host's colour. The person's own title shows where no state computes a name.
- **Settling.** The declaring state's label stands in, italic in `--dim`.
- **Stand-in.** The fallback text, or the state's label, in the host's colour with a dotted `--dim` underline 3px below the baseline.
- **Tooltip.** Only where there is something to add: why the name looks as it does, or the person's own title when a computed name has replaced it.

## Three looks cover every name

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | Cannot occur: a task always has a title to show. | |
| loading | While a computed name settles, the declaring state's label italic in `--dim`, with a tooltip saying so. It turns into the settled name in place. | [loading.html](../assets/task-name/loading.html) |
| partial | Cannot occur: the name is shown whole or as its stand-in. | |
| error | The name could not be computed: the process's fallback text, or the declaring state's label where it gives no fallback, with a dotted `--dim` underline and a tooltip naming the reason. | [error.html](../assets/task-name/error.html) |
| success | The settled name, computed or the person's own, in the host's style with no mark. A computed name that differs from the person's title carries that title as its tooltip. | [success.html](../assets/task-name/success.html) |

## Resting the pointer on a marked name says why it is marked

| On | Does | Feedback |
| --- | --- | --- |
| Pointer rests on the name | Nothing | The tooltip, where the name has one |

## The copy is the name and a sentence about it

| Where | String |
| --- | --- |
| Name | `{computed name}` · `{task title}` · `{fallback}` · `{state label}` while settling or where no fallback exists |
| Tooltip, settling | `{task title} · the title is still being worked out` |
| Tooltip, stand-in with a fallback | `{task title} · the title could not be computed, so this is its fallback: {reason}` |
| Tooltip, stand-in without one | `{task title} · the title could not be computed: {reason}` |
| Tooltip, computed and different | `{task title}` |

## The host decides width and wrapping, and the marks survive both themes

- On a card and in the Files lists the name stays on one line and ellipsises; in the panel head it wraps. A cut name is not repeated in full in any tooltip.
- Theme: the italic, `--dim` and the dotted underline are drawn the same way in both themes.
- Focus: the name is not a control and takes no focus; its tooltip is reached by pointer only.

## The name takes the app face in some hosts, and settling is dimmed with `--dim`

- It has no face of its own, so a task's name, which is data, reads in the app face in the panel head and the Files lists.
- A settling name is italic in `--dim`, where `.app-absent` would use `--tok-hint`.
