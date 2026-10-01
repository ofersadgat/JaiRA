/**
 * What floats over a DOM component — a popover, a dropdown, a completion list, a hover card, a
 * tooltip — for the islands (`schemaEditor.tsx`'s completion list). The page's own menus and tips are
 * `packages/universal`'s layers (`MenuLayer`, `TipLayer`, `SuggestLayer`), not these.
 *
 * ## Why there is exactly one of these
 *
 * A float drawn INSIDE its button's wrapper — `position: absolute` and a z-index — loses to the
 * page around it in two ways that no number in the float's own rule can fix:
 *
 *  - **clipping.** Every ancestor with `overflow` other than `visible` cuts it off at its edge: the
 *    tool mode picker at the bottom of an expanded Tools category was cut by the card's own scroll,
 *    the Files facts by the address bar's pane;
 *  - **stacking.** A z-index is measured inside the nearest ancestor STACKING CONTEXT, and anything
 *    with a `transform`, an `opacity` below 1, a `z-index` on a positioned box, `isolation`,
 *    `contain` or `will-change` makes one. The composer's popover came up under the top bar; the
 *    context menu opened inside an editor painted under the splitter beside it (CodeMirror gives
 *    `.cm-scroller` a `z-index: 0`). Even `position: fixed` is not an escape: a transformed ancestor
 *    becomes the containing block of a fixed descendant.
 *
 * Each of those was fixed once, where it was found, and the next float was written the old way and
 * came up underneath something else. So the rule is structural now: a float is rendered into
 * `document.body` by {@link Popover} (or {@link Overlay}, for one that places itself), which is the
 * only place in the renderer that calls `createPortal`, and `floatLayers.test.ts` fails the build on a
 * stylesheet rule shaped like an in-place float, on a z-index that is not one of the layer tokens,
 * and on a `createPortal` anywhere else.
 *
 * ## What a float gets for free
 *
 *  - **placement** against its anchor — an element, or a point or a rect — on the side asked for,
 *    flipped to the other when that has more room, clamped inside the window, its height capped to
 *    the room it has (it scrolls inside), and followed through every scroll and resize;
 *  - **hiding** when the anchor has scrolled out of the box that clips it, rather than pointing at a
 *    row nobody can see;
 *  - **the anchor's palette.** Tokens are declared on subtrees — an island's box carries its look
 *    (`islandStyles.ts`), an editor its theme's — and a float moved to `<body>` would otherwise lose
 *    them. The custom properties that differ between the anchor and the body are copied onto the
 *    float;
 *  - **dismissal**, through {@link usePopover}: a press outside closes it, where "outside" excludes
 *    the anchor, the float, and every float opened from inside it (they are not its DOM descendants
 *    any more — a context carries them up); Escape closes the innermost open one only.
 *
 * With no document (a server render, which is how the tests draw a still picture) a float renders in
 * place.
 */
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type JSX,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { FLOAT_EDGE, MIN_HEIGHT, placeFloat, type FloatAlign, type FloatRect, type FloatSide } from "./floatPlace";

export { FLOAT_EDGE, FLOAT_GAP, placeFloat, type FloatAlign, type FloatRect, type FloatSide } from "./floatPlace";

/** What a float is placed against: a live element, or a place in the window. */
export type FloatAnchor = RefObject<Element | null> | FloatRect | { x: number; y: number };

// --- dismissal ------------------------------------------------------------------------------------

/**
 * The floats that count as INSIDE an open popover.
 *
 * A float is portalled out of its opener's DOM, so `contains` can no longer tell a click on a submenu
 * from a click on the page. Every {@link Popover} registers its element with the nearest layer above
 * it in the REACT tree — which a portal keeps — and a layer passes the registration up, so a click on
 * a submenu of a submenu is inside all three.
 */
interface Layer {
  add: (element: Element) => () => void;
}
const LayerContext = createContext<Layer | null>(null);

/** Open floats, oldest first: Escape closes the last one only. */
const openStack: object[] = [];

export interface PopoverHandle<T extends HTMLElement = HTMLElement> {
  open: boolean;
  setOpen: (next: boolean | ((was: boolean) => boolean)) => void;
  toggle: () => void;
  close: () => void;
  /** Put on the element the float is placed against — usually the button's wrapper. A press on it is not outside. */
  anchor: RefObject<T | null>;
  /** Handed to {@link Popover} as `at`; it is what makes the float and its own floats count as inside. */
  layer: Layer;
}

