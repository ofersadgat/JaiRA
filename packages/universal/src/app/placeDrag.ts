import { useSyncExternalStore } from "react";
import { isWeb } from "@tamagui/core";
import type { PanelEntry } from "@jaira/ui/panelStack";
import { dropZonesOf, zoneAt, type DropZone, type Place, type ZoneRect } from "@jaira/ui/splitModel";

/**
 * Dragging something to a place (decision 0025, boards 08 and 09): an artifact by its card's title bar,
 * a conversation or a task by its row in the sidebar. Web and desktop only — a phone has no split, and
 * its press is its drag. Pointer events on the element, as the board's card drag is: a press that moves
 * 6px is a drag (less is still the press it was), the drop zones stand over the room while it goes on
 * (`DropZones.tsx`, which also does what a drop asks), and the click a drag ends in is swallowed, so a
 * row dropped is not also a row pressed.
 */

/** A drag going on: what is dragged, what it is called, where the pointer is, and the zones it can land in. */
export interface PlaceDragState {
  entry: PanelEntry;
  label: string;
  /** `place`: an artifact, to any of the three places; `pane`: a sidebar row, onto a pane's path (board 09). */
  kind: DragKind;
  x: number;
  y: number;
  zones: DropZone[];
}

let current: PlaceDragState | null = null;
const listeners = new Set<() => void>();
const set = (next: PlaceDragState | null): void => {
  current = next;
  for (const on of listeners) on();
};
const subscribe = (on: () => void): (() => void) => {
  listeners.add(on);
  return () => void listeners.delete(on);
};

/** The drag going on, read as it moves. */
export function usePlaceDrag(): PlaceDragState | null {
  return useSyncExternalStore(subscribe, () => current, () => current);
}

export type DragKind = "place" | "pane";

/** What a drop does: `DropZones` sets it while it is drawn. */
let dropper: ((place: Place, entry: PanelEntry, kind: DragKind) => void) | null = null;
export function setDropper(next: ((place: Place, entry: PanelEntry, kind: DragKind) => void) | null): void {
  dropper = next;
}

/** Where the panes and the panel stand now: the boxes marked `data-place` (`LeftPane`, `SplitPane`, `PanelColumn`). */
function placeRects(): { main?: ZoneRect; split?: ZoneRect; panel?: ZoneRect } {
  const out: { main?: ZoneRect; split?: ZoneRect; panel?: ZoneRect } = {};
  for (const place of ["main", "split", "panel"] as const) {
    const el = document.querySelector(`[data-place="${place}"]`);
    if (el === null) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) out[place] = { left: r.left, top: r.top, width: r.width, height: r.height };
  }
  return out;
}

const MOVED = 6;

/**
 * Whether the press going on — or the last one — became a drag. A row's long press opens its menu; one
 * the person dragged away is not a long press, and the row's own press never hears it let go (the
 * release lands on the drag's sheet), so the row asks here before it opens anything.
 */
let spent = false;
export function pressWasDrag(): boolean {
  return spent;
}

/**
 * Make an element a place to drag from. `pick` says what a press at a target inside it would drag —
 * null where nothing is (a button inside it keeps its press). Answers the way to stop listening.
 */
export function dragFrom(el: unknown, pick: (target: Element) => { entry: PanelEntry; label: string; kind: DragKind } | null): () => void {
  const host = el as HTMLElement | null;
  if (!isWeb || host === null || typeof host.addEventListener !== "function") return () => undefined;
  const onDown = (down: PointerEvent): void => {
    // A finger scrolls what it is on; a mouse or a pen drags.
    if (down.button !== 0 || down.pointerType === "touch" || !(down.target instanceof Element)) return;
    const picked = pick(down.target);
    spent = false;
    if (picked === null) return;
    let zones: DropZone[] | null = null;
    const move = (e: PointerEvent): void => {
      if (zones === null) {
        if (Math.abs(e.clientX - down.clientX) < MOVED && Math.abs(e.clientY - down.clientY) < MOVED) return;
        zones = dropZonesOf(placeRects(), picked.kind === "pane");
        // From here a sheet over the window takes the pointer (`DropZones`): a page in its frame under
        // it would otherwise take the moves and the release, and the drag would never hear it let go.
        if (zones.length === 0) return end();
        spent = true;
      }
      e.preventDefault();
      set({ ...picked, x: e.clientX, y: e.clientY, zones });
    };
    const up = (e: PointerEvent): void => {
      const dragged = zones !== null;
      const zone = zones === null ? undefined : zoneAt(zones, e.clientX, e.clientY);
      end();
      if (!dragged) return;
      // The click this press ends in is the drag's, not the row's or the card's.
      const swallow = (click: Event): void => {
        click.stopPropagation();
        click.preventDefault();
      };
      window.addEventListener("click", swallow, true);
      setTimeout(() => window.removeEventListener("click", swallow, true), 0);
      if (zone !== undefined) dropper?.(zone.place, picked.entry, picked.kind);
    };
    const key = (e: KeyboardEvent): void => {
      if (e.key === "Escape") end();
    };
    const end = (): void => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("keydown", key, true);
      if (current !== null) set(null);
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("keydown", key, true);
  };
  host.addEventListener("pointerdown", onDown);
  return () => host.removeEventListener("pointerdown", onDown);
}
