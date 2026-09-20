---
id: ui/surfaces/logs-view
type: ui-surface
status: shipped
updated: 2026-09-13
kind: screen
realizes: [ux/patterns/filter-in-place, ux/patterns/fold-to-a-summary-expand-in-place, ux/patterns/ordered-by-urgency-then-recency, ux/patterns/jump-to-the-place-and-mark-it, ux/patterns/absence-is-stated]
serves: [product/find-out-why-the-app-misbehaves]
components: []
mockups: [ui/assets/logs-view/empty.html, ui/assets/logs-view/listing.html, ui/assets/logs-view/dated.html, ui/assets/logs-view/configuring.html, ui/assets/logs-view/output.html]
siblings: [ui/surfaces/app-window, ui/surfaces/sidebar, ui/surfaces/debug-view, ui/surfaces/components-view, ui/surfaces/settings-view, ui/surfaces/tasks-view]
---

# Logs view

The Logs room: everything the app recorded across launches, as one full-width table with the newest entry at the top under a bar of filters, where a band for what is kept and a pane for a process's output open inside the same column. It fills the window right of the [sidebar](sidebar.md), whose settings sheet stays over the sidebar column while it shows, and takes the place of every other room. It has no context panel, and the title bar above it holds only the empty filler.

## The filter bar reads first, then the column names, then one line per entry

- **Bar.** A 1px `--line` rule below, 6px by 10px padding and 8px gaps: the `Minimum level` select reading `{level} and worse`, the `Source` select reading `all sources`, a 220px text box reading `Filter…`, then at the far right the bordered `Configure` button and `{n} shown` in `.app-secondary`, `{n}+ shown` while older entries remain.
- **Column names.** `time`, `level`, `source` and `message` in the app face at 10/12.5 of the app base, uppercase, `--dim`, over a `--line` rule. The last column, which holds the links, has no name. The widths are counted in characters of each line's own face, so a name sits a little left of the column it heads.
- **Rows.** One line each in the data face at 11.5/12 of the data base, on the page's `--bg`. Nothing wraps; every cell ends in an ellipsis rather than widening its column. The time takes 11 characters, right-aligned tabular `--dim`; the level 5, an uppercase word at 10/12.5 of the app base in `--text`, or `--warn` for warn and `--bad` for error; the `source` column 22 in `--dim`; the message the rest; the links 92px at the right. `task` and `output` are `--accent` words present only when the entry names a task or a process.
- **Foot.** One line in `--dim` flush with the column's left edge: `Scroll for older entries.` while older entries remain, `Reading…` while a page is on its way, nothing once the start of the log is reached.

## Opening a row grows it in place, and the band and the output open inside the column

- **Open row.** Pointing at a row gives it a `--panel-2` ground. Opening it keeps that ground, wraps the whole message and aligns every cell to its top. An entry that carries a stack or fields gets a block under the message: the stack, then the fields as indented JSON, each in a box on `--panel-2` with a 1px `--line` edge and 4px corners, `--dim` data text at 11/12 that keeps its own line breaks and scrolls sideways. An entry with neither shows only the grown row.
- **Date column.** Once any entry on screen is from an earlier day, a 10-character `date` column appears before `time` in the names and on every row. Today's rows leave it blank.
- **Keep band.** `Configure` opens a band under the bar on `--panel-2` with a `--line` rule below and 8px by 10px padding. First `Keep` with a select reading `{level} and worse` and a `--dim` sentence. Then a table with uppercase `--dim` headings `match`, `key`, `keep` and `sample` over a `--line` rule, one row per rule: the kind in `--dim`, the key in the data face, a level select, a 62px number box from 0 to 1 in steps of 0.1, and `remove` in `--accent`. With no rules the table holds one `--dim` line. Last an add row: a kind select, a `Source` select for a scope or a text box for a tag at least 240px wide, a level select and `Add rule`, which stays at half opacity until a key is chosen or typed. `Configure` shows no pressed look while the band is open.
- **Process output.** `output` docks a pane under the list, at most 45% of the column's height, with a `--line` rule above. Its head line reads `Process output` at 12/12.5 of the app base with a bordered `Close` at the right. Each stream follows under its name in uppercase `--dim` at 10/12.5, its text wrapped in a monospaced face at 11/12.5; `stderr` text is `--bad`. A chunk whose middle was dropped is preceded by `… {n} bytes not kept …` in italic `--dim`.

