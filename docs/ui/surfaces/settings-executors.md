---
id: ui/surfaces/settings-executors
type: ui-surface
status: shipped
updated: 2026-09-21
kind: panel
realizes: [ux/patterns/inherited-unless-set-here, ux/patterns/checked-status-with-the-fix, ux/patterns/name-it-where-it-will-live, ux/patterns/absence-is-stated]
serves: [product/bring-your-own-models-and-agents, product/share-processes-across-projects]
components: [ui/components/executor-tree, ui/components/llm-config-form, ui/components/schema-form, ui/components/settings-field]
mockups: [ui/assets/settings-executors/listing.html, ui/assets/settings-executors/nothing-yet.html, ui/assets/settings-executors/editing.html, ui/assets/settings-executors/inherited.html, ui/assets/settings-executors/adding.html, ui/assets/settings-executors/name-refused.html, ui/assets/settings-executors/writing.html, ui/assets/settings-executors/error.html]
siblings: [ui/surfaces/settings-view, ui/surfaces/settings-providers, ui/surfaces/settings-configuration]
---

# Settings executors

The Executors section of the [Settings view](settings-view.md): what actually answers the app's own model calls, drawn as the whole default executor fully expanded, then the named presets of call settings as one editor with two vertical rails of tabs — the presets, then the open preset's sections — beside its fields. It sits under the [settings header](../components/settings-header.md), which picks the layer it writes and re-runs the checks that decide the executor, and it replaces whichever section was shown.

## The default executor reads first, and the presets follow it

- **Column.** At most 780px wide, left-aligned, with 34px between the two groups and 28px under the last.
- **Group head.** Padded 11px at the sides: the group's name at 15/12.5 of the app size and weight 650, then a `--dim` hint at 11/12.5 at most 70 characters wide.
- **The default executor.** The [executor tree](../components/executor-tree.md), every level open: an `OPERATION` band tinted `--tint-accent` with its kind in uppercase `--accent`, then indented levels behind a 2px `--line` rule for `FUNCTIONS`, with its ordered allow and deny rules tinted `--tint-ok` and `--tint-bad`, and `PROMPTS`, holding the `ROUTER` band, its default call settings and one card per route. A route card is dashed while it is `derived` and solid with a green `pinned` chip once something in it is set. Every level ends in a closed `Around …` disclosure for the layers around its calls.
- **Presets.** One bordered box, 8px corners, in three columns: a 172px presets rail, a 146px sections rail, and the detail pane. There is one editor however many presets there are; choosing another preset swaps what it shows.
- **Presets rail.** The outer rail, one step darker than the sections rail (`--panel-2` mixed with 5% `--text`) so the two read as nested. One tab per preset this layer states, then one per preset only the other layer states, closed by `+ preset` in `--tok-hint`. A tab is the preset's name in the data face over a one-line `--dim` summary of its settings, ellipsised; a preset the layer being edited states carries a 6px `--accent` dot after its name. An inherited preset's summary starts `inherited · `, and one with settings not yet saved starts `unsaved · `. The chosen tab takes a `--panel` ground and a `--line` outline.
- **Sections rail and detail.** The [call-settings form](../components/llm-config-form.md) without a box of its own: `Sampling`, `Reasoning`, `Output limits` and `Advanced`, each with its summary, beside the chosen section's fields, which are the form's and unchanged.
- **Actions.** At the foot of the detail pane however short the section is: `Save` filled and `Revert` ghost at the left, and `Remove {name}` ghost in `--bad` at the far end, away from them.
- **Inherited preset.** The same editor with every box and select inert and no `SET HERE` tags. Above the foot, a `--dim` line: an `inherited` chip, `--dim` on `--panel-2` with a 6px dot, then `from {layer}. Nothing here can be changed in this layer until it is overridden.` `Override here`, ghost, is the only action.
- **`+ preset`.** Chosen, the box is two columns: the presets rail and a detail pane titled `A new preset` holding one `Name` [settings field](../components/settings-field.md) drawn by the [schema form](../components/schema-form.md), required, and a filled `Add it`. There is no sections rail until the preset has a name.

## The section shows the tree and presets, what is not there yet, a preset being edited, read or added, or that it cannot read

| State | Surface shows | Mockup |
| --- | --- | --- |
| listing | The whole tree as the checks resolved it, and the presets box opened on the first preset and on `Sampling`, untouched: `Save` and `Revert` inactive. | [listing.html](../assets/settings-executors/listing.html) |
| nothing yet | A `--dim` sentence stands for what is missing in the tree: `Not resolved yet — the startup check has not finished.`, which is the loading look. With no provider, server or agent available, `ROUTES (0)` holds its `--warn` sentence instead of cards. With no preset in either layer the presets rail holds only `+ preset`, chosen, beside the empty `Name` field. All three are drawn. | [nothing-yet.html](../assets/settings-executors/nothing-yet.html) |
| editing | A setting changed and not saved: the field shows it, the section's summary and the preset's tab follow it live, the tab's summary starts `unsaved · `, and `Save` and `Revert` are active. | [editing.html](../assets/settings-executors/editing.html) |
| inherited | A preset only the other layer states, opened read-only on `Reasoning`, with where it comes from and `Override here`. | [inherited.html](../assets/settings-executors/inherited.html) |
| adding | `+ preset` chosen with a name typed and `Add it` active. `Add it` is inactive while the box is empty. | [adding.html](../assets/settings-executors/adding.html) |
| name refused | A name that cannot be used: the box outlined in `--bad` with the reason under it, and `Add it` inactive. | [name-refused.html](../assets/settings-executors/name-refused.html) |
| writing | While a settings change is being written: every rule, field, `Add` and `Remove`, `Save`, `Remove {name}`, `Override here`, `Add it` and the header's buttons at half strength and inert. Both rails, `Revert` and the disclosures still work. | [writing.html](../assets/settings-executors/writing.html) |
| error | The settings cannot be read: `The configuration could not be read.` in `--dim` in place of both groups. | [error.html](../assets/settings-executors/error.html) |
| empty | Cannot occur as a whole: the executor group is always drawn, and an empty preset list opens on `+ preset`. | |

