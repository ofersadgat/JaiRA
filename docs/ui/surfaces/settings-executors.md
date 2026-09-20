---
id: ui/surfaces/settings-executors
type: ui-surface
status: shipped
updated: 2026-09-13
kind: panel
realizes: [ux/patterns/inherited-unless-set-here, ux/patterns/checked-status-with-the-fix, ux/patterns/name-it-where-it-will-live, ux/patterns/absence-is-stated]
serves: [product/bring-your-own-models-and-agents, product/share-processes-across-projects]
components: [ui/components/executor-tree, ui/components/llm-config-form, ui/components/schema-form, ui/components/settings-field]
mockups: [ui/assets/settings-executors/listing.html, ui/assets/settings-executors/nothing-yet.html, ui/assets/settings-executors/editing.html, ui/assets/settings-executors/writing.html, ui/assets/settings-executors/error.html]
siblings: [ui/surfaces/settings-view, ui/surfaces/settings-providers, ui/surfaces/settings-configuration]
---

# Settings executors

The Executors section of the [Settings view](settings-view.md): what actually answers the app's own model calls, drawn as the whole default executor fully expanded, then a list of named presets of call settings with a closed `Add a preset` disclosure under it. It sits under the [settings header](../components/settings-header.md), which picks the layer it writes and re-runs the checks that decide the executor, and it replaces whichever section was shown.

## The default executor reads first, and the presets follow it

- **Column.** At most 780px wide, left-aligned, with 34px between the two groups and 28px under the last.
- **Group head.** Padded 11px at the sides: the group's name at 15/12.5 of the app size and weight 650, then a `--dim` hint at 11/12.5 at most 70 characters wide.
- **The default executor.** The [executor tree](../components/executor-tree.md), every level open: an `OPERATION` band tinted `--tint-accent` with its kind in uppercase `--accent`, then indented levels behind a 2px `--line` rule for `FUNCTIONS`, with its ordered allow and deny rules tinted `--tint-ok` and `--tint-bad`, and `PROMPTS`, holding the `ROUTER` band, its default call settings and one card per route. A route card is dashed while it is `derived` and solid with a green `pinned` chip once something in it is set. Every level ends in a closed `Around …` disclosure for the layers around its calls.
- **Presets.** One row per preset this layer states, then one per preset only the other layer states. A row is the preset's name in the data face at 13/12.5 and weight 600 with a ghost `Configure` at the far end, over a one-line `--dim` summary of its settings. An inherited row has an `inherited` chip, `--dim` on `--panel-2` with a 6px dot, in place of the button.
- **Open preset.** Indented 30px under the name: the [call-settings form](../components/llm-config-form.md), a bordered box with a `--panel-2` rail of `Sampling`, `Reasoning`, `Output limits` and `Advanced`, each with its own summary, beside the chosen category's fields. Then `Save` filled, `Revert` ghost and `Remove` ghost in `--bad`. The button in the head reads `Done`.
- **Add a preset.** A 1px `--line` rule and a full-width head holding, centred, a `▶` caret, `Add a preset` and `· a named set of call settings` in `--dim`. Opened: one `Name` [settings field](../components/settings-field.md) with its box on the right-hand rail in the data face, and a plain `Add it`.

## The section shows the tree and presets, what is not there yet, an open preset, or that it cannot read

| State | Surface shows | Mockup |
| --- | --- | --- |
| listing | The whole tree as the checks resolved it, the presets with their summaries, and the disclosure closed. | [listing.html](../assets/settings-executors/listing.html) |
| nothing yet | A `--dim` sentence stands for what is missing: `Not resolved yet — the startup check has not finished.` in place of the tree, which is the loading look, and `None yet.` in place of the preset rows when neither layer has one. With no provider, server or agent available, `ROUTES (0)` holds its `--warn` sentence instead of cards. All three are drawn. | [nothing-yet.html](../assets/settings-executors/nothing-yet.html) |
| editing | A preset open with its form. Untouched, `Save` and `Revert` are inactive; once a setting changes, the summary line follows it live and both become active. The disclosure open with a name typed, `Add it` inactive while the box is empty. | [editing.html](../assets/settings-executors/editing.html) |
| writing | While a settings change is being written: every rule, field, `Add` and `Remove`, `Save`, `Add it` and the header's buttons at half strength and inert. `Configure`, `Done`, `Revert` and the disclosures still work. | [writing.html](../assets/settings-executors/writing.html) |
| error | The settings cannot be read: `The configuration could not be read.` in `--dim` in place of both groups. | [error.html](../assets/settings-executors/error.html) |
| empty | Cannot occur as a whole: the executor group is always drawn, and an empty preset list says `None yet.` | |

