---
id: ui/components/workflow-sync-panel
type: ui-component
status: shipped
updated: 2026-09-13
realizes: [ux/patterns/unsaved-proposal, ux/patterns/say-what-it-is-doing-and-for-how-long, ux/patterns/refuse-with-the-reason-and-the-fix, ux/patterns/one-document-several-readings]
serves: [product/keep-process-and-description-in-step, product/author-processes-without-memorising-the-format, product/review-changes-before-they-land]
surfaces: [ui/surfaces/files-view]
reuses: [ui/components/file-changes-list, ui/components/markdown-view]
implemented_by: [packages/app/src/renderer/syncPanel.tsx, packages/app/src/renderer/syncState.ts]
verified_by: [packages/app/test/syncState.test.ts, packages/app/test/workflowSync.test.ts, packages/app/test/reviewSync.test.ts]
mockups: [ui/assets/workflow-sync-panel/status.html, ui/assets/workflow-sync-panel/running.html, ui/assets/workflow-sync-panel/error.html, ui/assets/workflow-sync-panel/report.html, ui/assets/workflow-sync-panel/rewritten.html, ui/assets/workflow-sync-panel/declined.html]
siblings: [ui/components/markdown-view, ui/components/file-panel, ui/components/file-changes-list, ui/components/changeset-review]
---

# Workflow sync panel

The reading of a workflow description in the Files view: one sentence saying whether the description or the workflows moved since they last agreed, with `last synced 3 hours ago` at the right, a row of `Rewrite the description` and `Propose workflow changes` with the suggested one bordered, and under a hairline either the sync report or the rendered description.

## The sync panel is where a description and its workflows are brought back into agreement

**Use when.** A workflow description document is open in the Files view. The panel is that document's reading in the upper half, above the markdown editor that holds its text.

**Do not use when.** Any other markdown file is open: it reads as [markdown-view](markdown-view.md). Proposed files are decided one by one: the panel hands them to [changeset-review](changeset-review.md) through `Review as changeset`.

## The sentence reads first, the two directions second, and the report under them

- **Head.** Fixed at the top of the half, 10px by 15px inset, a hairline under it, 6px between its lines.
- **Sentence.** App face at 13/12.5 in `--text`, filling the line; `last synced {ago}` in `.app-secondary` at its right once a sync has been recorded.
- **Actions.** Wrapping, 6px apart. The direction the panel suggests is the plain bordered button; the other, and both when nothing is suggested, are ghost. While a sync runs a ghost `Cancel` follows. `Report` or `Preview` sits at the far right, and `Review as changeset` after it when the report carries a set of changes.
- **Delegated line.** In `.app-secondary` behind a 2px `--line` rule: each subtree another description covers, its root in bold, its state count, and that description's path as an accent link.
- **Progress.** While running: `Reading the workflows and the description…` in `.app-secondary`, then the last eight progress lines in mono at 11/12 in `--dim`, up to 140px before they scroll.
- **Notices.** A failed request as a `--bad` wash; an unsaved proposal as a `.app-secondary` sentence.
- **Body.** Scrolls under the head, 8px below the hairline: the report after a sync, the rendered description before one.
- **Report.** A verdict chip, `--ok` for `conforms` and `--warn` for `gaps` or `diverges`, beside `against {workflows}` and the cost. Then sections 14px apart, each headed in uppercase app type at 11/12.5 with .06em tracking in `--dim`, the title at the left and its count at the right, and rows split by hairlines in the app face at 12/12.5.
- **Requirement row.** A status chip, `--bad` for `contradicted` and `missing`, `--warn` for `partial`, `--ok` for `satisfied`; the requirement's id in bold and its text; a `.app-secondary` detail; the states it concerns in mono at 11/12 joined by ` · `. Worst first.
- **Proposed files.** The [file-changes-list](file-changes-list.md) with a tick or a cross on every file and an `Open` link on each file that was applied; a refused count on a `--bad` wash in the heading.

## Every state keeps the head, and the body follows the last request

| State | Rendered as | Mockup |
| --- | --- | --- |
| status | The sentence for the drift: in step; one side moved, with the other side's button suggested; both moved or never synced, with neither suggested; `Checking…` while the status is read. A blocked panel puts the reason in the sentence and disables both directions. Before any sync the body is the rendered description. | [status.html](../assets/workflow-sync-panel/status.html) |
| empty | Cannot occur as a look of its own: an empty description is a blocked status, and its body reads `This file is empty.` | |
| loading | Cannot occur as a look of its own: reading the status is the `Checking…` sentence, and generating is the running state. | |
| partial | Cannot occur as a look of its own: some proposals declined is the report with its `{n} not applied` count. | |
| running | Both directions disabled, `Cancel`, `Report` disabled until a result exists, and the progress sentence with its latest lines. The body keeps what it showed. | [running.html](../assets/workflow-sync-panel/running.html) |
| error | The request was refused or failed: the reason on a `--bad` wash under the actions; nothing is placed and the body is unchanged. | [error.html](../assets/workflow-sync-panel/error.html) |
| report | After proposing workflow changes: the verdict, `Proposed files` with each file's outcome, `Notes` as `--warn` washes, `Requirements`, and `Not described by the document`. The toggle reads `Preview`. | [report.html](../assets/workflow-sync-panel/report.html) |
| rewritten | After rewriting the description: `Changes to this document` opens with an accent-wash notice that the rewrite is in the editor below, then one row per change with the requirement ids it answers. The sentence counts the unsaved rewrite as a changed description, the pending-proposal sentence shows under the actions, and the folded editor's bar carries its unsaved dot. | [rewritten.html](../assets/workflow-sync-panel/rewritten.html) |
| declined | Every proposed file refused: `{n} not applied` equals the file count and a `--bad` notice under the heading says nothing was proposed for review; every row has a cross whose tooltip gives the reason. | [declined.html](../assets/workflow-sync-panel/declined.html) |

