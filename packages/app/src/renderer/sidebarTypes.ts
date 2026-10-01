/**
 * What the one left column is drawn from (SHELL.md §5.1): its projects, the views nested in the one
 * the address stands on, and the verbs a row carries. `shellModel.ts` builds them from the store and
 * `Sidebar` (`packages/universal/src/components/Sidebar.tsx`) draws them. Types only.
 */
import type { ReactNode } from "react";
import type { PillCounts } from "./pillModel";

/**
 * One thing a row can DO, drawn as a glyph inside it.
 *
 * A view row is a place, and every place has one or two verbs that belong to it and nowhere else —
 * "start a conversation" is only ever about Chat, "find a file" is only ever about Files. Those used
 * to live at the top of the drawer, which put them one fold away from the row that names them and
 * cost a line of the column each: the search box was on screen whether or not anybody was searching.
 *
 * On the ROW, they are reachable without opening the drawer at all, and a click on one means the
 * verb rather than "go there and then look for the button".
 */
export interface SidebarAct {
  id: string;
  glyph: string;
  /** What it does, as a sentence — the tooltip and the accessible name. */
  label: string;
  /** Whether it is currently ON, for the ones that toggle something in the drawer (search). */
  on?: boolean;
  /**
   * The button itself, for a verb that opens a MENU rather than doing one thing.
   *
   * `+` is that verb — a new file, a new folder or a new workflow — and a menu has to be positioned
   * under the control that opened it. The element rather than a point, so the caller measures it
   * with whatever it is about to draw: the row knows where its button is and nothing about how wide
   * a menu is. Every other act ignores it.
   */
  onAct: (from: HTMLElement) => void;
}

/** One row of the view switcher, and whatever it opens onto. */
export interface SidebarView {
  id: string;
  glyph: string;
  label: string;
  /**
   * What this view browses, shown under the row while the view is the one showing.
   *
   * Absent ⇒ the row is a plain switch. Tasks and Logs have nothing to list here: their content IS
   * the view.
   *
   * There is NO fold. A drawer is shown exactly while its view is the one selected, and hidden by
   * selecting another — which is the only state a person is expressing when they click a row. A
   * caret on top of that gave two ways to hide one thing and one of them was remembered, so a
   * column could open with the tree of the view you were on already gone.
   */
  panel?: ReactNode;
  /** This row's own verbs — see {@link SidebarAct}. Drawn only while the column has width for them. */
  acts?: readonly SidebarAct[];
  /** What this view has waiting in the open project — see SHELL.md §4.3. */
  counts?: PillCounts;
  /**
   * Marking this view's share seen, which is what clears its status pills — or, for a row whose pills
   * are not a count of unseen work (Settings' warnings and errors), what a click on them opens,
   * placed against `from`.
   */
  onSeen?: (from: HTMLElement) => void;
  /** What a click on the pills does, where it is not "mark these seen". */
  seenTitle?: string;
}

/** One project the window can stand on. */
export interface SidebarProject {
  /** The directory — what every project-scoped call names. */
  project: string;
  /** Its basename, or the root's own path for the one that has a role name. */
  label: string;
  kind: "user" | "shared";
  /**
   * The colour that stands for this project, as a CSS variable reference — see `hueOf`.
   *
   * One hue, four places: the dot on this row, this project's tile in the collapsed rail, the head
   * crumb of the address bar, and its chip on the inbox strip. It is how "this row, that crumb and
   * that pending approval are the same project" is answered without reading three directory names.
   */
  hue: string;
  counts: PillCounts;
  /** Beside the name, always: how many machines and workspaces a grouped project spans (decision 0013 §4). */
  where?: string;
  onSeen?: () => void;
}
