/**
 * The window's layout, and the names the parts of it are remembered under.
 *
 * Every divider you drag, every fold you close and every branch of the two trees you collapse is a
 * statement about how you want to work, and until this file existed all of them were `useState` —
 * so all of them were undone by closing the window, and several by switching views. The value is
 * stored in `user-settings.json` beside the theme (see {@link JairaUiState}), which is the only place it
 * could go: a pane width belongs to one person on one machine, and putting it in `settings.json` would
 * mean a layout preference could arrive through a pull request.
 *
 * ## Why ids rather than fields
 *
 * The stored shape is four maps keyed by string, and this module owns the keys. That is what keeps
 * the cost of remembering a new control down to one constant here plus reading it where it renders —
 * no shared type to widen, no parser to teach, no migration for the settings files already on disk.
 * The ids are namespaced by view (`files.tree`) so that reading a saved file tells you where each
 * number came from.
 *
 * ## Why the defaults live here too
 *
 * A remembered size needs a value to fall back to when nothing has been dragged yet, and a splitter
 * needs the same number for what a double-click restores. Those were the same constant written in
 * two files, and a default in two files is a default that stops agreeing with itself — a "reset"
 * that restores a width nobody has used since. One table, read by both.
 *
 * Everything here is PURE — a value in, a new value out — so the store can hold the state, the
 * components can read it, and the rules can be tested without a window.
 */
import { defaultUiState, type JairaUiState } from "@jaira/shared/browser";

/** Splitter ids. The value is a size in px: a width, except `filesViewer`, which is a height. */
export const PANE = {
  /**
   * The one left column, shared by every view.
   *
   * It replaced two — the Files tree and the Settings section list were separate columns beside a
   * separate icon rail, so the window had two left edges and the width you dragged in one view said
   * nothing about the other. One id, because there is now one sidebar.
   */
  shellSidebar: "shell.sidebar",
  filesInspector: "files.inspector",
  /** The Files view's horizontal divider — how tall the viewer opens above the editor. */
  filesViewer: "files.viewer",
  tasksPanel: "tasks.panel",
  /**
   * The Chat view's context panel, which exists only while something is pinned to it.
   *
   * Remembered anyway, and remembered separately from the Tasks panel: how wide you want a document
   * held beside a conversation is not how wide you want a task's detail, and a pane that opened at
   * whatever the other view was left at would be a pane you re-drag every time.
   */
  chatPanel: "chat.panel",
  /** The field reference beside the JSON editor. */
  schemaReference: "schema.reference",
} as const;

/**
 * What each pane opens at, and what a double-click on its divider restores.
 *
 * These are the numbers the stylesheet used to hard-code, and then the shell did. `filesViewer` is
 * roughly the 46% the stylesheet gave the viewer on a full-height window.
 */
export const PANE_DEFAULTS: Record<string, number> = {
  [PANE.shellSidebar]: 250,
  [PANE.filesInspector]: 300,
  [PANE.filesViewer]: 320,
  [PANE.tasksPanel]: 360,
  [PANE.chatPanel]: 420,
  [PANE.schemaReference]: 300,
};

/** How wide the sidebar is when it is collapsed: the nav glyphs and nothing else. */
export const SIDEBAR_RAIL = 46;

/**
 * How far a context panel may be dragged while it is HOLDING a value, in px.
 *
 * The ordinary caps on those panels — 680, 760 — are about what an inspector is for: a column of
 * facts about the thing on the left, which stops being readable long before it stops being wide. A
 * pinned value is the opposite case. It is a document, often a whole rendered page, and the panel is
 * the only place it can be read; capping it at inspector width would mean the panel refused to be
 * used for the one thing somebody explicitly asked it to hold.
 *
 * Still a cap rather than nothing, because the column beside it has to survive: past this the thing
 * you pinned the document FROM stops being a conversation and starts being a margin.
 */
export const PANE_WIDE = 1200;

/**
 * The narrowest a pinned SURFACE may be shown in, in px.
 *
 * A pinned value is a document and reads at any width; a pinned surface is a form, and its rows —
 * a name, a type, a binding, a switch — stop fitting beside each other somewhere below this. The
 * column grows to meet one rather than showing it folded over itself. See `statePanel.tsx`.
 */
export const PANE_SURFACE = 480;

