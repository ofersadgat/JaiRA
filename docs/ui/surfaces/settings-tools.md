---
id: ui/surfaces/settings-tools
type: ui-surface
status: shipped
updated: 2026-09-23
kind: screen
realizes: [ux/patterns/inherited-unless-set-here, ux/patterns/pick-from-what-exists, ux/patterns/name-it-where-it-will-live, ux/patterns/absence-is-stated, ux/patterns/fold-to-a-summary-expand-in-place, ux/patterns/one-document-several-readings]
serves: [product/agents-act-only-where-allowed, product/risky-actions-wait-for-approval, product/share-processes-across-projects, product/review-changes-before-they-land]
components: [ui/components/permissionSet-card, ui/components/settings-header, ui/components/schema-form, ui/components/settings-field, ui/components/executor-tree, ui/components/icon]
mockups: [ui/assets/settings-toolsets/project.html, ui/assets/settings-toolsets/built-in.html, ui/assets/settings-toolsets/inherited.html, ui/assets/settings-toolsets/unsaved.html, ui/assets/settings-toolsets/nested.html, ui/assets/settings-toolsets/new-permissionSet.html, ui/assets/settings-toolsets/new-bucket.html, ui/assets/settings-toolsets/refused.html, ui/assets/settings-toolsets/function.html, ui/assets/settings-toolsets/function-menu.html, ui/assets/settings-toolsets/function-form.html]
siblings: [ui/surfaces/settings-view, ui/surfaces/settings-models, ui/surfaces/settings-connections]
---

# Settings tools

The Tools page of the [Settings view](settings-view.md): what an agent may do, and every function a run can call. It reads three ways: the permission sets, as a rail of buckets beside one set drawn the way the composer's Tools card draws it; the same sets turned round, one row per function an agent calls and one column per set; and the functions a workflow state calls, each with its defaults and whether a run may reach it. It is the one Settings page whose [layer switch](../components/settings-header.md) has a third, read-only segment, `Built in`, because the permission sets are what JaiRA ships.

## Permission sets read first, then the functions an agent calls, then the functions a workflow calls

- **Head.** `Tools`, the lead `What an agent may do, and every function a run can call.` followed by the layer sentence — on `Built in`, `Showing what JaiRA ships, read-only — override a line in a layer of your own to change it.` — and the switch at the head's top-right.
- **Permission sets.** A wide section, up to 1040px, its sentence in view under the heading: what a permission set is and how a state names one. One bordered box in two columns: a 212px rail and the detail pane, at least 330px tall.
  - **Rail.** The bucket hierarchy. A bucket is a heading, not a tab: a folder glyph, its name in the data face at weight 600, and the layer that defines it as a `--tok-hint` pill. Under it one tab per permission set — its name in the data face over a `--dim` summary, `{n} lines · other {mode}` or `{n} lines · all {mode}` — then `+ permission set`; `+ bucket` closes the rail. A set this layer states carries a 6px `--accent` dot; one with lines not yet saved reads `unsaved · {summary}`; one whose file could not be read reads `could not be read`. A nested bucket hangs 12px further in per step.
  - **Detail.** The set's path, `{bucket} / {name}`, with a standing pill and which states name it; then the [permission set card](../components/permissionSet-card.md); then `Save` and `Revert`, and, where this layer's file overrides a lower one, `Compare with {what ships|the shared one}` and `Reset to {built in|shared}` in `--bad`.
  - **Built in.** The same rail and card, inert, with no minus and no add line. The only actions are `Override for all projects` and `Override here`.
  - **Comparison, detach note, `+ permission set`, `+ bucket`.** A three-column table of the lines the two layers disagree on; an amber note above the actions where the draft takes out a line the followed set holds; and a detail pane titled `A new permission set in {bucket}` or `A new bucket` with its [settings fields](../components/settings-field.md) and `Add it`.
