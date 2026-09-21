---
id: ui/components/settings-header
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/inherited-unless-set-here, ux/patterns/checked-status-with-the-fix]
serves: [product/share-processes-across-projects, product/bring-your-own-models-and-agents]
surfaces: [ui/surfaces/settings-view]
reuses: []
implemented_by: [packages/app/src/renderer/App.tsx, packages/app/src/renderer/panes.tsx]
verified_by: []
mockups: [ui/assets/settings-header/layered.html, ui/assets/settings-header/no-project.html, ui/assets/settings-header/checked.html, ui/assets/settings-header/loading.html, ui/assets/settings-header/disabled.html]
siblings: [ui/components/segmented-control, ui/components/settings-field, ui/components/provider-row]
---

# Settings header

A thin bar across the top of a settings section over a `--line` rule: at the left two equal buttons, `This project` and `Shared (all projects)`, with the chosen one filled blue, or a dim sentence about the shared settings in their place; at the far right a dim `checked 4 min ago` and a ghost `Re-check`.

## The header says which layer a section writes to and how fresh its checks are

**Use when.** A settings section reads and writes one configuration layer, which is Providers, Executors, Toolsets, Configuration and Files, or shows what the provider and agent checks found, which is Providers and Executors. One header serves every such section, so the choice of layer is made once for the whole Settings room.

**Do not use when.** The section holds a person's own preferences, as Appearance and Conversation do, or trims history, as History does: no header is drawn and the section opens on its own content. A choice between two readings of the same thing is a [segmented-control](segmented-control.md). Whether one setting is set in this layer is marked on the setting itself by [settings-field](settings-field.md). A single provider's check result is on its [provider-row](provider-row.md).

## The layer reads first and the check age sits apart at the far end

- **Layer switch.** Two ghost buttons of equal width, 4px apart, growing together to at most 320px. The chosen one takes `--fill-accent` with `--on-accent` text at 600 and the sheen; the other stays transparent with a `--line` outline and `--text`.
- **Third segment.** A section that holds a value JaiRA SHIPS gets a third button, `Built in`, drawn the same way ([decision 0006](../../engineering/decisions/0006-built-in-layer.md)). It is READ-ONLY: choosing it shows what ships, and the section offers the two overrides in place of its own actions. [Toolsets](../surfaces/settings-toolsets.md) is the only such section — the others read `settings.json`, which the built-in layer does not have.
- **No-project sentence.** With no project open the switch is not drawn at all. A sentence in `--dim` at the small app size stands in its place, at least 220px wide, and every mention of this project is gone — except on a section with the third segment, where the switch stays and drops `This project` instead, because `Built in` is still a choice worth making with nothing open.
- **Check age and Re-check.** On Providers and Executors only, pushed to the far end: the age in `--dim` at the small app size, then a ghost `Re-check`, 8px apart.
- **Bar.** Items 10px apart, 10px of space above a 1px `--line` rule, then 4px to the section below.

## Every state keeps the bar's shape and changes what fills its two ends

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | Cannot occur: a section with no layer and no checks draws no header at all. | |
| loading | After `Re-check`: the button reads `checking…` and is disabled until the checks return. The age keeps its old value until then. | [loading.html](../assets/settings-header/loading.html) |
| partial | Cannot occur: the bar draws whole. | |
| error | Cannot occur in the header. A check that cannot run at all is reported by the [error-notice](../surfaces/error-notice.md) and the header returns to `Re-check` with the previous age. What each check found is on its [provider-row](provider-row.md). | |
| layered | A project is open on Configuration or Files: the layer switch alone, with `This project` or `Shared (all projects)` filled. Both variants are drawn. | [layered.html](../assets/settings-header/layered.html) |
| no project | No project is open: the sentence in place of the switch. Providers and Executors still show the age and `Re-check`. | [no-project.html](../assets/settings-header/no-project.html) |
| checked | Providers or Executors with a project open: the switch at the left, the age and `Re-check` at the right. The age reads `not checked yet` until the startup check reports, then `checked just now`, `checked {n} min ago` or `checked {n} h ago`. | [checked.html](../assets/settings-header/checked.html) |
| disabled | While a settings change is being written: both layer buttons and `Re-check` at half strength and inert. | [disabled.html](../assets/settings-header/disabled.html) |

## A click on a layer re-reads the section and a click on Re-check runs the checks

| On | Does | Feedback |
| --- | --- | --- |
| Click the unchosen layer | Makes that layer the one every section below reads and writes, for the whole Settings room | The fill moves to that button and the section redraws from that layer. Open provider rows and preset rows close, and their unsaved typing is dropped |
| Click the chosen layer | Nothing changes | None |
| Pointer over a layer button | Nothing | The ghost side takes `--fill-ghost-hover`; the filled side deepens to `--fill-accent-hover` |
| Click `Re-check` | Runs every provider and agent check again | `checking…`, disabled; then `checked just now` and the rows below take the new results |

The layer holds across sections while the app is open. `Built in` does not: it belongs to the section that offers it, and leaving for another section returns to the layer that was chosen before. It starts on `This project` at launch. Standing on no project switches it to the shared layer, and opening a project again leaves it there.

## The copy names the two layers and the age of the checks

| Where | String |
| --- | --- |
| Layer buttons | `This project` · `Shared (all projects)` · `Built in`, the last only on a section that holds a shipped value |
| Layer tooltips | `this project only` · `the shared root — changes here affect every project that has not overridden them` · `what ships with JaiRA — read-only; it is changed by overriding it in one of the other two` |
| Layer group, announced | `Configuration layer` |
| No-project sentence | `Editing the shared settings, which apply to every project on this machine. Open a project to override them for it.` |
| Check age | `not checked yet` · `checked just now` under a minute · `checked {minutes} min ago` · `checked {hours} h ago` from an hour |
| Button | `Re-check` · `checking…` |

## The bar wraps rather than shrinking, and the age does not count up by itself

- Resize: the bar wraps. The sentence keeps at least 220px and the switch gives up width before its words; on a narrow column the age and `Re-check` wrap onto a second line and stay at its far end.
- The age is worked out when the screen draws and does not advance while the screen sits unchanged.
- Theme: fills, outlines and text are tokens in both themes.
- Focus: `This project`, `Shared (all projects)`, then `Re-check`, each a native button with the app's focus outline. The group is announced as `Configuration layer`, but neither button announces that it is the chosen one.
- Long or missing content: the strings are fixed. A section with nothing for the header to say draws none.

## The header departs from the type registers and from the one-primary rule

- The sentence and the age use a small app size in `--dim` of their own rather than `.app-secondary`.
- The chosen layer is filled like a primary button, so a section below that has its own filled `Save` shows two accent fills at once.
