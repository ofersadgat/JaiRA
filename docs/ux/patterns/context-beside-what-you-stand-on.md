---
id: ux/patterns/context-beside-what-you-stand-on
type: ux-pattern
status: shipped
updated: 2026-09-13
serves: [product/try-one-step-on-its-own, product/complete-record-of-every-run, product/know-what-work-costs, product/read-what-work-produced, product/hand-work-to-agents]
siblings: [ux/patterns/drill-in-and-back-out, ux/patterns/one-document-several-readings, ux/patterns/the-window-remembers-its-arrangement]
---

# Context beside what you stand on

Beside the main area, a companion area describes the thing the person last stood on: a piece of work, a run, a step of a process, a file or a folder. What it describes follows from where the person is, so the two never disagree. Opening a file or going into a run makes it the thing stood on. For things shown in the main area, such as work grouped by stage or the boxes of a picture of a process, a single click describes the thing without moving the main area. A double click goes into it, extending the address as in [drill-in-and-back-out](drill-in-and-back-out.md), and the companion then describes the new place. A description can link to a related thing, such as the work a run belongs to, and following the link offers a way back to the description before it. A value can also be pinned into the companion, which then holds that value in every view until the person closes it.

## Use it when the person keeps needing facts about the thing they are on

**Use when.** The person moves around a main area and repeatedly needs the facts and actions of the current thing: its runs, its cost, its inputs, what it produced. Or they want one value kept in sight while they read on elsewhere.

**Do not use when.** The facts are needed once, at one moment: show them with the thing itself. The thing has nothing to say beyond its name. The person wants to move into the thing and its contents: that is [drill-in-and-back-out](drill-in-and-back-out.md), which this pattern pairs with.

## One click describes, two clicks go in, and a link keeps its way back

| # | Person does | System does | Person knows |
| --- | --- | --- | --- |
| 1 | Clicks a thing in the main area once | Describes it in the companion and leaves the main area where it was | Its facts and what can be done with it |
| 2 | Double-clicks it | Goes into it, extends the address, and describes the new place | They moved, and where to |
| 3 | Follows a link in the description | Describes the related thing and offers a way back | How to return to what they were reading |
| 4 | Pins a value, and later closes it | Holds the value in the companion over any description until it is closed, then describes where the person stands again | The value stays in sight while they read elsewhere |

## Every state describes something or says what to choose

| State | Person sees | Can do next |
| --- | --- | --- |
| first_run | With nothing chosen, the companion asks for a piece of work or a file to be chosen | Choose something |
| empty | A thing with nothing to report says so. A file that is not a step says it is not one, and a step that never ran names how many pieces of work it searched and where, as in [absence-is-stated](absence-is-stated.md) | Run the step, or choose something else |
| loading | A run being read says it is reading. While a file loads, the companion briefly asks for a file to be chosen | Wait |
| partial | A file described with no project open says which facts need a project: its problems, what depends on it, its drift from its description, and its runs | Open a project |
| error | A description that fails to read shows nothing, and looks the same as a thing with nothing to report | Choose the thing again |
| denied | Cannot occur: anything the person can stand on can be described | Choose something |
| success | The description of the thing with its actions | Act, go in, or follow a link |

## Describing changes nothing, and the way back survives a second link

Describing only reads, so there is nothing to undo. After following a link, the way back restores the description the person left. Following a second link does not replace that way back.

A pinned value stays through changes of view and of address until it is closed. The description and any pinned value last for the session and are gone after a restart.

## Describing and going in need a pointer, and a wide companion can crowd out the main area

**Keyboard only.** Items grouped by stage and the stages themselves cannot take focus, so describing and going into them needs a pointer. Actions inside the companion are standard buttons reached by Tab. The divider beside the companion moves with arrow keys.

**Screen reader.** The companion is not marked as a region of its own, so it is found only by reading through the page.

**Small window.** The companion keeps the width it was dragged to and never narrows on its own. It can be dragged wide enough to crowd out the main area, and a pinned value allows it to grow wider than a description does.

**Slow machine.** A description that arrives after the person has chosen something else is ignored.
