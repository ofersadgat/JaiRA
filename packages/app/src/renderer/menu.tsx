/**
 * The context menu and the one dialog it needs.
 *
 * Both exist because file operations are the part of authoring that a tree is expected to do, and
 * the alternative — a form at the bottom of the panel for every verb — turns "rename this" into a
 * hunt. Right-click is where people already look.
 *
 * Deliberately not a general menu framework: one level, no submenus, no icons. Everything the Files
 * view needs is a flat list of verbs, and a nesting mechanism nobody uses is a nesting mechanism
 * nobody maintains.
 */
import { useEffect, useRef, useState, type JSX } from "react";

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
}

export interface MenuAnchor {
  x: number;
  y: number;
  items: MenuItem[];
}

/**
 * A menu at a point.
 *
 * Positioned by clamping rather than by measuring: a menu opened near the right or bottom edge would
 * otherwise render off-screen, and the window's own size is the only measurement needed to prevent
 * it. Closes on Escape, on any outside click, and on scroll — a menu anchored to a row that has
 * scrolled away is pointing at the wrong thing.
 */
export function ContextMenu({ anchor, onClose }: { anchor: MenuAnchor; onClose: () => void }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    // Capture, so a click on something that stops propagation still dismisses the menu.
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  const width = 232;
  // A noted item is two lines. Only the tallest case has to be right — this is a clamp against the
  // window edge, not a layout.
  const height = anchor.items.length * (anchor.items.some((i) => i.note !== undefined) ? 40 : 27) + 10;
  const left = Math.min(anchor.x, Math.max(4, window.innerWidth - width - 4));
  const top = Math.min(anchor.y, Math.max(4, window.innerHeight - height - 4));

  return (
    <div className="context-menu" role="menu" ref={ref} style={{ left, top, width }}>
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
          <button type="submit" className={spec.danger ? "danger" : undefined} disabled={!ok} autoFocus={!needsValue}>
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
