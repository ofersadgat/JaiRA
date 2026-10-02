/**
 * The sections of the Settings page on screen, and which one is being read — what the sidebar's
 * accordion lists under the open tab (the person's design, 2026-09-23: "the sections are listed
 * indented under the tab and as you scroll each section highlights, and clicking a section will
 * scroll to that section").
 *
 * The rule is here: which section is the one being read (`readingPartOf`) and the figures a click's
 * scroll goes by. The Settings page keeps the list itself — each section says it is one as it is drawn
 * (`packages/universal/src/components/settings/parts.ts`), so a page that adds a section, or draws one
 * only when a project is open, is listed without anybody keeping a second list in step with the first.
 */

export interface SettingsPart {
  id: string;
  label: string;
}

/** How far below the top of the scroll box a section's heading may sit and still be the one read. */
export const READING_LINE = 56;

/** How long a click's choice outranks the scroll it caused — a smooth scroll takes about this. */
export const CLICK_HOLD_MS = 900;

/** Where a click in the accordion lands: the heading, this far below the top of the scroll box (`scroll-margin-top`). */
export const PART_MARGIN = 12;

/**
 * The section being read: the last whose heading has reached the reading line — and at the very
 * bottom of the page, the last section, which may never get that far up. `tops` are the sections'
 * tops, in order, measured from the top of the scroll box as it is scrolled; `scroll` is the box.
 */
export function readingPartOf(
  tops: readonly { id: string; top: number }[],
  scroll: { top: number; height: number; contentHeight: number },
): string | null {
  if (tops.length === 0) return null;
  let current = tops[0]!.id;
  for (const part of tops) if (part.top <= READING_LINE) current = part.id;
  if (scroll.top > 0 && scroll.top + scroll.height >= scroll.contentHeight - 2) current = tops[tops.length - 1]!.id;
  return current;
}

/**
 * A section asked for from OUTSIDE the Settings page — the events task's panel sending a person to
 * Tools → Events. The page is not drawn when it is asked, so it is gone to once the section stands on
 * it; and a page whose sections take their data after they are drawn grows under the place just gone
 * to, so for a moment after arriving it is gone to again when it has.
 */
export interface WantedPart {
  id: string;
  /** When it was asked for. */
  asked: number;
  /** When it was first gone to; null until it has been. */
  arrived: number | null;
  /** How tall the page's content was when it was last gone to. */
  height: number;
}

/** How long a section that is not on the page is waited for: one a page never draws is forgotten, not gone to on a later visit. */
export const WANT_WAIT_MS = 10_000;

/** How long after arriving the page may still move under the section and be followed. */
export const WANT_SETTLE_MS = 3_000;

/**
 * What to do about a wanted section now: `go` to it, `wait` (it is not on the page yet, or a scroll to
 * it is still running, or it is where it was put), or `drop` the request (it never came, or the page
 * has had its moment to settle). `top` is the section's top from the top of the scroll box, null while
 * it is not drawn; `holding` is true while a scroll that was asked for is still moving.
 */
export function wantedStep(
  wanted: WantedPart,
  now: number,
  page: { top: number | null; contentHeight: number; holding: boolean },
): "go" | "wait" | "drop" {
  if (wanted.arrived === null) {
    if (now - wanted.asked > WANT_WAIT_MS) return "drop";
    return page.top === null ? "wait" : "go";
  }
  if (now - wanted.arrived > WANT_SETTLE_MS) return "drop";
  if (page.top === null || page.holding) return "wait";
  // Only when the page itself changed: a person who scrolled away by hand is left where they went.
  return page.contentHeight !== wanted.height && Math.abs(page.top - PART_MARGIN) > 2 ? "go" : "wait";
}
