---
id: ui/components/concurrent-band
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/nested-under-what-caused-it]
serves: [product/watch-agents-work-live, product/complete-record-of-every-run, product/large-work-splits-into-independent-pieces, product/read-comfortably]
surfaces: [ui/surfaces/run-conversation, ui/surfaces/run-view, ui/surfaces/task-context]
reuses: [ui/components/session-sheet, ui/components/icon]
implemented_by: [packages/app/src/renderer/sessionPanels.tsx, packages/app/src/renderer/sessionBands.ts]
verified_by: [packages/app/test/sessionPanels.test.ts, packages/app/test/sessionBands.test.ts]
mockups: [ui/assets/concurrent-band/columns.html, ui/assets/concurrent-band/tabs.html]
siblings: [ui/components/session-sheet, ui/components/run-step-note, ui/components/state-rail]
---

# Concurrent band

Two or more session sheets that ran at the same time, drawn across one row of a run page: side by side in equal columns, or as a row of file-tab buttons with one sheet under them, with a two-icon layout switch that appears in the band's top right corner only while pointed at.

## A band lays conversations across the page when they overlapped in time

**Use when.** Sessions in a run overlapped, such as the elements of a fan-out running at once: they share one band, so the page still reads down in time order. The elements of a fan-out that ran one after another also share a band when the person has set sequential batch elements to `Tabbed band` in Settings.

**Do not use when.** A band holds one session: a plain [session-sheet](session-sheet.md) is drawn with no band chrome and no switch. Work was split into tasks of its own: a [run-step-note](run-step-note.md) links them instead.

## The sheets read first and the switch stays out of the way

- **Measure.** When any band on the page holds more than one session, the whole [state-rail](state-rail.md) column widens from 1052px to at most 1472px, so each column is not half of one reading width.
- **Columns.** An equal-width grid with 12px between columns, each sheet top-aligned and each with its own gutter line naming its session.
- **Tabs.** A row of tabs 2px apart above the sheet, each in the data face at 0.92 of the data base, 4px by 12px, 8px top corners, a 1px `--line` border with no bottom edge. Resting tabs are `--bg` with `--dim` words; the chosen tab is `--panel` with `--text` words, joining the sheet under it. The sheet under the tabs has no gutter line, because the tab names it. The row keeps 60px clear at the right for the switch.
- **Switch.** Two 13px icons, columns and tabs, in a bordered box with 6px corners, pinned just above the band's top right. The chosen icon sits on `--panel-2` in `--text`, the other on `--panel` in `--dim`. At rest it is invisible.

## The band has a columns look and a tabs look

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | Cannot occur: a band with fewer than two sessions is drawn as a plain sheet. | |
| loading | Every sheet in the band draws at once with its gutter or tab, and each body reads `Loading…` until its conversation has been read. | [columns.html](../assets/concurrent-band/columns.html) |
| partial | Cannot occur as a look of its own: a session still going is a column or tab like the others, its span showing only when it began. | |
| error | Cannot occur as a look of its own: a failed session shows its failure inside its own sheet. | |
| columns | The layout for two sessions: two sheets side by side, each with its gutter line. | [columns.html](../assets/concurrent-band/columns.html) |
| tabs | The layout for three or more: a tab per session, the first chosen, and that session's sheet under the row. | [tabs.html](../assets/concurrent-band/tabs.html) |
| success | Cannot occur as a look of its own: settled sessions draw as columns or tabs. | |

## The switch and the tabs change only how the band is drawn

| On | Does | Feedback |
| --- | --- | --- |
| Pointer over the band, or focus inside it | Nothing | The switch fades in over 90ms |
| Columns icon, `Side by side` | Lays the sessions side by side | The icon takes the `--panel-2` ground; the tabs give way to columns |
| Tabs icon, `Tabbed` | Lays the sessions out as tabs | The icon takes the `--panel-2` ground; the first tab is chosen |
| A tab | Shows that session's sheet | The tab turns `--panel` with `--text` words |

The choice is not kept: leaving the task and coming back draws the band in its default layout again.

## The copy names each session

| Where | String |
| --- | --- |
| Switch tooltips | `Side by side` · `Tabbed` |
| Tab | `{session id}`, or for a state with no session `{child key}` or `{state id}` |
| Setting | `Sequential batch elements`: `One after another` · `Tabbed band` |

## The band shares its width and cuts long tab names

- Resize: columns split the row equally whatever the window width and narrow together. Tabs never wrap; each is at most 220px and ellipsises its name.
- Theme: grounds and borders are tokens, so both themes keep the tab edges and the switch box.
- Focus: tabs and the switch are buttons in the tab order, and the switch becomes visible when focus reaches it. Tabs do not move with arrow keys.
- Long or missing content: columns of different lengths keep their tops aligned and the shorter one leaves grey below it.

## The switch departs from the direction by standing without words

- Its two icons carry no label and are named only by tooltip.