/** Disclosure ids — the folds worth reopening the app on. */
export const FOLD = {
  /**
   * Whether the sidebar is showing, or collapsed to the strip of glyphs.
   *
   * Collapsed is a strip and not nothing, which is the whole difference between a fold and a
   * disappearance: the views are reached from here, so a sidebar that closed completely would take
   * the app's navigation with it and leave one button to get it back.
   */
  shellSidebar: "shell.sidebar",
  /*
   * `shell.files`, `shell.sections` and `shell.chats` were here, one per drawer in the sidebar.
   *
   * There are no such folds any more (see `sidebar.tsx`): a drawer is shown exactly while its view
   * is the one selected, so there is no second state to remember. The ids are named here rather
   * than merely deleted because a settings file written before this still carries them — reading an
   * unknown key costs nothing, and the alternative was giving a future control one of these names
   * and inheriting somebody's year-old fold.
   */
  /** The Files view's lower half: "Configuration" on a state, "Source" on anything else. */
  filesEditor: "files.editor",
  /** Whether the JSON editor is showing the schema's field reference. */
  schemaReference: "schema.reference",
  /** "Show effective" under the configuration editor. */
  settingsEffective: "settings.effective",
} as const;

/**
 * How each fold opens when nothing has been remembered about it.
 *
 * Not all `false`: the Files editor half defaults OPEN, because folding it away is the exception
 * (you do it to watch a board), and an app that started with the editor hidden would look like it
 * had failed to load the file.
 */
export const FOLD_DEFAULTS: Record<string, boolean> = {
  [FOLD.shellSidebar]: true,
  [FOLD.filesEditor]: true,
  [FOLD.schemaReference]: false,
  [FOLD.settingsEffective]: false,
};

/**
 * Ids for the collapsible trees, whose entries are the rows that are SHUT.
 *
 * `folders` is keyed by the tree's own `layer:path` — so it is per LAYER and not per checkout, and
 * two projects that both have a `workflows/review/` share its folded state. That is a deliberate
 * trade rather than an oversight: the alternative keys every row by absolute project path, which
 * grows without bound as projects come and go, to remember something about a folder in a project
 * that is not open.
 */
export const SHUT = {
  folders: "files.folders",
  /**
   * Folded STATES in a run's conversation — see `Sheet` in `sessionPanels.tsx`.
   *
   * One bucket for every run in every project rather than one per session, and the keys are what
   * makes that safe: a state is remembered as `run:instance:seq`, which is already the identity the
   * panels join on because an instance id names a different state in every run. A bucket per session
   * would key on an id the engine chose (`default` on most runs) and collide across tasks.
   */
  runStates: "run.states",
} as const;

/**
 * What a pane opens at, before anything has been dragged.
 *
 * A function rather than reading {@link PANE_DEFAULTS} directly, because the table is keyed by
 * string and every read of it would otherwise carry a `?? 0` for an id that cannot be missing. Zero
 * is the honest answer for a pane nobody has declared a default for — see {@link paneOf}.
 */
export function paneDefault(id: string): number {
  return PANE_DEFAULTS[id] ?? 0;
}

/**
 * How far a conversation has been read, by task id — see {@link JairaUiState.seen}.
 *
 * A fresh object is not made here: the map is read per row while a list renders, and this is a
 * lookup rather than a derivation.
 */
export function seenOf(ui: JairaUiState, taskId: string): number {
  return ui.seen[taskId] ?? 0;
}

/**
 * Mark a conversation read up to a moment.
 *
 * MONOTONIC — a mark never moves backwards. The two things that call this are a conversation being
 * opened and a turn landing in one that is already open, and they can arrive in either order for the
 * same thread; taking the later of the two means neither has to know about the other.
 *
 * Returns the state UNCHANGED when the mark would not move, which is what keeps this out of the
 * write path: it is called on every render that has a conversation open, and a new object each time
 * would be a settings write every four hundred milliseconds forever.
 */
export function withSeen(ui: JairaUiState, taskId: string, at: number): JairaUiState {
  if ((ui.seen[taskId] ?? 0) >= at) return ui;
  return { ...ui, seen: { ...ui.seen, [taskId]: at } };
}

/**
 * Mark a whole row's worth read at once — what clicking a project or a view does (SHELL.md §4.3).
 *
 * One pass and one new object, rather than folding {@link withSeen} over the list: a project row can
 * be clearing hundreds of marks, and each fold step would copy the whole map to move one key.
 *
 * Monotonic per task, exactly as the single form is, so a row whose marks are already current
 * returns the state unchanged and writes nothing.
 */
export function withSeenAll(ui: JairaUiState, marks: readonly { taskId: string; at: number }[]): JairaUiState {
  const moved = marks.filter(({ taskId, at }) => (ui.seen[taskId] ?? 0) < at);
  if (moved.length === 0) return ui;
  const seen = { ...ui.seen };
  for (const { taskId, at } of moved) seen[taskId] = Math.max(seen[taskId] ?? 0, at);
  return { ...ui, seen };
}

