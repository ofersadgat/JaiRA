---
id: engineering/units/ui-layout-state
type: engineering-unit
status: shipped
updated: 2026-09-13
implements: [ux/patterns/the-window-remembers-its-arrangement, ux/patterns/fold-to-a-summary-expand-in-place, ux/patterns/live-facts-and-unseen-counts, product/see-what-changed-since-you-looked, ui/components/splitter, ui/surfaces/sidebar, ui/components/file-tree, ui/components/file-panel, ui/components/session-sheet]
layer: ui
owns_contracts: []
requires: [engineering/units/user-settings]
implemented_by: [packages/app/src/renderer/uiState.ts, packages/app/src/renderer/store.ts]
verified_by: [packages/app/test/uiState.test.ts, packages/app/test/settings.test.ts]
siblings: [engineering/units/user-settings, engineering/units/renderer-store, engineering/units/drafts]
---

# UI layout state

## Layout state names every remembered pane, fold, mode and read mark, and reads and writes them over one `ui` document

`uiState.ts` in the renderer holds pure readers and writers over `JairaUiState`, the `ui` block of the preferences file:

- Ids: `PANE` for splitter sizes, `FOLD` for disclosures, `SHUT` for trees whose stored rows are the folded ones, `OPENED` for trees whose stored rows are the open ones, and `HALVES` for the Files editor's `shut`, `half` and `full` positions.
- Readers `paneOf`, `openOf`, `modeOf`, `shutOf`, `unfoldedOf` and `seenOf`, each falling back to the control's own default: `PANE_DEFAULTS`, `FOLD_DEFAULTS` and `MODE_DEFAULTS`.
- Writers `withPane`, `withOpen`, `withMode`, `toggleShut`, `withShut`, `toggleUnfolded`, `withUnfolded`, `withSeen`, `withSeenAll` and `forgetSeen`. None mutates its input, and the read-mark writers return the same object when no mark moves.

The store holds the document and writes it: `setUi` patches it locally at once and writes the whole `ui` block through `settings:write` 400 ms after the last change; `flushUi` writes a pending change at once on `pagehide` and on unmount; `refreshSettings` takes `ui` from the file only on its first success, and `keepingUi` keeps the window's copy in every later settings response. Selecting a conversation moves its read mark forward, and deleting tasks forgets theirs.

It deliberately does not own:

- Parsing, clamping and the file: [user-settings](user-settings.md), whose `parseSettings` caps a pane at 4000, drops a read mark that is not finite and positive, and de-duplicates fold lists.
- What a fold hides or how a pane draws. Each view reads its id and draws.

## Layout state is renderer code that reaches main only through `settings:write`

- Layer `ui`, in `packages/app/src/renderer`. It imports `defaultUiState` and `JairaUiState` from `@jaira/shared/browser`.
- Boundary: renderer and main. The renderer sends the whole `ui` block and main merges it one level deep into the file, so `ui` is replaced, never merged.
- No upstream seam.

## The window owns the layout after its first read, and the file is its durable copy

| Data | Read / written | Source of truth | Who else touches it |
| --- | --- | --- | --- |
| `AppState.settings.ui` | patched on every gesture; seeded once from `settings:read` | the renderer after hydration | every view reading an id |
| `ui` in `<base>/user-settings.json` | written whole by `setUi` and `flushUi`; read at startup | the file before hydration | [user-settings](user-settings.md) |
| `ui.shut["run.states"]` | keys `<taskId>:<instanceId>:<seq>`, built by `keyOfPiece` in `sessionPanels.tsx` | the file | the run conversation's folds |
| `ui.unfolded["files.folders"]` | keys `layer:path`, shared by every project with that path | the file | the Files tree |
| `ui.seen` | a read clock per task id | the file | unread counts on the sidebar and cards |

## The invariants keep a stored layout from moving a control somewhere it cannot go, or a read mark backwards

