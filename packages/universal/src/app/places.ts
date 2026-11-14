import { useMemo } from "react";
import { close, pop, push, type PanelEntry, type PanelStack } from "@jaira/ui/panelStack";
import {
  artifactEntryOf,
  artifactPathOf,
  followedEntry,
  followedSplit,
  leaveArtifactPane,
  litPlacesOf,
  openInPane,
  openPathInPane,
  paneOfPlace,
  placeMoveOf,
  publishedOfEntry,
  shownPlacesOf,
  topOfPath,
  type Place,
  type PlacesAt,
} from "@jaira/ui/splitModel";
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
 * the second: an artifact put in a split stands on its own path, its conversation › it (the person,
 * 2026-11-14), ‹ going to its conversation; put in the main view it goes on that pane's path. Where there are no panes (a phone, the Debug room) the main
 * view is an artifact drawn over the room (`artifactInMain`). The places are stores of their own
 * (`artifactInMain`, `splitView`, the panel's stack through `panelBridge.ts`), each drawn by its own
 * region; this is the one module that moves between them.
 */

/**
 * The surface of an artifact drawn away from its conversation: which task and project it reads from. Its
 * frame comes from its own grant, never `serve`, and there is no composer for a page to write into.
 */
export const surfaceOf = (taskId: string, project: string | undefined): ArtifactSurface => ({ serve: () => Promise.reject(new Error("no frame")), taskId, project });

/** What stands on top of each place now, read without drawing. */
function placesNow(): PlacesAt {
  const split = splitView.get();
  return { main: artifactInMain.get()?.published ?? null, first: topOfPath(split.panes[0]), second: topOfPath(split.panes[1]), panel: panelTop.get() };
}

/**
 * The places a view of an artifact lights, read as they change: those showing it at the version it
 * shows (`litPlacesOf`) — or, a call's card, those opened from the same call (`follows`).
 */
export function useLitPlaces(shown: { id: string; version: number; follows?: number | undefined }): Place[] {
  const main = artifactInMain.use();
  const split = splitView.use();
  const panel = panelTop.use();
  const first = topOfPath(split.panes[0]);
  const second = topOfPath(split.panes[1]);
  const { id, version, follows } = shown;
  return useMemo(() => litPlacesOf({ id, version, follows }, { main: main?.published ?? null, first, second, panel }), [id, version, follows, main, first, second, panel]);
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
  if (publishedOfEntry(topOfPath(split.panes[pane]))?.ref.id === id) splitView.set(leaveArtifactPane(split, pane));
}

/** Put an entry in the side panel, on top of what it holds, and unfold it. */
export function openInPanel(entry: PanelEntry): void {
  panelOnStack.get()?.((was) => push(was, entry));
  panelUnfold.get()?.();
}

/** Close the side panel (the person, 2026-11-14: its place button pressed again where it is lit). */
export function closePanel(): void {
  panelOnStack.get()?.(close);
}

/** Put an entry on a pane's path: the first is the main view, the second a split (made if it was not). */
function openAt(place: "main" | "split", entry: PanelEntry): void {
  splitView.set(openInPane(splitView.get(), paneOfPlace(place), entry));
}

/**
 * An artifact to a place, MOVED there: closed wherever else it stood, any version of it
 * (`placeMoveOf`). In a split it stands on its own path (`artifactPathOf`). On a phone a split is the
 * main view, and the panel's sheet is lowered to its head so the artifact is seen. `follows`: the call
 * it was opened from, which it goes on from (`artifactEntryOf`).
 */
export function placeArtifact(target: Place, ref: PublishedRef, artifacts: ArtifactSurface, phone: boolean, follows?: number): void {
  const { open, close: leaving } = placeMoveOf(shownPlacesOf(ref.id, placesNow()), target, phone);
  for (const place of leaving) leave(place, ref.id);
  const entry = artifactEntryOf(ref, artifacts.project, follows);
  if (open === "panel") openInPanel(entry);
  else if (splitHere.get() && !phone) {
    // A split stands on the artifact's own path; the main view goes on from what it shows, which is
    // often the room's own view (the Tasks room's board) — ‹ goes back to it.
    if (open === "split") splitView.set(openPathInPane(splitView.get(), paneOfPlace(open), artifactPathOf(ref, artifacts.project, follows)));
    else openAt(open, entry);
  } else {
    artifactInMain.set({ published: ref, artifacts });
    if (phone) sheetAsk.set({ detent: "peek", at: Date.now() });
  }
}

/**
 * A place button of an artifact's view pressed. Where it is lit: the side panel closes (the person,
 * 2026-11-14); the main view and a split already show it, and stay as they are. Unlit, it is put there
 * (`placeArtifact`), whatever version of it stood there before.
 */
export function pressPlace(target: Place, lit: readonly Place[], ref: PublishedRef, artifacts: ArtifactSurface, phone: boolean, follows?: number): void {
  if (lit.includes(target)) {
    if (target === "panel") closePanel();
    return;
  }
  placeArtifact(target, ref, artifacts, phone, follows);
}

/** Anything a pane holds, to a place: an artifact moves as its buttons move it; anything else is opened there. */
export function placeEntry(target: Place, entry: PanelEntry, phone: boolean): void {
  const published = publishedOfEntry(entry);
  if (published !== undefined) {
    placeArtifact(target, published.ref, surfaceOf(published.ref.taskId, published.project), phone, published.follows);
    return;
  }
  const open = phone && target === "split" ? "main" : target;
  if (open === "panel") openInPanel(entry);
  else openAt(open, entry);
}

/**
 * A conversation's publishes, as its transcript reads them (`publishSuccessorsOf`): every view opened
 * from a call a later one in the same run replaced goes on to that one — both panes' paths and the side
 * panel's stack, in place, no step added to either.
 */
export function followPublishes(successors: ReadonlyMap<string, PublishedRef>): void {
  if (successors.size === 0) return;
  const split = splitView.get();
  const moved = followedSplit(split, successors);
  if (moved !== split) splitView.set(moved);
  panelOnStack.get()?.((was) => followedStack(was, successors));
}

function followedStack(stack: PanelStack, successors: ReadonlyMap<string, PublishedRef>): PanelStack {
  let moved = false;
  const step = (entry: PanelEntry): PanelEntry => {
    const next = followedEntry(entry, successors) as PanelEntry;
    if (next !== entry) moved = true;
    return next;
  };
  const entries = stack.entries.map(step);
  const ahead = stack.ahead.map(step);
  return moved ? { ...stack, entries, ahead, motion: "none" } : stack;
}
