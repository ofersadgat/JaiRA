---
id: ui/components/settings-field
type: ui-component
status: shipped
updated: 2026-09-23
realizes: [ux/patterns/inherited-unless-set-here, ux/patterns/schema-driven-form, ux/patterns/fold-to-a-summary-expand-in-place]
serves: [product/bring-your-own-models-and-agents, product/share-processes-across-projects, product/agents-act-only-where-allowed, product/read-comfortably]
surfaces: [ui/surfaces/settings-view, ui/surfaces/settings-connections, ui/surfaces/settings-models, ui/surfaces/settings-tools, ui/surfaces/settings-runs, ui/surfaces/settings-files, ui/surfaces/settings-data, ui/surfaces/new-task-popover, ui/surfaces/gate-modal, ui/surfaces/context-panel]
reuses: [ui/components/switch, ui/components/preset-chips]
implemented_by: [packages/app/src/renderer/controls.tsx]
verified_by: [packages/app/test/schemaForm.test.ts]
mockups: [ui/assets/settings-field/success.html, ui/assets/settings-field/error.html, ui/assets/settings-field/stacked.html, ui/assets/settings-field/levels.html, ui/assets/settings-field/disclosure.html]
siblings: [ui/components/schema-form, ui/components/settings-header, ui/components/provider-row, ui/components/switch, ui/components/preset-chips, ui/components/size-stepper]
---

# Settings field

A settings row with its statement on the left, a bold label with an optional blue `SET HERE` tag over a grey hint ending in the mono config key, and its control on a right-hand rail, rows parted by faint hairlines under small uppercase level headings.

## A settings field states one setting, what it writes, and its value

**Use when.** One setting or one typed value is shown with its control: every row of the Connections, Models, Tools, Runs, Files and Data & history settings pages, and every member a [schema-form](schema-form.md) draws, so run inputs, New task inputs and gate forms share the same row. A level heading groups the rows one type of thing contributes, and a disclosure holds settings most projects never touch.

**Do not use when.** A whole value is declared by a schema: draw it with [schema-form](schema-form.md), which uses these rows. A thing with a status and its own switch, such as a provider, is a [provider-row](provider-row.md). Text in a conversation, a gate's own heading, or the options of a question are not settings.

## On a settings page a field is a row of a card, with a switch that enables it

Inside the Settings view (the person's pick of t3code's pattern, 2026-09-23) a field is drawn as a settings row: its name at 1.1× the app base in weight 550, capitalised; ONE sentence under it — the first sentence of the hint — and whatever followed, with the config key it writes, behind an `ⓘ` beside the name; its control on the right edge; rows parted by a full `--line` hairline inside one bordered card per section, under a quiet sentence-case heading ([settings-appearance](../surfaces/settings-appearance.md) is built the same way). A top-level level is such a section; nested levels stay bands inside it.

A field a layer may or may not state carries a **switch** before its name, and the switch enables the row: on, this layer states the value and the control edits it; off, the row is disabled — its control dimmed to 50% and unreachable — and shows what it inherits. Switching it on pins the value it shows, so nothing changes until it is edited; switching it off removes the value, and the row inherits again. This replaces the `SET HERE` tag on every settings page. A list or a nested form goes under the name across the row instead of on the right edge.

Everywhere else — run inputs, New task, a gate — a field keeps the shape below.

## The statement reads first, the value lands on one rail, and levels say what the settings belong to

- **Label.** The app face at 12/12.5 of its base, weight 550, `--text`; set in the data face at weight 500 when it names a key the author chose. On the same line, a `SET HERE` tag at 9.5/12.5 in uppercase with .04em tracking, `--accent` on `--tint-accent`, radius 4, when the layer being edited states the value; then anything the host adds, such as a required mark.
- **Hint.** Under the label at 11/12.5 with 1.4 line height in `--dim`, ending 6px later in the config key in the data face at 10/12 in `--dim`.
- **Rail.** The control sits in a column from 140px to 15rem wide, 22px from the statement, centred on the row. Rows have 7px above and below and a hairline of `--line` at 60% between them.
- **Controls.** Boxes on `--bg` with a 1px `--line` border, radius 7px, 6px by 9px padding, in the app face at its base size; a machine value such as a path or a model id in the data face at its base size; a number box at most 120px wide; a text area at 1.45 line height. Presets beside a box are [preset-chips](preset-chips.md); an on or off is a [switch](switch.md).
- **Error.** A message in `--bad` at 11/12.5 on its own line under the control, and the box border in `--bad`.
- **Level.** A heading in the app face at 11/12.5, weight 600, uppercase with .06em tracking, in `--dim`, with a hint under it; rows follow 8px below. A first and second nested level is indented 12px behind a 2px `--line` rule; deeper levels are not indented further.
- **Disclosure.** A hairline over a head of a small `▶`, a bold title at 12/12.5 and `· {description}` in `--dim`; opened, the caret turns to point down and the body is indented 17px.

