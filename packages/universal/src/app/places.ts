import { useMemo } from "react";
import { close, pop, push, type PanelEntry } from "@jaira/ui/panelStack";
import { artifactEntryOf, leavePane, openInPane, paneOfPlace, placeMoveOf, publishedOfEntry, shownPlacesOf, topOfPath, type Place } from "@jaira/ui/splitModel";
import type { PublishedRef } from "@jaira/ui/transcriptRows";
import type { ArtifactSurface } from "@jaira/ui/transcriptViewTypes";
import { panelOnStack, panelTop, panelUnfold } from "../components/panel/panelBridge";
import { artifactInMain, sheetAsk, splitHere, splitView } from "./viewState";

/**
 * Putting something in one of the three places (decision 0025): the main view, a split, the side panel.
 * The place buttons (`PlaceButtons.tsx`), the panes' ⋯ menus and a drop (`DropZones.tsx`) all go through
 * here, so a thing is put somewhere one way, and an artifact is never in two places after a move.
 *
 * In a room with panes (Tasks, Files, Chat on a computer), the main view is the first pane and a split
 * the second: something put there goes on that pane's path, ‹ returning to what it showed. Where there
 * are no panes (a phone, the Debug room) the main view is an artifact drawn over the room
 * (`artifactInMain`). The places are stores of their own (`artifactInMain`, `splitView`, the panel's
 * stack through `panelBridge.ts`), each drawn by its own region; this is the one module that moves
 * between them.
 */

/**
 * The surface of an artifact drawn away from its conversation: which task and project it reads from. Its
 * frame comes from its own grant, never `serve`, and there is no composer for a page to write into.
 */
export const surfaceOf = (taskId: string, project: string | undefined): ArtifactSurface => ({ serve: () => Promise.reject(new Error("no frame")), taskId, project });

/** What stands on top of each place now, read without drawing. */
function placesNow(): Parameters<typeof shownPlacesOf>[1] {
  const split = splitView.get();
  return { main: artifactInMain.get()?.published ?? null, first: topOfPath(split.panes[0]), second: topOfPath(split.panes[1]), panel: panelTop.get() };
}

/** Every place an artifact is in now, read as it changes. */
export function useShownPlaces(id: string): Place[] {
  const main = artifactInMain.use();
  const split = splitView.use();
  const panel = panelTop.use();
  const first = topOfPath(split.panes[0]);
  const second = topOfPath(split.panes[1]);
  return useMemo(() => shownPlacesOf(id, { main: main?.published ?? null, first, second, panel }), [id, main, first, second, panel]);
}

/** The places that can be offered here: the panel while a room has one, a split where the room can split. */
export function usePlacesHere(phone: boolean): { panel: boolean; split: boolean } {
  const panel = panelOnStack.use() !== null;
  const split = splitHere.use();
  return { panel, split: split && !phone };
}

/** Take an artifact away from a place it was in. */
function leave(place: Place, id: string): void {
  if (place === "panel") {
    // The panel goes back a level; an artifact that was all it held closes it.
    panelOnStack.get()?.((was) => (was.entries.length > 1 ? pop(was) : close(was)));
    return;
  }
  if (place === "main" && artifactInMain.get()?.published.id === id) artifactInMain.set(null);
  const pane = paneOfPlace(place);
  const split = splitView.get();
  if (publishedOfEntry(topOfPath(split.panes[pane]))?.ref.id === id) splitView.set(leavePane(split, pane));
}

/** Put an entry in the side panel, on top of what it holds, and unfold it. */
export function openInPanel(entry: PanelEntry): void {
  panelOnStack.get()?.((was) => push(was, entry));
  panelUnfold.get()?.();
}

/** Put an entry on a pane's path: the first is the main view, the second a split (made if it was not). */
function openAt(place: "main" | "split", entry: PanelEntry): void {
  splitView.set(openInPane(splitView.get(), paneOfPlace(place), entry));
}

/**
 * An artifact to a place, MOVED there: closed wherever else it stood (`placeMoveOf`). On a phone a split
 * is the main view, and the panel's sheet is lowered to its head so the artifact is seen.
 */
export function placeArtifact(target: Place, ref: PublishedRef, artifacts: ArtifactSurface, phone: boolean): void {
  const { open, close: leaving } = placeMoveOf(shownPlacesOf(ref.id, placesNow()), target, phone);
  for (const place of leaving) leave(place, ref.id);
  const entry = artifactEntryOf(ref, artifacts.project);
  if (open === "panel") openInPanel(entry);
  else if (splitHere.get() && !phone) openAt(open, entry);
  else {
    artifactInMain.set({ published: ref, artifacts });
    if (phone) sheetAsk.set({ detent: "peek", at: Date.now() });
  }
}

/** Anything a pane holds, to a place: an artifact moves as its buttons move it; anything else is opened there. */
export function placeEntry(target: Place, entry: PanelEntry, phone: boolean): void {
  const published = publishedOfEntry(entry);
  if (published !== undefined) {
    placeArtifact(target, published.ref, surfaceOf(published.ref.taskId, published.project), phone);
    return;
  }
  const open = phone && target === "split" ? "main" : target;
  if (open === "panel") openInPanel(entry);
  else openAt(open, entry);
}
