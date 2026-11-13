import { useMemo } from "react";
import { close, pop, push, topOf, type PanelEntry } from "@jaira/ui/panelStack";
import { artifactEntryOf, leavePane, openInPane, openInSplit, placeMoveOf, publishedOfEntry, shownPlacesOf, type Place } from "@jaira/ui/splitModel";
import type { PublishedRef } from "@jaira/ui/transcriptRows";
import type { ArtifactSurface } from "@jaira/ui/transcriptViewTypes";
import { panelOnStack, panelTop, panelUnfold } from "../components/panel/panelBridge";
import { artifactInMain, sheetAsk, splitHere, splitView } from "./viewState";

/**
 * Putting something in one of the three places (decision 0025): the main view, the right pane of a
 * split, the side panel. The place buttons (`PlaceButtons.tsx`), the panes' ⋯ menus and a drop
 * (`DropZones.tsx`) all go through here, so a thing is put somewhere one way, and an artifact is never
 * in two places after a move.
 *
 * The main view is two things: with no split, an artifact is drawn OVER the room (`artifactInMain`);
 * split, the left pane is a pane like the right, and the artifact goes on its path (‹ returns to what
 * it showed). The places are stores of their own (`artifactInMain`, `splitView`, the panel's stack
 * through `panelBridge.ts`), each drawn by its own region; this is the one module that moves between
 * them.
 */

/**
 * The surface of an artifact drawn away from its conversation: which task and project it reads from. Its
 * frame comes from its own grant, never `serve`, and there is no composer for a page to write into.
 */
export const surfaceOf = (taskId: string, project: string | undefined): ArtifactSurface => ({ serve: () => Promise.reject(new Error("no frame")), taskId, project });

/** What stands on top of each place now, read without drawing. */
function placesNow(): { main: PublishedRef | null; left: PanelEntry | undefined; split: PanelEntry | undefined; panel: PanelEntry | undefined } {
  const split = splitView.get();
  return { main: artifactInMain.get()?.published ?? null, left: topOf(split.left), split: split.right === null ? undefined : topOf(split.right), panel: panelTop.get() };
}

/** Every place an artifact is in now, read as it changes. */
export function useShownPlaces(id: string): Place[] {
  const main = artifactInMain.use();
  const split = splitView.use();
  const panel = panelTop.use();
  const left = topOf(split.left);
  const right = split.right === null ? undefined : topOf(split.right);
  return useMemo(() => shownPlacesOf(id, { main: main?.published ?? null, left, split: right, panel }), [id, main, left, right, panel]);
}

/** The places that can be offered here: the panel while a room has one, a split where the room can split. */
export function usePlacesHere(phone: boolean): { panel: boolean; split: boolean } {
  const panel = panelOnStack.use() !== null;
  const split = splitHere.use();
  return { panel, split: split && !phone };
}

/** Take an artifact away from a place it was in. */
function leave(place: Place, id: string): void {
  if (place === "main") {
    if (artifactInMain.get()?.published.id === id) artifactInMain.set(null);
    const split = splitView.get();
    if (publishedOfEntry(topOf(split.left))?.ref.id === id) splitView.set(leavePane(split, "left"));
  } else if (place === "split") splitView.set(leavePane(splitView.get(), "right"));
  // The panel goes back a level; an artifact that was all it held closes it.
  else panelOnStack.get()?.((was) => (was.entries.length > 1 ? pop(was) : close(was)));
}

/** Put an entry in the side panel, on top of what it holds, and unfold it. */
export function openInPanel(entry: PanelEntry): void {
  panelOnStack.get()?.((was) => push(was, entry));
  panelUnfold.get()?.();
}

/** Put an entry in the right pane: on its path, splitting the column if it was not. */
export function openInRight(entry: PanelEntry): void {
  splitView.set(openInSplit(splitView.get(), entry));
}

/**
 * An artifact to a place, MOVED there: closed wherever else it stood (`placeMoveOf`). On a phone a split
 * is the main view, and the panel's sheet is lowered to its head so the artifact is seen.
 */
export function placeArtifact(target: Place, ref: PublishedRef, artifacts: ArtifactSurface, phone: boolean): void {
  const { open, close: leaving } = placeMoveOf(shownPlacesOf(ref.id, placesNow()), target, phone);
  for (const place of leaving) leave(place, ref.id);
  const entry = artifactEntryOf(ref, artifacts.project);
  if (open === "main") {
    const split = splitView.get();
    if (split.right !== null) splitView.set(openInPane(split, "left", entry));
    else artifactInMain.set({ published: ref, artifacts });
    if (phone) sheetAsk.set({ detent: "peek", at: Date.now() });
  } else if (open === "split") openInRight(entry);
  else openInPanel(entry);
}

/**
 * Anything a pane holds, to a place: an artifact moves as its buttons move it; anything else is opened
 * there — the main view by `toMain` with no split (the room's own way of going to a task or a state),
 * on the left pane's path while split.
 */
export function placeEntry(target: Place, entry: PanelEntry, toMain: (entry: PanelEntry) => void, phone: boolean): void {
  const published = publishedOfEntry(entry);
  if (published !== undefined) {
    placeArtifact(target, published.ref, surfaceOf(published.ref.taskId, published.project), phone);
    return;
  }
  const open = phone && target === "split" ? "main" : target;
  if (open === "main") {
    const split = splitView.get();
    if (split.right !== null) splitView.set(openInPane(split, "left", entry));
    else toMain(entry);
  } else if (open === "split") openInRight(entry);
  else openInPanel(entry);
}
