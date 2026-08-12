/**
 * The window's layout, and the names the parts of it are remembered under.
 *
 * Every divider you drag, every fold you close and every branch of the two trees you collapse is a
 * statement about how you want to work, and until this file existed all of them were `useState` —
 * so all of them were undone by closing the window, and several by switching views. The value is
 * stored in `settings.json` beside the theme (see {@link JairaUiState}), which is the only place it
 * could go: a pane width belongs to one person on one machine, and putting it in `config.json` would
 * mean a layout preference could arrive through a pull request.
 *
 * ## Why ids rather than fields
 *
 * The stored shape is three maps keyed by string, and this module owns the keys. That is what keeps
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
  [PANE.schemaReference]: 300,
};

/** How wide the sidebar is when it is collapsed: the nav glyphs and nothing else. */
export const SIDEBAR_RAIL = 46;

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
  /** The sidebar's file browser — the accordion that holds the tree. */
  shellFiles: "shell.files",
  /** The sidebar's other accordion: the Settings sections, while Settings is open. */
  shellSections: "shell.sections",
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
  [FOLD.shellFiles]: true,
  [FOLD.shellSections]: true,
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

/** A pane's remembered size, or its default. */
export function paneOf(ui: JairaUiState, id: string): number {
  return ui.panes[id] ?? paneDefault(id);
}

export function withPane(ui: JairaUiState, id: string, size: number): JairaUiState {
  return { ...ui, panes: { ...ui.panes, [id]: size } };
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
 * A layout with nothing remembered — every control at its default.
 *
 * Re-exported through here rather than imported from the shared package at each use, so that the
 * renderer has one door to this state and it is the one that also holds the ids.
 */
export function emptyUiState(): JairaUiState {
  return defaultUiState();
}
