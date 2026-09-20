---
id: ui/components/session-sheet
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/fold-to-a-summary-expand-in-place, ux/patterns/the-window-remembers-its-arrangement, ux/patterns/choose-a-side-where-it-divided, ux/patterns/jump-to-the-place-and-mark-it, ux/patterns/context-beside-what-you-stand-on]
serves: [product/complete-record-of-every-run, product/watch-agents-work-live, product/pick-up-where-it-left-off, product/try-another-direction]
surfaces: [ui/surfaces/run-conversation, ui/surfaces/run-view, ui/surfaces/task-context]
reuses: [ui/components/letterhead, ui/components/fork-mark, ui/components/transcript, ui/components/computed-state-body, ui/components/gate-surface]
implemented_by: [packages/app/src/renderer/sessionPanels.tsx, packages/app/src/renderer/sessionBands.ts]
verified_by: [packages/app/test/sessionPanels.test.ts, packages/app/test/sessionBands.test.ts]
mockups: [ui/assets/session-sheet/solo.html, ui/assets/session-sheet/several-states.html, ui/assets/session-sheet/folded.html, ui/assets/session-sheet/surface.html, ui/assets/session-sheet/interrupted.html, ui/assets/session-sheet/fork-side.html]
siblings: [ui/components/concurrent-band, ui/components/letterhead, ui/components/waiting-on-sheet, ui/components/run-step-note]
---

# Session sheet

One conversation printed on a white rounded sheet on the grey run page, under a small grey line naming its session, the state that opened it as a mono link, and its time span, with torn zig-zag edges reading `paused session {id}` and `resumed session {id}` where other work cut into it.

## A sheet holds one session, or one state that had no session

**Use when.** A run's conversation reading draws a session: every state that spoke in that session goes on its sheet, in order. A state that computed its outputs or asked a question in no conversation also gets a sheet of its own, headed by its [letterhead](letterhead.md).

**Do not use when.** Several sessions ran at the same time: [concurrent-band](concurrent-band.md) lays their sheets across. A state was entered, blocked, or made other tasks: that is a [run-step-note](run-step-note.md) on the grey. The run waits for a move to its next stage: [waiting-on-sheet](waiting-on-sheet.md) draws the dashed empty sheet for it.

## The gutter line names the conversation, and the sheet under it holds what was said

- **Gutter line.** On the grey above the sheet, 8px between parts, 4px at the sides and below. Its words are at 0.88 of the app base in `--dim`.
  - On a sheet with one conversation state, a chevron leads and the whole line is the fold control, brightening to `--text` on hover.
  - The session id, ellipsised, or `no conversation` in italic.
  - The state id that opened the session, in the data face, turning `--accent` on hover. It is a link.
  - An untorn [fork-mark](fork-mark.md) chip when this session is one attempt of a retried state.
  - The span, pushed to the far right in tabular figures.
  - On a sheet with several states, a fold-all icon that grows its word on hover or focus.
- **Sheet.** `--panel`, a 1px `--line` border, 12px corners and a soft shadow; 13px of padding at the top and 15px elsewhere.
  - One conversation state: the conversation sits straight on the sheet with no letterhead, because the gutter already names and times it.
  - Several states: a letterhead over each state's body, which is the [transcript](transcript.md) of [message](message.md)s and [work-row](work-row.md)s, a [computed-state-body](computed-state-body.md), a [gate-surface](gate-surface.md), or `Loading…`.
- **Torn edge.** A strip of zig-zag teeth, stroked in `--accent` mixed into `--line`, either side of a lowercase label, on a 5% `--accent` wash with a `--rule` hairline between it and the body. The torn side's corners square to 2px.

