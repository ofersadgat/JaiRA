/**
 * A design canvas's index, `project/canvas.json` (decision 0020 §5), as Claude Design's instructions write it
 * — read leniently, so a file the model got wrong draws what it can rather than nothing. Its own module
 * so the island page can read an index without loading the board.
 */
/** One artboard's entry in `canvas.json`'s `boards`. */
export interface CanvasBoardEntry {
  x: number;
  y: number;
  w: number;
  h: number;
  title?: string;
  page?: string;
  expand?: string;
  is_interactive?: boolean;
  radius?: number;
  frameless?: boolean;
}

/** A note on the board: a title over several artboards, a sticky, or one of a person's shapes. */
export interface CanvasNote {
  x: number;
  y: number;
  text?: string;
  kind?: string;
  w?: number;
  h?: number;
  maxW?: number;
  size?: string | number;
  bold?: boolean;
  italic?: boolean;
  color?: string;
  fill?: string;
  page?: string;
  /** A line or arrow's other end, and a pen stroke's points — as the editor writes them. */
  x2?: number;
  y2?: number;
  points?: Array<[number, number]>;
}

export interface CanvasIndex {
  v?: number;
  title?: string;
  boards: Record<string, CanvasBoardEntry>;
  order?: string[];
  notes?: Record<string, CanvasNote>;
  pages?: Array<{ id: string; name: string }>;
  launch?: { view?: string; page?: string; file?: string };
}

/** `canvas.json` read leniently: a file the model got wrong draws what it can rather than nothing. */
export function readCanvasIndex(text: string | undefined): CanvasIndex {
  try {
    const parsed = JSON.parse(text ?? "") as Partial<CanvasIndex>;
    const boards = parsed.boards !== null && typeof parsed.boards === "object" ? parsed.boards : {};
    return { ...parsed, boards: boards as Record<string, CanvasBoardEntry> };
  } catch {
    return { boards: {} };
  }
}
