/**
 * A context menu's item and the one dialog a menu needs, as the models that BUILD them see them
 * (`boardMenus.ts`, `filesModel.ts`, `chatListModel.ts`, `crumbModel.ts`): one level, no submenus — a
 * flat list of verbs, or of kinds, each optionally wearing an icon. `ContextMenu` (`Menu.tsx`) and
 * `AskDialog` draw them. Types only.
 */
import type { PATHS } from "./iconPaths";

export interface MenuItem {
  label: string;
  onSelect: () => void;
  /** Destructive, so it reads as such before it is clicked. */
  danger?: boolean;
  disabled?: boolean;
  /** Draw a rule above this item — the grouping is the only structure a flat menu has. */
  separator?: boolean;
  /**
   * "You are here."
   *
   * For a menu that lists alternatives to something already chosen — the address bar's chevrons —
   * where a list with no mark on the current entry makes you count segments to work out which one
   * you are looking at.
   */
  checked?: boolean;
  /** A second line, dimmer: what distinguishes this entry from the others. */
  note?: string;
  /**
   * A glyph before the label, for a menu whose items are KINDS rather than actions.
   *
   * The type picker is the case and, so far, the only one: its rows are the same names the control
   * that opened it wears, and a list where the chip has a picture and the menu does not reads as two
   * different vocabularies for one choice. Absent everywhere else on purpose — a menu of verbs gains
   * nothing from a column of pictures, and the module's own rule is that a glyph alone is a guess.
   */
  icon?: keyof typeof PATHS;
}

export interface AskSpec {
  title: string;
  /** Absent for a plain confirmation — then there is nothing to type. */
  field?: string;
  initial?: string;
  /** Standing context: what this will affect, or what it will break. */
  note?: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: (value: string) => void;
}