/**
 * Open state for a float, closed by a press anywhere that is not the anchor, the float or a float
 * opened from it, and by Escape when it is the innermost open float.
 *
 * `onClose` hears every close, whoever caused it — for the host that has more than `open` to reset.
 */
export function usePopover<T extends HTMLElement = HTMLDivElement>(
  options: { startOpen?: boolean | undefined; onClose?: (() => void) | undefined } = {},
): PopoverHandle<T> {
  const parent = useContext(LayerContext);
  const [open, setOpenState] = useState(options.startOpen === true);
  const anchor = useRef<T | null>(null);
  const inside = useRef(new Set<Element>());
  const onClose = useRef(options.onClose);
  onClose.current = options.onClose;

  const setOpen = setOpenState;
  const wasOpen = useRef(open);
  useEffect(() => {
    if (wasOpen.current && !open) onClose.current?.();
    wasOpen.current = open;
  }, [open]);
  const layer = useMemo<Layer>(
    () => ({
      add: (element) => {
        inside.current.add(element);
        const up = parent?.add(element);
        return () => {
          inside.current.delete(element);
          up?.();
        };
      },
    }),
    [parent],
  );

  useEffect(() => {
    if (!open) return undefined;
    const token = {};
    openStack.push(token);
    const press = (event: Event): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (anchor.current?.contains(target) === true) return;
      for (const element of inside.current) if (element.contains(target)) return;
      setOpen(false);
    };
    const key = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && openStack[openStack.length - 1] === token) setOpen(false);
    };
    // Capture, so a press on something that stops propagation still counts.
    window.addEventListener("mousedown", press, true);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", press, true);
      window.removeEventListener("keydown", key);
      const at = openStack.indexOf(token);
      if (at >= 0) openStack.splice(at, 1);
    };
  }, [open, setOpen]);

  return {
    open,
    setOpen,
    toggle: useCallback(() => setOpen((was) => !was), [setOpen]),
    close: useCallback(() => setOpen(false), [setOpen]),
    anchor,
    layer,
  };
}

// --- placement ------------------------------------------------------------------------------------

function isRef(anchor: FloatAnchor): anchor is RefObject<Element | null> {
  return "current" in anchor;
}

