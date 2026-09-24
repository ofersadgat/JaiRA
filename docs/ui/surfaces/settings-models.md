---
id: ui/surfaces/settings-models
type: ui-surface
status: shipped
updated: 2026-09-23
kind: screen
realizes: [ux/patterns/inherited-unless-set-here, ux/patterns/checked-status-with-the-fix, ux/patterns/name-it-where-it-will-live, ux/patterns/fold-to-a-summary-expand-in-place, ux/patterns/absence-is-stated]
serves: [product/bring-your-own-models-and-agents, product/share-processes-across-projects]
components: [ui/components/llm-config-form, ui/components/executor-tree, ui/components/settings-header, ui/components/settings-field, ui/components/schema-form, ui/components/switch]
mockups: []
siblings: [ui/surfaces/settings-view, ui/surfaces/settings-connections, ui/surfaces/settings-tools]
---

# Settings models

The Models page of the [Settings view](settings-view.md): what answers a state that names nothing, and how — the defaults such a state is filled in with, the routes a model id's prefix dispatches to, the named presets of call settings a state picks, and under Advanced the executor tree those are part of. It sits between [Connections](settings-connections.md), which says what is reachable, and [Tools](settings-tools.md).

## Defaults read first, then routes, presets, and the tree folded last

- **Head.** `Models`, the lead `What answers a state that names nothing, and how.` followed by the layer sentence, and the [layer switch](../components/settings-header.md) at the head's top-right.
- **Defaults.** One card of two rows. `Default model`, led by a switch, with a mono box on the right edge that suggests every preset by name (a model field may name one); `Call settings`, across the card, its summary as its sentence, over the [call-settings form](../components/llm-config-form.md) — a rail of `Sampling`, `Reasoning`, `Output limits` and `Advanced`, each with its summary, beside the chosen section's fields. This is the one place the project's default model and call settings are set.
- **Routes.** One route card per route the router derived, as the [executor tree](../components/executor-tree.md) draws them: `{prefix}/…` in bold mono, a one-line summary, a `derived` or `pinned` chip and `Configure`.
- **Presets.** One bordered box in three columns: a presets rail, a sections rail and the detail pane.
  - **Presets rail.** One tab per preset this layer states, then one per preset only another layer states or only JaiRA ships, closed by `+ preset`. A tab is the name in the data face over a one-line `--dim` summary, its model first (`first available: opus · gpt-5.6-terra · reasoning high`); a preset this layer states carries a 6px `--accent` dot. A preset that ships untouched carries a `built in` pill (`cx-src`); this layer's copy of one carries `{layer} · copied from built in`. An inherited preset's summary starts `inherited · `, one with settings not yet saved `unsaved · `. The rail is one step darker than the sections rail, so the two read as nested.
  - **Sections rail.** `Model` first, then the call-settings form's `Sampling`, `Reasoning`, `Output limits` and `Advanced`. `Model`'s summary is the rule and the candidates' short names: `first available: opus · gpt-5.6-terra`, or `not set`.
  - **Model.** One wide row, `Model`, led by its set / not set switch. On, it holds the rule as a segmented control with its one option, `The first available`, pressed, and the sentence `The first model in this list that can run here answers.`; then the candidates through the schema form's list editor, one row per model id in order with ↑ ↓ ✕, each row's box suggesting model ids. Under each row: a `via {route} · {plan}` pill (`cx-src`; the plan is the signed-in account's, `API key`, or `local server`), then `available` in `--ok`, `not available — {why}` in `--bad`, or `not checked yet`; the first available row also carries `picked now` in `--accent`. The list ends in `+ another model`. A candidate list the parser would refuse keeps `Save` inert and says why under the row once nothing is still being typed.
  - **Detail.** The chosen section's fields, with `Save` filled and `Revert` ghost at the foot's left and `Remove {name}` ghost in `--bad` at the far end. On this layer's copy of a built-in preset the far end is `Put back the built-in`, ghost and not red: it deletes the copy.
  - **Built-in preset.** The same editor, editable, with a `built in` chip and `What JaiRA ships. Saving a change copies it into {layer}, where it wins; what ships stays as it is.` over `Save` and `Revert`, and nothing at the far end. Saving writes the preset into the layer being edited.
  - **Inherited preset.** The same editor, editable, with an `inherited` chip and `from {layer}. Saving a change copies it into {layer word}, where it wins.`; its actions are `Save` and `Revert` — the first save IS the copy, and there is no `Override here`.
  - **`+ preset`.** A detail pane titled `A new preset` holding one required `Name` field and a filled `Add it`, and no sections rail until the preset has a name.
- **Advanced.** A closed disclosure, `How a call is dispatched` · `the executor tree, and the layers around each level`. Open, it holds the executor tree: the operation banner, `Functions` with the layers around every function call, and `Prompts` with the router banner and the layers around every routed call. The tree does not repeat what the page already draws: the router says `Its defaults and its routes are the Defaults and Routes sections above.`, and Functions says which functions this executor may reach is on [Tools](settings-tools.md).

Sections stop at 740px.

## The page shows the resolved routes and presets, what is not there yet, a preset being edited, read or added, or that it cannot read

| State | Surface shows |
| --- | --- |
| listing | The defaults, every route as the checks resolved it, the presets box opened on the first preset and on `Model`, untouched, and Advanced closed. |
| nothing yet | `Not resolved yet — the startup check has not finished.` stands in Routes and in Advanced until the check reports, which is the loading look. With no provider, server or agent available, Routes holds its `--warn` sentence instead of cards. With no preset in either layer, the presets rail holds only `+ preset`, chosen. |
| editing | A preset's setting changed and not saved: the section's summary and the tab follow it, the tab reads `unsaved · `, and `Save` and `Revert` are active. |
| inherited | A preset only another layer states, opened editable, saying where it comes from and that saving copies it into the layer being edited. |
| adding | `+ preset` chosen with a name typed and `Add it` active; `Add it` is inactive while the box is empty. |
| name refused | A name that cannot be used: the box outlined in `--bad` with the reason under it, and `Add it` inactive. |
| writing | While a settings change is being written: every switch, box, route field, preset action and `Add it` at half strength and inert. Both rails, `Revert`, `Configure` and the disclosures still work. |
| error | The settings cannot be read: `The configuration could not be read.` in `--dim` in place of the page's sections. |
| empty | Cannot occur as a whole: Defaults is always drawn, and an empty preset list opens on `+ preset`. |

| Where | String |
| --- | --- |
| Section heads | `Defaults` · `Routes` · `Presets` · `Advanced` |
| Defaults, behind `ⓘ` | `What a state that names nothing is filled in with — the same fields a state's own environment block carries, one level out. Applied under whatever a state says, so naming a field there always wins.` |
| Default model | `Default model`, sentence `A model id, or a preset's name — 'coder' means the model coder chooses.`, key `executors.default.prompt.defaults.model`, placeholder `a model id, or a preset` |
| Call settings | `Call settings`, its sentence the summary: `provider defaults`, or the settings joined with ` · ` |
| Routes, behind `ⓘ` | `Where a model id's prefix sends a call — claude-cli/… to the CLI agent, anthropic/… to the API. Derived from everything available, so a provider or agent you set up appears here by itself; configuring one pins only what you changed.` |
| No routes | `Nothing can answer a prompt here yet — no provider key, no local server, and no agent that runs. Set one up under Connections and a route appears.` |
| Unresolved | `Not resolved yet — the startup check has not finished.` |
| Presets, behind `ⓘ` | `A named model and set of call settings a state picks with configRef, merged under its own config — simple, coder and planner ship built in, and editing one saves your copy in this layer. A model field (the default model, the judge) may name a preset too. A definition is the heavier tool — it chooses the provider and the stack too.` |
| Presets rail | `{name}` · `+ preset` · `built in` · `{layer} · copied from built in`; the dot's tooltip `set in the layer you are editing` |
| Model | `Model`, sentence `Which model a state that picks this preset runs on — chosen when its conversation starts, and kept for the rest of it.` · `The first available` · `The first model in this list that can run here answers.` · `via {route} · {plan}` · `available` · `not available — {why}` · `not checked yet` · `picked now` · `+ another model` |
| Preset actions | `Save` · `Revert` · `Remove {name}` · `Put back the built-in` |
| Built-in note | `built in` `What JaiRA ships. Saving a change copies it into {layer}, where it wins; what ships stays as it is.` |
| Inherited note | `inherited` `from {layer}. Nothing here can be changed in this layer until it is overridden.` |
| New preset | `A new preset` · `A named set of call settings. A name is all it needs — its sections appear once it has one.` · `Name`, hint `What a state will write in configRef — one word, since a model field may name it too.` · `Add it` |
| Name refused | `there is already a preset called '{name}'` · `'{name}' is inherited here — open it and edit it, and the edit is saved here` · `'{name}' ships built in — open it and edit it, and the edit is saved here` · `a preset's name is a word — letters, digits and _, starting with a letter — so it can never be read as a model id, which always has a - / . or :` · `'{name}' reads as a model id of the {family} family, so a model field naming it would be ambiguous` |
| Advanced | `How a call is dispatched` · `· the executor tree, and the layers around each level`; behind `ⓘ`, `The default executor as the tree it is: an operation executor over a function executor and a router, and the layers wrapped around each. …` |
| In the tree | `Its defaults and its routes are the Defaults and Routes sections above.` · `Which functions this executor may reach is Settings → Tools → Functions, the available column.` |
| Unreadable | `The configuration could not be read.` |

## A person arrives from the sidebar, and every change except a preset's is written at once

- `Models` in the sidebar shows this page with the tree the last check resolved, running no check.
- A default, a route field or a tree field writes that one value into the layer being edited straight away, with no `Save`; a route it belongs to turns `pinned`. A row's switch off removes the value, so it is derived or inherited again.
- A preset is edited as a draft: choosing another preset keeps the draft and its tab says `unsaved`; `Save` writes it; `Revert` puts back the saved settings; `Remove {name}` deletes it at once and moves to the next preset down. Saving an inherited or built-in preset copies it into this layer. `Add it` writes an empty preset under the typed name and opens it on `Sampling`.
- Switching the layer redraws the page from that layer, opens its first preset and drops unsaved preset settings. Leaving the page drops them without a prompt.

## The page keeps its width, and only presets hold unsaved settings

- **Resize.** Sections stop at 740px. Rows stack label over box under 380px. A route card's summary ellipsises on one line. Under a 720px window the two preset rails become two sideways-scrolling rows of tabs above the fields.
- **Theme.** Chips, route edges, rails and fields are tokens in both themes; the presets rail's ground is mixed from `--text`, a step darker than the sections rail in the light theme and a step lighter in the dark one.
- **Focus.** Nothing takes focus on entry. Tab follows reading order: the defaults, the route cards' `Configure`, then the presets rail, the sections rail, the chosen section's controls and the actions, then the Advanced disclosure. Each rail is one stop; `↑` and `↓` move within it and `→` steps from the presets rail to the sections rail.
- **Unsaved work.** Only presets hold settings not yet written, one draft per preset.

## The page departs from the visual direction in two places

- A preset's name is set in the data face at the rail label's app-derived size rather than a data register.
- Layers not in use around a call are dimmed by opacity.
