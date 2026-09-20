---
id: ui/components/fork-mark
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/choose-a-side-where-it-divided, ux/patterns/jump-to-the-place-and-mark-it]
serves: [product/try-another-direction, product/rewind-to-where-it-went-wrong, product/complete-record-of-every-run, product/chat-with-agents]
surfaces: [ui/surfaces/chat-view, ui/surfaces/run-conversation, ui/surfaces/task-context]
reuses: [ui/components/context-menu, ui/components/icon]
implemented_by: [packages/app/src/renderer/sessionPanels.tsx, packages/app/src/renderer/chatPane.tsx]
verified_by: [packages/app/test/forkMark.test.ts, packages/app/test/sessionPanels.test.ts]
mockups: [ui/assets/fork-mark/success.html, ui/assets/fork-mark/open.html, ui/assets/fork-mark/origin.html]
siblings: [ui/components/session-sheet, ui/components/run-step-note, ui/components/letterhead]
---

# Fork mark

A zig-zag torn line across the page with a quiet lowercase chip in its middle, a fork glyph, a bold `fork:`, `2 of 2 — {side}` and a chevron, that opens a menu of the other sides; the origin variant reads `forked from: {task}, {point}`.

## The mark says a history divided here and lets the person pick a side

**Use when.** A chat message was replaced and the conversation now has two sides. A state was retried, so its attempts are separate sessions: the chip sits untorn in each attempt's gutter on its [session-sheet](session-sheet.md). A task or conversation was forked or split from another: the origin variant sits where the copied part ends and the task's own part begins.

**Do not use when.** Fewer than two sides are on the page: nothing is drawn. The person is about to cut the history: the rewind and fork glyphs on a [run-step-note](run-step-note.md) arm that. Work started by other work: that nests under what caused it and is no fork.

## The glyph and the count read first, and the side's name after

- **Teeth.** An 8px-tall zig-zag, stroked in `--accent` mixed into `--line`, filling the width on both sides of the chip. The torn placement keeps 14px above and 12px below. The gutter placement has no teeth and no margins.
- **Chip.** App text at 0.84 of the base, lowercase with slight tracking, 2px by 9px, 7px corners, 6px between parts. At rest it has no box: its words sit in `--dim` on the page.
- **Order inside.** The 11px fork glyph and `fork:` at 600, both in `--accent` mixed 70% into `--dim`; then `{i} of {n} — {side}`, which ellipsises; then a chevron.
- **Width.** In a chat the mark keeps the transcript's measure, at most 900px and centred. On a run page it takes the row's width.

## The mark has a resting look, an open look and an origin look

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | Cannot occur as a look: a history with fewer than two sides on the page draws no mark. | |
| loading | Cannot occur: the sides arrive with the record they belong to. | |
| partial | Cannot occur as a look of its own: an attempt still going is named `running` and counts like any other side. | |
| success | At rest, the chip is words on the page between the teeth, or words in a gutter beside the session id. The count names the side being read, not the newest. | [success.html](../assets/fork-mark/success.html) |
| open | Pointer over, focus, or menu open: the chip takes a `--panel-2` box with an `--accent`-tinted border and `--text` words. A 232px menu hangs centred under it, headed by the note in the small uppercase data face, then every side oldest first, the side shown bold with an `--accent` dot, each with its note at the right in `--dim`. | [open.html](../assets/fork-mark/open.html) |
| origin | A copy's seam: the same teeth and chip reading `forked from:` and `{title}, {point}` with a chevron. It opens the task it came from rather than a menu. | [origin.html](../assets/fork-mark/origin.html) |
| error | The task a copy came from was deleted: the chip reads `a task since deleted` for the title and still carries its chevron; following it empties the panel. | [origin.html](../assets/fork-mark/origin.html) |

## Picking a side shows it in a chat and goes to it on a run page

| On | Does | Feedback |
| --- | --- | --- |
| Click or Enter on the chip | Opens the menu of sides | The chip keeps its box while the menu is open |
| Pick a side in a chat | Shows that side's messages below the mark; the side that was replaced is read-only and takes no live output | The count and the name on the chip change |
| Pick an attempt on a run page | Scrolls that attempt's sheet into view | Its border turns `--accent` with a 3px ring for 1.2 seconds |
| Escape, a click elsewhere, a scroll or a resize | Closes the menu | The chip returns to rest |
| Origin chip | Selects the task or conversation it was copied from | That task opens |

## The copy counts before it names

| Where | String |
| --- | --- |
| Chip | `fork:` then `{i} of {n} — {side}` |
| Chip tooltip | the note, else `the other sides of this fork` |
| Chat note, menu heading | `a message was replaced here` |
| Chat sides | the first line of the side's opening message, cut at 40 characters with `…`; else `what was replaced` or `this conversation` |
| Run note, menu heading | `the position was already taken, so every attempt after the first branched` |
| Run sides | `failed` · `stopped` · `running` · `finished`, each noted with `{session id}` |
| Origin | `forked from:` then `{title}, {point}`, where `{point}` is `before {state key}`, `before message {n}`, `at a transition` or `element {i} of {mount key}`, with ` ({item})` when the element has a name |
| Origin tooltip | `go to {title}, where this was forked from` |
| Deleted origin | `a task since deleted` |

## The chip gives up its name before the teeth give up their width

- Resize: the teeth and the chip share the row. The side's name ellipsises while each run of teeth keeps at least 12px; the glyph, `fork:` and the chevron never shrink. The menu clamps inside the window.
- Theme: teeth and tints mix from `--accent`, so both themes keep them.
- Focus: the chip is a button in the tab order and announces that it opens a menu. The menu does not take focus and has no arrow-key movement; its items come last in the tab order.
- Long or missing content: a long message first line is cut to 40 characters before it reaches the chip, and the chip ellipsises the rest.

## The chip departs from the type registers by lowercasing data

- The whole chip is lowercased, so message first lines, task titles and session ids in it lose their case.
- The menu heading uppercases the note.