## A direction runs a sync, and nothing is written until the person saves

| On | Does | Feedback |
| --- | --- | --- |
| Opening the description, or typing in it | Reads which side moved; unsaved typing counts as a changed description without asking again | The sentence and the suggested button update |
| `Rewrite the description` | Generates a new description from the workflows, read-only | Running; the rewrite lands in the editor below as an unsaved edit |
| `Propose workflow changes` | Generates edits to the state files from the description, read-only | Running; each applied proposal lands on its file as an unsaved edit |
| `Cancel` | Stops the sync; nothing is placed | The running look ends |
| `Report` or `Preview` | Swaps the body between the report and the rendered description; a new result shows its report again | The word flips |
| `Review as changeset` | Parks a changeset review of the proposed files on a task of its own | The review appears on that task's conversation |
| `Open` on a proposed file | Opens that state file | The Files view moves to it |
| A delegated description's path | Opens that description | The Files view moves to it, with its own panel |

Opening any other file clears the report. Restarting the app discards every unsaved proposal.

## The copy says which side moved and who decides

| Where | String |
| --- | --- |
| Checking | `Checking…` |
| In step | `The description and the workflows are in step.` |
| Description moved | `The description has changed since the last sync; the workflows have not.` |
| Workflows moved | `{n} workflow file changed since the last sync; the description has not.` · plural `{n} workflow files` |
| Both moved | `Both have changed since the last sync — the description, and {n} workflow files. Only you can say which is right.` |
| Never synced | `These have never been synced, so there is no baseline to say which one has moved. Choose which one is right.` |
| Never synced, unsaved | `These have never been synced, and the description has unsaved edits. Choose which one is right.` |
| Blocked | `open a project to sync its workflows` · `this description is empty — write what the workflows should do, then sync` · `every state here is described by {documents}` · `'{root}' names no workflow here. This project has: {roots}` |
| Last synced | `last synced just now` · `last synced {n} minutes ago`, likewise hours and days; tooltip `{local date and time}` |
| Directions | `Rewrite the description` · tooltip `from the workflows as they are` · `Propose workflow changes` · tooltip `from what the description asks for` |
| Other actions | `Cancel` · `Report` · `Preview` · `Review as changeset`, tooltip `Decide each proposed file — merge, revert, or comment — and apply the merged ones` |
| Delegated | `Described elsewhere: {root} ({n} states) by {document}`, several joined by ` · ` |
| Progress | `Reading the workflows and the description…` then `{latest lines}` |
| Pending | `A proposal from this session is still unsaved — the baseline moves when you save it.` |
| Refused request | `a sync is already running` · `{path} is empty; there is nothing to sync` |
| Verdict | `conforms` · `gaps` · `diverges` · `against {workflow}, {workflow}` · ` · ${cost to three places}` |
| Section headings | `Changes to this document` · `Proposed files` · `Notes` · `Requirements` · `Not described by the document` |
| Rewrite notice | `The rewritten description is in the editor below, unsaved. Read it, then Save or Revert.` |
| Refused count | `{n} not applied` |
| All declined | `The model wrote this file and JaiRA declined it — nothing here was proposed for review. Each row says why.` · `The model wrote all {n} of these files and JaiRA declined them — nothing here was proposed for review. Each row says why.` |
| No proposals | `Nothing to change.` |
| Open link | `Open` · tooltip `Open {state id}` |
| Finding status | `contradicted` · `missing` · `partial` · `satisfied` |
| No requirement rows | `The check returned no findings.` |

## The head stays put while the body scrolls in whatever height the half is given

- It fills the upper half of the Files view's middle column: 320px until the person drags the rule, or the whole column with the editor folded. The head never scrolls; the body does.
- The actions wrap on a narrow column, `Report` or `Preview` keeping to the right end of its line.
- Theme: every colour is a token; an opened diff inside the proposed files is painted in its own palette.
- Focus: Tab runs through the actions, the delegated links, then the report's rows and links, top to bottom. Progress lines are not announced as they arrive.
- Unsaved work: nothing the panel produces is saved by it. A rewritten description and applied proposals stay as unsaved edits on their files, marked wherever those files appear, until the person saves or reverts them.

## The report departs from the UI direction in its data

- Requirement ids, delegated roots and the workflow names after `against` are data drawn in the app face.
