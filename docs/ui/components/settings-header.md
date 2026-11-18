---
id: ui/components/settings-header
type: ui-component
status: shipped
updated: 2026-11-18
realizes: [ux/patterns/inherited-unless-set-here]
serves: [product/share-processes-across-projects, product/bring-your-own-models-and-agents, product/read-comfortably]
surfaces: [ui/surfaces/settings-view, ui/surfaces/settings-appearance, ui/surfaces/settings-connections, ui/surfaces/settings-models, ui/surfaces/settings-tools, ui/surfaces/settings-runs, ui/surfaces/settings-data]
reuses: [ui/components/context-menu]
implemented_by: [packages/universal/src/components/settings/SettingsCrumb.tsx, packages/universal/src/components/Sidebar.tsx, packages/universal/src/components/settings/SettingsPage.tsx, packages/universal/src/app/SettingsView.tsx, packages/app/src/renderer/settingsScope.ts, packages/app/src/renderer/settingsSections.ts, packages/app/src/renderer/layerLabels.ts]
verified_by: [packages/app/test/settingsScope.test.ts, packages/app/test/settingsSections.test.ts, packages/app/test/projectSettingsDoor.test.ts, packages/app/test/settings.test.ts, packages/app/test/federation.test.ts]
mockups: [ui/assets/settings-header/layered.html, ui/assets/settings-header/project.html, ui/assets/settings-header/picker.html, ui/assets/settings-header/no-project.html, ui/assets/settings-header/just-you.html, ui/assets/settings-header/nothing-yours.html, ui/assets/settings-header/machine.html, ui/assets/settings-header/full.html, ui/assets/settings-header/disabled.html]
siblings: [ui/components/segmented-control, ui/components/settings-field, ui/components/provider-row]
---

# Settings header

Whose settings a page edits, said as a path beside the word Settings in the settings sheet's head, and again in words in the page's own head:

```
Settings › atlas › build-01 › Just you › +
```

The path has up to three parts, always in that order: a project, a machine, Just you. Each is optional, and a part left out means "all": no part is Shared — every project, every machine, everyone. It replaced the three-way layer switch (`Just you` · `This project` · `Shared (all projects)`) at the page's top-right corner (the person's design, 2026-11-17).

## The path names one layer, and every page edits it

**Use when.** A settings page reads and writes one configuration layer: every page of the Settings room but About, which reads the machine part only — with a paired machine in the path it is about that machine (its version, and its update track and engine hosting read and written there); otherwise this one. Machines reads the machine part only too: with a paired machine in the path, its first section is that machine's.

**Do not use when.** A choice between two readings of one thing is a [segmented-control](segmented-control.md). Whether one setting is set in this layer is the switch on the setting itself, in [settings-field](settings-field.md). What JaiRA ships is not a part of the path: the built-in layer is read-only, and a value it holds shows as what a row inherits.

The layers a path makes, least to most specific — compared person first, then machine, then project:

| Path | Layer | Kept in |
| --- | --- | --- |
| `Settings` | Shared | `~/.jaira/settings.json`, synced to the person's machines |
| `Settings › atlas` | the project | `atlas/.jaira/settings.json`, committed |
| `Settings › build-01` | the machine | `machine-settings.json` in build-01's shared root, never synced |
| `Settings › atlas › build-01` | the project on that machine | `.jaira/settings.local.json` in atlas's workspace on build-01, ignored by git |
| `Settings › Just you` | Just you | `~/.jaira/personal-settings.json`, synced |
| `Settings › atlas › Just you` | you in the project | `~/.jaira/projects/<repository>/personal-settings.json`, synced to every clone of it on the person's machines; a clone with no remote keeps it on its machine |

A machine with Just you is not a layer: the machines are the person's own. So once a machine is in the path `+` does not offer Just you, and once Just you is in it `+` offers no machine. Just you is more specific than a project on a machine.

## The path reads like a breadcrumb, and `+` adds to it

- **Settings.** The sheet's title, in the app-title register. With a part in the path it is a ghost press, and pressing it goes back to Shared.
- **Crumbs.** Each part after a `›` in `--faint`: its name in the data face at 11.5/12.5, 600, on a 24px ghost press; a paired machine's carries its dot (`--ok` online, `--warn` otherwise). Pressing a crumb keeps the path up to it. Its `×` — shown on hover, always on a touch screen — takes just that part out.
- **`+`.** After the last crumb, a 22px ghost press that opens a [context-menu](context-menu.md) titled `Narrow to`: the projects, then the machines (this one first, noted `this machine`; a paired one `paired`, or `paired · offline`), then `Just you` (noted `your own settings, on every machine of yours`). It lists only kinds the path does not have yet, and only choices that make a layer that exists: with a project in the path, the machines it has a workspace on; with a machine, the projects that have one there. A chosen part takes its place in the order. On a full path `+` is not drawn.
- **Wrapping.** The head grows to wrap a long path; the pills stay at its end.
- **Sentence.** Under the page's name: the page's purpose, then whose settings these are, where they are kept and what overrides them, by the path's own names — `Editing atlas on build-01: .jaira/settings.local.json in that workspace, which git ignores. It overrides the project's and the machine's settings; yours override it.` When the path's layers cannot be read (its machine is offline, its workspace gone) the reason follows in bold.
- **Which rows.** On Just you and on you in a project, a segmented `What you changed` · `Every row` under the sentence. `What you changed` draws only the rows that layer states, each with a line saying what it replaces (`instead of 0.8 from Shared`, `instead of 3 from atlas on build-01`).

