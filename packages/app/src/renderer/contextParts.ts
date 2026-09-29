/**
 * The colour of each category in a context breakdown — moved unchanged out of `usageMeters.tsx`, which
 * imports it, so the universal copies (`TurnContext`, the context card) colour the same categories
 * the same way (decision 0015).
 */

/** The colour of the n-th category in a breakdown — the rail palette, then the accent. */
export const PART_COLOURS = ["var(--p3)", "var(--p2)", "var(--um-teal)", "var(--p1)", "var(--accent)", "var(--p4, var(--dim))"];
export function colourOf(name: string, index: number): string {
  const key = name.toLowerCase();
  if (key.includes("message")) return "var(--accent)";
  return PART_COLOURS[index % (PART_COLOURS.length - 1)]!;
}
