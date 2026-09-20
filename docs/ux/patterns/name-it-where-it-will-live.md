---
id: ux/patterns/name-it-where-it-will-live
type: ux-pattern
status: shipped
updated: 2026-09-13
serves: [product/author-processes-without-memorising-the-format, product/share-processes-across-projects, product/chat-with-agents]
siblings: [ux/patterns/verbs-on-the-thing-itself, ux/patterns/pick-from-what-exists, ux/patterns/schema-driven-form, ux/patterns/second-deliberate-step-for-irreversible, ux/patterns/filter-in-place]
---

# Name it where it will live

Creating a thing asks only which kind: a file, a folder, a process, or a step inside a process. The system opens the place the thing belongs and puts an editable name at the exact spot it will appear, so the place is the answer to where. Confirming the name creates the thing there, with any folder it needs, and selects it. An empty name or Escape abandons it with nothing created. Renaming a conversation takes the same shape: its name becomes editable where it is listed.

## Use it when a new item belongs to a visible list and needs only a name

**Use when.** A new or renamed item belongs to a hierarchy or list the person can see, and a name is all it needs.

**Do not use when.** Creating the thing needs more than a name, such as inputs for new work: use [schema-driven-form](schema-driven-form.md). The name must match something that exists: offer it with [pick-from-what-exists](pick-from-what-exists.md).

## The person picks a kind, types the name in place, and the item appears there

| # | Person does | System does | Person knows |
| --- | --- | --- | --- |
| 1 | Asks to add, on a folder or list | Offers the kinds that can exist there | What can be made here |
| 2 | Picks a kind | Opens the containing folder and puts an editable name where the item will appear | Where it will live |
| 3 | Types a name and confirms | Creates it there, with any folder it needs, and selects it | It exists |
| 3' | Presses Escape, or leaves the name empty | Removes the name and creates nothing | Nothing happened |

## Every state either creates the item at its place or leaves nothing behind

| State | Person sees | Can do next |
| --- | --- | --- |
| first_run | A place that does not exist on disk says adding to it will create it | Add the first item |
| empty | An empty name creates nothing | Type a name, or leave |
| loading | Cannot occur as its own state: the name goes away on confirming and the item appears when it is created | Edit the item |
| partial | Typing a filter into the file list removes a half-typed name, because the place it belonged to is no longer drawn | Clear the filter and add again |
| error | A name already taken is refused, the refusal is reported apart from the list and does not stay, and nothing is created | Add again with another name |
| denied | Kinds that cannot exist at a place are not offered: a process only where processes are kept, and nothing without a project open | Add at a place that takes that kind, or open a project |
| success | The new item is selected at its place | Edit it |

## A created item stays until deleted, and an abandoned name leaves nothing

Creating has no undo. A created item is removed by deleting it, as in [second-deliberate-step-for-irreversible](second-deliberate-step-for-irreversible.md). A renamed conversation is renamed back the same way it was renamed.

Abandoning a name loses only the typed name.

## Naming works by keyboard alone, but leaving the box means different things

**Keyboard only.** The add action on a folder is reached by Tab and appears when focused. Enter confirms a name and Escape abandons it. Leaving a new item's name box with a name typed creates the item, while leaving a conversation's rename box abandons the rename.

**Screen reader.** A new item's name box is named for the kind being created. A conversation's rename box has no name of its own.

**Small window.** The name box sits in the list and narrows with it.

**Slow machine.** Nothing marks a creation in progress. The item appears when the system reports it created.
