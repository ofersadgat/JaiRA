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
