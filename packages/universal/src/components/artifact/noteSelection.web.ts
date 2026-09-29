/**
 * Reading a selection in the artifact's well, painting the notes over it, and hit-testing the pointer
 * against them — on web, the desktop's own code (`reviewSelection.ts`) over the DOM react-native-web
 * draws: the well's element is a DOM element, and its text is `textContent` as the DOM's is. A phone has
 * no document to select in (`noteSelection.ts`).
 */
export { HELD_QUOTE, KEEPS_SELECTION, reselect, useFlatText, useHoveredNote, useNoteHighlights, useSelectionInside, type PendingSelection } from "@jaira/ui/reviewSelection";