## A row is inherited or set, and may be wrong, stacked, nested or folded

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | Not a look of its own: an empty box shows its placeholder, `—` for a number, and means the value is inherited; drawn as `Artifact directory` in the success mockup. | |
| loading | Cannot occur: a row draws from the values the pane already holds. | |
| partial | Cannot occur: a row is drawn whole. | |
| success | The Artifacts rows in the field's own shape: rows the project states carry `SET HERE`, an inherited row does not, and a preset row shows its chips over a mono box and a line of variables. | [success.html](../assets/settings-field/success.html) |
| error | A touched value that fails its check, drawn in a gate's form: the box border turns `--bad` and the message sits under it. | [error.html](../assets/settings-field/error.html) |
| stacked | In a box 380px wide or less, each row's control drops under its statement at full width. A row placed outside a list of rows keeps its two columns. | [stacked.html](../assets/settings-field/stacked.html) |
| levels | Nested levels in the executor tree, each heading over its own rows, indented behind a rule. | [levels.html](../assets/settings-field/levels.html) |
| folded | A closed disclosure over an open one: `▶` and the title alone, then the turned caret over its indented rows and button. | [disclosure.html](../assets/settings-field/disclosure.html) |
| disabled | Not a look of its own: a layer that cannot be edited dims every control to 55% and takes no input, as the locked copy in the schema-form layered mockup shows. | |

## The control does the work, and the row shows what it did

| On | Does | Feedback |
| --- | --- | --- |
| Typing in a box | Writes the value to the layer being edited | On a settings page the row's switch is already on; elsewhere `SET HERE` appears once the layer states it |
| A row's switch, on a settings page | On pins the value the row shows into this layer; off removes it, so the row inherits | The row enables, or dims and shows what it inherits |
| Emptying a box | Leaves the setting unset, so it inherits; a number box never writes zero for empty | The placeholder returns and the tag goes |
| Typing a number part way, such as `0.` | Keeps the typed text until the box is left | The box shows exactly what was typed |
| Pointer over a box | Nothing | Border `--rule` |
| Keyboard focus on a box | Nothing | Border `--accent` inside the focus ring |
| A disclosure's head | Opens or closes it; it opens closed each time the pane is drawn unless the host opens it | The caret turns over 120ms and the body appears or goes |
| Pointer over a disclosure's head | Nothing | The caret and title turn `--text` |

## The copy names the setting in words and the key in code

| Where | String |
| --- | --- |
| Set tag | `set here`, drawn uppercase; tooltip `set in the layer you are editing` |
| Label | `{label}`, such as `Keep inline below` |
| Hint | `{hint}` then `{config key}`, such as `artifacts.inlineMaxBytes` |
| Number placeholder | `—` |
| Level | `{title}`, drawn uppercase, such as `Default call settings`, then `{hint}` |
| Disclosure | `{title}` · `· {description}`, such as `How a call is dispatched` · `· the executor tree, and the layers around each level`, `Which of them a run may reach` · `· everything the workflow registers`, `Add an agent CLI` · `· any other coding-agent binary` |
| New task workflow picker | `choose a workflow…` |

## The rows measure their own box rather than the window

- Resize: rows stack when their own list is 380px wide or less, whatever the window does, and a list declared for narrow controls is always stacked. The rail never grows past 15rem, so a wide pane leaves space between statement and control.
- Theme: every ground, border and colour is a token; set or inherited is carried by the tag's word as well as its colour.
- Focus order: the statement takes no focus; the control does, then the next row's. A disclosure's head is one button in the order.
- Long content: labels wrap onto the tag's line, hints wrap, and a long config key ellipsises at the end of its hint. A box's text scrolls inside it.
- Missing content: without a hint or key the label stands alone and the row centres on it.

## The rows depart from the direction in weight, ratios and dimming

- Labels, tags, hints and keys use their own ratios of the base sizes and a 550 label weight rather than the ten register classes.
- A disabled control is dimmed with 55% opacity.
- The disclosure's caret is a typed `▶` rather than a line icon.