- **Functions an agent calls.** A wide section holding one table.
  - **Columns.** `Function`, `Defaults`, then one column per permission set this layer can see, grouped by bucket, the bucket's name in the data face over the first of its columns and a rule before it.
  - **Rows.** Grouped under the tool vocabulary's categories in uppercase `--dim` bands — `File permissions`, `Execution`, `Web`, `Tasks & workflows` — then `Everything not listed` with the one row `other`, `an agent's own tools with no equal here, and MCP`. Under Execution, every command a set names (`git push`) hangs indented under `bash`, then `script`.
  - **Cells.** The mode that set gives the function, as a chip: `ask` grey, `allow` green, `deny` red, `☆ {function}` accent; `—` where the set does not offer it. A cell in a set this layer states is outlined.
  - **Defaults.** What the function's defaults come to on one line: `built-in refusals on` for `bash`, `model: {model} · prompt: {default|its own}` for `smart`, `—` for a function with none.
- **Functions a workflow calls.** One card of rows: `smart`, the gates (`choose_option`, `review_artifact`, `edit_artifact`, `fill_form`, `confirm_action`, `review_artifacts`, `approve_tool_call`), then every agent the project configures. A row is the name in the data face, what it does, its defaults summary, an `available` pill in `--ok` or `not reachable` in `--bad`, and a chevron. The card ends in a closed disclosure, `Which of them a run may reach`, holding the default executor's function rules as the [executor tree](../components/executor-tree.md)'s rule list.
- **A function, opened.** Under its row in either list: `Defaults`, the function's settings as [schema-form](../components/schema-form.md) rows, each led by a switch — `smart`'s `Model` and `Prompt`, with the prompt JaiRA ships printed in full in a mono block until a layer writes its own; `review_artifacts`' `Publish` and `Wait after a comment`; `bash`'s `Built-in refusals` — then `Used by`, each set that offers it (or, for `smart`, hands calls to it) as a link with what it says.

While Tools is open, the sidebar lists `Permission sets` · `Functions an agent calls` · `Functions a workflow calls` under it.

## The page shows a set this layer states, one it inherits, what ships, a draft, an addition, a refusal, and the functions as the sets resolve them

| State | Surface shows | Mockup |
| --- | --- | --- |
| project | The layer that states the set: the accent dot on its tab, `overrides built in` beside its path, the card live, and all four actions. The mockups show the permission sets under the layer switch, as one column. | [project.html](../assets/settings-toolsets/project.html) |
| built in | What ships, read: every row inert, the two overrides in place of the actions; the function tables show what ships, their defaults read-only with ` · shown as in effect; set them in a project or the shared layer`. | [built-in.html](../assets/settings-toolsets/built-in.html) |
| inherited | A set this layer does not state: read the same way, `built in` beside its path, `Override here` its only action. | [inherited.html](../assets/settings-toolsets/inherited.html) |
| unsaved | Lines changed and not saved: the tab reads `unsaved · `, `Save` and `Revert` are live, the detach note names the line an override cannot drop, and the comparison is open. The table still shows what is saved. | [unsaved.html](../assets/settings-toolsets/unsaved.html) |
| nested | A project's own set in a bucket that holds another bucket; Execution open with a command group and the add menu. | [nested.html](../assets/settings-toolsets/nested.html) |
| new permission set | `+ permission set` chosen with a name the bucket already holds: the box outlined in `--bad`, the reason under it, `Add it` inactive. | [new-permissionSet.html](../assets/settings-toolsets/new-permissionSet.html) |
| new bucket | `+ bucket` chosen: a bucket and a first permission set, both required, and `Add it` live. | [new-bucket.html](../assets/settings-toolsets/new-bucket.html) |
| a line names a function | A line whose mode is `{ "function": … }`: its mode chip is a star and the function's name; its cell in the table reads `☆ {function}`. | [function.html](../assets/settings-toolsets/function.html) |
| mode menu | `allow` · `ask` · `deny`, each with its hint, then a rule and `function…`. | [function-menu.html](../assets/settings-toolsets/function-menu.html) |
| naming a function | `function…` chosen: the one schema form with a `function` field, and `Back` / `Set`. | [function-form.html](../assets/settings-toolsets/function-form.html) |
| a function open | A row of either list opened: its defaults as rows, the shipped prompt under `smart`'s, and `Used by`. | |
| not reachable | A workflow function the default executor's rules leave out: `not reachable` in `--bad`, and the disclosure's summary counts the rules. | |
| refused | While a write is in flight: every control at half strength and inert, and what the last write was refused with said above the actions. | [refused.html](../assets/settings-toolsets/refused.html) |
| loading | `Reading permission sets…` in place of the box, and `Reading the permission sets…` in place of the table. | |
| empty | Cannot occur: eight permission sets ship, and the built-in layer is on the search path of every project. | |
| error | The permission sets cannot be read: `Permission sets could not be read — {reason}` in `--dim` in place of the box. A single file that cannot be read is listed in the rail and says so in the pane. | |

| Where | String |
| --- | --- |
| Section heads | `Permission sets` · `Functions an agent calls` · `Functions a workflow calls` |
| Permission sets sentence | `Which tools are offered, and what happens when each is called. A state names one as $/permission-sets/<bucket>/<name>; a bucket is a place with its own versions of the same names.` |
| Layer switch | `This project` · `Shared (all projects)` · `Built in`, the last titled `what ships with JaiRA — read-only; it is changed by overriding it in one of the other two` |
| Rail | `{name}` with the dot's tooltip `set in the layer you are editing` · `+ permission set` · `+ bucket` · `{n} lines · other {mode}` · `{n} lines · all {mode}` · `unsaved · ` · `could not be read` |
| Standing | `overrides built in` · `overrides all projects` · `built in` · `all projects` · `this project` · `overridden in this project` · `overridden for all projects` |
| Used by, in the detail | `used by {state}` · `used by {a} and {b}` · `used by {state} and {n} more states` · `no state names it` |
| Set actions | `Save` · `Revert` · `Compare with what ships` / `Compare with the shared one` / `Hide the comparison` · `Reset to built in` / `Reset to shared` · `Override for all projects` · `Override here` |
| Mode menu | `allow` — `goes ahead without asking` · `ask` — `stop and ask before each call` · `deny` — `refused every time` · `function…` — `a function decides each call, and may ask you — smart, or your own` |
| Detach note | `Taking out '{a}', '{b}' is something an override cannot say — a line left out means "as {lower} says". Saving writes this permission set whole, and it stops following {lower}.` |
| New permission set | `A new permission set in {bucket}` · `Name`, hint `The file's name — what a state writes after the bucket.` |
| New bucket | `A new bucket` · `Bucket`, hint `A folder under permission-sets/. It may nest: feature/implementation.` · `First permission set` · `Add it` |
| Name refused | `there is already a permission set called '{id}'` · `'{id}' is inherited here — open it and override it` · `a name is letters, digits, '-', '_' and '.', starting with a letter or a digit` |
| Agent table, behind `ⓘ` | `Each row is a tool an agent may call, and each column a permission set this layer can see; the cell is the mode that set gives it. A dash is a set that does not offer the tool — a call to it falls to that set's other line. An outlined cell is in a set this layer states. A row opens the function; a cell opens that set above.` |
| Agent table | `Function` · `Defaults` · `Everything not listed` · `other` · `an agent's own tools with no equal here, and MCP`; cell tooltips `{set}: {mode hint} — open it` · `{set} does not offer {name}` |
| Workflow list, behind `ⓘ` | `Gates, the permission judge, and an agent reached as a function. A workflow state calls these, not an agent, so no permission set lists them; what decides whether a run may call one is the default executor's rules, below.` |
| Workflow rows | `judges a call for a permission set: allow, deny, or unsure (then you are asked)` · `human gate — {what}` · `a review of N files, each decided — optionally opened on the forge too` · `the approval prompt — puts one tool call to you` · `agent — delegate a state to that runtime` · `available` · `not reachable` |
| Reach rules | `Which of them a run may reach` · `· everything the workflow registers` or `· {n} rule(s)` · `Walked in order, last match winning. Start with a baseline — everything or nothing — then add or subtract; the available column above is what they come to.` |
| A function open | `Defaults` · `The prompt it uses now — the one JaiRA ships. The call being judged is appended as JSON.` · `Used by` · `every line ({n})` · `{n} lines` · `No defaults — it takes nothing a layer could set.` · `No defaults — a set's other line is all there is to it.` · `No permission set this layer can see offers it.` · `No permission set this layer can see hands a call to it.` |
| Function defaults | `Model`, `Which model judges each call, written as a state's model is — claude-haiku-4, or claude-cli/haiku to insist on a route.` · `Prompt`, `What the judge is told.` · `Publish` · `Wait after a comment` · `Built-in refusals` |

