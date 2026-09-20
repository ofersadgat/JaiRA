---
id: ui/components/address-bar
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/drill-in-and-back-out, ux/patterns/live-facts-and-unseen-counts, ux/patterns/problems-marked-where-they-are, ux/patterns/nested-under-what-caused-it, ux/patterns/context-beside-what-you-stand-on]
serves: [product/keep-track-of-everything, product/all-projects-in-one-place, product/see-what-changed-since-you-looked, product/complete-record-of-every-run, product/watch-agents-work-live, product/catch-process-mistakes-before-running]
surfaces: [ui/surfaces/app-window, ui/surfaces/tasks-view, ui/surfaces/files-view, ui/surfaces/task-context]
reuses: [ui/components/context-menu, ui/components/status-pill, ui/components/segmented-control]
implemented_by: [packages/app/src/renderer/crumbs.tsx, packages/app/src/renderer/taskBar.tsx, packages/app/src/renderer/files.tsx, packages/app/src/renderer/runViews.tsx]
verified_by: [packages/app/test/trail.test.ts]
mockups: [ui/assets/address-bar/empty.html, ui/assets/address-bar/listing.html, ui/assets/address-bar/walked.html, ui/assets/address-bar/files.html, ui/assets/address-bar/alternatives-open.html, ui/assets/address-bar/subagent-walk.html]
siblings: [ui/components/segmented-control, ui/components/project-row, ui/components/file-tree, ui/components/instance-index]
---

# Address bar

One row of path segments across the top of the window: a hue-washed mono project name or a sans `All projects`, grey mono folders, blue mono states and `▸`-marked run names, joined by `›` marks that open a menu of what else stands at that level, with pills, problem chips and view tools at the right end.

## One bar says where the person stands in Tasks, in Files and inside a subagent walk

**Use when.** A view shows one level of a hierarchy and every level above it must stay one step away: the Tasks view's project, process levels and runs; the Files view's folders, state files and runs. A context panel walking into subagent conversations draws the small row form.

**Do not use when.** The Chat view names one conversation, which has no path. To list a run's states for jumping between them, use [instance-index](instance-index.md). To pick a project or a file from everything open, use [project-row](project-row.md) or [file-tree](file-tree.md). Switching between two readings of the same run is [segmented-control](segmented-control.md), which the bar hosts at its right end.

## The head of the path reads first, the current level last and the facts about it at the far end

- **Ground.** `--panel` with a 1px `--line` hairline under it, 7px by 12px inset, 3px between segments. In the window's title row the bar takes only its content's width and shares the row's hairline; the rest of the row is where the window is dragged.
- **Project.** The project's directory name in mono at 500 in `--text`, on an 18% wash of the project's hue with a 5px hue dot and 4px corners. Open projects cycle through `--p1`, `--p2` and `--p3`; the shared root and JaiRA's own project take `--p0`. With no project to stand on, the head is `All projects` in the app face at 600, with no wash and no dot.
- **Folders.** Mono in `--dim`, from the layer root `.jaira` or `~/.jaira` down.
- **States.** Mono in `--accent`: the process levels in Tasks, and the segments under `workflows/` in Files. A level shows the state's label where it has one, else the last part of its id.
- **Runs.** The app face in `--text`, prefixed `▸ ` in `--dim`, one per run walked into. The first names the task; each deeper one names its pass.
- **Current level.** The last segment at 600, not clickable, in its family's colour. A run as the last segment sits on `--panel-2` with 5px corners.
- **Joins.** A plain `›` in `--dim` where the level has nothing beside it, and a small borderless `›` button where it has. The first segment carries a join only when it has alternatives.
- **Far end.** Tasks while listing: the project's [status-pill](status-pill.md) counts right after the path. Files on a state file: the state's label in `--dim` app text, then `{n} error` and `{n} warning` outline chips in `--bad` and `--warn`. Last, the tools: the reading switch where a run has two readings, and in Tasks `+ New task` on the current project.
- **Panel row.** In a context panel a subagent walk is its own row of small app-face words in `--dim` over a `--rule` hairline, the last word in `--text`. It wraps.

## The bar keeps one shape and changes which segments it carries

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | Tasks with no project open: `All projects` bold and not clickable, with a `›` button whose menu offers `Open another project…`. Files with nothing open draws no bar. | [empty.html](../assets/address-bar/empty.html) |
| loading | The first run segment shows the declaring state's label italic in `--dim` while the task's computed title settles, drawn as the second bar of the walked mockup. | [walked.html](../assets/address-bar/walked.html) |
| partial | Cannot occur: every segment comes from what is already read, and a level whose only member is itself shows a plain `›` instead of a one-item menu. | |
| error | Cannot occur for the bar itself: a failed read leaves the path as it was. Problems in an open state file are counted in chips, drawn in the files row. | |
| listing | Tasks showing every project: the head names the project scrolled to and is clickable, with its pills after it. Each project group after the first opens with the same bar at full width, with a `--line` hairline above; it scrolls away and the title row takes its name. | [listing.html](../assets/address-bar/listing.html) |
| walked | Tasks narrowed to one project and drilled into levels and runs: project, blue levels, `▸` runs, and the reading switch in the tools. | [walked.html](../assets/address-bar/walked.html) |
| files | A folder open ends on a bold grey folder. A state file ends on a bold blue state, then its label, its problem chips and, for a state with children, the reading switch. | [files.html](../assets/address-bar/files.html) |
| alternatives open | The chevron turns to `⌄` in `--accent` on `--panel-2` with a `--line` edge, and a [context-menu](context-menu.md) under it lists the level's members, the current one set at 600 behind an `--accent` dot, with a dim note where the member has one. | [alternatives-open.html](../assets/address-bar/alternatives-open.html) |
| subagent walk | A subagent's run segment reads `⑂ {description}` and has no chevron. In a context panel the same kind of walk is the small row `Conversation › ⑂ {description}`. | [subagent-walk.html](../assets/address-bar/subagent-walk.html) |