| Where | String |
| --- | --- |
| Level select | `debug and worse` · `info and worse` · `warn and worse` · `error and worse` |
| `Source` select | `all sources`, then each part of the app that writes entries; a dotted family is a group headed `{family}` holding `{family} (all)` and its members |
| Count | `{n} shown` · `{n}+ shown` |
| Row links | `task` · `output` |
| Foot | `Nothing to show.` · `Reading…` · `Scroll for older entries.` |
| Keep band | `Keep` · `{level} and worse` · `everywhere, unless a rule below says otherwise. An error is kept whatever this says.` |
| Rules table | `match` · `key` · `keep` · `sample` · `remove` · `No rules — the level above applies everywhere.` |
| Add row | `scope` · `tag` · `tag (e.g. llm)` · `debug` · `info` · `warn` · `error` · `Add rule` |
| Output pane | `Process output` · `Close` · `This process printed nothing.` · `… {n} bytes not kept …` |

## The table shows the entries asked for, and says when there are none or more are coming

| State | Surface shows | Mockup |
| --- | --- | --- |
| empty | The bar and the column names over `Nothing to show.` in `--dim`. A log with no entries, filters that match nothing and a read that failed look the same. | [empty.html](../assets/logs-view/empty.html) |
| loading | The first page on its way: the bar and the column names over `Reading…`. It is drawn under the empty list. | [empty.html](../assets/logs-view/empty.html) |
| listing | Entries newest first, one of them opened to its stack and fields, with `Scroll for older entries.` after the last row. | [listing.html](../assets/logs-view/listing.html) |
| partial | Scrolled within 400px of the end with older entries left: the rows stay, `Reading…` stands at the foot, and the next page joins the bottom. The date column appears once an entry from an earlier day is on screen. A page that fails to arrive leaves the rows as they were, and the next scroll asks again. | [dated.html](../assets/logs-view/dated.html) |
| error | Cannot occur as its own look: a failed first read shows `Nothing to show.`, a failed older page leaves the list alone, and a process output that cannot be read is reported by the [error notice](error-notice.md). | |
| configuring | The keep band open between the bar and the column names, with two rules and the add row waiting for a key. | [configuring.html](../assets/logs-view/configuring.html) |
| output | A process's output docked under the list, one stream with a dropped middle and one `stderr` stream. A process that printed nothing shows `This process printed nothing.` under the head line. | [output.html](../assets/logs-view/output.html) |

## A person arrives from the settings sheet and leaves toward the task an entry names

- `≡ Logs` at the foot of the sidebar's settings sheet opens the room with the lowest level and `all sources`, and reads the newest page. Logs is lit in the sheet.
- A change of either select, or a pause of 0.18 seconds in typing, replaces the list with the newest entries that match.
- `task` switches to the [tasks view](tasks-view.md) with that task selected and described in its context panel. Choosing it does not open the row.
- `output` keeps the room and docks that process's output. `Close` removes the pane.
- A keep level, a rule's level or sampling, `remove` and `Add rule` take effect for the next entry the app writes, and change nothing already in the table.
- A section, `Debug` or `Components` in the settings sheet leaves for that room, and `‹` leaves for the room shown before Settings.

## The columns hold their widths, and filters last only while the room is open

- **Resize.** The fixed columns keep their widths and the message column takes what remains, down to nothing. The bar does not wrap; the keep band's head line and add row do. The output pane stays within 45% of the height and each stream scrolls inside it.
- **Theme.** Grounds, rules, links and level colours are tokens with a light and a dark value.
- **Focus.** Entering moves focus nowhere. Tab reaches the two selects, the text box, `Configure`, then each row and its links in turn. Enter or Space opens or folds the focused row. The text box clears only by deleting its text.
- **Long or missing content.** A long `source` cell ends in an ellipsis and shows in full as its tooltip. A long message ends in an ellipsis until its row is opened.
- **Unsaved work.** None. Leaving the room resets the filters, folds every row and closes the keep band; a docked output is still docked on return.

## The table departs from the visual direction in four places

- The level word and the `task` and `output` links are app words set in the data face.
- Stream names come from the process and are uppercased.
- The output pane's text is set in the browser's monospace face, not the data face.
- The column names and the rules table's headings take the label's size and case at their own weight and a 0.4px tracking, not `.app-label`.