function rectOf(anchor: FloatAnchor): FloatRect | null {
  if (isRef(anchor)) {
    const r = anchor.current?.getBoundingClientRect();
    return r === undefined ? null : { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }
  if ("x" in anchor) return { left: anchor.x, top: anchor.y, right: anchor.x, bottom: anchor.y };
  return anchor;
}

/**
 * Whether any of the anchor is still on screen inside every box that clips it. An anchor scrolled out
 * of its list leaves the float pointing at nothing, so the float hides until it comes back.
 */
function visibleIn(element: Element, rect: FloatRect): boolean {
  let left = rect.left;
  let top = rect.top;
  let right = rect.right;
  let bottom = rect.bottom;
  for (let at = element.parentElement; at !== null && at !== document.body; at = at.parentElement) {
    const style = getComputedStyle(at);
    if (style.overflowX === "visible" && style.overflowY === "visible") continue;
    const clip = at.getBoundingClientRect();
    left = Math.max(left, clip.left);
    top = Math.max(top, clip.top);
    right = Math.min(right, clip.right);
    bottom = Math.min(bottom, clip.bottom);
    // A pixel of slack: a zero-width caret marker sitting on the clip's left edge is still visible.
    if (right < left - 1 || bottom < top - 1) return false;
    if (style.position === "fixed") break;
  }
  return true;
}

interface Placed {
  left: number;
  top: number;
  maxHeight: number | undefined;
  hidden: boolean;
}

/**
 * Every custom property the stylesheets declare, read once.
 *
 * From the RULES, because Chromium does not list custom properties among an element's computed
 * style — iterating `getComputedStyle` finds none, and a carry-over built on it copies nothing. A
 * rule's own declaration does list them. A property only ever set inline by a script is a
 * component's private value, and not a token a float needs.
 */
let declared: readonly string[] | null = null;
function declaredTokens(): readonly string[] {
  // Not kept while it is empty: the universal page adopts the islands' stylesheet when its first island
  // mounts (`islandStyles.ts`), and a float asked before that would have read a page with no token.
  if (declared !== null && declared.length > 0) return declared;
  const names = new Set<string>();
  const walk = (list: CSSRuleList): void => {
    for (const rule of Array.from(list)) {
      if (rule instanceof CSSStyleRule) {
        for (let i = 0; i < rule.style.length; i += 1) {
          const name = rule.style.item(i);
          if (name.startsWith("--")) names.add(name);
        }
      }
      if ("cssRules" in rule && rule.cssRules instanceof CSSRuleList) walk(rule.cssRules);
    }
  };
  // The adopted sheets too: the universal page has the stylesheet nowhere else (`islandStyles.ts`).
  for (const sheet of [...Array.from(document.styleSheets), ...document.adoptedStyleSheets]) {
    try {
      walk(sheet.cssRules);
    } catch {
      // A sheet from another origin cannot be read; it declares none of ours.
    }
  }
  declared = [...names];
  return declared;
}

/**
 * The tokens the anchor sees differently from where the float stands (`from`: its seat in `<body>`) —
 * an editor's theme, a subtree's own palette — so a float carried out to `<body>` keeps the colours of
 * the place it opened from.
 */
function tokensOf(element: Element, from: Element): Array<[string, string]> {
  const here = getComputedStyle(element);
  const base = getComputedStyle(from);
  const out: Array<[string, string]> = [];
  for (const name of declaredTokens()) {
    const value = here.getPropertyValue(name);
    if (value !== base.getPropertyValue(name)) out.push([name, value]);
  }
  const scheme = here.getPropertyValue("color-scheme");
  if (scheme !== base.getPropertyValue("color-scheme")) out.push(["color-scheme", scheme]);
  return out;
}

/**
 * A float's seat in `<body>`, made an island where the float was opened from one.
 *
 * On the universal page the stylesheet is scoped to the islands (`islandStyles.ts`:
 * `@scope ([data-island])`), and a float opened from one has been carried out of the only box its
 * rules reach: the schema editor's completion list stood in `<body>` unplaced (`.float` is what makes
 * it fixed), in the browser's own face, with no token to draw from. So the seat is marked an island
 * itself — a root of that scope, with the card inside it, where every rule matches again — and dressed
 * as the island it came from is: the same look attributes and the same inline variables, which is what
 * the scoped token blocks and the inherited colour and face resolve from. The seat draws no box of its
 * own (`display: contents`), so the card is laid out as if it stood in `<body>` itself.
 *
 * On a page that carries the stylesheet — an island's own, on a phone — no anchor stands in such a
 * box, and the seat stays a bare element.
 */
const SEAT = { display: "contents" } as const;
function dressSeat(seat: HTMLElement, anchor: Element): void {
  const island = anchor.closest<HTMLElement>("[data-island]");
  if (island === null) return;
  for (const [name, value] of Object.entries(island.dataset)) if (value !== undefined) seat.dataset[name] = value;
  seat.dataset["island"] = "float";
  for (const name of Array.from(island.style)) if (name.startsWith("--")) seat.style.setProperty(name, island.style.getPropertyValue(name));
}

// --- the components -------------------------------------------------------------------------------

/** Hand an element to a ref of either kind. */
function assign<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === "function") ref(value);
  else if (ref !== null && ref !== undefined) ref.current = value;
}

type DivProps = Omit<HTMLAttributes<HTMLDivElement>, "children">;

export interface PopoverProps extends DivProps {
  /** What it is placed against. With a {@link PopoverHandle} as `at`, its `anchor` is the default. */
  anchor?: FloatAnchor | undefined;
  /** The handle from {@link usePopover}: makes the float count as inside for dismissal. */
  at?: PopoverHandle<HTMLElement> | undefined;
  side?: FloatSide | undefined;
  align?: FloatAlign | undefined;
  gap?: number | undefined;
  /** As wide as the anchor — a dropdown under a field. A `min-width` in its rule still wins. */
  matchWidth?: boolean | undefined;
  /** The float's own element, for a host that dismisses it by rules of its own. */
  ref?: Ref<HTMLDivElement> | undefined;
  /**
   * Once shown, it STAYS where it opened — against the anchor, which it still follows — and grows
   * downward from there, scrolling inside past the window's edge, instead of being placed afresh when
   * its content changes size. For a card whose rows open under the pointer: placed afresh, a card that
   * grew past its room flipped to the anchor's other side or slid up, the pointer was left outside it,
   * and it closed before the click that opened the row could be followed by another.
   */
  settle?: boolean | undefined;
  children?: ReactNode;
}

