---
id: ui/components/settings-header
type: ui-component
status: shipped
updated: 2026-09-23
realizes: [ux/patterns/inherited-unless-set-here]
serves: [product/share-processes-across-projects, product/bring-your-own-models-and-agents, product/read-comfortably]
surfaces: [ui/surfaces/settings-view, ui/surfaces/settings-appearance, ui/surfaces/settings-connections, ui/surfaces/settings-models, ui/surfaces/settings-tools, ui/surfaces/settings-runs, ui/surfaces/settings-data]
reuses: []
implemented_by: [packages/app/src/renderer/App.tsx, packages/app/src/renderer/panes.tsx, packages/app/src/renderer/settingsLayout.tsx, packages/app/src/renderer/settingsSections.ts, packages/app/src/renderer/layerLabels.ts]
verified_by: [packages/app/test/settingsSections.test.ts]
mockups: [ui/assets/settings-header/layered.html, ui/assets/settings-header/project.html, ui/assets/settings-header/just-you.html, ui/assets/settings-header/nothing-yours.html, ui/assets/settings-header/no-project.html, ui/assets/settings-header/disabled.html]
siblings: [ui/components/segmented-control, ui/components/settings-field, ui/components/provider-row]
---

# Settings header

The layer switch at the top-right corner of a settings page's head: three equal buttons, `Just you`, `This project` and `Shared (all projects)`, the chosen one filled blue. The page's name and its sentence — what the page is for and whose settings these are — sit to its left, and on `Just you` a second choice, `What you changed` · `Every row`, sits under the sentence.

## The switch says which layer a page writes to, and it is always in the same corner

**Use when.** A settings page reads and writes one configuration layer: every page of the Settings room — Appearance, Connections, Models, Tools, Runs and Data & history. One switch serves every page, so the choice of layer is made once for the whole Settings room, and it sits at the head's top-right on every one of them however long the sentence beside it runs.

**Do not use when.** A choice between two readings of the same thing is a [segmented-control](segmented-control.md). Whether one setting is set in this layer is the switch on the setting itself, in [settings-field](settings-field.md). What JaiRA ships is not a segment: the built-in layer is read-only, and a value it holds shows as what a row inherits. When the availability checks last ran is said at the head of the Agents section on [Connections](../surfaces/settings-connections.md), beside its `Re-check`.

## The switch keeps the corner, and the sentence says the same thing in words

- **Switch.** Ghost buttons 4px apart, strongest layer first. The chosen one takes `--fill-accent` with `--on-accent` text at 600 and the sheen; the others stay transparent with a `--line` outline and `--text`. It never wraps under the sentence: the sentence wraps, and the switch keeps its corner 2px below the head's top.
- **No project.** With no project open the switch is `Just you` · `Shared (all projects)`; there is no project layer to choose.
- **Sentence.** Under the page's name: the page's purpose, then whose settings these are — `Showing Just you: kept on this machine in personal-settings.json, never shared, and read after every other layer.`, `Editing {project}; anything left unset comes from ~/.jaira, and yours override both.`, or `Editing ~/.jaira, shared by every project on this machine; a project's own settings override it, and yours override both.`
- **Which rows.** On `Just you` only, a segmented `What you changed` · `Every row` under the sentence. `What you changed` draws only the rows the personal layer states, each with a line saying what it replaces (`instead of 0.8 from Shared`); a section left with none is not drawn, and a page left with none says `Nothing is set just for you on this page. Choose Every row to set something.` under the head. `Every row` draws the page whole.

## Every state keeps the switch's shape and changes which button is filled

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | Cannot occur: every page has a layer. | |
| loading | Cannot occur: the switch draws from the layer already chosen. | |
| partial | Cannot occur: the switch draws whole. | |
| error | Cannot occur in the switch. A page whose settings cannot be read says so under its head. | |
| layered | The default: `Shared (all projects)` filled over Runs, with a project open. | [layered.html](../assets/settings-header/layered.html) |
| project | `This project` filled, and the sentence naming the project. | [project.html](../assets/settings-header/project.html) |
| just you | `Just you` filled, `What you changed` chosen under the sentence, and only the row the personal layer states, saying what it replaces. | [just-you.html](../assets/settings-header/just-you.html) |
| nothing yours | `Just you` on `What you changed` with nothing stated on the page: the one line under the head, and no sections. | [nothing-yours.html](../assets/settings-header/nothing-yours.html) |
| no project | `Just you` · `Shared (all projects)`, the second filled. | [no-project.html](../assets/settings-header/no-project.html) |
| disabled | While a settings change is being written: every button at half strength and inert, and the page's controls with them. | [disabled.html](../assets/settings-header/disabled.html) |

The mockups are rendered from the real components by `packages/app/shots/settings-header-static.mts`.

## A click on a layer re-reads the page

| On | Does | Feedback |
| --- | --- | --- |
| Click an unchosen layer | Makes that layer the one every page reads and writes, for the whole Settings room | The fill moves to that button, the sentence follows, and the page redraws from that layer. Open rows close, and unsaved typing in them is dropped |
| Click the chosen layer | Nothing changes | None |
| Click `What you changed` or `Every row` | Draws only what the personal layer states, or every row | The page redraws in place |
| Pointer over a button | Nothing | The ghost side takes `--fill-ghost-hover`; the filled side deepens to `--fill-accent-hover` |

The layer holds across pages while the app is open. The switch starts on `Shared (all projects)` at launch, and opening a project does not move it. Standing on no project while on `This project` moves it to `Shared (all projects)`; `Just you` and `Shared (all projects)` stay where they are. `Just you` opens on `What you changed` each time a window opens.

## The copy names the layers

| Where | String |
| --- | --- |
| Buttons | `Just you` · `This project` · `Shared (all projects)` |
| Tooltips | `only you, on this machine — personal-settings.json, never shared, and read after every other layer` · `this project only` · `the shared root — changes here affect every project that has not overridden them` |
| Group, announced | `Configuration layer`; the rows choice `Which rows` |
| Rows choice | `What you changed` · `Every row` |
| Sentence | `{purpose} Showing Just you: kept on this machine in personal-settings.json, never shared, and read after every other layer.` · `{purpose} Editing {project}; anything left unset comes from ~/.jaira, and yours override both.` · `{purpose} Editing ~/.jaira, shared by every project on this machine; a project's own settings override it, and yours override both.` |
| Nothing stated | `Nothing is set just for you on this page. Choose Every row to set something.` |
| What a stated row replaces | `instead of {value} from {Shared\|this project\|built in}` · `set nowhere else` |

## The switch holds its corner at every width

- Resize: the switch never shrinks or wraps; the page's name and sentence take what is left beside it.
- Theme: fills, outlines and text are tokens in both themes.
- Focus: each button is a native button with the app's focus outline, first in the page's order. The group is announced as `Configuration layer`, but no button announces that it is the chosen one.
- Long or missing content: the strings are fixed.

## The switch departs from the one-primary rule

- The chosen layer is filled like a primary button, so a page that has its own filled `Save` shows two accent fills at once.
