import { createContext } from "react";

/**
 * Whether a piece of transcript is drawn inside a note row — an adopted task's history, unfolded under
 * the line that adopted it (`SessionBands.tsx`'s `MadeRow`). A message rail inside a note is drawn as the
 * note's own is (no margin above, no floor, no padding, centred, one line, pushed to the row's end), so
 * whatever draws one asks.
 */
export const InNoteContext = createContext(false);
