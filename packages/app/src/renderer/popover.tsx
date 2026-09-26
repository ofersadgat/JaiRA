/**
 * Everything that floats: popovers, submenus, dropdowns, completion lists, hover cards, tooltips.
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
 *  - **the anchor's palette.** Tokens are re-declared on subtrees — the sidebar has a dark set of
 *    its own, an editor its theme's — and a float moved to `<body>` would otherwise lose them and
 *    paint in the window's colours. The custom properties that differ between the anchor and the
 *    body are copied onto the float;
 *  - **dismissal**, through {@link usePopover}: a press outside closes it, where "outside" excludes
 *    the anchor, the float, and every float opened from inside it (they are not its DOM descendants
 *    any more — a context carries them up); Escape closes the innermost open one only.
 *
 * With no document (a server render, which is how the tests and the catalog draw a still picture)
 * a float renders in place, so the markup is what it always was.
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

/** Room kept between a float and its anchor, and between a float and the window's edge. */
export const FLOAT_GAP = 6;
export const FLOAT_EDGE = 4;
/** The least height a float is squeezed to before it is allowed to overlap its anchor instead. */
const MIN_HEIGHT = 120;

/** A box in window coordinates — a selection's rect, a caret, a pointer (a rect of no size). */
export interface FloatRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** What a float is placed against: a live element, or a place in the window. */
export type FloatAnchor = RefObject<Element | null> | FloatRect | { x: number; y: number };

/** Which side of the anchor a float prefers. It takes the other one when that has more room. */
export type FloatSide = "above" | "below" | "left" | "right";
/**
 * Which edges line up along the other axis: `start` puts the float's left (or top) edge on the
 * anchor's, `end` its right (or bottom) edge, `center` their middles.
 */
export type FloatAlign = "start" | "end" | "center";

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

/** Where a float of `width` × `height` goes against `a`. Pure, so it can be read on its own. */
export function placeFloat(
  a: FloatRect,
  size: { width: number; height: number },
  view: { width: number; height: number },
  side: FloatSide,
  align: FloatAlign,
  gap: number = FLOAT_GAP,
): { left: number; top: number; maxHeight: number | undefined } {
  const { width, height } = size;
  const clampX = (x: number): number => Math.max(FLOAT_EDGE, Math.min(x, view.width - width - FLOAT_EDGE));
  const clampY = (y: number): number => Math.max(FLOAT_EDGE, Math.min(y, view.height - height - FLOAT_EDGE));
  const along = (start: number, end: number, extent: number): number =>
    align === "start" ? start : align === "end" ? end - extent : (start + end) / 2 - extent / 2;

  if (side === "above" || side === "below") {
    const above = a.top - gap - FLOAT_EDGE;
    const below = view.height - a.bottom - gap - FLOAT_EDGE;
    const wanted = side === "above" ? above : below;
    const other = side === "above" ? below : above;
    const up = height <= wanted || wanted >= other ? side === "above" : side !== "above";
    const room = Math.max(MIN_HEIGHT, up ? above : below);
    const shown = Math.min(height, room);
    const top = up ? a.top - gap - shown : a.bottom + gap;
    return {
      left: clampX(along(a.left, a.right, width)),
      top: Math.max(FLOAT_EDGE, Math.min(top, view.height - shown - FLOAT_EDGE)),
      maxHeight: height > room ? room : undefined,
    };
  }
  const leftRoom = a.left - gap - FLOAT_EDGE;
  const rightRoom = view.width - a.right - gap - FLOAT_EDGE;
  const wanted = side === "left" ? leftRoom : rightRoom;
  const other = side === "left" ? rightRoom : leftRoom;
  const toLeft = width <= wanted || wanted >= other ? side === "left" : side !== "left";
  const roomY = view.height - 2 * FLOAT_EDGE;
  return {
    left: clampX(toLeft ? a.left - gap - width : a.right + gap),
    top: clampY(along(a.top, a.bottom, Math.min(height, roomY))),
    maxHeight: height > roomY ? roomY : undefined,
  };
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
  if (declared !== null) return declared;
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
  for (const sheet of Array.from(document.styleSheets)) {
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
 * The tokens the anchor sees differently from `<body>` — the sidebar's dark set, an editor's theme —
 * so a float carried out to `<body>` keeps the colours of the place it opened from.
 */
function tokensOf(element: Element): Array<[string, string]> {
  const here = getComputedStyle(element);
  const base = getComputedStyle(document.body);
  const out: Array<[string, string]> = [];
  for (const name of declaredTokens()) {
    const value = here.getPropertyValue(name);
    if (value !== base.getPropertyValue(name)) out.push([name, value]);
  }
  const scheme = here.getPropertyValue("color-scheme");
  if (scheme !== base.getPropertyValue("color-scheme")) out.push(["color-scheme", scheme]);
  return out;
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
  /** The float's own element, for a host that dismisses it by rules of its own (the context menu). */
  ref?: Ref<HTMLDivElement> | undefined;
  children?: ReactNode;
}

/**
 * A float placed against an anchor, drawn over everything. The element it renders IS the card:
 * `className` styles it, and the layer's own `.float` rule makes it fixed on the float layer.
 */
export function Popover({ anchor, at, side = "below", align = "start", gap, matchWidth, ref, className, style, children, ...rest }: PopoverProps): JSX.Element {
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
    for (const [name, value] of tokensOf(anchorElement)) element.style.setProperty(name, value);
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
    const next = placeFloat(a, { width, height }, { width: window.innerWidth, height: window.innerHeight }, side, align, gap);
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
  return createPortal(card, document.body);
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
