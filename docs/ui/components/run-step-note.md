---
id: ui/components/run-step-note
type: ui-component
status: shipped
updated: 2026-09-22
realizes: [ux/patterns/arm-the-cut-then-confirm, ux/patterns/verbs-on-the-thing-itself, ux/patterns/nested-under-what-caused-it]
serves: [product/complete-record-of-every-run, product/failures-explain-themselves, product/rewind-to-where-it-went-wrong, product/try-another-direction, product/large-work-splits-into-independent-pieces]
surfaces: [ui/surfaces/run-conversation, ui/surfaces/run-view, ui/surfaces/task-context]
reuses: [ui/components/icon, ui/components/context-menu]
implemented_by: [packages/app/src/renderer/sessionPanels.tsx, packages/app/src/renderer/sessionBands.ts]
verified_by: [packages/app/test/sessionPanels.test.ts, packages/app/test/sessionBands.test.ts]
mockups: [ui/assets/run-step-note/entered.html, ui/assets/run-step-note/failed.html, ui/assets/run-step-note/made.html, ui/assets/run-step-note/rewind-armed.html, ui/assets/run-step-note/skipped.html, ui/assets/run-step-note/moved.html]
siblings: [ui/components/session-sheet, ui/components/state-rail, ui/components/fork-mark, ui/components/computed-state-body]
---

# Run step note

A small sentence written straight on the grey of a run page between the sheets, with no box: a fork-path glyph, `entered` and a path such as `product → explore` in `--dim`, or a red alert glyph and `could not enter build → verify: {reason}` in `--bad`, with rewind and fork glyphs that appear at the row's end when pointed at.

## A note records what the machine did where no conversation holds it

**Use when.** A run entered a state: every entry gets a note, whether or not the state then spoke. A state could not be entered, or gave up, with no conversation to report it. A fan-out turned its elements into tasks of their own: the note names and links them. A Skip stepped over states ([decision 0005](../../engineering/decisions/0005-connect.md) §4): the state it interrupted keeps its own note with how long it had run, and the states it never entered, in one mount one after another, are ONE note naming them all. A conversation's `start_task` or `move_task` took effect: the note is the tool's own sentence, at the conversation's level, from the host's `jaira.moved` row, and the conversation's sheet is cut at the call that did it so the note sits right after that call and before the reply (after the whole turn where the row names no call).

**Do not use when.** A state's own call failed: the red reason goes inside its [session-sheet](session-sheet.md) as a [computed-state-body](computed-state-body.md). A history divided: that is a [fork-mark](fork-mark.md). The run itself stopped: the [activity-strip](activity-strip.md) says so.

## The glyph and the verb read first, the path second, and the reason last

- **Row.** One row of the [state-rail](state-rail.md), 4px of padding, 8px between parts, baseline-aligned, in app text at 0.92 of the base. Nothing frames it.
- **Glyph.** A fork-path glyph in `--dim` for a move; an alert circle in `--bad` for a failure.
- **Verb.** `entered`, `could not enter`, `made`, `split off` or `skipped`, in `--dim`; a moved note's verb is the tool's — `entered`, `moved to`, `connected to`, `adopted into` or `fast-forwarding to`. A failure with no verb starts with its path.
- **Path.** Child keys from the level being read, joined by ` → `, in `--dim`, at most 30% of the row and ellipsised. The level being read never gets a note for entering itself.
- **Reason.** After a failure's path, in `--bad`, wrapping onto as many lines as it needs.
- **Cut glyphs.** On an entry, a rewind glyph and a fork glyph, 13px each, pushed to the row's end, invisible until the row is pointed at or holds focus.
- **Made list.** After `made` or `split off`, every other task the fan-out made: its title as a link at most 24 characters wide, then `· {standing}`, separated by commas. A task this one waits for is bold and led by a `waits for` pill with a 1px `--line` border. The path follows the list.

