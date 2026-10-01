/**
 * What each palette is called, and the colours of the miniature task board its card draws
 * (`ThemeMini.tsx`, Settings → Appearance). A TABLE of colours rather than the tokens themselves: every
 * card has to show its OWN palette while the window is painted in another, and the tokens in force are
 * one palette's. So this is a copy of the palettes in `styles.css`, small enough to keep in step by eye.
 */
import type { Palette } from "@jaira/shared/browser";

/** One palette in one theme, as the miniature needs it. */
export interface MiniColors {
  /** The sidebar, and the ink on it. */
  chrome: string;
  chromeInk: string;
  /** Hairline down the sidebar's edge, where the palette draws one. */
  sideEdge?: string;
  bg: string;
  /** A column's ground and edge — ignored for a line-bucket palette. */
  track: string;
  edge: string;
  /** Each column's own tint, for a palette that colours its lanes. */
  lanes?: readonly [string, string, string];
  tile: string;
  tileEdge: string;
  ink: string;
  accent: string;
  ok: string;
  warn: string;
  bad: string;
  /** The rule under a line-bucket column's heading. */
  line?: string;
  /** Corner radius in px. */
  r: number;
  /** Inverted column headings (high contrast). */
  band?: boolean;
  /** A solid offset shadow on the cards (high contrast). */
  hard?: boolean;
  /** A soft drop shadow on the cards (pastel). */
  soft?: boolean;
  /** Dashed column outlines (blueprint). */
  dash?: boolean;
  /** The colour of a graph-paper grid behind the board (blueprint). */
  grid?: string;
}

export interface PaletteCard {
  label: string;
  /** One sentence, as the card and the section below the cards say it. */
  note: string;
  light: MiniColors;
  dark: MiniColors;
}

const CLASSIC_STATUS_LIGHT = { ok: "#0f7a45", warn: "#8a6100", bad: "#c02c1f" };
const CLASSIC_STATUS_DARK = { ok: "#57d38c", warn: "#ffc857", bad: "#ff6b6b" };
const PASTEL_LANES_LIGHT = ["#f9e1e8", "#e0eefc", "#dff3e7"] as const;
const PASTEL_LANES_DARK = ["#3a2d3d", "#2b3450", "#2e3a3a"] as const;

