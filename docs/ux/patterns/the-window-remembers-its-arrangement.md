---
id: ux/patterns/the-window-remembers-its-arrangement
type: ux-pattern
status: shipped
updated: 2026-09-13
serves: [product/read-comfortably, product/all-projects-in-one-place, product/see-what-changed-since-you-looked]
siblings: [ux/patterns/fold-to-a-summary-expand-in-place, ux/patterns/context-beside-what-you-stand-on, ux/patterns/draft-belongs-to-the-file]
---

# The window remembers its arrangement

How the person arranged the window is kept for that person on that machine and restored when the app opens: the size behind each divider, which areas are folded, which folders of the file tree are open, which steps of runs are folded, how far each conversation has been read, and which projects were open. It is never stored in a project, so a layout cannot arrive through a change to a repository. Anything the record does not mention opens at its default, so a new control needs nothing from an older record. A divider moves by dragging or by arrow keys, and a double click returns it to its default.

## Use it for arrangement that is personal and stable

**Use when.** A choice about how the window is laid out holds from one day to the next, and reopening the app without it would mean arranging the window again.

**Do not use when.** The state is what the person is in the middle of: the place in the address, the chosen run, a filter, a pinned value. Those last for the session. The state is an unsaved edit: it follows [draft-belongs-to-the-file](draft-belongs-to-the-file.md). The choice changes how content reads rather than how the window is laid out: [preview-beside-the-setting](preview-beside-the-setting.md).

## Arranging applies at once, is recorded a moment later, and comes back on reopening

| # | Person does | System does | Person knows |
| --- | --- | --- | --- |
| 1 | Drags a divider, folds an area, or opens a folder | Applies the change at once and records it a moment later | The window is as they set it |
| 2 | Closes the app | Records any change not written | Nothing, and nothing is needed |
| 3 | Opens the app | Reopens the projects that were open, restores the arrangement before the window appears, and stands at the most recently opened project | The window is as they left it |
| 4 | Double-clicks a divider | Returns it to its default | The divider is back where it began |

## Every state opens on a usable arrangement, remembered or default

| State | Person sees | Can do next |
| --- | --- | --- |
| first_run | Every divider, fold and folder at its default, with no project open | Arrange the window, or open a project |
| empty | Cannot occur: a control with nothing remembered opens at its default | Arrange it |
| loading | Cannot occur as its own state: the arrangement and the open projects are restored before the window appears | Carry on |
| partial | The arrangement comes back, but the window opens on the work of the most recently opened project rather than the last place stood. A project folder that was deleted is no longer reopened, and one that cannot be reached is skipped and tried again next time | Go to the place |
| error | A record that could not be written is not reported, and the change is lost at the next restart. A record damaged by hand is read entry by entry, and entries that still make sense are kept | Arrange the window again |
| denied | Cannot occur: the arrangement belongs to whoever uses the machine | Arrange it |
| success | The window as the person left it | Carry on |

## A divider resets in one gesture, and closing straight after a change keeps it

A divider returns to its default with a double click. Folds and folders are undone by folding or opening them again.

A change is written a moment after it is made and again as the app closes, so closing straight after a change keeps it. The arrangement belongs to one person on one machine, so another machine or another account starts at the defaults.

## Dividers move by keyboard but reset only by pointer, and a narrow window is not protected

**Keyboard only.** Each divider takes focus and moves with arrow keys in small steps, or larger steps with Shift. Returning a divider to its default needs a pointer.

**Screen reader.** Each divider is announced as a separator named for what it resizes. Its size is not announced as it moves.

**Small window.** Side areas have limits that do not depend on the window's width, so a side area restored or dragged wide can crowd out the main area. The window has no smallest size, and nothing folds on its own.

**Slow machine.** A change is written after a pause of 0.4 seconds, so a drag writes once when it ends. A drag works out each size from where it began, so slow frames do not make a divider drift.
