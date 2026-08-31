/**
 * The context menu and the one dialog it needs.
 *
 * Both exist because file operations are the part of authoring that a tree is expected to do, and
 * the alternative — a form at the bottom of the panel for every verb — turns "rename this" into a
 * hunt. Right-click is where people already look.
 *
 * Deliberately not a general menu framework: one level, no submenus. Everything the Files view needs
 * is a flat list of verbs, and a nesting mechanism nobody uses is a nesting mechanism nobody
 * maintains.
 *
 * It grew a glyph column and a caption when the transcript's type picker arrived, because that menu
 * is not a list of verbs — it is a list of KINDS, and the control that opens it wears one of their
 * icons. Both are optional and both are off everywhere else: a menu of verbs gains nothing from a
 * column of pictures.
 */
import { useEffect, useRef, useState, type JSX } from "react";
import { Icon, type PATHS } from "./icons";

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

/**
 * How wide a menu is, in px.
 *
 * A constant rather than a stylesheet rule because the positioning below needs the number: a menu is
 * placed by clamping against the window edge, which cannot be done without knowing how much room the
 * menu will take. Exported for the one caller that anchors a menu to a BUTTON rather than to a
 * pointer — right-aligning under a control means subtracting this, and a second copy of it is a
 * second copy that stops agreeing.
 */
export const MENU_WIDTH = 232;

/**
 * Where a menu was asked for: the point, and the thing that was under it.
 *
 * The point is what the menu is drawn at. `origin` is what it is ABOUT, and it exists for one
 * decision — see the scroll rule in {@link ContextMenu}. A menu that knows its row can tell a scroll
 * that carried that row away from a scroll somewhere else in the window entirely, and the second
 * kind is not rare: selecting a card also swaps the panel beside it, and a panel that follows a live
 * transcript scrolls itself the moment it has one. Without this, opening a card's menu closed it.
 */
export interface MenuPoint {
  x: number;
  y: number;
  /** Absent where there is no element to name — a menu forwarded from a frame we cannot reach in. */
  origin?: Element;
}

/** A right-click, as the point it happened at. `currentTarget` is the row the handler is on. */
export function pointOf(e: { clientX: number; clientY: number; currentTarget: EventTarget | null }): MenuPoint {
  const origin = e.currentTarget;
  return { x: e.clientX, y: e.clientY, ...(origin instanceof Element ? { origin } : {}) };
}

export interface MenuAnchor extends MenuPoint {
  items: MenuItem[];
  /** A dim caption above the items, for a menu that answers a question rather than offering verbs. */
  title?: string;
}

/**
 * A menu at a point.
 *
 * Positioned by clamping rather than by measuring: a menu opened near the right or bottom edge would
 * otherwise render off-screen, and the window's own size is the only measurement needed to prevent
 * it. Closes on Escape, on any outside click, and on the scroll that carried its own row away — a
 * menu anchored to a row that has scrolled off is pointing at the wrong thing, and a menu closed by
 * some other column scrolling is a menu nobody gets to read.
 */
export function ContextMenu({ anchor, onClose }: { anchor: MenuAnchor; onClose: () => void }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const origin = anchor.origin;

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    /**
     * A scroll that moved THIS menu's row, as opposed to any scroll anywhere.
     *
     * The listener has to be a capture one — scroll does not bubble — so it hears every scrolling box
     * in the window, and the ones it hears most are not the reader's. Clicking a card selects it, and
     * a panel that follows a live transcript writes `scrollTop` the moment a different conversation
     * lands in it; that is a scroll, it arrives a frame or two after the menu opened, and it used to
     * close the menu before anybody had read a word of it. The Tasks board's right-click has been
     * unusable for exactly that reason.
     *
     * So: only a scroller that CONTAINS the row the menu is about has carried it away. Everything
     * else is another column moving, which the menu has no opinion about. A menu that never said what
     * it was about keeps the old rule — a menu whose row we cannot name is a menu we cannot check.
     */
    const onScroll = (e: Event): void => {
      const scroller = e.target;
      // The document itself, which moves everything on it, this menu's row included.
      if (!(scroller instanceof Element)) return onClose();
      if (origin === undefined || scroller.contains(origin)) onClose();
    };
    window.addEventListener("keydown", onKey);
    // Capture, so a click on something that stops propagation still dismisses the menu.
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose, origin]);

  const width = MENU_WIDTH;
  // A noted item is two lines. Only the tallest case has to be right — this is a clamp against the
  // window edge, not a layout.
  const height = anchor.items.length * (anchor.items.some((i) => i.note !== undefined) ? 40 : 27) + 10;
  const left = Math.min(anchor.x, Math.max(4, window.innerWidth - width - 4));
  const top = Math.min(anchor.y, Math.max(4, window.innerHeight - height - 4));

  return (
    <div className="context-menu" role="menu" ref={ref} style={{ left, top, width }}>
      {anchor.title !== undefined ? <div className="menu-title">{anchor.title}</div> : null}
      {anchor.items.map((item, i) => (
        <button
          key={`${item.label}-${i}`}
          role="menuitem"
          className={`menu-item${item.danger ? " danger" : ""}${item.separator ? " sep" : ""}${item.checked === true ? " here" : ""}`}
          disabled={item.disabled === true}
          onClick={() => {
            onClose();
            item.onSelect();
          }}
        >
          {item.checked === true ? <span className="menu-mark">•</span> : null}
          {item.icon !== undefined ? <Icon name={item.icon} className="menu-icon" /> : null}
          <span className="grow ellip">{item.label}</span>
          {item.note !== undefined ? <span className="menu-note ellip">{item.note}</span> : null}
        </button>
      ))}
    </div>
  );
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

/**
 * Ask before doing something irreversible, and ask for a name when one is needed.
 *
 * One component for both because the difference is a single field. A rename with no confirmation is
 * as unrecoverable as a delete — the file is gone from where it was either way — so both go through
 * the same gate.
 */
export function AskDialog({ spec, onCancel }: { spec: AskSpec; onCancel: () => void }): JSX.Element {
  const [value, setValue] = useState(spec.initial ?? "");
  const needsValue = spec.field !== undefined;
  const ok = !needsValue || value.trim().length > 0;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => (e.target === e.currentTarget ? onCancel() : undefined)}>
      <form
        className="modal"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) spec.onConfirm(value.trim());
        }}
      >
        <h3>{spec.title}</h3>
        {spec.note ? <div className={`notice${spec.danger ? " bad" : ""}`}>{spec.note}</div> : null}
        {needsValue ? (
          <label className="field">
            <span>{spec.field}</span>
            <input value={value} onChange={(e) => setValue(e.target.value)} autoFocus spellCheck={false} />
          </label>
        ) : null}
        <div className="options">
          <button type="submit" className={spec.danger ? "danger" : "primary"} disabled={!ok} autoFocus={!needsValue}>
            {spec.confirmLabel}
          </button>
          <button type="button" className="ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
