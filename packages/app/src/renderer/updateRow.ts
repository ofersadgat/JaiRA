/**
 * What the sidebar's Update row does when it is pressed, and how it is washed — moved out of
 * `updatesView.tsx`'s `SidebarUpdateRow` unchanged, so the universal copy (decision 0015) does the same.
 */
import type { UpdateState } from "@jaira/shared/browser";
import type { SidebarUpdate } from "./updatesModel";

/** The row's one click. */
export function pressUpdateRow(
  row: SidebarUpdate,
  next: UpdateState["available"],
  f: { openUrl: (url: string) => void; apply: () => void; onOpenAbout: () => void },
): void {
  if (row.kind === "manual" && next !== undefined) f.openUrl(next.url);
  else if (row.kind === "available" || row.kind === "downloaded") f.apply();
  // A failure, a download under way and a restart that is waiting are each said in full on About;
  // the chevron is where the choices are.
  else if (row.kind !== "restarting") f.onOpenAbout();
}

/** Washed in the accent once a restart is all that is left, red when a check or download failed. */
export function updateRowTone(row: SidebarUpdate): "ready" | "bad" | undefined {
  return row.kind === "waiting" || row.kind === "downloaded" || row.kind === "restarting" ? "ready" : row.kind === "error" ? "bad" : undefined;
}

/** Whether hovering the row shows the full version beside it (not over the menu, which says more). */
export function showsUpdateTip(row: SidebarUpdate, next: UpdateState["available"]): boolean {
  return next !== undefined && (row.kind === "available" || row.kind === "manual" || row.kind === "downloaded");
}