## Where a path's layers are read and written

- A project's layers are read and written in its workspace on the machine the path names — else the workspace the shell stands on, else this machine's. Another machine's workspace is reached through the engine, which forwards a request naming it (`Federation.route`).
- A paired machine with no project: its own layers, on it (`config:read` and `config:write` with `machine`, for no project).
- Otherwise this machine's, for the project the shell stands on when it is one of this machine's — so a change shows in the window: a value written is taken out of every stronger layer that states it.
- A machine's own layers are not written through an engine that predates them, which would put them in Just you's file: the page says that machine runs an older JaiRA.

## Every state keeps the path's shape

| State | Rendered as | Mockup |
| --- | --- | --- |
| shared | `Settings › +`: no part, the default at launch. `Settings` is plain while the path is empty. | [layered.html](../assets/settings-header/layered.html) |
| project | `Settings › atlas › +`, and the sentence naming atlas and its `.jaira/settings.json`. Hovered, a crumb shows its `×`. | [project.html](../assets/settings-header/project.html) |
| picking | `+` open under itself: `Narrow to`, then the choices that make a layer — with atlas in the path, only the machines atlas has a workspace on (`desk` · `this machine`, `build-01` · `paired · offline`), then `Just you`. | [picker.html](../assets/settings-header/picker.html) |
| no project | `+` on an empty path in a window with no project: this machine, the paired ones and Just you, no project. | [no-project.html](../assets/settings-header/no-project.html) |
| just you | `Settings › Just you › +`, `What you changed` chosen under the sentence. | [just-you.html](../assets/settings-header/just-you.html) |
| nothing yours | Just you on `What you changed` with nothing stated on the page: one line under the head, and no sections. | [nothing-yours.html](../assets/settings-header/nothing-yours.html) |
| another machine | `Settings › build-01 › +`, its dot `--warn` while it is not online; offline, the sentence ends `build-01 is offline.` in bold and the page's controls are inert. | [machine.html](../assets/settings-header/machine.html) |
| full | `Settings › atlas › build-01`: a project on a machine takes no Just you, so no `+`. | [full.html](../assets/settings-header/full.html) |
| disabled | While a change is being written, the page's controls are at half strength and inert; the path stays pressable. | [disabled.html](../assets/settings-header/disabled.html) |

The mockups (redrawn 2026-11-18) put the settings sheet — the sidebar's panel, its rail left out — beside the page, with the path in the sheet's head; the Runs page under it is the one captured 2026-09-24, with the sentence as `settingsLeadParts` words it now. The crumbs' measures are restated from `SettingsCrumb.tsx` in [settings-header.css](../assets/settings-header/settings-header.css), over the frozen stylesheet and the sidebar's (`../sidebar/sidebar.css`). Seen in a browser, light and dark, served from the repository's root.

## A part chosen re-reads every page

| On | Does | Feedback |
| --- | --- | --- |
| `+`, then a choice | Adds that part, in its place | The crumb appears, the sentence follows, and the page redraws from that layer, read where it lives |
| A crumb | Keeps the path up to it | The crumbs after it go |
| A crumb's `×` | Takes that part out | The path narrows to what is left |
| `Settings`, with a path | Back to Shared | Every crumb goes |
| A project's `⚙` in the sidebar | Settings with that project in the path | `Settings › {project}` |
| A machine in Settings → Machines → Your machines | That machine in the path (Just you, if there, goes) | Machines' first section is that machine's |

The path holds across pages while the app is open, starts at Shared at launch, and opening a project does not move it. A project the window closes, or a machine that is unpaired, leaves the path.

## The copy

| Where | String |
| --- | --- |
| Menu title | `Narrow to` |
| Just you | `Just you`, noted `your own settings, on every machine of yours` |
| A machine's note | `this machine` · `paired` · `paired · {state}` |
| Announced | the row `Whose settings`; `+` `Narrow these settings`; a crumb's `×` `Take {name} out` |
| What a stated row replaces | `instead of {value} from {Shared\|atlas\|build-01\|atlas on build-01\|you\|you in atlas\|built in}` · `set nowhere else` |
| Nothing to read | `Nothing to show: that project has no workspace on that machine.` |

## The path is pressable at every width

- Resize: the path stays on one line in the sheet's head; a crumb's name ellipsizes, and `+` keeps its place at the end.
- Theme: every fill and text is a token in both themes.
- Focus: `Settings`, each crumb, its `×` and `+` are native buttons with the app's focus outline, in that order.
