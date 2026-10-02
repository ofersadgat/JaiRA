---
id: ui/components/environment-bar
type: ui-component
status: shipped
updated: 2026-10-02
realizes: [ux/patterns/pick-from-what-exists, ux/patterns/live-facts-and-unseen-counts, ux/patterns/absence-is-stated, ux/patterns/say-what-it-is-doing-and-for-how-long]
serves: [product/chat-with-agents, product/parallel-work-without-collisions, product/nothing-stalls-in-silence]
surfaces: [ui/surfaces/chat-view]
reuses: [ui/components/machine-icon, ui/components/icon, ui/components/composer]
implemented_by: [packages/universal/src/components/chat/EnvironmentBar.tsx, packages/universal/src/components/chat/environment.ts, packages/app/src/renderer/environmentModel.ts, packages/app/src/renderer/environmentStore.ts]
verified_by: [packages/app/test/environmentModel.test.ts, packages/app/test/environment.test.ts, packages/app/shots/chat-placement.mts, packages/client/src/specimens/environmentSpecimens.tsx#environment-bar, packages/client/src/specimens/environmentSpecimens.tsx#environment-list]
mockups: [ui/assets/environment-bar/default.html, ui/assets/environment-bar/list.html, ui/assets/chat-view/where-list.html]
siblings: [ui/components/composer, ui/components/composer-setting-chip, ui/components/placement-summary]
---

# Environment bar

A shallow tray tucked under the composer, in a faint accent wash with a hairline edge: on its left a machine's icon and `machine / workspace`, on its right a branch, `↑2`, `+128 −34` and a merge request.

## The bar states the shell environment a conversation runs in

**Use when.** A conversation is typed into: the box that starts one and the box that replies in one, in the Chat room. It answers where the agent's commands run: which machine, which folder, which branch, with what unpushed and uncommitted, under which merge request.

**Do not use when.** The message's own settings are chosen: model, thinking, permissions and tools are the [composer-setting-chip](composer-setting-chip.md)s inside the composer. A task card says where it runs with its machine chip.

## The machine and workspace read on the left and the checkout on the right

- **Tray.** The composer's width. Its top lies 22px under the composer's ring, behind it, so it reads as part of the box. Padding 28px above, 16px at the sides, 6px below; a 1px `--line` edge on every side but the top; 20px bottom corners; a 3% wash of `--accent` over `--panel`. The app face at 11.5/12.5 in `--dim`.
- **Machine.** The [machine-icon](machine-icon.md) at 16px, then the machine's name in `--text`: `this machine` for the machine the engine is on, another machine's own name, or `automatic` with the dashed screen while nothing is chosen. A 12px chevron follows while the list can be opened.
- **Workspace.** After a `/` at 45% opacity: a 13px folder and the workspace's folder name in `--text`. Where no workspace is decided, the same place says what stands instead, in `--dim`: `the first of {n} workspaces with room`, a turning spinner and `choosing a workspace`, or a clock and what it waits for.
- **Checkout.** Pushed to the right edge, only once a workspace is decided: a 13px branch glyph and the branch in `--text`; `↑{n}` for commits not pushed; `+{a}` in `--ok` and `−{d}` in `--bad` for lines changed since the last commit; a 1px by 13px `--rule`; the forge's mark at 12px, the request's number in `--text` and its state in its tone. Counts are tabular. A count of zero is left out.

## The bar follows the conversation from a choice to a fact

| State | Rendered as | Mockup |
| --- | --- | --- |
| empty | Nothing chosen: the dashed screen, `automatic`, a chevron, and `the first of {n} workspaces with room`. The right is empty. | [default.html](../assets/environment-bar/default.html) |
| loading | Until the engine has answered where the project can run, the bar is not drawn and the composer keeps its own foot. | |
| partial | A machine chosen: its icon and name, and `the first of {n} workspaces with room`; a machine with one workspace names that workspace and shows its checkout. A workspace chosen: the machine, the folder, the checkout. | [default.html](../assets/environment-bar/default.html) |
| placing | While the conversation's workspaces are asked for the first time: the choice's machine, a spinner and `choosing a workspace`. The bar opens nothing. | [default.html](../assets/environment-bar/default.html) |
| waiting | Nothing it may run on has room: the choice's machine, a clock and `waiting for a workspace with room`, `waiting for room on {machine}` or `waiting for room in {workspace}`. The list still opens, and a choice made there changes what the conversation waits for. | [default.html](../assets/environment-bar/default.html) |
| success | Running: the machine, the workspace and its checkout, with no chevron. The checkout is read again when a run, a turn or a call ends in that workspace. | [default.html](../assets/environment-bar/default.html) |
| error | A machine that cannot be reached keeps its place with its dot in `--warn` or `--bad`. A workspace the project no longer holds is named from the record of where the conversation was placed, with no checkout. | |

A project with one workspace has nothing to choose: the bar names that workspace from the start and never opens.

## The list offers automatic, a machine, or one workspace

The list opens under the machine it was opened from, start edges aligned, 10px away, and flips above where there is more room. It is 690px wide, or the window less 32px, on `--panel` with a 1px `--line` edge, 12px corners and the lifted shadow.

- **Automatic.** The dashed screen at 18px, `Automatic` at weight 600, and under it `the first workspace with room, in this project's order` in `--dim`.
- **A machine's block.** One per machine, in the order tasks are placed, each under a `--line` rule. Its line: the icon at 18px, the name at weight 600, what it is in `--dim` (`Windows desktop`, `Mac mini`, `Linux server`), and at the right its two meters. Choosing the line sends the conversation to that machine's first workspace with room.
- **Meter.** A label, a 44px by 5px track in `--panel-2` filled in `--accent`, and the figure. From 90% the fill and the figure are `--warn`. `CPU` is the share of the processor working; `Memory` is the share in use.
- **A workspace's line.** Under its machine: a 26px slot holding the work ring when tasks run or wait there, a folder and the folder's name, and at the right its checkout, written as the bar writes it. Choosing the line sends the conversation to that workspace and no other.
- **The choice.** A 10% wash of `--accent` over `--panel` and a `✓` in `--accent` at the row's end. A chosen machine's line reads `any workspace · the first with room` in place of what it is.
- **Out of reach.** A machine that is connecting or offline is listed with its name in `--dim`, `connecting…` in `--warn` or `offline` in `--bad` in place of its meters, its workspaces at 55% opacity, and none of its rows can be chosen.

| On | Does | Feedback |
| --- | --- | --- |
| The machine, while a chevron shows | Opens the list | The list under or over the bar |
| `Automatic` | Clears the choice | The bar, the title's chip and the start sentence read `automatic` |
| A machine's line | Chooses that machine | All three name the machine |
| A workspace's line | Chooses that workspace | All three name the machine and the workspace, and the bar shows its checkout |
| Any choice, while the conversation waits | Changes what it waits for, and asks again at once | The summary above the message starts counting for the new choice |
| A press outside, or Escape | Closes the list | The list is gone |
| The merge request | Opens it in the browser | |

A choice with no room is still the choice. The conversation waits for it; it is not sent elsewhere and it does not fail.

## The copy names the place, or says what stands in for one

| Where | String |
| --- | --- |
| Machine | `this machine` · `{machine name}` · `automatic` |
| Workspace | `{folder}` · `the first of {n} workspaces with room` · `the one workspace in reach, when it has room` · `choosing a workspace` · `waiting for a workspace with room` · `waiting for room on {machine}` · `waiting for room in {workspace}` |
| Checkout | `{branch}` · `↑{n}` · `+{a}` `−{d}` · `!{n}` on GitLab or `#{n}` on GitHub · `open`, `draft`, `merged`, `closed` |
| Checkout tooltips | `commits not pushed` · `lines changed since the last commit` · `Open {request} in the browser` |
| List, automatic | `Automatic` · `the first workspace with room, in this project's order` |
| List, machine | `{OS} {form}` · `any workspace · the first with room` · `CPU` · `Memory` · `connecting…` · `offline` · `another version` |
| List, workspace tooltip | `{path}` · `No room now: {reason}. A conversation sent here waits for it.` |
| Work ring tooltip | `{n} tasks: {r} at work, {q} waiting` |

## The bar keeps one line and gives up the workspace's name first

- Width: the tray is the composer's width at every size. The workspace's words end in an ellipsis before the machine or the checkout is cut.
- Theme: the wash, the edge, the meters and the tones are tokens with a light and a dark value. The dot's ring takes the wash's own colour so it reads as cut out of the tray.
- Focus: the machine is a button reached after the composer's send; the list's rows are options, and one that cannot be chosen is disabled.
- The same choice is stated in two more places, which open the same list: the chip beside the conversation's title and the sentence over the start box.

## The tray departs from the direction by sitting behind another control

- The tray is drawn partly under the composer's ring, which no other surface does; the composer and the bar are read as one box.
- A machine's name and a folder's name are data set in the app face.
