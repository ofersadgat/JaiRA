/**
 * Which of a panel's tabs get their LABEL at the width the panel has (the person's ruling,
 * 2026-09-24): as many as fit, the OPEN tab first, then from the left.
 *
 * Every tab always keeps its icon and its count — those are what the folded rail shows too, so a tab
 * that has lost its label still reads as the same control. What is handed out is the words, in the
 * order they are worth most: the one you are on, and then the reading order. That is what lets the
 * panel have any width at all; a fixed set of labels chose the width for it.
 *
 * Pure over measured widths, so the rule is tested without a window and the component only measures.
 */
export interface TabMeasure {
  /** The tab with no label: icon, count and padding. */
  bare: number;
  /** What the label adds when it is shown, gap included. */
  label: number;
}

/** `true` for each tab that shows its label. */
export function labelPlan(tabs: readonly TabMeasure[], open: number, available: number): boolean[] {
  const plan = tabs.map(() => false);
  let used = tabs.reduce((sum, tab) => sum + tab.bare, 0);
  const order = open >= 0 && open < tabs.length ? [open, ...tabs.map((_, i) => i).filter((i) => i !== open)] : tabs.map((_, i) => i);
  for (const i of order) {
    // In order, and stopping at the first that does not fit: a later, shorter label squeezing in
    // after a longer one was skipped would put words on the fourth tab and none on the second, which
    // reads as noise rather than as a priority.
    if (used + tabs[i]!.label > available) break;
    plan[i] = true;
    used += tabs[i]!.label;
  }
  return plan;
}
