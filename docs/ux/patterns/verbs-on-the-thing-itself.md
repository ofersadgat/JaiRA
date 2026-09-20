---
id: ux/patterns/verbs-on-the-thing-itself
type: ux-pattern
status: shipped
updated: 2026-09-13
serves: [product/hand-work-to-agents, product/pick-up-where-it-left-off, product/rewind-to-where-it-went-wrong, product/try-another-direction, product/chat-with-agents, product/author-processes-without-memorising-the-format]
siblings: [ux/patterns/second-deliberate-step-for-irreversible, ux/patterns/arm-the-cut-then-confirm, ux/patterns/name-it-where-it-will-live, ux/patterns/context-beside-what-you-stand-on]
---

# Verbs on the thing itself

The actions for an item are offered on the item: by right-clicking it, or by pointing at it, which shows a few actions on the item. They are not permanent controls elsewhere. Right-clicking an item makes it the current item first, so the description beside it, as in [context-beside-what-you-stand-on](context-beside-what-you-stand-on.md), is about the item the actions act on. A set of items is chosen the way a file explorer chooses: Shift-click extends a range and Ctrl-click adds or removes one item. Right-clicking a stage offers the same set actions for everything in it. An action on a set names how many items it will touch, skips the members it does not apply to, and says which kind it skipped. An action that does not apply stays in its place and cannot be taken.

## Use it when items have several actions that would clutter a list if always shown

**Use when.** Items in a list carry several actions each, or several items must be acted on together: re-running, cancelling or deleting work, renaming or deleting files and conversations, copying what a message holds.

**Do not use when.** One action is the main thing to do with the item: offer it plainly, worded as in [button-says-what-will-happen](button-says-what-will-happen.md). The action must be reachable by keyboard alone: most actions in this shape open only for a pointer, as the last section states. The action creates a new item: name it where it will appear with [name-it-where-it-will-live](name-it-where-it-will-live.md).

## The item becomes current, its actions are offered, and a set says what it will skip

| # | Person does | System does | Person knows |
| --- | --- | --- | --- |
| 1 | Optionally chooses a set with Shift-click and Ctrl-click | Marks the chosen items and describes the last one touched | Which items are chosen |
| 2 | Right-clicks an item or points at it | Makes a right-clicked item outside the set the only chosen item, then offers the actions. For a set, each action names how many items it will touch and which kind it skips | What can be done, and to how many |
| 3 | Takes an action | Acts on each eligible item in turn. An irreversible action first asks, as in [second-deliberate-step-for-irreversible](second-deliberate-step-for-irreversible.md) | That the action is under way |
| 4 | Nothing | Shows the effect on each item as the system reports it | What was done |

## Every state keeps unavailable actions in view and says what a set skipped

| State | Person sees | Can do next |
| --- | --- | --- |
| first_run | Cannot occur as its own state: actions belong to items, and there is nothing to act on before an item exists | Create or open an item |
| empty | An item with no actions offers nothing when right-clicked | Open the item |
| loading | Cannot occur: the actions are known when offered, and nothing is fetched to offer them | Take an action |
| partial | An action on a set names the kind of member it skips, such as running work skipped by a re-run. A set is acted on one item at a time, and a failure stops the rest: the failure is reported, and the items before it stay acted on without being listed | Check which items changed, then act on the rest |
| error | A failed action reports its reason apart from the item. The report goes when the next action is taken or the view changes | Read the reason and take the action again |
| denied | An action that does not apply is shown and cannot be taken, such as deleting running work or cancelling finished work. On a single item it gives no reason | Change the item's situation, such as stopping the work, then act |
| success | The effect shows on each item | Carry on |

## Actions taken here have no undo of their own, and destructive ones ask first

An action taken from an item is undone only by an opposite action where one exists. Deleting asks first and states what will be lost. Closing the offered actions without choosing one changes nothing.

A chosen set lasts for the session and is not kept across a restart. Deleting a set clears the choice.

## Actions on items need a pointer, and an opened list of actions never takes focus

**Keyboard only.** Items grouped by stage cannot take focus, so their actions cannot be opened from the keyboard. An opened list of actions does not take focus and does not move with arrow keys. Escape closes it, and so do a press outside it, a resize of the window, and a scroll that carries its item away. Actions shown by pointing also show when focus moves inside the item. Choosing a set needs a pointer.

**Screen reader.** A list of actions is announced as a menu of items. Actions shown by pointing carry names.

**Small window.** A list of actions opened near an edge is moved inside the window, and the area it was opened in never cuts it off.

**Slow machine.** The actions open at once. Their effect shows only when the system reports it, however long that takes.
