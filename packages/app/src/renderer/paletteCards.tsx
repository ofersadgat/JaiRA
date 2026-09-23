/**
 * What each palette is called, and the miniature task board its card draws.
 *
 * A TABLE of colours rather than the stylesheet itself, which is how t3code draws its theme
 * wireframes too, and for the same reason: every card has to show its OWN palette while the window
 * is painted in another, and the stylesheet's tokens are keyed on `:root`, which holds one. So this is
 * a copy of `styles.css` — like `PALETTE_FRAME` — small enough to keep in step by eye.
 *
 * The miniature is a task board because that is what the palettes were chosen on: the sidebar, three
 * columns, and a running, a waiting, a failed and a finished card, each with its pill's colour.
 */
import type { CSSProperties, JSX } from "react";
import { PALETTE_SURFACE, type BucketStyle, type JairaTheme, type Palette } from "@jaira/shared/browser";

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

const mix = (ink: string, pct: number): string => `color-mix(in srgb, ${ink} ${pct}%, transparent)`;

type MiniCard = { kind: "running" | "waiting" | "error" | "success" | null; selected?: boolean };
const COLUMNS: readonly (readonly MiniCard[])[] = [
  [{ kind: "running", selected: true }, { kind: "success" }],
  [{ kind: "waiting" }, { kind: "error" }],
  [{ kind: null }],
];

/** One pane of a miniature: a whole board in one palette and theme, optionally clipped to a half. */
function Pane({
  c,
  buckets,
  lanes,
  clip,
}: {
  c: MiniColors;
  buckets: BucketStyle;
  lanes: boolean;
  clip?: "left" | "right" | undefined;
}): JSX.Element {
  const pane: CSSProperties = { position: "absolute", inset: 0, background: c.bg };
  if (clip === "left") pane.clipPath = "polygon(0 0, calc(50% - 1px) 0, calc(50% - 1px) 100%, 0 100%)";
  if (clip === "right") pane.clipPath = "polygon(calc(50% + 1px) 0, 100% 0, 100% 100%, calc(50% + 1px) 100%)";
  if (c.grid !== undefined) {
    pane.backgroundImage = `linear-gradient(${c.grid} 1px, transparent 1px), linear-gradient(90deg, ${c.grid} 1px, transparent 1px)`;
    pane.backgroundSize = "8px 8px";
  }
  const line = buckets === "line";
  const tinted = lanes && c.lanes !== undefined;
  return (
    <span style={pane}>
      <span style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: "21%", background: c.chrome, boxShadow: `inset -1px 0 0 ${c.sideEdge ?? "transparent"}` }} />
      {[22, 36, 50].map((top, i) => (
        <span
          key={top}
          style={{ position: "absolute", left: "3%", width: "15%", top: `${top}%`, height: "8%", borderRadius: Math.min(c.r, 3), background: i === 0 ? mix(c.accent, 40) : mix(c.chromeInk, 14) }}
        />
      ))}
      {COLUMNS.map((cards, col) => {
        const lane = tinted ? c.lanes![col]! : undefined;
        const column: CSSProperties = { position: "absolute", top: "10%", bottom: "8%", left: `${25 + col * 25}%`, width: "22%", borderRadius: c.r };
        if (!line) {
          column.background = lane ?? c.track;
          column.border = `1px ${c.dash === true ? "dashed" : "solid"} ${c.edge}`;
        }
        return (
          <span key={col} style={column}>
            {c.band === true && !line ? (
              <span style={{ position: "absolute", left: 0, right: 0, top: 0, height: "15%", background: c.ink }}>
                <span style={{ position: "absolute", left: "8%", top: "35%", width: "45%", height: "32%", borderRadius: 1, background: c.bg }} />
              </span>
            ) : (
              <span style={{ position: "absolute", left: "8%", top: "6%", width: "45%", height: "6%", borderRadius: 1, background: tinted ? mix(c.accent, 60) : mix(c.ink, 45) }} />
            )}
            {line ? <span style={{ position: "absolute", left: 0, right: 0, top: "17%", height: 2, background: lane ?? c.line ?? c.edge }} /> : null}
            {cards.map((card, i) => {
              const status = card.kind === "running" ? c.accent : card.kind === "waiting" ? c.warn : card.kind === "error" ? c.bad : card.kind === "success" ? c.ok : null;
              const shadow = card.selected === true ? `0 0 0 1.5px ${c.accent}` : c.hard === true ? `1.5px 1.5px 0 ${c.tileEdge}` : c.soft === true ? "0 1px 2px rgba(0, 0, 0, 0.12)" : "none";
              return (
                <span
                  key={i}
                  style={{ position: "absolute", left: "7%", right: "7%", top: `${22 + i * 32}%`, height: "26%", borderRadius: Math.max(0, c.r - 1), background: c.tile, border: `1px solid ${c.tileEdge}`, boxShadow: shadow }}
                >
                  <span style={{ position: "absolute", left: "9%", top: "32%", width: "50%", height: "22%", borderRadius: 1, background: mix(c.ink, 42) }} />
                  {status !== null ? (
                    <span style={{ position: "absolute", right: "8%", top: "24%", width: "22%", height: "40%", borderRadius: 6, background: mix(status, 26) }}>
                      <span style={{ position: "absolute", left: "18%", top: "28%", width: "22%", height: "44%", borderRadius: "50%", background: status }} />
                    </span>
                  ) : null}
                </span>
              );
            })}
          </span>
        );
      })}
    </span>
  );
}

/**
 * A palette's task board in miniature — in one theme, or split light | dark for `system`, the way
 * t3code draws its System tile. The buckets and lanes are the palette's own, not the person's
 * current options: the card is a picture of what choosing it gives you.
 */
export function ThemeMini({ palette, theme }: { palette: Palette; theme: JairaTheme | "system" }): JSX.Element {
  const card = PALETTE_CARDS[palette];
  const surface = PALETTE_SURFACE[palette];
  return (
    <span className="theme-mini" aria-hidden="true">
      {theme === "system" ? (
        <>
          <Pane c={card.light} buckets={surface.buckets} lanes={surface.laneColors} clip="left" />
          <Pane c={card.dark} buckets={surface.buckets} lanes={surface.laneColors} clip="right" />
        </>
      ) : (
        <Pane c={card[theme]} buckets={surface.buckets} lanes={surface.laneColors} />
      )}
    </span>
  );
}