## Every segment goes to its level, and every chevron goes sideways

| On | Does | Feedback |
| --- | --- | --- |
| Pointer over a segment | Nothing | Folder turns `--text` on `--panel-2`; state and `All projects` gain `--panel-2`; run gains `--panel-3`; the project wash deepens to 30% |
| Click the project, Tasks listing | Narrows the column to that project | Only that project's board remains and the pills leave the bar |
| Click the project, Tasks narrowed and drilled | Goes back to the project's process roots | The level segments go |
| Click a level | Opens that level; the last level while a run is walked leaves the walk | The deeper segments go |
| Click a folder, Files | Opens the folder's listing | The path ends on that folder |
| Click a state, Files | Opens the state's file, or its folder where no file exists | The path ends there |
| Click a run | Walks back to that run | The deeper run segments go |
| Click a chevron | Opens the level's alternatives; a second click closes them | `⌄`, and the menu under it |
| Choose an alternative | A project narrows to it; `All projects` lists every project; `Open another project…` starts opening one. At the first run, another task at the level is selected. At a deeper run, that sibling replaces the level and every level below it goes. In Files, the folder, state or file opens | The path is rebuilt |
| Click the pills, Tasks listing | Marks that project's ended work seen | Outcome pills clear; `▶` and `⏸` stay |
| Click the bar's empty ground, Files | The context panel goes back to describing the end of the address | The panel switches |
| Click `Conversation` or an earlier word in the panel row | Leaves the subagent walk, or cuts it back to that word | The panel shows that conversation |

## The copy is the path in its own names, with app words only for levels JaiRA names

| Where | String |
| --- | --- |
| Tasks head | `{project directory name}` · `All projects` |
| Tasks head tooltip | `{project path}` · `every project this window can see` |
| Tasks head menu | `All projects` · `{project}` with note `{n} task` or `{n} tasks`, then ` · {n} running` · `Open another project…` |
| Level | `{state label}` or `{last part of the state id}`; tooltip `{state id}` |
| Files root | `.jaira` · `~/.jaira`; bar tooltip and menu note `this project` · `shared`; the menu ends with `Open another project…` |
| Files folder menu | `{folder}` with note `folder` · `{last part of a state id}` · `{file name}` |
| Files far end | `{state label}` · `{n} error` · `{n} warning`, never plural |
| First run | `{task name}` with the state's own id cut from its start, or `#{last 8 characters of the run id}` |
| Deeper run | `{pass label or child key}` or `#{last 8 characters of the run id}` |
| Subagent run | `⑂ {description}` · `⑂ subagent` |
| Run tooltip | `{task name} — run #{id} of {state id}` · `run #{id} of {state id}` · `subagent conversation in run #{id} of {state id}` |
| Run menus | first run: `{task name}` with note `{active state id}` or `{status}`; deeper: `{pass name}` with note `{status}` in words, such as `waiting for user`. Replaced passes are left out |
| Chevron tooltip | `what else is at this level` |
| Fallback tooltip | `back to this run` · `open this state` |
| Pills | tooltip `mark these seen`; each pill `{n} {kind}`; overflow `+{n}` with tooltip `{n} more` |
| Tools | `Tasks` · `Conversation` · `+ New task` |
| Panel row | `Conversation` · `⑂ {description}`, or the call id where the call has no description |

## The bar never wraps and gives up segment width before its facts

- Folder and state segments ellipsise past 220px, the project past 240px and runs past 190px. The state label at the far end ellipsises; chips and tools keep their width.
- Pills get 220px. What does not fit folds into one `+{n}` in the colour of the most serious kind it hides, and `▶` is never folded.
- Theme: every colour is a token and the project wash is mixed from its hue, so both themes keep each project's pairing.
- Focus: segments and chevrons are native buttons in the tab order with the app's focus outline; the current segment is plain text. An open menu takes no focus and no arrow keys, so an alternative is chosen by pointer. Pills are not reached by Tab, and no key walks back.
- Missing content: a state with no label shows no label at the far end; a project with nothing running, waiting or unseen shows no pills; a run with no name shows its short id.

## Run names, the state label and the problem counts leave the data face

- Run segments set task and pass names, which are data, in the app face.
- The state label and the `{n} error` and `{n} warning` counts at the far end are in the app face.
- The panel row sets subagent descriptions in the app face.
- Segments carry sizes of their own instead of the ten registers.
