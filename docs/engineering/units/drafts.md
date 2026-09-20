---
id: engineering/units/drafts
type: engineering-unit
status: shipped
updated: 2026-09-13
implements: [ux/patterns/draft-belongs-to-the-file, ux/patterns/unsaved-proposal, ui/components/editor-chrome, ui/components/file-tree]
layer: ui
owns_contracts: []
requires: []
implemented_by: [packages/app/src/renderer/drafts.ts]
verified_by: [packages/app/test/drafts.test.ts]
siblings: [engineering/units/renderer-store, engineering/units/ui-layout-state, engineering/units/workflow-authoring]
---

# Drafts

## Drafts hold a file's unsaved text as a difference from disk, and the rules that clear, settle and move it

`drafts.ts` in the renderer holds pure functions over one map, `Drafts`, from `docKey(layer, path)` to text:

- `draftBox(drafts, onDraft, key, onDisk)` derives what an editor shows: `text`, `dirty`, `set` and `revert`. Setting the text back to `onDisk` clears the entry, so an entry exists only while it differs from disk.
- `useDraftBox` is the same box for a surface with no store behind it, falling back to component state keyed by the document.
- `withDraft` records or clears one entry, `settled` drops an entry a re-read now matches, `movedDraft` follows a renamed file, and `withoutDraftsUnder` and `movedDraftsUnder` forget or re-root every entry under a path. Each returns the same map when nothing changes.

`docKey` is also the key the store uses for a document's schema choice and editor tab.

It deliberately does not own:

- The map itself, `AppState.drafts`, and the save actions `saveDoc`, `saveConfig` and `saveState`: [renderer-store](renderer-store.md).
- Writing, moving and deleting files: [workflow-authoring](workflow-authoring.md).
- Persisting anything. A draft lives only as long as the window.

## Drafts are pure renderer code, and the store is the only caller that changes the map

- Layer `ui`, in `packages/app/src/renderer`. It imports only React, for `useDraftBox`.
- It calls nothing across the renderer and main boundary. No upstream seam.
- The store clears or moves entries at these points: `refreshDoc` calls `settled` after every `file:read`; the document save clears the entry after its re-read; the config save clears the saved layer's entry; a state rename calls `movedDraft`; a state delete calls `withoutDraftsUnder`; a file or folder delete or rename calls `withoutDraftsUnder` or `movedDraftsUnder`; a description sync writes its proposals in with `withDraft`.
- `App.tsx` reads the map's keys as the set of dirty files the tree and the editors mark.

## The file on disk is the truth, and the map holds only what differs from it

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| `AppState.drafts` | written through `setDraft` and the store's clear and move sites; read by every editing surface | renderer memory; the file on disk for anything absent from it | [renderer-store](renderer-store.md) |
| `useDraftBox` local text | component state while mounted, only when no store is passed | the component | none |
| The file's text | read through `file:read` as `onDisk` | the file | [workflow-authoring](workflow-authoring.md) |

## The invariants keep a draft from masking the file or surviving the file it was about

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | An editor shows the draft when one exists and the file otherwise, and two files never share a draft | `drafts.test.ts` "shows the file when there is no draft", "shows the draft when there is one", "keeps two files apart" |
| 2 | The map never holds an entry equal to the file | `drafts.test.ts` "clears rather than storing a copy of the file", "drops a draft the file has caught up with" |
| 3 | Revert forgets the draft and never undoes a save | `drafts.test.ts` "revert forgets the draft rather than undoing a save" |
| 4 | Rebuilding a surface for the same file keeps its draft | `drafts.test.ts` "survives being rebuilt for the same file" |
| 5 | A re-read never replaces unsaved typing that still differs from disk | `drafts.test.ts` "leaves a draft that still differs — a re-read must not land on unsaved typing" |
| 6 | A deleted path takes its own draft and every draft under it, and no neighbour's that merely shares a prefix | `drafts.test.ts` "drops the file itself", "drops a directory's contents and not its neighbours" |
| 7 | A rename moves the draft to the new path, file by file for a directory, and forgets it when the new path is unknown | `drafts.test.ts` "moves one file's draft to where the file went", "re-roots a whole directory, file by file", "forgets it when the new path could not be resolved" |
| 8 | A write that changes nothing returns the same map, so React does not re-render | `drafts.test.ts` "records, replaces and deletes", "returns the same map when nothing changes, so React can bail out", "returns the same map when it covers nothing", "returns the same map when nothing under it is being edited" |

## Drafts are lost with the window, and one key can name files in two projects

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| The renderer reloads or is killed | the map is memory only | none | every unsaved edit is gone |
| The same layer and path are open in two projects | `docKey` names no project and nothing clears drafts when the project changes, so both files share one entry; a save writes that text into whichever file is open | none | one project's unsaved text shows over the other project's file |
| Two surfaces edit one file | both read and write the same entry | none needed | both show the same text |
| A re-read fails | `refreshDoc` sets `doc` to null and leaves the draft | the next successful read | the editor closes and the file stays marked unsaved |
| A save's write succeeds and its re-read is slower than more typing | the clear after the re-read drops the entry, typing included | none | the typing after Save is lost |
| A description sync proposes state-file edits | each applicable edit is stored with `withDraft` without comparing to disk | the next re-read of that file settles it | a file marked unsaved that matches disk |
| The same `setDraft` arrives twice | the second write returns the same map | none needed | none |

## Drafts depart from the store's other state by never reaching a preferences file

- Unsaved edits are not persisted, because restoring them later would resurrect a change without the reason it was made and without knowing which layer it belongs to.
