import { createContext } from "react";

/**
 * Whether a piece of transcript is drawn inside a note row — an adopted task's history, unfolded under
 * the line that adopted it (`SessionBands.tsx`'s `MadeRow`). The DOM's rules for a note's own rail reach
 * every message rail inside it (`.sb-note .ts-rail`: no margin above, no floor, no padding, centred, one
 * line, pushed to the row's end), so the copies that draw one ask.
 */
export const InNoteContext = createContext(false);