| # | Invariant | Asserted by |
| --- | --- | --- |
| 1 | A control with nothing stored opens at its own default, and a stored position the control does not offer falls back | `uiState.test.ts` "opens at the control's own default until something has been chosen", "returns what was chosen", "falls back rather than taking a position the control does not offer" |
| 2 | A pane with nothing stored takes its own default, an unknown pane answers 0, and a write touches no other pane and mutates nothing | `uiState.test.ts` "falls back to the pane's own default until something has been dragged", "returns what was stored, and leaves the other panes alone", "answers for a pane it has never heard of rather than throwing", "does not mutate the layout it was given" |
| 3 | A fold uses its own default, the sidebar opens for a file written before it existed, and a stored close is kept | `uiState.test.ts` "uses the fold's own default, which is not always shut", "opens the sidebar for a settings file written before the sidebar existed", "remembers being closed, which is the whole point of storing a boolean" |
| 4 | A run-state row nobody folded is open, a Files folder nobody opened is shut, the trees never share rows, and a row is stored once | `uiState.test.ts` "lists what is SHUT, so a branch nobody has folded is open", "lists what is OPEN for the Files tree, so a folder nobody opened is shut", "opens and closes the same row", "folds and unfolds the same row", "keeps the trees apart", "stores a row once however many times it is toggled" |
| 5 | A layout the app produced reads back unchanged through the file, and a file with no layout opens at the defaults | `uiState.test.ts` "round-trips a layout the app actually produced", "opens at the defaults when the file has never heard of a layout", "survives being written and read back" |
| 6 | A read mark never moves backwards, alone or in bulk, and a mark that would not move returns the same object | `uiState.test.ts` "reads as unread until something has been seen", "moves the mark forward as a conversation is read", "never moves the mark backwards, and hands back the same object when it would not move", "marks a whole row at once, each task at its own clock", "is monotonic in bulk too, and hands back the same object when nothing would move", "marks one conversation without touching another" |
| 7 | Deleting tasks forgets only their read marks, and the marks survive the file | `uiState.test.ts` "forgets the marks of deleted conversations and leaves the rest alone", "survives the settings file", "has an empty map when the file has never heard of one" |
| 8 | A `ui` write replaces the stored layout whole and leaves every other preference alone, and a malformed entry costs only itself | `settings.test.ts` "remembers the window layout, and writes it whole", "keeps the layout out of the way of the other preferences", "drops layout entries of the wrong shape rather than the whole layout" |
| 9 | A settings read after hydration never replaces the window's layout | unasserted |
| 10 | A change made less than 400 ms before the window closes is written by `pagehide` | unasserted |

## A lost layout write costs the last gesture and never an error

| When | Behavior | Recovery | UX state |
| --- | --- | --- | --- |
| The write fails | `setUi` and `flushUi` swallow the error | the next gesture writes again | none; the layout is not kept across a restart |
| A gesture lands before the first `settings:read` resolves | the read replaces the local layout with the file's | repeat the gesture | the gesture is undone |
| The renderer is killed within 400 ms of a gesture | `pagehide` does not fire | none | the last gesture is gone next launch |
| Another preference is written while a layout write waits | the response's `ui` is replaced by the window's own through `keepingUi` | the pending write lands | none |
| Two windows share one shared root | each writes its whole `ui` block from its own copy | none | the last window to write wins |
| A task is deleted | its `seen` mark is forgotten, but its `run.states` keys stay | none | none; the stored fold list grows without bound |
| A retried write sends the same layout | the same block is written again | none needed | none |

## Older layouts read without migration

- The retired fold ids `shell.files`, `shell.sections` and `shell.chats` are ignored when read and are never reused.
- `files.editor` moved from `open` to `modes`, so an older `open` entry for it is ignored and the editor opens at `half`.
- Nothing rolls back: an older build reads the ids it knows and ignores the rest.

## Layout state departs from the other preferences by being owned by the window after the first read

- The file seeds the layout once and the renderer owns it afterwards, because every settings response is up to one write delay behind a pane being dragged.
- The Files tree's open folders are keyed per layer rather than per project, so unbounded keys for projects that are not open are never stored.