export const PALETTE_CARDS: Record<Palette, PaletteCard> = {
  ink: {
    label: "Ink rail",
    note: "A dark sidebar beside a near-white workspace.",
    light: { chrome: "#171a2e", chromeInk: "#eceefa", bg: "#f5f6fa", track: "#eceef5", edge: "transparent", tile: "#ffffff", tileEdge: "#dfe2ec", ink: "#121526", accent: "#4a4fd1", ok: "#13794a", warn: "#8f5f00", bad: "#c4302b", line: "#e0e3ec", r: 5 },
    dark: { chrome: "#08091a", chromeInk: "#eceefa", bg: "#0f1017", track: "#13151e", edge: "transparent", tile: "#181b27", tileEdge: "#262a3b", ink: "#e8e9f3", accent: "#9ea2ff", ok: "#5fd49a", warn: "#f2c35b", bad: "#ff7b72", line: "#242838", r: 5 },
  },
  classic: {
    label: "Classic",
    note: "The greys JaiRA first shipped with.",
    light: { chrome: "#eceff4", chromeInk: "#1b2130", bg: "#f5f6f8", track: "#eceff4", edge: "#d4dae3", tile: "#dfe2e8", tileEdge: "transparent", ink: "#1b2130", accent: "#2563c7", r: 6, ...CLASSIC_STATUS_LIGHT },
    dark: { chrome: "#1c2029", chromeInk: "#e6e9ef", bg: "#0f1115", track: "#1c2029", edge: "#262b36", tile: "#252a33", tileEdge: "transparent", ink: "#e6e9ef", accent: "#6ea8fe", r: 6, ...CLASSIC_STATUS_DARK },
  },
  hairline: {
    label: "Hairline",
    note: "No fills: every edge is a one-pixel line.",
    light: { chrome: "#ffffff", chromeInk: "#111827", sideEdge: "#e3e6eb", bg: "#ffffff", track: "#ffffff", edge: "#e3e6eb", tile: "#ffffff", tileEdge: "#e3e6eb", ink: "#111827", accent: "#2563c7", r: 5, ...CLASSIC_STATUS_LIGHT },
    dark: { chrome: "#0d0f13", chromeInk: "#e7eaf0", sideEdge: "#232831", bg: "#0d0f13", track: "#0d0f13", edge: "#232831", tile: "#0d0f13", tileEdge: "#2a303a", ink: "#e7eaf0", accent: "#6ea8fe", r: 5, ...CLASSIC_STATUS_DARK },
  },
  contrast: {
    label: "High contrast",
    note: "Black and white, hard edges.",
    light: { chrome: "#ffffff", chromeInk: "#000000", sideEdge: "#141414", bg: "#ffffff", track: "#ffffff", edge: "#141414", tile: "#ffffff", tileEdge: "#141414", ink: "#000000", accent: "#0040c8", ok: "#0a6b2f", warn: "#7a4d00", bad: "#b00d0d", r: 0, band: true, hard: true },
    dark: { chrome: "#000000", chromeInk: "#ffffff", sideEdge: "#ededed", bg: "#000000", track: "#000000", edge: "#ededed", tile: "#000000", tileEdge: "#ededed", ink: "#ffffff", accent: "#7fb2ff", ok: "#5fe08f", warn: "#ffd166", bad: "#ff7070", r: 0, band: true, hard: true },
  },
  blueprint: {
    label: "Blueprint",
    note: "A drafting sheet: blue ink on a grid, dashed columns.",
    light: { chrome: "#0f3b7a", chromeInk: "#f2f7ff", bg: "#f7faff", track: "transparent", edge: "#6f93c7", tile: "#ffffff", tileEdge: "#6f93c7", ink: "#0f2f5e", accent: "#d9480f", ok: "#1b7a4a", warn: "#9a6400", bad: "#c0271d", r: 1, dash: true, grid: "rgba(15, 59, 122, 0.10)" },
    dark: { chrome: "#0b2f63", chromeInk: "#f2f7ff", bg: "#0f3b7a", track: "transparent", edge: "#9bb7de", tile: "#174a8f", tileEdge: "#9bb7de", ink: "#f2f7ff", accent: "#ffe066", ok: "#7cf0b0", warn: "#ffb86b", bad: "#ff9a9a", r: 1, dash: true, grid: "rgba(255, 255, 255, 0.10)" },
  },
  pastel: {
    label: "Pastel",
    note: "Lavender and soft colour, one per column.",
    light: { chrome: "#f5f2ff", chromeInk: "#2b2640", bg: "#fbfaff", track: "#f5f2ff", edge: "transparent", lanes: PASTEL_LANES_LIGHT, tile: "#ffffff", tileEdge: "transparent", ink: "#2b2640", accent: "#6d4aff", ok: "#1f8a4c", warn: "#9a6200", bad: "#d02f55", r: 8, soft: true },
    dark: { chrome: "#181825", chromeInk: "#cdd6f4", bg: "#1e1e2e", track: "#1b1b29", edge: "transparent", lanes: PASTEL_LANES_DARK, tile: "#2a2b3d", tileEdge: "#3a3b52", ink: "#cdd6f4", accent: "#cba6f7", ok: "#a6e3a1", warn: "#f9e2af", bad: "#f38ba8", r: 8, soft: true },
  },
  "pastel-rail": {
    label: "Pastel rail",
    note: "Pastel's lanes beside a dark aubergine sidebar.",
    light: { chrome: "#2b2640", chromeInk: "#ece8fb", bg: "#fbfaff", track: "#f5f2ff", edge: "transparent", lanes: PASTEL_LANES_LIGHT, tile: "#ffffff", tileEdge: "transparent", ink: "#2b2640", accent: "#6d4aff", ok: "#1f8a4c", warn: "#9a6200", bad: "#d02f55", r: 8, soft: true },
    dark: { chrome: "#11111b", chromeInk: "#ece8fb", bg: "#1e1e2e", track: "#1b1b29", edge: "transparent", lanes: PASTEL_LANES_DARK, tile: "#2a2b3d", tileEdge: "#3a3b52", ink: "#cdd6f4", accent: "#cba6f7", ok: "#a6e3a1", warn: "#f9e2af", bad: "#f38ba8", r: 8, soft: true },
  },
  zinc: {
    label: "Zinc",
    note: "Zinc neutrals and one indigo: borders, not fills.",
    light: { chrome: "#fafafa", chromeInk: "#27272a", sideEdge: "#e4e4e7", bg: "#fcfcfc", track: "#fdfdfd", edge: "#e4e4e7", tile: "#ffffff", tileEdge: "#e4e4e7", ink: "#27272a", accent: "#2150e0", ok: "#047857", warn: "#b45309", bad: "#b91c1c", r: 6 },
    dark: { chrome: "#000000", chromeInk: "#f1f3f7", sideEdge: "#1f1f1f", bg: "#0a0a0a", track: "#0f0f0f", edge: "#1f1f1f", tile: "#141414", tileEdge: "#262626", ink: "#f5f5f5", accent: "#7c9cff", ok: "#34d399", warn: "#fbbf24", bad: "#f87171", r: 6 },
  },
};

/** The miniature's cards, column by column: a running (selected) and a finished, a waiting and a failed, and one with no status. */
export type MiniCard = { kind: "running" | "waiting" | "error" | "success" | null; selected?: boolean };
export const COLUMNS: readonly (readonly MiniCard[])[] = [
  [{ kind: "running", selected: true }, { kind: "success" }],
  [{ kind: "waiting" }, { kind: "error" }],
  [{ kind: null }],
];
