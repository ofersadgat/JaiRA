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
import { COLUMNS, PALETTE_CARDS, type MiniColors } from "./paletteCardsModel";

export { PALETTE_CARDS, type MiniColors, type PaletteCard } from "./paletteCardsModel";

const mix = (ink: string, pct: number): string => `color-mix(in srgb, ${ink} ${pct}%, transparent)`;

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
