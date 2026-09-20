---
id: ux/patterns/drill-in-and-back-out
type: ux-pattern
status: shipped
updated: 2026-09-13
serves: [product/complete-record-of-every-run, product/watch-agents-work-live, product/hand-work-to-agents, product/author-processes-without-memorising-the-format, product/keep-track-of-everything]
siblings: [ux/patterns/context-beside-what-you-stand-on, ux/patterns/nested-under-what-caused-it, ux/patterns/choose-a-side-where-it-divided, ux/patterns/jump-to-the-place-and-mark-it]
---

# Drill in and back out

Going into something nested extends an address instead of replacing the view: a process, a step of it, a run of that step, a helper agent's conversation inside the run, or a folder. The address always shows the whole path from the top, and what is shown is its last level. Every earlier level is one step back. Each level also offers the other things that stand beside it, with the current one marked, so a sibling is one step sideways without climbing out. Taking a sibling replaces that level and drops every level below it. When work is run again and a level on the path stops existing, the address is cut at that level.

## Use it when things contain things several levels deep

**Use when.** The person moves through work inside processes, runs inside runs, the conversations of helper agents, or folders, and needs to know where they stand and how they got there.

**Do not use when.** The hierarchy is one level: a plain list is enough. The person only needs facts about a thing without going into it: use [context-beside-what-you-stand-on](context-beside-what-you-stand-on.md). Work started by other work is to be read in place: show it with [nested-under-what-caused-it](nested-under-what-caused-it.md). The place is visited from anywhere and left to return where the person was, as settings are: it is not a level of the address, and leaving it returns to the view it was opened from.

## Going in adds a level, and every level above stays one step away

| # | Person does | System does | Person knows |
| --- | --- | --- | --- |
| 1 | Goes into a nested thing | Adds a level to the address and shows that level | Where they are, and the path that led there |
| 2 | Opens the alternatives at a level | Lists what stands at that level with the current one marked. A level with nothing beside it offers no list | What else is at that level |
| 3 | Takes a sibling | Replaces that level and drops the levels below it | They moved sideways, and the deeper levels are gone |
| 4 | Takes an earlier level | Cuts the address back to it and shows it | They are back at that level |

## Every state leaves the person a level to go back to

| State | Person sees | Can do next |
| --- | --- | --- |
| first_run | With no project open, the place says a project must be opened to show its work or its files | Open a project |
| empty | A level with nothing inside says so, such as a step that holds no steps or an empty folder | Go back, or take a sibling |
| loading | A run being read says it is reading. A project's work that is loading says there is nothing there, which is also what a failed load shows | Wait, or go back |
| partial | A helper agent's conversation that is still arriving shows what has arrived, as in [stream-then-settle](stream-then-settle.md) | Watch, or go back |
| error | A run replaced by running the work again says it is no longer part of the work. Work that never ran the step being viewed says so | Go back |
| denied | A level the work never reached cannot be entered: the gesture does nothing and the address stays as it was | Go into a level the work did reach |
| success | The last level is shown, and every level above is one step away | Go deeper, sideways or back |

## Moving through the address changes nothing, and the path lasts only while the same work is chosen

Any earlier level is one step back, and a sibling taken by mistake is undone by taking the first one again from the same level. Moving through the address only reads, so leaving loses no work.

The path is kept while the person stays on the same piece of work. Choosing other work starts a new path at that work's top. A restart loses the path, and the app opens at the most recently opened project.

## The address works by keyboard, but going in and choosing a sibling need a pointer

**Keyboard only.** Each level and each list of alternatives is a standard button reached by Tab. An opened list of alternatives does not take focus and does not move with arrow keys, so a sibling is chosen by pointer. Going into an item grouped by stage, or a box in a picture of a process, is by double click only. No key and no mouse button goes back.

**Screen reader.** A list of alternatives is announced as a menu. The last level is plain text and is not marked as the current place.

**Small window.** Level names are cut short to fit the width.

**Slow machine.** An answer about work the person has since left is ignored, so a slow read never replaces the place they moved to.
