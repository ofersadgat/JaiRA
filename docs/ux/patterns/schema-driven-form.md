---
id: ux/patterns/schema-driven-form
type: ux-pattern
status: shipped
updated: 2026-09-13
serves: [product/hand-work-to-agents, product/try-one-step-on-its-own, product/decisions-stay-yours, product/bring-your-own-models-and-agents, product/try-a-process-without-spending]
siblings: [ux/patterns/inherited-unless-set-here, ux/patterns/pick-from-what-exists, ux/patterns/one-document-several-readings, ux/patterns/ask-one-or-several-questions, ux/patterns/park-and-ask]
---

# Schema-driven form

What a target accepts is described once, and the form is drawn from that description. Each field gets a control suited to its kind, required fields are marked, each field states the kind and range of value it takes, and each default is filled in or stated as what applies when the field is left unset. An optional field is either set or not set, and the person says which by switching it on or off. Not set means left out, or left to a default or an inherited value, and is never an empty value. A value that may take several shapes offers a choice of shape. In a form that is submitted, values are checked as they are typed by the same rules the target applies, a problem shows on its field once the person has touched that field, and the form cannot be sent while a problem remains. A settings form has no submit: each change is written as it is made and checked as it is written.

## Use it wherever a person gives typed values that something declares it accepts

**Use when.** A person must give values of declared kinds: the inputs for starting work on a process, the inputs for running one step on its own, a form a process asks a person to fill while it waits as in [park-and-ask](park-and-ask.md), and configuration in settings.

**Do not use when.** The answer is a pick among a few offered options: use [ask-one-or-several-questions](ask-one-or-several-questions.md). The person wants the stored document as text: use [one-document-several-readings](one-document-several-readings.md), which keeps the text and the form the same document.

## The person fills what the description asks for and the form refuses to send anything it would reject

| # | Person does | System does | Person knows |
| --- | --- | --- | --- |
| 1 | Opens the form | Draws a field for each accepted value, marks required ones, states the kind of value each takes, and fills in or states each default. An optional field starts not set unless its default is filled in | What is needed and of what kind |
| 2 | Switches optional fields on or off, fills values, and picks a shape where there is a choice | A moment after typing pauses, checks the values against the target's rules and shows each problem on its field once that field is touched. Values from a fixed set are offered as the person types | Which values are wrong, and why |
| 3 | Submits | Refuses while a problem remains, naming the first problem and how many there are. Otherwise sends the values, leaving out every field that is not set | That the values were sent, or what blocks them |
| 4 | Changes a value in a settings form | Writes the change at once to the layer being edited, checked as it is written. Switching a field off releases it to the inherited value, as in [inherited-unless-set-here](inherited-unless-set-here.md) | That the change is in effect, or that it was refused |

## Every state names what blocks sending and what the person can fix

| State | Person sees | Can do next |
| --- | --- | --- |
| first_run | Before a process is chosen, the form says its inputs will appear once one is. While a chosen process's inputs are read, it says so | Choose a process |
| empty | A process that declares no inputs says so. Each field that is not set says what that means: left out of the answer, the default that will apply, or the value inherited from the layer beneath | Submit, or switch a field on |
| loading | Until the first check answers, sending is unavailable and the form says the values are being checked. During later checks sending stays unavailable without comment | Keep filling values |
| partial | Some values pass and some fail. Problems show only on touched fields, and the first problem is named beside the action wherever it is. A collapsed list item holding a problem opens and stays open | Fix the named problem |
| error | The checker cannot be reached: the form says the values could not be checked and blocks sending until a check succeeds. A broken description says it cannot be checked. A process whose file does not parse says its inputs cannot be read. In settings, a refused change is not written, the field shows the stored value again, and the reason is given apart from the field | Edit a value to check again, fix the process file, or make the settings change again in a valid form |
| denied | Sending is unavailable while any value fails, with the first problem beside the action. A settings layer that cannot be edited, such as a project's layer with no project open, shows its values and takes no changes | Fix the problem, or open the project |
| success | A submitted form hands its values to the work. A form a process asked for stays in the record showing what was sent, with fields that were not sent marked as not answered. A settings change is in effect immediately | Follow the work, or read the record |

## Values typed toward sending last for the session at most, and a settings change has no undo

Values typed for starting work or running a step are kept for each process and step while the app stays open, and are lost when it restarts.

A form a process asks a person to fill keeps its values only while it stays in view. Leaving it discards them, and the question stays waiting.

A settings change is written the moment it is made and is undone only by changing it back. Writing through the form keeps any stored field the form does not show.

## Every control works by keyboard, but field names and problems are not tied to their controls for a screen reader

**Keyboard only.** Optional fields are switched with real switches that say what switching does. The form for starting work submits on Enter. List items are moved and removed with their own controls. A renamed key applies on Enter or on leaving the box, and Escape abandons the rename.

**Screen reader.** A field's name and its problem are not associated with its control, so a control is announced without its name and a problem is found only by reading around it. Switches and shape choices announce what they are.

**Small window.** Fields stack into one column.

**Slow machine.** Checks wait for a 0.12 second pause in typing, and an answer about values that have since changed is discarded. While a check is out, the previous problems stay shown and sending stays unavailable. In settings the form takes no input while a change is being written, so keystrokes made during a write are lost.

## This departs from the UX principles in one place

A settings change is written the moment it is made so the form always shows what is in effect, and a change the check refuses is discarded rather than held for correction.
