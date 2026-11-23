import { createContext, useContext, useEffect, useMemo, useRef, useState, type JSX, type ReactNode, type RefObject } from "react";
import type { ScrollView } from "react-native";

/**
 * `Virtual.tsx` in a browser. A browser keeps no bitmap per text box, so nothing drawn is ever let go
 * here. What it does do is put off drawing a piece far from what shows, when the piece says it may be
 * put off (`lazy`): a long conversation opened at its end drew every message and call above it before
 * the first frame — 16,000 elements and 1.5 s of script for one with 29 mock-ups (2026-11-22). Such a
 * piece is an empty box until it comes within two screens of the scroller's view, and drawn from then
 * on, its state kept like any other's.
 */
export interface ScrollWindow {
  content(): null;
  band(): { top: number; bottom: number };
  subscribe(listener: (why: "scrolled" | "moved") => void): () => void;
  /** The element that scrolls, which a put-off piece watches its distance from. */
  scroller(): HTMLElement | null;
}

const NOTHING = (): void => undefined;
const ScrollWindowContext = createContext<ScrollWindow | null>(null);

export function useScrollWindow(scroller: RefObject<ScrollView | null>): { window: ScrollWindow; scrolled: (y: number) => void; sized: (height: number) => void; moved: (width?: number, height?: number) => void; atEnd: () => void } {
  const window = useMemo<ScrollWindow>(
    () => ({
      content: () => null,
      band: () => ({ top: -Infinity, bottom: Infinity }),
      subscribe: () => () => undefined,
      scroller: () => (scroller.current as unknown as { getScrollableNode?: () => HTMLElement | null } | null)?.getScrollableNode?.() ?? null,
    }),
    [scroller],
  );
  return { window, scrolled: NOTHING, sized: NOTHING, moved: NOTHING, atEnd: NOTHING };
}

export function ScrollWindowProvider({ window, children }: { window: ScrollWindow; children: ReactNode }): JSX.Element {
  return <ScrollWindowContext.Provider value={window}>{children}</ScrollWindowContext.Provider>;
}

/** How near the view a put-off piece must come to be drawn: two screens either side. */
const NEAR = "200% 0px";
/** The height a put-off piece stands at until drawn: a guess, which the scroller's anchoring absorbs. */
const GUESS = 160;

/**
 * A piece of a long scroll. With `lazy`, inside a scroll window, it may start as an empty box (`GUESS`
 * tall) carrying `stamp` — the attributes the thread finds its pieces by (`data-from`, `data-to`,
 * `data-day`), so the day chip and a step picked in the index still find it — and it is drawn once near
 * the view, and stays drawn. Otherwise it is simply drawn.
 */
export function Virtual({ children, lazy = false, stamp }: { children: ReactNode; lazy?: boolean; stamp?: Record<string, string | number> }): JSX.Element {
  const scroll = useContext(ScrollWindowContext);
  const [drawn, setDrawn] = useState(() => !lazy || scroll === null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (drawn || el === null) return undefined;
    if (typeof IntersectionObserver === "undefined") {
      setDrawn(true);
      return undefined;
    }
    const near = new IntersectionObserver((entries) => entries.some((entry) => entry.isIntersecting) && setDrawn(true), { root: scroll?.scroller() ?? null, rootMargin: NEAR });
    near.observe(el);
    return () => near.disconnect();
  }, [drawn, scroll]);
  if (drawn) return <>{children}</>;
  return <div ref={box} aria-hidden style={{ height: GUESS, flexShrink: 0 }} {...stamp} />;
}