## Notes read as moves, failures, made tasks and an armed cut

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | Cannot occur: a note is drawn only for something the run recorded. | |
| loading | Cannot occur: notes come with the run's record, before any conversation is read. | |
| partial | Cannot occur as a look of its own: a made task still going shows its standing, such as `· running` or `· waiting for 2 tasks`. | |
| entered | A move in `--dim`: `entered {path}`. A transition reads the same, with the state it went to repeated after the path. Pointed at, the rewind and fork glyphs appear at the end. | [entered.html](../assets/run-step-note/entered.html) |
| error | A failure in `--bad` with the alert glyph: `could not enter {path}: {reason}` for a state that could not be entered, or `{path} {reason}` for a state that gave up. The reason wraps whole. | [failed.html](../assets/run-step-note/failed.html) |
| made | `split off` or `made`, then each other task with its standing, then the mount's path. The task being read is not listed: it continues below. | [made.html](../assets/run-step-note/made.html) |
| skipped | The fork-path glyph, dimmed: `skipped · interrupted at {t} · {path}` for the state the Skip cut, and `skipped · never entered · {mount} → {key}, {key}` for the states it stepped over, one note for all of them. | [skipped.html](../assets/run-step-note/skipped.html) |
| moved | The tool's own sentence at the conversation's level, between the turn that moved and the one after: `adopted into **{workflow}** as {key} · standing at {path}`, `moved to {path}`, `entered {key}`, or `fast-forwarding to **{target}** · through {…} · {workflow}`. It opens no lane and offers no cut. | [moved.html](../assets/run-step-note/moved.html) |
| rewind armed | The entry's knot takes a red ring, a lowercase `--bad` line between dashed red rules under it reads `{n} states below this line will be deleted`, and every row after it fades to 35%. | [rewind-armed.html](../assets/run-step-note/rewind-armed.html) |
| success | Cannot occur as a look of its own: a finished run shows its entries like any other. | |

## The cut glyphs arm a rewind or fork at once, and a made title opens its task

| On | Does | Feedback |
| --- | --- | --- |
| Pointer over or focus in an entry | Nothing | The rewind and fork glyphs fade in at the row's end |
| Rewind glyph | Arms a rewind to before that state | The line and the fade appear, and the activity strip becomes the confirmation |
| Fork glyph | Makes a new task at once that keeps everything before that state and starts by entering it | The new task opens |
| Right-click the entry's knot on the rail | Offers the same two acts in a menu | A menu at the pointer |
| A made task's title | Selects that task | The task opens |

The glyphs appear only where the host can cut the run.

## The copy is a sentence about the machine

| Where | String |
| --- | --- |
| Verbs | `entered` · `could not enter` · `made` · `split off` · `skipped` |
| Skipped | `interrupted at {t}` · `interrupted` · `never entered` |
| Moved | `entered` · `moved to` · `connected to` · `adopted into` · `fast-forwarding to` · `as` · `standing at` · `one task per element, held · standing at` · `· through {states}` |
| Blocked reason | `: {reason}` |
| Rewind glyph | tooltip `Rewind to before {path} — it and everything after it are deleted, and the run enters it again`; name `Rewind to before {path}` |
| Fork glyph | tooltip `Fork before {path} — a new task that keeps everything before it and starts by entering it`; name `Fork before {path}` |
| Knot menu | `Rewind to before {path}`, note `deletes it and everything after` · `Fork before {path}`, note `a new task from here` |
| Made | `waits for`, tooltip `this task waits for it to complete` · title tooltip `open {title} ({task id})` · `· {status}` · `· waiting for 1 task` · `· waiting for {n} tasks` |
| Armed line | `1 state below this line will be deleted` · `{n} states below this line will be deleted` |

## The path gives way before the reason, and a made list wraps

- Resize: the path never takes more than 30% of the row; a reason wraps instead of cutting; a made list wraps its tasks onto further lines, and each title ellipsises at 24 characters.
- Theme: `--dim` and `--bad` carry the two tones in both themes.
- Focus: the cut glyphs and the made titles are buttons in the tab order, and focus reveals the glyphs as the pointer does. The knot's menu has no keyboard route; the glyphs are that route.
- Missing content: a note about the level being read has no path and is the sentence alone.

## The note departs from the type registers in its path and its armed line

- The path is data and renders in the app face.
- The armed line is lowercased, and its size is a hand-set ratio instead of a register.
