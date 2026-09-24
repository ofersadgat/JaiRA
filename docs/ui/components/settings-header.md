---
id: ui/components/settings-header
type: ui-component
status: shipped
updated: 2026-09-23
realizes: [ux/patterns/inherited-unless-set-here]
serves: [product/share-processes-across-projects, product/bring-your-own-models-and-agents]
surfaces: [ui/surfaces/settings-view, ui/surfaces/settings-connections, ui/surfaces/settings-models, ui/surfaces/settings-tools, ui/surfaces/settings-runs, ui/surfaces/settings-files, ui/surfaces/settings-data, ui/surfaces/settings-raw]
reuses: []
implemented_by: [packages/app/src/renderer/App.tsx, packages/app/src/renderer/panes.tsx, packages/app/src/renderer/settingsLayout.tsx]
verified_by: []
mockups: [ui/assets/settings-header/layered.html]
siblings: [ui/components/segmented-control, ui/components/settings-field, ui/components/provider-row]
---

# Settings header

The layer switch at the top-right corner of a settings page's head: two equal buttons, `This project` and `Shared (all projects)`, the chosen one filled blue, with a third, `Built in`, on the one page that holds what JaiRA ships. The page's name and its sentence — what the page is for and whose settings these are — sit to its left.

## The switch says which layer a page writes to, and it is always in the same corner

**Use when.** A settings page reads and writes one configuration layer: every page of the `Project & shared` group — Connections, Models, Tools, Runs, Files, Data & history and `settings.json`. One switch serves every such page, so the choice of layer is made once for the whole Settings room, and it sits at the head's top-right on every one of them however long the sentence beside it runs.

**Do not use when.** The page holds a person's own preferences, as Appearance does: no switch is drawn. A choice between two readings of the same thing is a [segmented-control](segmented-control.md). Whether one setting is set in this layer is the switch on the setting itself, in [settings-field](settings-field.md). When the availability checks last ran is said at the head of the Agents section on [Connections](../surfaces/settings-connections.md), beside its `Re-check`.

## The switch keeps the corner, and the sentence says the same thing in words

- **Switch.** Ghost buttons 4px apart. The chosen one takes `--fill-accent` with `--on-accent` text at 600 and the sheen; the others stay transparent with a `--line` outline and `--text`. It never wraps under the sentence: the sentence wraps, and the switch keeps its corner 2px below the head's top.
- **Third segment.** The page that holds a value JaiRA SHIPS — [Tools](../surfaces/settings-tools.md), for its permission sets — gets a third button, `Built in`, drawn the same way ([decision 0006](../../engineering/decisions/0006-built-in-layer.md)). It is READ-ONLY: choosing it shows what ships, and the page offers the two overrides in place of its own actions. The other pages read `settings.json`, which the built-in layer does not have.
- **No project.** With no project open the switch is not drawn, and the page's sentence says it edits `~/.jaira` and how to override it for one project. On Tools the switch stays, as `Shared (all projects)` and `Built in`, because `Built in` is still a choice worth making with nothing open.
- **Sentence.** Beside the switch, under the page's name: the page's purpose, then `Editing {project}; anything left unset comes from ~/.jaira.` on the project layer, `Editing ~/.jaira, shared by every project on this machine.` on the shared one, or `Showing what JaiRA ships, read-only — override a line in a layer of your own to change it.` on `Built in`.

## Every state keeps the switch's shape and changes which button is filled

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | Cannot occur: a page with no layer draws no switch at all. | |
| loading | Cannot occur: the switch draws from the layer already chosen. | |
| partial | Cannot occur: the switch draws whole. | |
| error | Cannot occur in the switch. A page whose settings cannot be read says so under its head. | |
| layered | A project is open: `This project` or `Shared (all projects)` filled. The mockup draws the switch above a section rather than in a page's head. | [layered.html](../assets/settings-header/layered.html) |
| built in | Tools with `Built in` filled, and the sentence saying it shows what ships. | |
| no project | No switch, except on Tools, where `Shared (all projects)` and `Built in` stand alone. | |
| disabled | While a settings change is being written: every button at half strength and inert. | |

## A click on a layer re-reads the page

| On | Does | Feedback |
| --- | --- | --- |
| Click an unchosen layer | Makes that layer the one every page reads and writes, for the whole Settings room | The fill moves to that button, the sentence follows, and the page redraws from that layer. Open rows close, and unsaved typing in them is dropped |
| Click the chosen layer | Nothing changes | None |
| Pointer over a button | Nothing | The ghost side takes `--fill-ghost-hover`; the filled side deepens to `--fill-accent-hover` |

The layer holds across pages while the app is open. `Built in` belongs to Tools: every other page keeps the layer chosen before it, and Tools is on `Built in` again on return. The switch starts on `This project` at launch. Standing on no project switches it to the shared layer, and opening a project again leaves it there.

## The copy names the layers

| Where | String |
| --- | --- |
| Buttons | `This project` · `Shared (all projects)` · `Built in`, the last only on Tools |
| Tooltips | `this project only` · `the shared root — changes here affect every project that has not overridden them` · `what ships with JaiRA — read-only; it is changed by overriding it in one of the other two` |
| Group, announced | `Configuration layer` |
| Sentence | `{purpose} Editing {project}; anything left unset comes from ~/.jaira.` · `{purpose} Editing ~/.jaira, shared by every project on this machine.`, then `Open a project to override it for one.` with none open · `{purpose} Showing what JaiRA ships, read-only — override a line in a layer of your own to change it.` |

## The switch holds its corner at every width

- Resize: the switch never shrinks or wraps; the page's name and sentence take what is left beside it.
- Theme: fills, outlines and text are tokens in both themes.
- Focus: each button is a native button with the app's focus outline, first in the page's order. The group is announced as `Configuration layer`, but no button announces that it is the chosen one.
- Long or missing content: the strings are fixed.

## The switch departs from the one-primary rule

- The chosen layer is filled like a primary button, so a page that has its own filled `Save` shows two accent fills at once.
