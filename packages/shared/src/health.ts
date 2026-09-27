/**
 * Settings' warnings and errors (the person, 2026-09-26: "settings should have warning + error
 * notification on it. settings should display an error if a tool was available but became unavailable
 * (e.g. claude code token expired, oauth session expired, there was an error log, etc). failed download
 * should be a warning").
 *
 * An ERROR is something that worked and stopped: an agent, a model route or a forge connection a check
 * once found working and now finds failing, or errors written to the log since the person last dismissed
 * them (warnings written to the log count as warnings).
 * A tool that never worked on this machine is not one — it was never available to lose. A WARNING is a
 * thing that did not happen and can be tried again: a plugin or update download, an update check.
 *
 * The main process keeps the board (`packages/app/src/main/health.ts`) and pushes it whole on every
 * change; the window draws a count on the Settings row and each item on the page it belongs to.
 */

export type HealthLevel = "error" | "warning";

/** The Settings page an item belongs to, where its fix is. `logs` is the Logs panel. */
export type HealthPage = "connections" | "about" | "logs";

/** What the item's button does. */
export type HealthAction =
  /** Sign an agent or a forge connection in again (`subject` names it). */
  | "sign-in"
  /** Check the tool again. */
  | "check"
  /** Download the plugin again (`subject` is its id). */
  | "retry-plugin"
  /** Check for updates again, or download the update again. */
  | "retry-update"
  /** Open the Logs panel. */
  | "open-logs";

export interface HealthItem {
  /** Stable per problem: `executor:<name>`, `route:<name>`, `forge:<name>`, `plugin:<id>`, `update`, `log:errors`, `log:warnings`. */
  id: string;
  level: HealthLevel;
  page: HealthPage;
  /** What it is about, in a few words: "Claude Code", "GitLab (gitlab.com)". */
  title: string;
  /** What is wrong, one line: "signed out — its token expired". */
  detail: string;
  /** What would fix it, one imperative line, when known. */
  fix?: string;
  action?: HealthAction;
  /** The agent, connection or plugin the action is for. */
  subject?: string;
  /** Since when, epoch ms. */
  since: number;
  /** How many, for an item that counts (the log's errors and warnings since they were last dismissed). */
  count?: number;
}

/** The count a Settings row shows: errors win the colour. */
export function healthSummary(items: readonly HealthItem[]): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const item of items) item.level === "error" ? (errors += 1) : (warnings += 1);
  return { errors, warnings };
}
