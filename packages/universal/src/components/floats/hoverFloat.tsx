import { useEffect, useRef, useState, type JSX, type MutableRefObject, type ReactNode } from "react";
import { Pressable } from "react-native";
import { isWeb } from "@tamagui/core";
import type { FloatRect } from "@jaira/ui/floatPlace";
import { useCanHover } from "../../canHover";
import { MenuLayer } from "../MenuLayer";
import { HoverLayer } from "../panel/HoverLayer";

/**
 * Something that shows more of itself in a float — a hover card, a tip with a breakdown in it — and how
 * it is opened, which is the POINTER's to decide (`canHover.ts`), not the platform's:
 *
 *   a pointer that hovers     open while it is over the anchor or the float, or while the keyboard's
 *                             focus is on the anchor; closed `linger` ms after it leaves. The float is
 *                             drawn in the `HoverLayer`, which leaves the page under it to the pointer.
 *   a finger (the phone app,  a press on the anchor opens it, as a modal: it is drawn in the `MenuLayer`
 *   a phone's browser)        — over everything, nothing under it taking a touch — and a press anywhere
 *                             outside it closes it (on web, Escape too).
 *
 * `useHoverFloat` is its state; spread `bind` on the anchor (and hand it `anchor` as its ref), wrap the
 * anchor in `Tap`, spread `cardBind` on the float if the pointer may travel into it, and draw the float
 * in `HoverFloatLayer`. While it is open it follows its anchor: anything scrolling or the window
 * resizing moves the anchor, and the float is placed against where it is now.
 */
export interface HoverFloat {
  open: boolean;
  /** The anchor's ref: what the float is placed against. */
  anchor: MutableRefObject<unknown>;
  /** Where the anchor stood when it was last measured, in the window. */
  rect: FloatRect | null;
  /** The pointer hovers: `false` where the float opens on a press. */
  hovers: boolean;
  /** For the anchor: the pointer's and the focus's events. Nothing under a finger. */
  bind: Record<string, unknown>;
  /** For the float: it stays open while the pointer is on it. */
  cardBind: Record<string, unknown>;
  /** A press on the anchor, under a finger: opens it, or closes it if it is open. */
  press: () => void;
  close: () => void;
}

type Measured = { getBoundingClientRect?: () => { left: number; top: number; right: number; bottom: number }; measureInWindow?: (then: (x: number, y: number, w: number, h: number) => void) => void };

export function useHoverFloat(linger = 160): HoverFloat {
  const hovers = useCanHover();
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<FloatRect | null>(null);
  const anchor = useRef<unknown>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Where the anchor is now; `then` once it is known (at once on web, a frame later on a phone). */
  const measure = (then?: () => void): void => {
    const el = anchor.current as Measured | null;
    if (el !== null && typeof el.getBoundingClientRect === "function") {
      const r = el.getBoundingClientRect();
      setRect({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
      then?.();
    } else if (el !== null && typeof el.measureInWindow === "function") {
      el.measureInWindow((x, y, w, h) => {
        setRect({ left: x, top: y, right: x + w, bottom: y + h });
        then?.();
      });
    }
  };
  const stay = (): void => {
    clearTimeout(timer.current);
    measure();
    setOpen(true);
  };
  const leave = (): void => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(false), linger);
  };
  const close = (): void => {
    clearTimeout(timer.current);
    setOpen(false);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!open || !isWeb || typeof window === "undefined") return undefined;
    const follow = (): void => measure();
    window.addEventListener("scroll", follow, true);
    window.addEventListener("resize", follow);
    return () => {
      window.removeEventListener("scroll", follow, true);
      window.removeEventListener("resize", follow);
    };
    // `measure` reads the anchor's ref, which is the same box for as long as the float is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return {
    open,
    anchor,
    rect,
    hovers,
    bind: hovers ? { onMouseEnter: stay, onMouseLeave: leave, onFocus: stay, onBlur: leave } : {},
    cardBind: hovers ? { onMouseEnter: stay, onMouseLeave: leave } : {},
    press: () => {
      if (hovers) return;
      if (open) return close();
      // Opened once the anchor is measured: a float placed against nothing would be drawn at the corner first.
      measure(() => setOpen(true));
    },
    close,
  };
}

/** Where the float is drawn: the hover layer under a pointer that hovers, a modal under a finger. */
export function HoverFloatLayer({ hover, children }: { hover: Pick<HoverFloat, "hovers" | "close">; children: ReactNode }): JSX.Element {
  return hover.hovers ? <HoverLayer>{children}</HoverLayer> : <MenuLayer onClose={hover.close}>{children}</MenuLayer>;
}

/**
 * The anchor, pressable where there is no hover: what is pointed at under a mouse is tapped under a
 * finger. `style` is what the anchor's box said of its place in its parent (its flex, its width) — the
 * pressable stands there in its stead.
 */
export function Tap({ hover, style, children }: { hover: Pick<HoverFloat, "hovers" | "press">; style?: Record<string, unknown>; children: ReactNode }): JSX.Element {
  if (hover.hovers) return <>{children}</>;
  return (
    <Pressable onPress={hover.press} style={style as never}>
      {children}
    </Pressable>
  );
}
