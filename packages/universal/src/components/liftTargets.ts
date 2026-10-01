import { useCallback, useRef, useState } from "react";
import type { View as HostView } from "react-native";

/**
 * Where a lifted thing may land on a phone (`Lift.tsx`), found by the finger's point: on web `dragover`
 * is the browser's hit test, and a phone has none for a gesture, so the places are measured in the window
 * when the lift starts (`measure`) and the finger's point is looked up in them (`hit`).
 *
 * `over` is the place under the finger, which is what `dragover`/`dragleave` tell a column on web. A
 * place is registered with `host(key)`, a ref callback kept per key so it does not change between draws.
 */
type Rect = { x: number; y: number; w: number; h: number };

export interface LiftTargets {
  host: (key: string) => (node: HostView | null) => void;
  measure: () => void;
  hit: (x: number, y: number) => string | null;
  move: (x: number, y: number) => void;
  clear: () => void;
  over: string | null;
}

export function useLiftTargets(): LiftTargets {
  const hosts = useRef(new Map<string, HostView>());
  const rects = useRef(new Map<string, Rect>());
  const refs = useRef(new Map<string, (node: HostView | null) => void>());
  const [over, setOver] = useState<string | null>(null);
  const host = useCallback((key: string) => {
    let ref = refs.current.get(key);
    if (ref === undefined) {
      ref = (node: HostView | null) => {
        if (node === null) hosts.current.delete(key);
        else hosts.current.set(key, node);
      };
      refs.current.set(key, ref);
    }
    return ref;
  }, []);
  const measure = useCallback(() => {
    rects.current.clear();
    for (const [key, node] of hosts.current) node.measureInWindow((x, y, w, h) => rects.current.set(key, { x, y, w, h }));
  }, []);
  const hit = useCallback((x: number, y: number): string | null => {
    for (const [key, r] of rects.current) if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return key;
    return null;
  }, []);
  const move = useCallback((x: number, y: number) => {
    const key = hit(x, y);
    setOver((was) => (was === key ? was : key));
  }, [hit]);
  const clear = useCallback(() => setOver(null), []);
  return { host, measure, hit, move, clear, over };
}

/**
 * The picture of a lifted thing that follows the finger on a phone — what the browser draws under the
 * pointer during an HTML5 drag. Where it stands in `root` (the view it is drawn over): the lifted view's
 * place in the window, moved by the finger, in `root`'s own units (the desktop frame scales the shell, so
 * a window point is divided by the scale `root` is drawn at).
 */
export type Ghost = { left: number; top: number; width: number; dx: number; dy: number; x0: number; y0: number; scale: number };

export function ghostOf(node: HostView | null, root: HostView | null, rootWidth: number, x: number, y: number, done: (ghost: Ghost) => void): void {
  if (node === null || root === null || rootWidth <= 0) return;
  root.measureInWindow((rx, ry, rw) => {
    node.measureInWindow((nx, ny, nw) => {
      // `measureInWindow` gives what the window shows; a layout width gives the view's own.
      const scale = rw > 0 ? rw / rootWidth : 1;
      done({ left: (nx - rx) / scale, top: (ny - ry) / scale, width: nw / scale, dx: 0, dy: 0, x0: x, y0: y, scale });
    });
  });
}

/** The ghost moved with the finger. */
export function ghostAt(ghost: Ghost, x: number, y: number): Ghost {
  return { ...ghost, dx: (x - ghost.x0) / ghost.scale, dy: (y - ghost.y0) / ghost.scale };
}

/** The scroller a lifted thing is over, as its host hands it down: where it stands, how far it is scrolled, and a way to move it. */
export interface EdgeScroller {
  /** Its box in the window. */
  measure: (done: (y: number, height: number) => void) => void;
  offset: () => number;
  scrollTo: (y: number) => void;
}

/** How near an edge the finger must be, in the window's units, and how far a step scrolls, in the scroller's. */
const EDGE = 36;
const STEP = 14;

/**
 * A lifted thing held near the top or the foot of its scroller scrolls it, as a browser scrolls what is
 * under an HTML5 drag held at an edge — on a phone nothing does, so a card could only land in a column
 * already on screen. While the finger stays in the band the scroller moves a step a frame; `onScrolled`
 * says by how much it really moved (none at an end), for what was measured when the lift began: the
 * places to land in have moved in the window, and the picture following the finger is drawn in the
 * content, which moved under it.
 */
export function useEdgeScroll(scroller: EdgeScroller | null, onScrolled: (by: number) => void): { begin: () => void; at: (y: number) => void; end: () => void } {
  const box = useRef<{ y: number; height: number } | null>(null);
  const way = useRef(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const last = useRef(0);
  const told = useRef(onScrolled);
  told.current = onScrolled;
  const end = useCallback(() => {
    if (timer.current !== null) clearInterval(timer.current);
    timer.current = null;
    way.current = 0;
    box.current = null;
  }, []);
  const begin = useCallback(() => {
    end();
    if (scroller === null) return;
    last.current = scroller.offset();
    scroller.measure((y, height) => (box.current = { y, height }));
  }, [scroller, end]);
  const at = useCallback(
    (y: number) => {
      if (scroller === null || box.current === null) return;
      // However it came to move since it was last asked — a step of this, or the content growing shorter
      // under it (a drop preview going away) and the scroller stepping back to its new end.
      const moved = (): number => {
        const now = scroller.offset();
        if (now !== last.current) told.current(now - last.current);
        last.current = now;
        return now;
      };
      moved();
      way.current = y < box.current.y + EDGE ? -1 : y > box.current.y + box.current.height - EDGE ? 1 : 0;
      if (way.current === 0 || timer.current !== null) return;
      timer.current = setInterval(() => {
        const now = moved();
        if (way.current === 0) {
          if (timer.current !== null) clearInterval(timer.current);
          timer.current = null;
          return;
        }
        scroller.scrollTo(Math.max(0, now + way.current * STEP));
      }, 16);
    },
    [scroller],
  );
  return { begin, at, end };
}

/** The ghost when the content it is drawn in has scrolled by `by` under a finger that did not move. */
export function ghostScrolled(ghost: Ghost, by: number): Ghost {
  return { ...ghost, y0: ghost.y0 - by * ghost.scale, dy: ghost.dy + by };
}
