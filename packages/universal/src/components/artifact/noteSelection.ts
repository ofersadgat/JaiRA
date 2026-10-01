import type { RefObject } from "react";
import type { ReviewNote } from "@jaira/shared/browser";
import type { PendingSelection } from "@jaira/ui/reviewSelection";

/**
 * On a phone: no selection to anchor a note to. React Native's text reports no selection range, so a
 * passage cannot be picked out of a rendered artifact and the composer never opens; the notes a review
 * already carries are listed all the same (`ReviewNotes.tsx`), anchored against the artifact's text.
 * The web half is `noteSelection.web.ts`: `reviewSelection.ts`, over the DOM react-native-web draws.
 */
export type { PendingSelection };
export { HELD_QUOTE, KEEPS_SELECTION } from "@jaira/ui/reviewSelection";
export function useSelectionInside(_ref: RefObject<unknown>): [PendingSelection | null, () => void] {
  return [null, () => undefined];
}
export function useNoteHighlights(_ref: RefObject<unknown>, _notes: readonly ReviewNote[], _hot?: number | null, _drafting?: { start: number; end: number } | null): void {}
/** The text notes are anchored in: the rendered text on web, the artifact's own text here. */
export function useFlatText(_ref: RefObject<unknown>, text: string): string {
  return text;
}
export function useHoveredNote(_ref: RefObject<unknown>, _notes: readonly ReviewNote[]): number | null {
  return null;
}
export function reselect(_root: unknown, _note: ReviewNote): void {}
