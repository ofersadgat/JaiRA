---
id: ui/surfaces/new-task-popover
type: ui-surface
status: shipped
updated: 2026-09-13
kind: dialog
realizes: [ux/patterns/schema-driven-form, ux/patterns/pick-from-what-exists, ux/patterns/refuse-with-the-reason-and-the-fix, ux/patterns/absence-is-stated]
serves: [product/hand-work-to-agents, product/repeatable-agent-processes]
components: [ui/components/schema-form, ui/components/address-bar]
mockups: [ui/assets/new-task-popover/first-run.html, ui/assets/new-task-popover/form.html, ui/assets/new-task-popover/error.html]
siblings: [ui/surfaces/tasks-view, ui/surfaces/app-window, ui/surfaces/task-context, ui/surfaces/confirm-dialog]
---

# New task popover

A 340px card that drops from the `+ New task` button in the Tasks room's title bar, where a person picks one of the project's workflows, fills the inputs it declares, and creates a task from it. It floats over the board and the context panel of the [tasks view](tasks-view.md) without dimming them, and has no title field, because a task made here is named after its workflow.

## The workflow picker reads first, then the picked workflow's inputs, then Create

- **Button.** `+ New task`, a bordered button among the [address-bar](../components/address-bar.md)'s tools, after the crumbs, drawn only while the address stands in the project the sidebar stands in.
- **Card.** 6px under the button, right edges aligned, on `--panel` with a 1px `--line` edge, 10px corners, the `--lift` shadow, 12px padding and 8px between parts.
- **Workflow.** `Workflow` as an uppercase `--dim` caption over a select listing `choose a workflow…` and then every workflow that can be started here, by its label or its id.
- **Notice.** Under the picker, when the picked workflow has one: a `--bad` wash with the reason its file could not be loaded, or an amber wash counting its validation errors. The count never disables Create.
- **Inputs.** Nothing but a `--dim` line until a workflow is picked and read. Then its declared inputs as a [schema-form](../components/schema-form.md): each name in the data face, `*` on a required input, a switch before an optional one, the kind of value beside the name and the input's description under it. An input wired to something else shows its name over `bound to {binding}`. The inputs scroll inside the card past 46% of the window's height.
- **Actions.** A primary `Create`, a ghost `Cancel`, and a `--dim` line cut to an ellipsis that says why Create is off, or how many inputs the workflow asks for.

| Where | String |
| --- | --- |
| Button | `+ New task` |
| Picker | `Workflow` · `choose a workflow…` · `{workflow label}` |
| Before inputs | `Its inputs appear here.` · `reading its inputs…` · `This workflow declares no inputs.` |
| Notices | `{load error}` · `{n} validation error — it will start, and probably fail.` · `{n} validation errors — it will start, and probably fail.` · `That workflow's file does not parse, so its inputs cannot be read.` |
| Fixed inputs | `bound to {binding}` · `a spread — republished from a child` |
| Unset input | `not set` · `not set — the default applies: {default}` |
| Actions | `Create` · `Cancel` |
| Why Create is off | `choose a workflow` · `reading its inputs` · `that workflow's file does not parse` · `checking…` · `{input}: {problem}` · `{n} problems — {input}: {problem}` · `busy` |
| Count | `{n} input` · `{n} inputs` |
| Create tooltip | the reason it is off, or `creates {workflow}` |
| Created task's name | `{workflow} #{n}`, counting the tasks already made from that workflow here |

## The card grows from a picker to a form, and says what stops Create at each step

| State | Surface shows | Mockup |
| --- | --- | --- |
| closed | The button alone in the title bar. | [app-window room](../assets/app-window/room.html) |
| first_run | Nothing picked: the picker on `choose a workflow…`, `Its inputs appear here.`, and Create at half opacity with `choose a workflow` beside it. Drawn beside the loading and empty cards, which differ only in their words. | [first-run.html](../assets/new-task-popover/first-run.html) |
| loading | A workflow picked and its inputs on their way: `reading its inputs…`, Create off with `reading its inputs`. Until the values' first check answers, Create stays off with `checking…`; during later checks it is off with no words. | [first-run.html](../assets/new-task-popover/first-run.html) |
| empty | A workflow that declares no inputs: `This workflow declares no inputs.` and Create available with nothing beside it. | [first-run.html](../assets/new-task-popover/first-run.html) |
| form | The picked workflow's inputs, the required one filled, one optional input switched on and set, the rest not set with the default each would get, and `{n} inputs` beside an available Create. | [form.html](../assets/new-task-popover/form.html) |
| partial | Values the form refuses: each touched input with a problem gets a `--bad` edge and its complaint under it, and Create is off with the first problem and the count beside it. An amber validation notice may sit above, and does not block. | [error.html](../assets/new-task-popover/error.html) |
| error | A workflow whose file cannot be read: the `--bad` load notice, `That workflow's file does not parse, so its inputs cannot be read.`, and Create off with `that workflow's file does not parse`. Drawn beside the refused values. | [error.html](../assets/new-task-popover/error.html) |

## The button opens it and only its own buttons close it

- `+ New task` opens the card, and pressing it again closes it. A click outside and Escape leave it open.
- Picking a workflow reads its inputs and opens the form with every required input empty and every other input not set, so an input with a default says which default applies. A workflow filled before opens with the values last typed for it.
- `Create`, or Enter in the form, creates a task from the workflow with the inputs that are set, names it `{workflow} #{n}`, closes the card and selects the new task in the context panel, where [task-context](task-context.md) offers `Start`. Creating does not start it. A failure to create is reported by the [error notice](error-notice.md).
- `Cancel` closes the card and keeps what was typed.
- Reopening the card finds the last picked workflow still chosen, while the room stays open.

## The card keeps its width, and typed values last until the app closes

- **Resize.** The card stays 340px wide, anchored to the button's right edge, and is not moved to stay inside the window. Its inputs scroll inside it once they pass 46% of the window's height; the picker and the actions stay in view.
- **Theme.** Card, washes, switches and the primary button are tokens with a light and a dark value.
- **Focus.** Opening moves focus nowhere and focus is not held inside the card. Tab goes from the button into the picker, the inputs in order, `Create` and `Cancel`; an unavailable Create is skipped.
- **Long or missing content.** A long reason or count beside the buttons ends in an ellipsis and shows in full as Create's tooltip. Notices wrap.
- **Unsaved work.** Values typed for a workflow are kept for it until the app closes, shared with the Files view's run form for the same workflow. The picked workflow is forgotten when the room is left.