/**
 * A float placed against an anchor, drawn over everything. The element it renders IS the card:
 * `className` styles it, and the layer's own `.float` rule makes it fixed on the float layer.
 */
export function Popover({ anchor, at, side = "below", align = "start", gap, matchWidth, settle, ref, className, style, children, ...rest }: PopoverProps): JSX.Element {
  const parent = useContext(LayerContext);
  const layer = at?.layer ?? parent;
  const own = useRef<HTMLDivElement | null>(null);
  const setOwn = (element: HTMLDivElement | null): void => {
    own.current = element;
    assign(ref, element);
  };
  const [placed, setPlaced] = useState<Placed | null>(null);
  const [matched, setMatched] = useState<number | undefined>(undefined);
  const [, bump] = useState(0);
  const target: FloatAnchor | undefined = anchor ?? at?.anchor;
  /** With `settle`: where it was first shown, relative to the anchor's top left. */
  const settled = useRef<{ dx: number; dy: number } | null>(null);

  // Registered with the layer it opened from, so a press inside it is not a press outside that one.
  useLayoutEffect(() => {
    const element = own.current;
    if (element === null || layer === null) return undefined;
    return layer.add(element);
  }, [layer]);

  // The anchor's palette, once per anchor element.
  const anchorElement = target !== undefined && isRef(target) ? target.current : null;
  useLayoutEffect(() => {
    const element = own.current;
    if (element === null || anchorElement === null) return;
    const seat = element.parentElement ?? document.body;
    // First the seat (see `dressSeat`): what the anchor sees differently is measured against it.
    if (seat !== document.body) dressSeat(seat, anchorElement);
    for (const [name, value] of tokensOf(anchorElement, seat)) element.style.setProperty(name, value);
  }, [anchorElement]);

  // Placed on every render, converging: the same place again is the same object, so it settles.
  useLayoutEffect(() => {
    const element = own.current;
    if (element === null || target === undefined) return;
    const a = rectOf(target);
    if (a === null) return;
    const hidden = isRef(target) && target.current !== null ? !visibleIn(target.current, a) : false;
    if (matchWidth === true) setMatched((was) => (was === a.right - a.left ? was : a.right - a.left));
    const width = element.offsetWidth;
    // The height it WANTS, not the height a previous cap left it: what it scrolls through counts.
    const chrome = element.offsetHeight - element.clientHeight;
    const height = Math.max(element.offsetHeight, element.scrollHeight + chrome);
    const view = { width: window.innerWidth, height: window.innerHeight };
    let next = placeFloat(a, { width, height }, view, side, align, gap);
    if (settle === true && !hidden) {
      if (settled.current === null) settled.current = { dx: next.left - a.left, dy: next.top - a.top };
      else {
        const top = a.top + settled.current.dy;
        const room = Math.max(MIN_HEIGHT, view.height - top - FLOAT_EDGE);
        next = { left: a.left + settled.current.dx, top, maxHeight: height > room ? room : undefined };
      }
    }
    setPlaced((was) =>
      was !== null && Math.abs(was.left - next.left) < 0.5 && Math.abs(was.top - next.top) < 0.5 && was.maxHeight === next.maxHeight && was.hidden === hidden
        ? was
        : { ...next, hidden },
    );
  });

  // Anything moving moves the anchor: follow it. A float whose own content changes size re-places too.
  useEffect(() => {
    const move = (): void => bump((n) => n + 1);
    window.addEventListener("scroll", move, true);
    window.addEventListener("resize", move);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(move);
    if (own.current !== null) observer?.observe(own.current);
    return () => {
      window.removeEventListener("scroll", move, true);
      window.removeEventListener("resize", move);
      observer?.disconnect();
    };
  }, []);

  const classes = `float${className !== undefined ? ` ${className}` : ""}`;
  const card = (
    <div
      {...rest}
      ref={setOwn}
      className={classes}
      style={
        placed === null
          ? // Measured before it is seen: the first frame is laid out transparent, then placed. Not
            // `visibility: hidden`, which would refuse focus to a field inside that focuses itself on mount.
            { ...style, opacity: 0, pointerEvents: "none", left: 0, top: 0, ...(matched !== undefined ? { width: matched } : {}) }
          : {
              ...style,
              left: placed.left,
              top: placed.top,
              // Capped to the room it has, it scrolls inside rather than running off the window.
              ...(placed.maxHeight !== undefined ? { maxHeight: placed.maxHeight, overflowY: "auto" } : {}),
              ...(matched !== undefined ? { width: matched } : {}),
              ...(placed.hidden ? { visibility: "hidden", pointerEvents: "none" } : {}),
            }
      }
    >
      <LayerContext.Provider value={at?.layer ?? parent}>{children}</LayerContext.Provider>
    </div>
  );
  if (typeof document === "undefined") return <div {...rest} className={className} style={style}>{children}</div>;
  // In a seat that draws no box: see `dressSeat`.
  return createPortal(<div style={SEAT}>{card}</div>, document.body);
}

