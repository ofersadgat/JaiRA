import { createContext, useContext, useState } from "react";

/**
 * How big a picture is drawn, as a share of its natural size (1 = 1:1), and what the person's controls
 * do to it (`SizedPicture.tsx`). A picture nobody has sized is drawn as it always was: no wider than its
 * column, no taller than {@link TALLEST}, never larger than itself.
 */
export const SCALE_MIN = 0.1;
export const SCALE_MAX = 2;
/** A dragged corner this close to Fit or 1:1 stops there. */
export const SNAP = 8;
/** The tallest a picture nobody has sized is drawn. */
export const TALLEST = 420;

export interface Natural {
  width: number;
  height: number;
}

export const clampScale = (scale: number): number => Math.min(SCALE_MAX, Math.max(SCALE_MIN, scale));

/** A picture nobody has sized: its column's width at most, {@link TALLEST} at most, never above 1:1. */
export const defaultScale = (natural: Natural, room: number): number => Math.min(1, room / natural.width, TALLEST / natural.height);

/** Fit: the column's width exactly, larger than itself if it is small. */
export const fitScale = (natural: Natural, room: number): number => clampScale(room / natural.width);

/** − and +: to the next tenth down or up — 26% goes to 20% and 30%. */
export function stepScale(scale: number, dir: 1 | -1): number {
  const tenths = scale * 10;
  // A hair's tolerance: 0.3 * 10 is 2.9999999999999996.
  const next = dir > 0 ? Math.floor(tenths + 1e-6) + 1 : Math.ceil(tenths - 1e-6) - 1;
  return clampScale(next / 10);
}

/** The corner dragged `dx` from where it was `startWidth` wide: the width it comes to, held at Fit and 1:1 within {@link SNAP}. */
export function dragScale(startWidth: number, dx: number, natural: Natural, room: number): number {
  let width = startWidth + dx;
  if (Math.abs(width - room) <= SNAP) width = room;
  else if (Math.abs(width - natural.width) <= SNAP) width = natural.width;
  return clampScale(width / natural.width);
}

/** What the chip says: the scale as a whole percent. */
export const percentOf = (scale: number): string => `${Math.round(scale * 100)}%`;

/**
 * The sizes given in one conversation, by the picture's source: kept while the conversation is open
 * (a picture drawn again — a phase folded and opened, a long thread's window moving — keeps its size)
 * and dropped when it is left (the person's ruling, 2026-11-14: "until you leave"). Its provider is the
 * conversation (`ChatThread`); a picture drawn outside one keeps its size for as long as it is drawn.
 */
export const PictureSizesContext = createContext<Map<string, number> | null>(null);

/** One picture's size: `null` until the person gives it one. */
export function usePictureSize(src: string): [number | null, (scale: number | null) => void] {
  const sizes = useContext(PictureSizesContext);
  const [scale, setScale] = useState<number | null>(() => sizes?.get(src) ?? null);
  return [
    scale,
    (next) => {
      if (next === null) sizes?.delete(src);
      else sizes?.set(src, next);
      setScale(next);
    },
  ];
}

/**
 * A size the person chose, as they chose it: Fit, 1:1, or a share of the natural size. Fit and 1:1 are
 * kept as words, not numbers, so a choice carried to another picture (`viewCarry.ts`) fits THAT picture.
 */
export type PictureChoice = "fit" | "actual" | number;

/** The choice a scale set by a control says: Fit and 1:1 by the button that set them, else the number. */
export function choiceOf(scale: number, natural: Natural, room: number): PictureChoice {
  if (Math.abs(scale - fitScale(natural, room)) < 1e-6) return "fit";
  if (Math.abs(scale - 1) < 1e-6) return "actual";
  return scale;
}

/**
 * How big a picture opens: the size the person gave it here, else the choice carried to it, else Fit
 * where it stands on its own (the side panel, the main view, a split — the person, 2026-11-22: "the
 * image viewer should start by default at 'fit'"), else the conversation's rest size ({@link defaultScale}).
 */
export function openingScale(natural: Natural, room: number, given: number | null, carried: PictureChoice | undefined, alone: boolean): number {
  if (given !== null) return given;
  const choice = carried ?? (alone ? "fit" : undefined);
  if (choice === "fit") return fitScale(natural, room);
  if (choice === "actual") return 1;
  if (typeof choice === "number") return clampScale(choice);
  return defaultScale(natural, room);
}
