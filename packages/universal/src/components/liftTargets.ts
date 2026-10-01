import { useCallback, useRef, useState } from "react";
import type { View as HostView } from "react-native";

/**
 * Where a lifted thing may land on a phone (`Lift.tsx`), found by the finger's point: the desktop's
 * `dragover` is the browser's hit test, and a phone has none for a gesture, so the places are measured
 * in the window when the lift starts (`measure`) and the finger's point is looked up in them (`hit`).
 *
 * `over` is the place under the finger, which is what `dragover`/`dragleave` tell a DOM column. A place
 * is registered with `host(key)`, a ref callback kept per key so it does not change between draws.
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