| Where | String |
| --- | --- |
| Group heads | `The default executor` · `Presets` |
| Executor hint | `What every UI-initiated operation uses — starting a task, proposing workflow changes, summarizing a conversation. It is a TREE: an operation executor over a function executor and a router, and the whole of it is below. Nothing here has to be configured: what is shown is DERIVED from what is available, and a change pins only the field you changed, so a provider or agent you set up tomorrow still appears by itself.` |
| Presets hint | `A named set of call settings a state picks with configRef, merged under its own config. A definition is the heavier tool — it chooses the provider and the stack too; a preset is only the settings.`, with `configRef` in the data face |
| Unresolved tree | `Not resolved yet — the startup check has not finished.` |
| No routes | `Nothing can answer a prompt here yet — no provider key, no local server, and no agent that runs. Set one up under Providers and a route appears.` |
| Presets rail | `{name}` · `+ preset`; the dot's tooltip `set in the layer you are editing` |
| Preset summary | `provider defaults`, or `reasoning {effort}`, `{setting} {value}`, `≤{n} tokens` and `+{n} more` joined with ` · `, such as `temperature 0.2 · ≤1200 tokens`; prefixed `inherited · ` or `unsaved · ` |
| Preset actions | `Save` · `Revert` · `Remove {name}` |
| Inherited note | `inherited` `from {layer}. Nothing here can be changed in this layer until it is overridden.`, where `{layer}` is `Shared (all projects)` or `This project` · `Override here`, tooltip `copy this preset into the layer being edited, where it can be changed` |
| New preset | `A new preset` · `A named set of call settings. A name is all it needs — its sections appear once it has one.` |
| Name field | `Name`, required, hint `What a state will write in configRef.`, key `models.presets.<name>` · `Add it` |
| Name refused | `there is already a preset called '{name}'` · `'{name}' is inherited here — open it and choose Override here` · `a name can't contain a dot — it is written as the key models.presets.<name>` |
| Unreadable | `The configuration could not be read.` |

## A person arrives from the settings sheet, and every change except a preset's is written at once

- `Executors` in the settings sheet shows this section with the tree the last check resolved, running no check. `Re-check` in the header resolves it again. The presets open on the first preset, or on `+ preset` when there is none.
- Any change in the tree writes that one value into the layer being edited straight away, with no `Save`. The field gains a `SET HERE` tag and a route it belongs to turns `pinned`.
- Choosing a preset's tab shows it in the editor and keeps the chosen section, so walking the presets on `Reasoning` compares their reasoning. Settings typed into one preset are kept while another is looked at, and its tab says `unsaved`.
- `Save` writes the preset into the layer and the selection stays on it. `Revert` puts back the saved settings. `Remove {name}` deletes the preset from the layer at once, with no second step: the selection moves to the next preset down, the one above when it was the last, and `+ preset` when it was the only one — or stays where it is when the other layer states the same name, where the tab turns inherited.
- `Override here` copies the inherited preset into the layer being edited as it stands. Its tab gains the dot and the editor comes alive on the same section.
- `Add it` writes an empty preset under the typed name; once written, the editor moves to it on `Sampling` with `provider defaults`, and the box is emptied. A name already in the rail is refused rather than replacing that preset, and so is a name with a dot in it.
- After `Add it`, `Remove {name}` and `Override here` the button that was pressed is gone, so the focus goes to the chosen preset's tab.
- Editing the shared layer with a project open, a preset only the project states is also listed as inherited, from `This project`.
- Switching the layer redraws the section from that layer, opens its first preset and drops unsaved preset settings; open route cards stay open. Leaving for another section or room drops unsaved preset settings without a prompt.

## The section keeps its width, and only presets hold unsaved settings

- **Resize.** The section is 780px at most. Fields stack label over box under 380px. A route card's summary ends in an ellipsis on one line. Under a 720px window the two rails become two sideways-scrolling rows of tabs, the presets over the open preset's sections, above the fields; the darker row on top keeps the nesting. A preset's tab is at most 200px wide there, and `+ preset` stays pinned to the end of its row over whatever scrolls under it.
- **Theme.** Bands, tints, dashed and solid edges, chips, rails and fields are tokens with a light and a dark value. The presets rail's ground is mixed from `--text`, so it is a step darker than the sections rail in the light theme and a step lighter in the dark one.
- **Focus.** Tab follows reading order through the tree's rule controls, fields and `Configure` buttons, then the presets rail, the sections rail, the chosen section's controls and the actions. Each rail is one stop, on its chosen tab. Inside a rail `↑` and `↓` choose the previous and next tab and wrap, `Home` and `End` the first and last, and choosing follows the focus; `→` steps from the presets rail to the sections rail and `←` back. Where the rails are rows the pairs swap: `←` and `→` move along a row, `↓` and `↑` between the rows. A focused tab is ringed in `--accent` inside its edge.
- **Unsaved work.** Only presets hold settings not yet written, one draft per preset. Everything else in the section is written as it changes.

## The section departs from the visual direction in three places

- A preset's name is set in the data face at the rail label's app-derived size rather than a data register.
- Layers not in use around a call are dimmed by opacity.
- Group heads, hints and band titles use size ratios of their own rather than the registers.
