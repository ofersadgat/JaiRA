---
id: ui/surfaces/settings-conversation
type: ui-surface
status: shipped
updated: 2026-09-13
kind: screen
realizes: []
serves: [product/read-comfortably, product/large-work-splits-into-independent-pieces]
components: [ui/components/settings-field]
mockups: [ui/assets/settings-conversation/success.html, ui/assets/settings-conversation/disabled.html]
siblings: [ui/surfaces/settings-view, ui/surfaces/settings-appearance, ui/surfaces/run-conversation]
---

# Settings conversation

The Conversation section of the Settings room: one level heading and one setting that decides how a run's transcript lays out the elements of a fan-out that ran one after another. It fills the settings column with no layer header above it, is reachable with no project open, and replaces whichever section was showing.

## One heading says whose preference this is, and one row holds the choice

- **Level.** `CONVERSATION` as an uppercase level heading in `--dim`, with its hint under it, from [settings-field](../components/settings-field.md).
- **Row.** `Sequential batch elements` with its long hint on the left and a select on the right-hand rail. The row carries no config key and no `SET HERE` tag, because the value belongs to the person and has no layers.
- **Width.** The level runs the full width of the settings column; unlike Configuration it has no 780px cap, so on a wide window the select sits far from its statement.

## The row shows the chosen layout, or is inert while a write is in flight

| State | Surface shows | Mockup |
| --- | --- | --- |
| success | The select reads `One after another` or `Tabbed band`. The two differ only in that word and are drawn stacked. | [success.html](../assets/settings-conversation/success.html) |
| disabled | While any write in the window is in flight: the select at reduced strength and inert. | [disabled.html](../assets/settings-conversation/disabled.html) |
| empty | Cannot occur: the setting always holds one of its two values. | |
| loading | Cannot occur: the preference arrives with the window. | |
| error | Not a look of its own: the choice applies at once, and a write that fails is reported by the [error-notice](error-notice.md) while the choice stays on screen. | |

## Choosing a layout redraws every open transcript

| On | Does | Feedback |
| --- | --- | --- |
| `One after another` | Draws a sequential fan-out's elements down the page in the order they ran | The select shows it; a [run-conversation](run-conversation.md) redraws its sequential batches as stacked sheets |
| `Tabbed band` | Draws them across, two columns or tabs from three up, the way concurrent elements are drawn | The select shows it; the batches redraw as a band |

## The copy explains both layouts in the hint

| Where | String |
| --- | --- |
| Level | `Conversation` · `How a run's transcript is drawn. Yours alone — a reading preference, not a fact about any project.` |
| Row | `Sequential batch elements` · `A fan-out whose elements ran one after another. One after another draws them down the page in the order they ran, as any sequence of states is drawn; a band draws them across — two columns, or tabs from three up — the way elements that ran at the same time already are.` |
| Options | `One after another` · `Tabbed band` |

## A person arrives from the Settings panel and leaves with the choice applied

- The sidebar's Settings panel lists `Conversation` whether or not a project is open.
- Choosing another section, `‹`, or another room leaves. The choice is already written and follows the person into every project.

## The row stacks in a narrow column and keeps its tokens in both themes

- Resize: the row stacks its select under the hint when the column is 380px wide or less. The hint wraps.
- Theme: the heading, hint and select are tokens in both themes.
- Focus: nothing takes focus on entry; the select is the only stop.
