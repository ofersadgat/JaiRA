---
id: ux/patterns/absence-is-stated
type: ux-pattern
status: shipped
updated: 2026-09-13
serves: [product/try-one-step-on-its-own, product/complete-record-of-every-run, product/chat-with-agents, product/author-processes-without-memorising-the-format]
siblings: [ux/patterns/refuse-with-the-reason-and-the-fix, ux/patterns/say-what-it-is-doing-and-for-how-long, ux/patterns/filter-in-place]
---

# Absence is stated

A place with nothing to show says which kind of nothing it is: nothing has happened there, it is empty by nature, it has not loaded, or something was looked for and not found. Where the place searched, it says what it searched, such as how many pieces of work in which project, so a wrong empty can be told from a true one. A place that does not exist says what adding to it will do. A conversation already on screen is not cleared by a read that fails or comes back empty: what it last showed stays until a read brings more.

## Use it wherever a place can be empty for a good reason or its read can fail

**Use when.** A list, record or view can legitimately hold nothing, or reading it can fail: a step's runs, a conversation, a folder, the inputs a process declares, a filtered list.

**Do not use when.** The absence means an action cannot be taken: use [refuse-with-the-reason-and-the-fix](refuse-with-the-reason-and-the-fix.md). Something is on its way and taking time: say what is happening and for how long with [say-what-it-is-doing-and-for-how-long](say-what-it-is-doing-and-for-how-long.md).

## The place says what kind of nothing it holds and keeps what it already showed

| # | Person does | System does | Person knows |
| --- | --- | --- | --- |
| 1 | Opens a place | Reads it, and when there is nothing, states which kind of nothing and what was searched | Whether it is truly empty or only looks empty |
| 2 | Stays while the place refreshes | Keeps a conversation on screen unless the new read has more | What they were reading does not vanish |
| 3 | Adds to a place that does not exist | Creates the place with its first item, as the place said it would | The place now exists |

## Every state tells a true empty from one that only looks empty, except where stated

| State | Person sees | Can do next |
| --- | --- | --- |
| first_run | A place where nothing has happened says so, such as a project with no conversations. A folder for processes that does not exist says adding a step there creates it | Start a conversation, or add a step |
| empty | A step with no runs names how many pieces of work it searched and in which project. A process that declares no inputs says so. A folder says it is empty, and a filtered list of conversations says nothing matches | Change what is searched, or add to the place |
| loading | Some places say they are loading or reading. Others show their empty statement while they load: a conversation says nothing has been said, and a project's work says there is nothing there | Wait |
| partial | A conversation whose refresh failed or came back empty keeps what it last showed | Keep reading |
| error | A process file that does not parse says so. A structured file that is not valid says its form cannot be used until its text is fixed. Many failed reads say nothing and look empty, and a file tree that fails to load asks for a project to be opened | Fix the file, or open the place again |
| denied | A file of a kind nothing in the app can edit names its kind and says so | Open the file in another program |
| success | The content | Read or act on it |

## Stating an absence changes nothing, and a conversation opened afresh has nothing to keep

An absence statement only reads, so there is nothing to undo, and leaving a place loses nothing. Coming back reads the place again.

What a conversation keeps through a failed refresh lasts only while it stays open. A conversation opened afresh has nothing to keep, so a failed first read shows it as a conversation where nothing has been said.

## Absence statements are plain text that is read in place and never announced

**Keyboard only.** A statement takes no input. Where the place offers a next step, the step has its own control.

**Screen reader.** A statement is plain text in the place it describes, and nothing is announced when it appears or changes.

**Small window.** Statements get no special handling and take the width of the place they sit in.

**Slow machine.** A place reads again each time the thing it shows changes, with no delay between reads. A place that shows its empty statement while loading shows it for as long as loading lasts.