## Every state keeps the same sheet, and only its heading and edges change

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | Cannot occur: a sheet is drawn only for a session or a state that has started. | |
| loading | The gutter, the sheet and every letterhead draw at once; a state's body reads `Loading…` in `--dim` until its conversation has been read. | [several-states.html](../assets/session-sheet/several-states.html) |
| partial | A session still going: the span is the start clock alone and the running state's body grows at its foot. A call that has not written its session yet reads `no conversation` in the gutter. | [solo.html](../assets/session-sheet/solo.html) |
| success | One conversation state, settled: chevron, session id, link and `{clock} · {duration}` over the conversation on a plain sheet. | [solo.html](../assets/session-sheet/solo.html) |
| error | The sheet never takes a failure colour. Alone on its sheet, a failed state keeps the plain gutter and its body is the red reason; beside other states, its letterhead becomes a red title block. | [solo.html](../assets/session-sheet/solo.html) |
| several states | A letterhead per state over its body, and the fold-all icon ending the gutter. | [several-states.html](../assets/session-sheet/several-states.html) |
| folded | A folded one-state sheet is its gutter line alone, the chevron turned back. A sheet with every state folded keeps its letterheads, each showing its summary, and the icon turns to expand. | [folded.html](../assets/session-sheet/folded.html) |
| surface | A computed or asked state with no session: the gutter holds only the link, and the sheet opens with the state's letterhead. | [surface.html](../assets/session-sheet/surface.html) |
| interrupted | One session cut by other work: the earlier sheet ends in `paused session {id}` with square bottom corners, the other work draws between, and the later sheet starts with `resumed session {id}` and square top corners. | [interrupted.html](../assets/session-sheet/interrupted.html) |
| fork side | A retried state: each attempt's gutter carries a fork chip counting it among the attempts. The sheet a fork chip jumps to lights its border `--accent` with a 3px ring for 1.2 seconds. | [fork-side.html](../assets/session-sheet/fork-side.html) |

## The gutter folds, links and jumps, and the fold is remembered

| On | Does | Feedback |
| --- | --- | --- |
| Click, Enter or Space on a one-state gutter | Folds the sheet away or brings it back; kept for the task across restarts | The chevron turns a quarter and the sheet goes or returns |
| Fold-all icon | Folds or opens every state on the sheet; kept the same way | Every letterhead's chevron turns and the icon swaps between fold and unfold |
| Pointer or focus on the fold-all icon | Nothing | A `--panel-2` box with a hairline, and its word slides out beside the icon |
| Link | Describes that state, with the values the run gave it, in the context panel | The context panel changes |
| Fork chip | Opens the menu of attempts; picking one scrolls its sheet into view | The picked sheet flashes `--accent` |
| A bookmark from the run's index | Scrolls to where the state was entered | A one-state sheet's body takes a 3px `--accent` ring for 1.2 seconds; nothing else is lit |

## The copy is the session, the state and the time

| Where | String |
| --- | --- |
| Session | `{session id}`, or `no conversation` |
| Link | `{state id}`, tooltip `{state id} — describe this run of it` |
| Span | `{clock}` while the session is open; `{clock} · {duration}` once it has ended, such as `10:02:11 · 6 m 18 s`, `2.4 s` or `840 ms` |
| Fold all | `collapse all` or `expand all`; accessible names `Collapse all` and `Expand all` |
| Torn edges | `paused session {session id}` · `resumed session {session id}` |
| Fork chip | `fork:` `{i} of {n} — {failed, stopped, running or finished}`, tooltip `the position was already taken, so every attempt after the first branched` |

## The sheet takes the rail's width and gives up its names before its times

- Resize: the sheet spans the column the rail leaves it, from the 360px context panel to a 1052px measure. In the gutter the session id and the link ellipsise; the chevron, the chip's glyph, the span and the fold-all icon never shrink.
- Theme: the sheet's shadow deepens in dark, and the teeth and washes mix from `--accent`, so both themes keep them.
- Focus: a one-state gutter is itself in the tab order, then its link, fork chip and fold-all icon. Arriving from a jump does not move focus.
- Long or missing content: the clock is the reader's locale time. A session with no start shows no span. Without a host that can describe a state the link is absent. A tabbed band draws the sheet with no gutter, because its tab carries the name.

## The gutter departs from the type registers in three places

- The session id is data and renders in the app face.
- The torn-edge label is lowercased, and the session id inside it with it.
- The fold-all icon stands without its word until pointed at or focused.