## A person picks a layer, then a set or a function, and every change but a set's lines is written at once

- `Tools` in the sidebar shows every permission set the chosen layer can see — its own files and those of the layers below it — opened on the first. `Built in` shows only what ships. It belongs to this page: every other page keeps reading and writing the layer chosen before, and Tools is on `Built in` again when a person comes back to it.
- A set's lines are a draft per set and per layer: `Save` writes the whole map into the layer — the layer's own file edited in place, or an override holding only the lines that differ from the nearest lower layer — and `Revert` puts back what is on disk. `Override for all projects` and `Override here` write an override that inherits everything and move the page to that layer. `Reset to …` deletes this layer's file.
- A cell in the agent table opens that set in the section above and scrolls to it. A row opens the function under it; another row closes it.
- A function's defaults are written into the layer being edited as each row changes: `functions.smart.model`, `functions.smart.prompt`, `functions.review_artifacts.publish`, `functions.review_artifacts.settleAfter`, `functions.bash.builtins`. On `Built in` they are shown as in effect and cannot be changed.
- A change to the reach rules pins the default executor's function rules into the layer; removing the last rule unpins them. The `available` pills follow.
- What ships is never written to: the page offers no way, and the service refuses one anyway.

## The page keeps its workspaces wide, and only a set's lines wait for Save

- **Resize.** The permission sets box and the agent table take up to 1040px; the workflow list stops at 740px. The table scrolls sideways inside its section rather than squeezing its columns, so the page itself never scrolls sideways.
- **Theme.** Mode chips, the outline on this layer's cells, the availability pills, the rail's dots and the comparison table are tokens in both themes.
- **Focus.** Nothing takes focus on entry. Tab moves through the rail (one stop, arrows within it), the card, the actions, then each function row's button and each cell, then the workflow rows and the disclosure.
- **Unsaved work.** Only a set's lines are held unsaved, per set and per layer, so looking at what ships loses nothing; leaving the page drops them without a prompt.

## The page departs from the direction in its table cells

- A cell's mode is a chip rather than a pill, so a column of them reads as a column of words; a function mode's star is a typed `☆`.
