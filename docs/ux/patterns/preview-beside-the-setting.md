---
id: ux/patterns/preview-beside-the-setting
type: ux-pattern
status: shipped
updated: 2026-09-13
serves: [product/read-comfortably, product/try-a-process-without-spending]
siblings: [ux/patterns/one-document-several-readings, ux/patterns/the-window-remembers-its-arrangement, ux/patterns/inherited-unless-set-here]
---

# Preview beside the setting

A choice whose effect is hard to judge from its name is shown applied to a real sample beside the control, before the person leaves it. The sample is drawn by the same thing that draws the real content, never by a picture of it. Typefaces, sizes and text smoothing redraw a sample of the app's own lists. The way each kind of file is drawn, and its colour scheme, redraw a sample file of that kind that can be typed in. A question a process may ask a person is drawn from its configuration, and answering it shows what the process would receive and whether it would be accepted. Where a choice cannot be drawn on a sample, or a group's members disagree, a note says so in place of a misleading preview.

## Use it when the effect of a choice must be seen to be judged

**Use when.** The choice is about how things read and is hard to predict from its name, or an author needs to see what a configured question looks like and returns before any work reaches it.

**Do not use when.** The choice has no visible effect. The person wants to read an existing thing in another form: use [one-document-several-readings](one-document-several-readings.md).

## The person changes a choice and sees the real result before leaving

| # | Person does | System does | Person knows |
| --- | --- | --- | --- |
| 1 | Changes a reading preference, or edits a question's configuration | Applies a preference at once and keeps it for the person, and redraws the sample with the real drawing | What the choice looks like |
| 2 | Types into a sample, or answers a sample question | Behaves as the real thing does, and for a question shows what was returned and whether it would be accepted | How it behaves, not only how it looks |
| 3 | Leaves | Discards the samples and anything done to them | The preference holds wherever it applies |

## Every state shows the real result or says why it cannot

| State | Person sees | Can do next |
| --- | --- | --- |
| first_run | Samples drawn with the defaults | Change a choice |
| empty | A kind of file drawn by nothing says nothing is drawn. Turning off every way of drawing a kind says that kind is off | Turn a way of drawing back on |
| loading | Cannot occur as its own state: samples are made on the machine, and a heavy drawing appears once loaded | Wait for it |
| partial | A group of file kinds whose members are set differently shows a note in place of a sample | Set one value for the whole group |
| error | A way of drawing that needs a real open file says so in place of the sample. A typeface that is not monospaced warns that columns will not line up, and an answer the process would not accept is marked as rejected | Pick another, or open a real file |
| denied | Cannot occur: every choice is previewed or says why not | Change a choice |
| success | The sample, redrawn with the choice | Leave, or change it again |

## A choice is undone by changing it back, and nothing done to a sample is kept

No single step returns every reading preference to its default. Text typed into a sample, an edited question configuration and its answers are discarded on leaving.

## Previews are not fully usable by keyboard or screen reader

**Keyboard only.** The typeface chooser takes no arrow keys and closes on a press outside it, not on Escape. Size steps and view choices are reached by Tab.

**Screen reader.** View choices announce which is pressed. Size steps are announced by their symbol rather than by what they change.

**Small window.** The settings for kinds of file are not rearranged for a narrow window.

**Slow machine.** A heavy way of drawing loads only when first shown. A sample that fails to draw is replaced by its note and does not affect the rest of the settings.
