import { createContext, useContext } from "react";
import type { RendererId, ViewId } from "@jaira/shared/browser";
import type { PictureChoice } from "./pictureSize";

/**
 * How the person last chose to look at an item of a shown set, carried to the next one they step to (the
 * person, 2026-11-22: "inside the multi artifact view, when you change the view settings for one
 * artifact, the same view settings should apply to the next artifact that you look at").
 *
 * What is carried is what the person CHOSE, and only that: the view (Preview, Source, JSON…), whether the
 * artifact's own view leads, the renderer of a view that has two, and a picture's size. An item that has
 * no such view opens at its own default and leaves the choice as it was, so it still applies to the item
 * after it that has one.
 *
 * Held per set for as long as the window is open (`carryOf`), so leaving the set and coming back keeps it.
 * It is handed down where an item of a set is drawn (`SetItemBody`) and nowhere else, and only the item's
 * own value view takes it: one drawn inside another's body is not steered (`ValueView`'s `InsideValueContext`).
 */
export interface ViewCarry {
  view?: ViewId;
  lead?: boolean;
  renderers?: Partial<Record<ViewId, RendererId>>;
  picture?: PictureChoice;
}

export interface ViewCarryStore {
  get: () => ViewCarry;
  set: (patch: ViewCarry) => void;
}

const SETS = new Map<string, ViewCarry>();

/** The carry of one set, by its key. */
export function carryOf(key: string): ViewCarryStore {
  return {
    get: () => SETS.get(key) ?? {},
    set: (patch) => SETS.set(key, { ...(SETS.get(key) ?? {}), ...patch }),
  };
}

export const ViewCarryContext = createContext<ViewCarryStore | null>(null);

export function useViewCarry(): ViewCarryStore | null {
  return useContext(ViewCarryContext);
}
