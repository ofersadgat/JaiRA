import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type JSX, type ReactNode, type RefObject } from "react";
import { View, type ScrollView } from "react-native";

/**
 * What a phone keeps drawn of a long scroll: the part in view and three screens either side of it.
 *
 * iOS backs every text view with one bitmap the size of its box, on screen or not (`textRuns.ts`): a
 * long conversation, all of it mounted, held hundreds of megabytes of them. So a scroll view says where
 * it stands ({@link useScrollWindow}), and each {@link Virtual} in it — a message, a block of a document,
 * a run of a long text — is drawn while it is near that, and is an empty box of its measured height
 * otherwise: what it holds unmounts, its bitmaps with it.
 *
 * React Native's own `VirtualView` (0.86) was the first way: its JavaScript wrapper declares Flow enums
 * the native build's Flow stripping leaves undefined, and driven directly, its native side crashed
 * Fabric on the emulator (SIGSEGV in `MountingCoordinator::pullTransaction`, 2026-10-27). This is plain
 * React Native: `onLayout`, `measureLayout`, a box's height.
 *
 * `Virtual.web.tsx` is all of it as nothing: a browser draws only what shows.
 */
export interface ScrollWindow {
  /** The scroll view's content, which every piece is measured against. */
  content(): View | null;
  /** The band kept drawn, in the content's coordinates. */
  band(): { top: number; bottom: number };
  /** Hears the band moving (`"scrolled"`) and the content moving under it (`"moved"`: measure again). */
  subscribe(listener: (why: "scrolled" | "moved") => void): () => void;
}

const ScrollWindowContext = createContext<ScrollWindow | null>(null);


/** How far either side of what shows stays drawn: three screens, and never less than this — a fling covers two between scroll events (seen on the emulator). */
const SCREENS = 3;
const AT_LEAST = 2000;
/** A scroll this small does not move the band: drawing follows by the screenful, not the pixel. */
const STEP = 120;

/**
 * A scroll view's half: the window, and what the scroll view tells it — where it is scrolled to, how
 * tall it shows, that its content changed size (where everything in it may have moved: `moved` takes
 * `onContentSizeChange`'s arguments), and that it was sent to its end (`atEnd`): a scroll made by
 * `scrollTo` raises no scroll event on Android, and the window would stay where it was — at the top
 * of a conversation pinned to its foot, every piece of it a box (seen on the emulator, 2026-10-27).
 * The scroll view's content is then given the window with {@link ScrollWindowProvider}.
 */
export function useScrollWindow(scroller: RefObject<ScrollView | null>): {
  window: ScrollWindow;
  scrolled: (y: number) => void;
  sized: (height: number) => void;
  moved: (width?: number, height?: number) => void;
  atEnd: () => void;
} {
  const state = useRef({ y: 0, height: 0, content: 0, listeners: new Set<(why: "scrolled" | "moved") => void>() }).current;
  const scroll = useMemo<ScrollWindow>(
    () => ({
      // `getInnerViewRef`: the content view, a host instance `measureLayout` takes (the typings this
      // project compiles against have only the older node handle, `getInnerViewNode`).
      content: () => (scroller.current as unknown as { getInnerViewRef(): View | null } | null)?.getInnerViewRef() ?? null,
      band: () => {
        const margin = Math.max(state.height * SCREENS, AT_LEAST);
        return { top: state.y - margin, bottom: state.y + state.height + margin };
      },
      subscribe: (listener) => {
        state.listeners.add(listener);
        return () => void state.listeners.delete(listener);
      },
    }),
    [scroller, state],
  );
  const tell = useCallback(
    (why: "scrolled" | "moved") => {
      for (const listener of [...state.listeners]) listener(why);
    },
    [state],
  );
  return {
    window: scroll,
    scrolled: useCallback(
      (y: number) => {
        if (Math.abs(y - state.y) < STEP) return;
        state.y = y;
        tell("scrolled");
      },
      [state, tell],
    ),
    sized: useCallback(
      (height: number) => {
        if (height === state.height) return;
        state.height = height;
        tell("scrolled");
      },
      [state, tell],
    ),
    moved: useCallback(
      (_width?: number, height?: number) => {
        if (height !== undefined) state.content = height;
        tell("moved");
      },
      [state, tell],
    ),
    atEnd: useCallback(() => {
      const y = Math.max(0, state.content - state.height);
      if (y === state.y) return;
      state.y = y;
      tell("scrolled");
    }, [state, tell]),
  };
}

/** The window, for the pieces in a scroll view's content. */
export function ScrollWindowProvider({ window, children }: { window: ScrollWindow; children: ReactNode }): JSX.Element {
  return <ScrollWindowContext.Provider value={window}>{children}</ScrollWindowContext.Provider>;
}

/**
 * A piece of a long scroll a phone draws only near what shows. Drawn whole at first, and measured, so
 * the box it leaves is its own height and the scroll never jumps. Outside a scroll window it is simply
 * drawn.
 */
export function Virtual({ children }: { children: ReactNode }): JSX.Element {
  const scroll = useContext(ScrollWindowContext);
  const ref = useRef<View>(null);
  const box = useRef<{ y: number; height: number } | null>(null);
  // The height of the box left in its place, or `null`: drawn.
  const [left, setLeft] = useState<number | null>(null);
  const judge = useCallback(() => {
    const at = box.current;
    if (at === null || scroll === null) return;
    const { top, bottom } = scroll.band();
    const away = at.y + at.height < top || at.y > bottom;
    setLeft((was) => (away ? (was === at.height ? was : at.height) : null));
  }, [scroll]);
  const measure = useCallback(() => {
    const content = scroll?.content();
    if (content === null || content === undefined || ref.current === null) return;
    ref.current.measureLayout(
      content,
      (_x, y, _width, height) => {
        box.current = { y, height };
        judge();
      },
      () => undefined,
    );
  }, [scroll, judge]);
  useEffect(() => scroll?.subscribe((why) => (why === "moved" ? measure() : judge())), [scroll, measure, judge]);
  if (scroll === null) return <>{children}</>;
  return (
    <View ref={ref} collapsable={false} onLayout={measure} {...(left !== null ? { style: { height: left } } : {})}>
      {left === null ? children : null}
    </View>
  );
}