/**
 * A float that places ITSELF — a tooltip that follows the pointer, written to through its ref. It
 * gets the float layer and nothing else: no anchor, no placement, no dismissal.
 */
export const Overlay = forwardRef<HTMLDivElement, DivProps & { children?: ReactNode }>(function Overlay({ className, children, ...rest }, ref) {
  const parent = useContext(LayerContext);
  const own = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (own.current === null || parent === null) return undefined;
    return parent.add(own.current);
  }, [parent]);
  const setRef = (element: HTMLDivElement | null): void => {
    own.current = element;
    assign(ref, element);
  };
  const classes = `float${className !== undefined ? ` ${className}` : ""}`;
  if (typeof document === "undefined") return <div {...rest} ref={setRef} className={className}>{children}</div>;
  return createPortal(
    <div {...rest} ref={setRef} className={classes}>
      {children}
    </div>,
    document.body,
  );
});

/**
 * A hover card the pointer can travel INTO: it stays open for `linger` ms after the anchor is left,
 * and for as long as the pointer is on the card itself. {@link useHover} closes the moment the anchor
 * is left, which is right for a tooltip and wrong for a card whose rows open — the pointer crosses a
 * gap on its way there. Spread `bind` on the anchor and `cardBind` on the float.
 */
export function useHoverCard<T extends HTMLElement>(
  linger = 160,
): {
  open: boolean;
  anchor: RefObject<T | null>;
  bind: Pick<HTMLAttributes<T>, "onMouseEnter" | "onMouseLeave" | "onFocus" | "onBlur">;
  cardBind: Pick<HTMLAttributes<HTMLDivElement>, "onMouseEnter" | "onMouseLeave">;
  close: () => void;
} {
  const [open, setOpen] = useState(false);
  const anchor = useRef<T | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const stay = useCallback(() => {
    clearTimeout(timer.current);
    setOpen(true);
  }, []);
  const leave = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(false), linger);
  }, [linger]);
  const close = useCallback(() => {
    clearTimeout(timer.current);
    setOpen(false);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  return {
    open,
    anchor,
    bind: { onMouseEnter: stay, onMouseLeave: leave, onFocus: stay, onBlur: leave },
    cardBind: { onMouseEnter: stay, onMouseLeave: leave },
    close,
  };
}

/**
 * Open while the pointer is over the anchor or focus is inside it — a hover card. Spread `bind` on
 * the anchor; `open` says whether to draw the float.
 */
export function useHover<T extends HTMLElement>(): {
  open: boolean;
  anchor: RefObject<T | null>;
  bind: Pick<HTMLAttributes<T>, "onMouseEnter" | "onMouseLeave" | "onFocus" | "onBlur">;
} {
  const [open, setOpen] = useState(false);
  const anchor = useRef<T | null>(null);
  return {
    open,
    anchor,
    bind: {
      onMouseEnter: () => setOpen(true),
      onMouseLeave: () => setOpen(false),
      onFocus: () => setOpen(true),
      onBlur: () => setOpen(false),
    },
  };
}
