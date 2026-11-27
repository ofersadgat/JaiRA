/**
 * The taskbar button's overlay (`attention.ts`'s `badge`) drawn as a bitmap, so it needs no image files:
 * a filled circle — amber with the count of open asks, red with "!", green with a tick — and its glyph
 * in a 5×7 pixel font. 32×32 BGRA, which Windows scales to the overlay's 16×16 (sharp at 200%).
 */
import type { TaskbarState } from "./attention";

export const BADGE_SIZE = 32;

const GLYPHS: Record<string, readonly string[]> = {
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
  "+": ["00000", "00100", "00100", "11111", "00100", "00100", "00000"],
  "!": ["00100", "00100", "00100", "00100", "00100", "00000", "00100"],
  "✓": ["00000", "00001", "00010", "10100", "01000", "00000", "00000"],
};

type Rgb = readonly [number, number, number];
const FILL: Record<NonNullable<TaskbarState["badge"]>["kind"], Rgb> = { asking: [0xf3, 0xc4, 0x64], failed: [0xe5, 0x48, 0x4d], done: [0x30, 0xa4, 0x6c] };
const INK: Record<NonNullable<TaskbarState["badge"]>["kind"], Rgb> = { asking: [0x1a, 0x14, 0x00], failed: [0xff, 0xff, 0xff], done: [0xff, 0xff, 0xff] };

/** The text a badge carries: the count (9+ past nine), "!" or a tick. */
export function badgeText(badge: NonNullable<TaskbarState["badge"]>): string {
  if (badge.kind === "failed") return "!";
  if (badge.kind === "done") return "✓";
  return badge.count > 9 ? "9+" : String(badge.count);
}

/** The badge as BGRA pixels, row by row, `BADGE_SIZE` square. */
export function badgeBitmap(badge: NonNullable<TaskbarState["badge"]>): Uint8Array {
  const n = BADGE_SIZE;
  const out = new Uint8Array(n * n * 4);
  const put = (x: number, y: number, [r, g, b]: Rgb, a = 255): void => {
    if (x < 0 || y < 0 || x >= n || y >= n) return;
    const i = (y * n + x) * 4;
    out[i] = b;
    out[i + 1] = g;
    out[i + 2] = r;
    out[i + 3] = a;
  };
  // The circle, its edge softened by coverage so it is not jagged.
  const c = (n - 1) / 2;
  const radius = n / 2;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const d = Math.hypot(x - c, y - c);
      const cover = Math.max(0, Math.min(1, radius - d));
      if (cover > 0) put(x, y, FILL[badge.kind], Math.round(cover * 255));
    }
  }
  // The glyphs: ×3 for one, ×2 side by side for two, centred.
  const text = [...badgeText(badge)];
  const scale = text.length === 1 ? 3 : 2;
  const gap = scale;
  const width = text.length * 5 * scale + (text.length - 1) * gap;
  const height = 7 * scale;
  let left = Math.round((n - width) / 2);
  const top = Math.round((n - height) / 2);
  for (const ch of text) {
    const rows = GLYPHS[ch] ?? GLYPHS["!"]!;
    rows.forEach((row, gy) => {
      [...row].forEach((bit, gx) => {
        if (bit !== "1") return;
        for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) put(left + gx * scale + dx, top + gy * scale + dy, INK[badge.kind]);
      });
    });
    left += 5 * scale + gap;
  }
  return out;
}
