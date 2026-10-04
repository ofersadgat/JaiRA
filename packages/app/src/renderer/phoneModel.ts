/**
 * The phone's layout (decision 0015, amended 2026-10-04: the mobile pass). What decides it, as plain
 * functions: when a window is a phone's, how much larger its text is, the context panel's sheet — its
 * heights and where a drag lets it go — and the board's column strip. The shell draws from these
 * (`packages/universal/src/app/PhoneFrame.tsx`, `components/panel/PanelSheet.tsx`, `components/Board.tsx`).
 */

/** A window narrower than this is a phone's: the shell lays itself out for it instead of fitting the desktop's. */
export const PHONE_WIDTH = 700;

export function isPhoneWidth(width: number): boolean {
  return width > 0 && width < PHONE_WIDTH;
}

/**
 * The phone's text, relative to the desktop's: a finger and an arm's length want it larger, and the two
 * bases (`--size-app`, `--size-data`) carry every size that is written as a multiple of them.
 */
export const PHONE_TEXT = 1.16;

/** The two bases (and the editor's, when it is set apart), scaled for the phone. Other overrides pass through. */
export function phoneTypography(overrides: Readonly<Record<string, string>>, scale = PHONE_TEXT): Record<string, string> {
  const out: Record<string, string> = { ...overrides };
  for (const [name, fallback] of [
    ["size-app", 12.5],
    ["size-data", 12],
  ] as const) {
    const given = parseFloat(overrides[name] ?? "");
    out[name] = `${round2((Number.isFinite(given) ? given : fallback) * scale)}px`;
  }
  const editor = parseFloat(overrides["size-editor"] ?? "");
  if (Number.isFinite(editor)) out["size-editor"] = `${round2(editor * scale)}px`;
  return out;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The context panel on a phone is a sheet over the room, at one of three heights: its header alone
 * (`peek`), half the room (`half`), or all of it but a strip at the top (`full`). Dragged past full it
 * — or flicked up while full — moves the conversation into the main view (`main`); dragged down past its
 * header it closes (`close`).
 */
export type SheetDetent = "peek" | "half" | "full";
export type SheetSettle = SheetDetent | "main" | "close";
export interface SheetHeights {
  peek: number;
  half: number;
  full: number;
}

/** The room left over the sheet at full height: a strip of what is under it, to know it is a sheet. */
export const SHEET_TOP_GAP = 10;
/** How far past full (or under the header) a drag must go to mean "into the main view" (or "close"). */
export const SHEET_PAST = 40;
/** A flick: a release faster than this (px/ms) moves one height in its direction. */
export const SHEET_FLICK = 0.6;

/** The three heights in a room `room` tall, with a header `header` tall. */
export function sheetHeights(room: number, header: number): SheetHeights {
  const full = Math.max(0, room - SHEET_TOP_GAP);
  const peek = Math.min(full, Math.max(0, header));
  const half = Math.min(full, Math.max(peek, Math.round(room * 0.52)));
  return { peek, half, full };
}

/**
 * Where a drag released at height `height`, moving at `velocity` (px/ms, positive downward), settles.
 * `canMain`: whether there is a main view to move into (a task's conversation).
 */
export function settleSheet(height: number, velocity: number, h: SheetHeights, canMain: boolean): SheetSettle {
  if (canMain && (height > h.full + SHEET_PAST || (velocity < -SHEET_FLICK && height >= h.full - 4))) return "main";
  if (height < h.peek - SHEET_PAST || (height < h.peek && velocity > SHEET_FLICK)) return "close";
  const order: SheetDetent[] = ["peek", "half", "full"];
  const at = (d: SheetDetent): number => h[d];
  if (Math.abs(velocity) > SHEET_FLICK) {
    // A flick goes one height on from the nearest one at or behind where it was let go.
    if (velocity < 0) return order.find((d) => at(d) > height + 1) ?? "full";
    return [...order].reverse().find((d) => at(d) < height - 1) ?? "peek";
  }
  return order.reduce((best, d) => (Math.abs(at(d) - height) < Math.abs(at(best) - height) ? d : best), "peek" as SheetDetent);
}

/** The height a drag shows: the finger's, held to the heights it may reach (with a little give past each end). */
export function dragHeight(start: number, dy: number, h: SheetHeights, canMain: boolean): number {
  const raw = start - dy;
  const top = h.full + (canMain ? SHEET_PAST * 1.6 : 12);
  return Math.max(0, Math.min(top, raw));
}

/**
 * The board's column strip on a phone: "All" first, then each column by name and count. What is shown
 * is "all" (every column stacked) or one column's key.
 */
export type BoardShown = "all" | { column: string };

export interface StripColumn {
  key: string;
  label: string;
  count: number;
}

/** Consecutive empty columns, which the stacked view folds into one line. */
export type StackedPart = { kind: "column"; column: StripColumn; index: number } | { kind: "empties"; columns: { column: StripColumn; index: number }[] };

export function stackedParts(columns: readonly StripColumn[]): StackedPart[] {
  const parts: StackedPart[] = [];
  columns.forEach((column, index) => {
    if (column.count > 0) {
      parts.push({ kind: "column", column, index });
      return;
    }
    const last = parts[parts.length - 1];
    if (last?.kind === "empties") last.columns.push({ column, index });
    else parts.push({ kind: "empties", columns: [{ column, index }] });
  });
  return parts;
}

/** The column shown after a swipe: one on in the swipe's direction, held to the ends. */
export function swipeColumn(columns: readonly StripColumn[], shown: BoardShown, direction: 1 | -1): BoardShown {
  if (columns.length === 0) return "all";
  if (shown === "all") return direction > 0 ? { column: columns[0]!.key } : "all";
  const at = columns.findIndex((c) => c.key === shown.column);
  const next = at + direction;
  if (next < 0) return "all";
  return { column: columns[Math.min(columns.length - 1, next)]!.key };
}

/** What is shown, made sound against the columns there are now: a column that went is "all". */
export function shownOf(shown: BoardShown, columns: readonly StripColumn[]): BoardShown {
  return shown === "all" || columns.some((c) => c.key === shown.column) ? shown : "all";
}

/**
 * The Steps rail at a phone's conversation edge (`StepsRail`): the run's index flattened to a strip,
 * pulled left into the index itself. `pull` is how far out it is, 0 (the strip) to 1 (the index).
 */
export const RAIL_WIDTH = 30;
export const RAIL_OPEN = 300;
/** The lanes' spacing at rest, as a share of the index's. */
export const RAIL_SQUEEZE = 0.22;

/** How far out a pull that started at `from` is, the finger `dx` along (left is out). */
export function railPull(from: number, dx: number, open = RAIL_OPEN, rest = RAIL_WIDTH): number {
  return Math.max(0, Math.min(1, from - dx / Math.max(1, open - rest)));
}

/** The rail's width, the lanes' spacing and the rows' opacity, `pull` out. */
export function railAt(pull: number, open = RAIL_OPEN, rest = RAIL_WIDTH): { width: number; squeeze: number; fade: number } {
  const p = Math.max(0, Math.min(1, pull));
  return { width: Math.round(rest + p * (open - rest)), squeeze: RAIL_SQUEEZE + p * (1 - RAIL_SQUEEZE), fade: p };
}

/** Which of `count` rows, filling `height`, a finger at `y` is on. */
export function scrubRow(y: number, height: number, count: number): number {
  if (count <= 0 || height <= 0) return 0;
  return Math.max(0, Math.min(count - 1, Math.floor((y / height) * count)));
}

/** The names of a state's ancestors, outermost first, for the label a scrub shows. */
export function ancestorsOf<N extends { instanceId: string; parentInstanceId?: string | undefined }>(node: N, byId: ReadonlyMap<string, N>, name: (n: N) => string): string[] {
  const out: string[] = [];
  let at = node.parentInstanceId === undefined ? undefined : byId.get(node.parentInstanceId);
  while (at !== undefined && out.length < 12) {
    out.unshift(name(at));
    at = at.parentInstanceId === undefined ? undefined : byId.get(at.parentInstanceId);
  }
  return out;
}

/**
 * Where a drag of the phone's drawer lets it go: out (true) or back in. `at` is how far out it was let go
 * (0 to `width`), `velocity` the finger's (px/ms, positive to the right). A flick goes its way; else past
 * a third of the way it opens.
 */
export function drawerSettles(at: number, velocity: number, width: number): boolean {
  if (velocity > 0.5) return true;
  if (velocity < -0.5) return false;
  return at > width / 3;
}