| Where | String |
| --- | --- |
| Group heads | `The default executor` · `Presets` |
| Executor hint | `What every UI-initiated operation uses — starting a task, proposing workflow changes, summarizing a conversation. It is a TREE: an operation executor over a function executor and a router, and the whole of it is below. Nothing here has to be configured: what is shown is DERIVED from what is available, and a change pins only the field you changed, so a provider or agent you set up tomorrow still appears by itself.` |
| Presets hint | `A named set of call settings a state picks with configRef, merged under its own config. A definition is the heavier tool — it chooses the provider and the stack too; a preset is only the settings.`, with `configRef` in the data face |
| Unresolved tree | `Not resolved yet — the startup check has not finished.` |
| No routes | `Nothing can answer a prompt here yet — no provider key, no local server, and no agent that runs. Set one up under Providers and a route appears.` |
| No presets | `None yet.` |
| Preset row | `{name}` · `Configure` / `Done` · `inherited` |
| Preset summary | `provider defaults`, or `reasoning {effort}`, `{setting} {value}`, `≤{n} tokens` and `+{n} more` joined with ` · `, such as `temperature 0.2 · ≤1200 tokens` |
| Preset actions | `Save` · `Revert` · `Remove` |
| Disclosure | `Add a preset` · `· a named set of call settings` |
| Name field | `Name`, hint `What a state will write in configRef.`, key `models.presets.<name>`, example `fast` · `Add it` |
| Unreadable | `The configuration could not be read.` |

## A person arrives from the settings sheet, and every change except a preset's is written at once

- `Executors` in the settings sheet shows this section with the tree the last check resolved, running no check. `Re-check` in the header resolves it again.
- Any change in the tree writes that one value into the layer being edited straight away, with no `Save`. The field gains a `SET HERE` tag and a route it belongs to turns `pinned`.
- `Configure` opens a preset and `Done` closes it; typing survives closing it. `Save` writes the preset into the layer. `Revert` puts back the saved settings. `Remove` deletes the preset from the layer at once, with no second step: its row goes, or becomes an `inherited` row when the other layer states the same name.
- `Add it` writes an empty preset under the typed name and clears the box. The row appears with `provider defaults`. A name the layer already states is replaced by an empty preset, losing its settings.
- Editing the shared layer with a project open, a preset only the project states is also listed as `inherited`.
- Switching the layer redraws the section from that layer, closes every open preset and drops its unsaved settings; open route cards stay open. Leaving for another section or room closes everything, the disclosure included, and drops unsaved preset settings without a prompt.

## The section keeps its width, and only presets hold unsaved settings

- **Resize.** The section is 780px at most. Fields stack label over box under 380px. A route card's summary ends in an ellipsis on one line. Under a 720px window the call-settings form's rail becomes a sideways-scrolling row of tabs above the fields.
- **Theme.** Bands, tints, dashed and solid edges, chips and fields are tokens with a light and a dark value.
- **Focus.** Tab follows reading order through the tree's rule controls, fields and `Configure` buttons, then each preset's `Configure`, its form and actions, then the disclosure head and `Name`.
- **Unsaved work.** Only an open preset holds settings not yet written. Everything else in the section is written as it changes.

## The section departs from the visual direction in three places

- A preset's name is set in the data face at the app-derived size of the row title rather than a data register.
- Layers not in use around a call are dimmed by opacity.
- Group heads, hints and band titles use size ratios of their own rather than the registers.
