---
id: ui/components/letterhead
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/fold-to-a-summary-expand-in-place, ux/patterns/park-and-ask, ux/patterns/the-window-remembers-its-arrangement]
serves: [product/complete-record-of-every-run, product/watch-agents-work-live, product/decisions-stay-yours, product/failures-explain-themselves, product/know-what-work-costs]
surfaces: [ui/surfaces/run-conversation, ui/surfaces/task-context]
reuses: [ui/components/icon]
implemented_by: [packages/app/src/renderer/stateSurface.tsx, packages/app/src/renderer/sessionPanels.tsx, packages/app/src/renderer/runViews.tsx]
verified_by: [packages/app/test/stateSurface.test.ts]
mockups: [ui/assets/letterhead/loading.html, ui/assets/letterhead/success.html, ui/assets/letterhead/computed.html, ui/assets/letterhead/asked.html, ui/assets/letterhead/asking.html, ui/assets/letterhead/error.html, ui/assets/letterhead/folded.html, ui/assets/letterhead/waiting-on-you.html]
siblings: [ui/components/session-sheet, ui/components/waiting-on-sheet, ui/components/computed-state-body, ui/components/instance-index]
---

# Letterhead

A one-line heading at the top of each state on a session sheet: a chevron, a dot or a kind glyph with an uppercase kind word, the state's key in bold mono, its label, and a clock at the far right over a hairline, which fills out to the sheet's edges in blue, amber or red while the state runs, asks or has failed.

## A letterhead heads every state that shares a sheet and every state that is not a conversation

**Use when.** A session sheet holds several states: each one gets a letterhead. A state with no conversation, one that computed its outputs or put a question to a person, gets one even alone on its sheet, because nothing above it names it. [waiting-on-sheet](waiting-on-sheet.md) draws the same line for a run parked on a move.

**Do not use when.** A sheet holds a single conversation state: the line above the [session-sheet](session-sheet.md) already names, times and folds it. A composite state gets none, because it only orchestrates. To list a run's states for jumping between them, use [instance-index](instance-index.md).

## The kind and the key read first, the label second and the time last

- **Marker.** A chevron in `--dim`, pointing down while folded and turned a quarter to point left while open. Then a 6px dot for a conversation, or a 1em line glyph for any other kind: sigma for computed, a speech bubble for asked, a clock for waiting. Never both.
- **Kind word.** `COMPUTED`, `ASKED OF YOU` or `WAITING ON YOU` in the data face at 600, uppercase with wide tracking, in the line's colour. A conversation has none.
- **Key.** The child key, or the last segment of the state id, in bold mono in `--text`.
- **Label or summary.** Open, the state's label in the app face. Folded, what the fold hides, in the app face in `--dim`. Only one of the two is drawn.
- **Meta.** At the far right in tabular figures: the start clock, and the duration once the state has ended.
- **Rule and spacing.** A 1px `--line` hairline under the line and 11px to the body. Each letterhead after the first has 20px above it, 12px after a folded one, 16px above a title block.
- **Title block.** The same line filled out to the sheet's edges, its hairline, glyphs, key and words all taking the tone's colour.

## The tone is derived from the state and never chosen

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | Cannot occur: a letterhead always names a state, and where there is nothing to head no letterhead is drawn. | |
| loading | A model still writing, or an asked state still open where the view holds no question for it: `--accent` title block with an `--accent` hairline and text. Meta is the start clock alone. | [loading.html](../assets/letterhead/loading.html) |
| partial | Cannot occur: the line draws whole, and what a fold hides is the folded state below. | |
| success | A settled conversation: chevron, dot, key, label and meta in `--dim` over the hairline, key in `--text`. The dot is `--dim` for every outcome. A canceled or interrupted state rests the same way and is never alarmed. | [success.html](../assets/letterhead/success.html) |
| computed | Sigma glyph and `COMPUTED` on a resting line. | [computed.html](../assets/letterhead/computed.html) |
| asked | Speech-bubble glyph and `ASKED OF YOU` on a resting line, once the question is answered or its run has stopped. | [asked.html](../assets/letterhead/asked.html) |
| asking | A question is on offer for this state: `--warn` tinted title block with a dashed `--warn` hairline and `--warn` text, and the question in the body under it. It stays amber after the app is closed and reopened while the question survives. | [asking.html](../assets/letterhead/asking.html) |
| error | The state or its call failed: `--bad` tinted title block with a `--bad` hairline and text. It stays red when folded. | [error.html](../assets/letterhead/error.html) |
| folded | Body hidden, the summary in place of the label, no gap under the hairline. A red title block keeps its fill and its spacing. | [folded.html](../assets/letterhead/folded.html) |
| waiting on you | Drawn by waiting-on-sheet: clock glyph, `WAITING ON YOU`, the target state and a live duration on an amber title block with no chevron. It does not fold. | [waiting-on-you.html](../assets/letterhead/waiting-on-you.html) |

## Clicking the line folds the state in place

| On | Does | Feedback |
| --- | --- | --- |
| Click, Enter or Space | Folds the state or opens it; the fold is kept for that task and survives a restart | The chevron turns over 120ms, the body goes, and the summary takes the label's place |
| Pointer over a resting line | Nothing | Text goes from `--dim` to `--text`; a title block keeps its colour |
| The sheet's collapse all or expand all | Folds or opens every letterhead on the sheet | Every chevron turns |

## The copy names the kind, the state and the time

| Where | String |
| --- | --- |
| Kind word | `computed` · `asked of you` · `waiting on you`, drawn uppercase |
| Key | `{child key}` or `{last segment of the state id}` |
| Label, open | `{state label}`, such as `Draft the features` |
| Summary, folded | `{failure reason}` or `failed` for a failed call, else `canceled` for a canceled state; then `${cost}` to two decimals; parts joined by ` · ` |
| Meta | `{start clock}` while running; `{start clock} · {duration}` once ended, such as `10:02:11 · 3 m 12 s` |
| Waiting on you, key | `→ {target state}`, or `{event name}` when the move has no target |
| Waiting on you, meta | `{duration so far}`, counting |

## The line stretches with its sheet and gives up the label first

- It has no width of its own: it spans the sheet, from the 360px context panel to a wide conversation column, and a title block reaches the sheet's edges on both sides.
- The chevron, glyph, kind word, key and meta never shrink. The label or summary ellipsises, and on a narrow sheet it goes first.
- Theme: every tint is mixed from `--accent`, `--warn` or `--bad` into `--panel`, so both themes keep the three tones. Running and failed differ by colour alone; asking also carries a dashed hairline.
- Focus: a foldable letterhead is a native button in the tab order with the app's focus outline. With reduced motion the chevron turns without animating. The waiting-on-you line is not a control and is hidden from screen readers; the button under it is.
- Missing content: without a label the key stands alone before the meta; a folded state that neither failed, was canceled nor cost anything shows no summary.

## The kind words and the meta depart from the type registers

- The kind words are JaiRA's words set in the data face and uppercased, where app words take the sans.
- The meta is quietened with 85% opacity instead of the `--tok-hint` register.