/**
 * Drop the marks for conversations that have been deleted.
 *
 * By the ids that WENT rather than by the ids that remain, which is the only safe direction here. A
 * window holds one project's task list at a time and this map spans every project a person has ever
 * had a conversation in, so pruning to "what is on screen" would forget every mark belonging to a
 * project that merely happens to be closed.
 */
export function forgetSeen(ui: JairaUiState, taskIds: readonly string[]): JairaUiState {
  if (!taskIds.some((taskId) => taskId in ui.seen)) return ui;
  const seen = { ...ui.seen };
  for (const taskId of taskIds) delete seen[taskId];
  return { ...ui, seen };
}

/** A pane's remembered size, or its default. */
export function paneOf(ui: JairaUiState, id: string): number {
  return ui.panes[id] ?? paneDefault(id);
}

export function withPane(ui: JairaUiState, id: string, size: number): JairaUiState {
  return { ...ui, panes: { ...ui.panes, [id]: size } };
}

/**
 * The Files view's lower half has three positions, not two.
 *
 * `half` is the working split — what the state is DOING above, what it IS below. `full` gives the
 * whole column to the editor, which is what authoring a nine-child state actually needs; `shut`
 * gives it to the viewer, which is what watching one run needs. Two positions made the third of
 * those impossible and the fold had to be dragged instead.
 */
export const HALVES = ["shut", "half", "full"] as const;
export type HalfMode = (typeof HALVES)[number];

/** What a multi-position control opens at when nothing has been remembered. */
export const MODE_DEFAULTS: Record<string, string> = {
  [FOLD.filesEditor]: "half",
};

/**
 * A multi-position control's position — see {@link JairaUiState.modes}.
 *
 * `among` is the list of positions the control actually has, so a word from a settings file written
 * by another version cannot put a control into a state it no longer offers.
 */
export function modeOf<T extends string>(ui: JairaUiState, id: string, among: readonly T[], fallback: T): T {
  const held = ui.modes[id] ?? MODE_DEFAULTS[id];
  return among.includes(held as T) ? (held as T) : fallback;
}

export function withMode(ui: JairaUiState, id: string, mode: string): JairaUiState {
  return { ...ui, modes: { ...ui.modes, [id]: mode } };
}

/** Whether a disclosure is open, falling back to {@link FOLD_DEFAULTS} and then to open. */
export function openOf(ui: JairaUiState, id: string): boolean {
  return ui.open[id] ?? FOLD_DEFAULTS[id] ?? true;
}

export function withOpen(ui: JairaUiState, id: string, open: boolean): JairaUiState {
  return { ...ui, open: { ...ui.open, [id]: open } };
}

/**
 * The folded rows of one tree, as the set the components test against.
 *
 * A fresh Set per call, so it must not be handed straight to a memo dependency — the callers hold it
 * for a render and ask again on the next one, which is what a derived value of this size is for.
 */
export function shutOf(ui: JairaUiState, id: string): ReadonlySet<string> {
  return new Set(ui.shut[id] ?? []);
}

/** Fold a row, or unfold it. The stored list is a set; this keeps it one. */
export function toggleShut(ui: JairaUiState, id: string, key: string): JairaUiState {
  const current = ui.shut[id] ?? [];
  const next = current.includes(key) ? current.filter((k) => k !== key) : [...current, key];
  return { ...ui, shut: { ...ui.shut, [id]: next } };
}


/**
 * Fold or unfold SEVERAL rows of one tree at once — what a "collapse all" spends.
 *
 * Beside {@link toggleShut} rather than a loop over it, because a loop would write the settings
 * document once per row: `setUi` defers the disk write but the STATE update is per call, so folding
 * a nine-state session would re-render the conversation nine times while it collapsed.
 */
export function withShut(ui: JairaUiState, id: string, keys: readonly string[], shut: boolean): JairaUiState {
  const current = new Set(ui.shut[id] ?? []);
  for (const key of keys) {
    if (shut) current.add(key);
    else current.delete(key);
  }
  return { ...ui, shut: { ...ui.shut, [id]: [...current] } };
}

/**
 * A layout with nothing remembered — every control at its default.
 *
 * Re-exported through here rather than imported from the shared package at each use, so that the
 * renderer has one door to this state and it is the one that also holds the ids.
 */
export function emptyUiState(): JairaUiState {
  return defaultUiState();
}
