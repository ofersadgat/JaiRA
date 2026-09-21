---
id: ui/components/llm-config-form
type: ui-component
status: shipped
updated: 2026-09-21
realizes: [ux/patterns/inherited-unless-set-here, ux/patterns/refuse-with-the-reason-and-the-fix]
serves: [product/bring-your-own-models-and-agents, product/share-processes-across-projects]
surfaces: [ui/surfaces/settings-configuration, ui/surfaces/settings-executors]
reuses: [ui/components/settings-field]
implemented_by: [packages/app/src/renderer/llmConfigForm.tsx, packages/app/src/renderer/schemaForm/widgets/LlmConfigWidget.tsx]
verified_by: [packages/app/test/llmConfigForm.test.ts, packages/app/test/presetTabs.test.ts]
mockups: [ui/assets/llm-config-form/empty.html, ui/assets/llm-config-form/set.html, ui/assets/llm-config-form/reasoning-on.html, ui/assets/llm-config-form/conflict.html, ui/assets/llm-config-form/error.html, ui/assets/llm-config-form/disabled.html]
siblings: [ui/components/schema-form, ui/components/executor-tree, ui/components/settings-field]
---

# LLM config form

A bordered two-pane box: a grey rail at the left listing `Sampling`, `Reasoning`, `Output limits` and `Advanced`, each with a one-line summary such as `provider defaults` or `4000 tokens · 1 stop`, and at the right the chosen category's title, hint and setting rows.

## The form edits the settings a model call is made with, one category at a time

**Use when.** A place stores provider-neutral call settings: sampling, reasoning effort or budget, output limits, and passthrough keys. It is drawn under Configuration's default environment, under the executor tree's default call settings and each route's call settings, and as the editor of the chosen preset on Executors, where it is drawn without its box inside the presets' own. A schema that declares a value of this kind draws the same form.

**Do not use when.** The value is the model id itself: that is a separate field above the form. The settings are an executor's retry, memoize, rate-limit or deadline layers: those are [schema-form](schema-form.md) cards in [executor-tree](executor-tree.md). A single setting stands alone: use [settings-field](settings-field.md).

## The rail summarises every category and the detail pane edits the chosen one

- **Box.** 1px `--line` border, 8px corners, `--panel` ground; a 168px rail beside the detail pane.
- **Rail.** A list of tabs beside the one panel they choose. `--panel-2` ground with a `--line` rule on its right, 6px padding, items 2px apart. Each item is the category's name at 550 in `--dim` over its summary at a small size in `--dim`, ellipsised. The chosen item takes a `--panel` ground and a `--line` outline, and its name turns `--text`.
- **Detail.** 13px by 15px padding and 12px gaps: the category's title at 600, its hint in `--dim`, then [settings-field](settings-field.md) rows, each ending its hint with the key it writes and carrying a `SET HERE` tag when the value is stated.
- **Unset.** An empty box means the setting is not stated and the provider's own default applies; number boxes show `—` and are at most 120px wide.
- **Host's parts.** A host may draw the rail and the detail pane without the box, inside a box of its own that holds something else first; may put its own notes and actions at the foot of the detail pane; may keep the chosen category itself; and may switch the `SET HERE` tags off for a value that belongs to another layer. The presets on [Settings executors](../surfaces/settings-executors.md) do all four.
- **Notice.** A `--tint-warn` block with `--warn` text, 7px by 9px, where a category cannot be used or holds keys it must not.

## Every state keeps the rail and changes the summaries and the detail pane

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | Nothing is stated: summaries `provider defaults`, `off`, `no limits` and `none`, and every box shows `—`. Drawn on Configuration with the default model field above it and the summary line below. | [empty.html](../assets/llm-config-form/empty.html) |
| loading | Cannot occur: the form draws from a value its host already holds. | |
| partial | Cannot occur as its own look: a value with some categories stated is the set state. | |
| set | Stated values carry `SET HERE` and the rail summaries name them, such as `temperature`, `4000 tokens · 1 stop` and `1 extra`. | [set.html](../assets/llm-config-form/set.html) |
| reasoning on | An effort or a budget is stated: the Sampling summary reads `not applicable — reasoning is on` and its pane holds the notice in place of the six boxes. | [reasoning-on.html](../assets/llm-config-form/reasoning-on.html) |
| conflict | Reasoning is on and sampling keys are also stated: under the reasoning fields a notice names the keys, with a ghost `Clear the sampling knobs`. | [conflict.html](../assets/llm-config-form/conflict.html) |
| error | Advanced text that is not a JSON object: `not saved — {reason}` in `--warn` under the box, and the value keeps what it had. | [error.html](../assets/llm-config-form/error.html) |
| disabled | The host is locked: every box and select at 55% strength. The rail still switches categories. | [disabled.html](../assets/llm-config-form/disabled.html) |

