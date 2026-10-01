/**
 * The colour of each category in a context breakdown, in one place so `TurnContext` and the context
 * card (`UsageCards.tsx`) colour the same categories the same way.
 */

/** The colour of the n-th category in a breakdown — the rail palette, then the accent. */
export const PART_COLOURS = ["var(--p3)", "var(--p2)", "var(--um-teal)", "var(--p1)", "var(--accent)", "var(--p4, var(--dim))"];
export function colourOf(name: string, index: number): string {
  const key = name.toLowerCase();
  if (key.includes("message")) return "var(--accent)";
  return PART_COLOURS[index % (PART_COLOURS.length - 1)]!;
}
