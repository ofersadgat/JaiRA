---
id: ui/components/model-cascade
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/pick-from-what-exists, ux/patterns/inherited-unless-set-here]
serves: [product/chat-with-agents, product/bring-your-own-models-and-agents]
surfaces: [ui/surfaces/chat-view, ui/surfaces/run-conversation, ui/surfaces/task-context]
reuses: [ui/components/icon]
implemented_by: [packages/app/src/renderer/composer.tsx, packages/app/src/renderer/icons.tsx, packages/app/src/renderer/brands.ts]
verified_by: []
mockups: [ui/assets/model-cascade/in-force.html, ui/assets/model-cascade/grouped.html, ui/assets/model-cascade/filtered.html, ui/assets/model-cascade/empty.html]
siblings: [ui/components/composer-setting-chip, ui/components/context-menu, ui/components/llm-config-form]
---

# Model cascade

Inside the Model card of the composer, a bordered box 208px tall split into columns that open on hover: routes with brand marks and `›`, then for a route that relays other vendors a column of vendors, then a pale column of model names in mono with a green `✓` on the one in force, under two small `IN any` and `OUT any` filter pills at the card's top right.

## A model cascade picks the model and the route that answers for one message

**Use when.** A person chooses which model a message runs on, and through which route: a provider, an agent that runs a vendor's models on a subscription, or a relay of many vendors. It is the only content of the Model [composer-setting-chip](composer-setting-chip.md)'s card.

**Do not use when.** The model is set for a process, a state or an executor: the settings forms take it. The choice is flat and short: a [context-menu](context-menu.md) or the option rows of another chip's card. Model call settings such as sampling belong to [llm-config-form](llm-config-form.md).

## The route column reads first, and each column to its right answers the one hovered

- **Filters.** Out of flow on the card's own title line, 9px from its top and 12px from its right, 6px apart. Each pill has a 1px `--line` edge, is fully rounded and padded 2px by 7px: a label `IN` or `OUT` at 9.5/12.5 of the app size, uppercase with 0.06em tracking in `--tok-hint`, then `any` at 10.5/12.5, or the 11px glyph of each modality chosen. A pill with a choice sits on a 16% `--accent` wash with an `--accent` edge and label.
- **Box.** A 1px `--line` edge with 9px corners, 208px tall whatever it holds, 8px above the card's foot. Columns scroll on their own.
- **Routes.** 148px wide, a 1px `--line` rule on its right, rows 5px by 7px with 7px corners: a 12px brand mark in its brand colour, or a tinted initial for a vendor with no mark, the route's name in the app face at 12/12.5 in `--dim`, and a `›` in `--tok-hint` at the row's end.
- **Vendors.** Only for a route whose models are named as vendor then model: the same rows, 148px wide.
- **Models.** At least 190px on a 45% wash of `--panel-2`: a 10px tick slot then the model's name in the data face at 11.5/12 of the data size, centred in its row. An agent route starts with `default` over `whatever the CLI picks`.
- **Where the pointer is.** The hovered route or vendor, and the vendor shown, sit on a 7% `--text` wash in `--text`.
- **Where the message is.** The route, vendor and model in force sit on a 13% `--accent` wash, and the model has a `✓` in `--ok`, so both stay visible while the pointer wanders.

## Every state keeps the box's height and changes what the right-hand columns hold

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | A route that lists no models of its own and borrows none: the model column holds `this route picks its own model` in `--tok-hint`. | [empty.html](../assets/model-cascade/empty.html) |
| loading | Cannot occur as its own look: the card opens with the routes already known. Before the settings are read the route column is empty and the model column is blank. | |
| in force | The card opens on the route in force, washed, with its models beside it and the current one ticked. An agent route that runs another vendor's models lists `default` first, then that vendor's models. | [in-force.html](../assets/model-cascade/in-force.html) |
| grouped | A relay route hovered: a vendor column between routes and models, the first or hovered vendor washed, and its models in the last column. | [grouped.html](../assets/model-cascade/grouped.html) |
| filtered | A modality chosen: its pill washed and showing the glyph, and every column narrowed to models that take or produce all the chosen modalities. The list of modalities opens below its pill, right-aligned, over the columns, each row a tick slot, a glyph and the modality's name. | [filtered.html](../assets/model-cascade/filtered.html) |
| error | Cannot occur: every offered model is one this machine can reach, and a route with nothing to offer says so as the empty state. | |

## Hovering previews a column and only a click changes the message

| On | Does | Feedback |
| --- | --- | --- |
| Pointer over, or focus on, a route | Shows that route's vendors or models | The columns to the right redraw; the route is washed |
| Pointer over, or focus on, a vendor | Shows that vendor's models | The model column redraws |
| Click a route | Moves the message to the same model on that route when the route has it; otherwise only shows the route | The chip's value and brand mark change, or the columns only redraw |
| Click a model, or `default` | Sets it for this message | `✓` moves, the chip turns `--accent` and names it |
| Click a filter pill | Opens or closes its list of modalities | The list below the pill |
| Click a modality | Adds it to the filter or takes it out | Tick in the list, glyph on the pill, columns narrow |
| Click outside the filter list | Closes it | The list is gone |

## The copy is route, vendor and model names, and three phrases

| Where | String |
| --- | --- |
| Filter labels | `in` · `out`, drawn uppercase · `any` |
| Filter tooltip | `any input` · `any output` · `{input or output}: {modality} + {modality}` |
| Modalities | `{modality}`, such as `image`, `text`, `audio` or `file` |
| Route and vendor rows | `{route}` · `{vendor}` · `›` |
| Agent route first row | `default` over `whatever the CLI picks` |
| Model rows | `{model}`, the id without its route and vendor |
| No models | `this route picks its own model` |

## The box never changes height, so the pointer never loses its row

- The box is 208px tall in every state. A column longer than that scrolls inside itself; the rest of the card does not move.
- Width: route and vendor columns are 148px each and the model column at least 190px, so the card grows to fit two or three columns up to 560px or 78% of the window. The model column's wash stops at its own width and leaves the box's right edge unwashed when the card is wider.
- Names end in an ellipsis within their column.
- Theme: washes and the tick are tokens. Brand marks keep their brand colour in both themes, so a near-black mark is faint on the dark ground.
- Focus: routes, vendors and models are native buttons in Tab order, and focus on a route or vendor opens its columns as hover does. Escape closes the whole card. A filter list closes only on a click outside it.

## The cascade departs from the voices and from centred rows

- Route and vendor names are data set in the app face; only model names take the data face.
- Model names and the modality rows centre their words, where every other option list aligns its words to the left.