## Each change writes into the value at once, and the host decides when it is saved

| On | Does | Feedback |
| --- | --- | --- |
| Pointer over a rail item | Nothing | A `--line` outline |
| Click a rail item | Shows that category | The item takes the chosen ground and the detail pane swaps |
| `↑` `↓` `Home` `End` on a rail item | Chooses the previous, next, first or last category, wrapping, and moves the focus with it | As a click. Where the rail is a row, `←` and `→` do this instead |
| `→` `←` on a rail item | Moves the focus to the chosen item of the rail beside this one in the same box, when a host has put one there | Nothing, with no other rail. Where the rails are rows, `↓` and `↑` do this instead |
| Type in a number box | Writes the number into the value; an emptied box removes the key | `SET HERE` appears or goes and the rail summary follows. `0.` stays while typing; text that is not a number writes nothing and the box empties when it loses focus |
| Choose an effort | States the effort; `— inherit` removes it | The Sampling summary turns to `not applicable — reasoning is on` |
| Type stop sequences | Splits the text on commas into the list; empty removes it | The limits summary counts them. The box redraws from the list, so a comma typed at its end disappears at once |
| Click `Clear the sampling knobs` | Removes every sampling key | The notice goes |
| Type in `Other settings` | A JSON object replaces every key the form has no control for; empty removes them all | A problem shows `not saved — {reason}` under the box |

Configuration and the executor tree write each change to the layer as it is made. The presets hold the change as a draft, one per preset, until `Save`. The chosen category is not kept: the form opens on `Sampling` each time it is drawn, unless its host keeps the category, as the presets do across the presets they show.

## The copy says what each knob does and why a category is closed

| Where | String |
| --- | --- |
| Categories and hints | `Sampling` · `How the model picks its next token. A reasoning model rejects these outright, so they are only offered while reasoning is off.` · `Reasoning` · `How hard to think, as an effort level and/or a token budget. Provider-neutral: it is adapted to each provider's own shape at the call.` · `Output limits` · `How long an answer may run, and what ends it.` · `Advanced` · `Anything this form has no dedicated control for. Editable as JSON so a setting is never silently dropped.` |
| Summaries | Sampling `provider defaults`, `{keys joined by " · "}` or `not applicable — reasoning is on` · Reasoning `off`, `{effort}` or `{n} tokens` · Output limits `no limits` or `{n} tokens · {k} stop` · Advanced `none` or `{n} extra` |
| Sampling fields | `Temperature` · `Top-p` · `Top-k` · `Presence penalty` · `Frequency penalty` · `Seed` |
| Reasoning fields | `Effort`, choices `— inherit`, `low`, `medium`, `high`, `xhigh` · `Thinking budget` |
| Output limit fields | `Max output tokens` · `Max tool steps` · `Stop sequences` |
| Advanced field | `Other settings` with hint `Everything with no dedicated control above — provider passthroughs, and anything newer than this form. Kept exactly as written.`, key `(any)` and example `{ "providerOptions": { "anthropic": { "cacheControl": true } } }` |
| Field hints, examples | `Higher is more varied, lower more repeatable. Empty inherits the provider's default.` · `A ceiling on the answer's length — the main lever on the cost of one call. Empty means the model's own maximum.` · `A level rather than a number of tokens, so it means the same thing across providers. A provider that tops out lower clamps rather than refusing.` |
| Reasoning-on notice | `Reasoning is on, and a model is sampling or reasoning — never both. The sampling knobs are refused by a reasoning endpoint, so they are not offered here. Turn reasoning off to use them.`, with `or` in italics |
| Conflict notice | `This configuration also sets {keys}, which a reasoning endpoint refuses. Clear them, or turn reasoning off.` and `Clear the sampling knobs` |
| Advanced problem | `not saved — {reason}` · `not saved — must be a JSON object` |
| Empty box | `—` |

## The rail folds above the detail in a narrow window and the rows stack in a narrow box

- Resize: the box takes its host's width. In a window narrower than 720px the rail becomes one horizontally scrolling row of items above the detail pane; the rule follows the window, so a narrow host in a wide window keeps the side rail. Setting rows stack into one column in a detail pane narrower than 380px. Summaries ellipsise.
- Theme: grounds, outlines and the notice are tokens in both themes.
- Focus: the rail is one stop, on the chosen item; its items are tabs announcing which is selected, and the detail pane is their panel. Then the chosen category's controls in order. A focused item is ringed in `--accent` inside its edge, because the box clips what is drawn outside it.
- Long or missing content: a long summary ellipsises in the rail; a stated key the form has no control for is never dropped and is counted under `Advanced`.

## The rail departs from the type registers

- Rail names at weight 550, and every size in the box is a ratio of its own rather than a register.
