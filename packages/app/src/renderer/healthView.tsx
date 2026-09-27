/**
 * Settings' warnings and errors, drawn (the person's rulings on round 3, 2026-09-26): what was
 * working and stopped — an agent signed out, a forge session expired, errors in the log — and what
 * failed and can be tried again — a plugin or update download, an update check. The board is main's
 * (`main/health.ts`); `updatesStore.ts` holds it here.
 *
 * Two render functions, placed by their callers:
 *
 *  - {@link NeedsAttention}, the section a page opens with while it has something in it: each item,
 *    since when, the button that fixes it, and an × on hover that dismisses it;
 *  - {@link HealthCard}, the one place listing them all, grouped by page — the card the Settings row's
 *    pills open, with Dismiss all.
 *
 * What a fix DOES belongs to the shell (it signs in, re-checks, opens a page), so both take it as
 * `onFix`. Each row is washed red or amber rather than striped (the person's rule: no coloured left
 * edge); the pill glyph before its name says which.
 */
import type { JSX } from "react";
import type { HealthItem, HealthPage } from "@jaira/shared/browser";
import { SettingsLayerContext } from "./controls";
import { PILL_GLYPH } from "./pill";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { healthFixLabel, healthGroups, healthTally, sinceWords } from "./updatesModel";
import { dismissAllHealth, dismissHealth } from "./updatesStore";

/** The pill's glyph alone, in the item's colour — what the row is, before its name says it. */
function Mark({ item }: { item: HealthItem }): JSX.Element {
  return (
    <span className={`prob-mark pill pill-${item.level} pill-status`} aria-label={item.level} role="img">
      <span className="pill-glyph">{PILL_GLYPH[item.level]}</span>
    </span>
  );
}

/** A log count is CLEARED by dismissing it; a problem is hidden until it clears and happens again. */
const dismissWords = (item: HealthItem): string => (item.id.startsWith("log:") ? "Dismiss: clears the count" : "Dismiss: hide until it happens again");

function FixButton({ item, onFix, small }: { item: HealthItem; onFix: (item: HealthItem) => void; small?: boolean }): JSX.Element | null {
  if (item.action === undefined) return null;
  return (
    <button type="button" className={small === true ? "sm" : undefined} title={item.fix} onClick={() => onFix(item)}>
      {healthFixLabel(item.action)}
    </button>
  );
}

/**
 * The section a page opens with — Connections, About — while the board has something for it. Not
 * drawn at all when it has nothing: the page reads as it always did.
 */
export function NeedsAttention({ items, page, onFix }: { items: readonly HealthItem[]; page: HealthPage; onFix: (item: HealthItem) => void }): JSX.Element | null {
  const mine = items.filter((item) => item.page === page);
  if (mine.length === 0) return null;
  return (
    // Not a setting of any layer: drawn whichever layer the page's switch is on, and under "What you
    // changed" too.
    <SettingsLayerContext.Provider value={null}>
      <SettingsSection
        id="attention"
        title="Needs attention"
        info="What was working and stopped, and what failed and can be tried again. Each goes away by itself once the check that raised it passes, or when you dismiss it."
      >
        {mine.map((item) => (
          <div key={item.id} className={`prob prob-${item.level}`}>
            <SettingsRow
              name={
                <span className="prob-name">
                  <Mark item={item} />
                  {item.title}
                </span>
              }
              description={
                <>
                  <span className="prob-since">{sinceWords(item)}</span> · {item.detail}
                </>
              }
              control={
                <>
                  <FixButton item={item} onFix={onFix} />
                  <button type="button" className="set-icon set-reset prob-x" title={dismissWords(item)} aria-label={dismissWords(item)} onClick={() => dismissHealth(item.id)}>
                    ×
                  </button>
                </>
              }
            />
          </div>
        ))}
      </SettingsSection>
    </SettingsLayerContext.Provider>
  );
}

/**
 * Everything, grouped by page — the card the Settings row's pills open. A group's name goes to its
 * page; each row has its fix and an ×; Dismiss all empties the card.
 */
export function HealthCard({
  items,
  onFix,
  onOpenPage,
}: {
  items: readonly HealthItem[];
  onFix: (item: HealthItem) => void;
  onOpenPage: (page: HealthPage) => void;
}): JSX.Element {
  const groups = healthGroups(items);
  return (
    <>
      <div className="prob-card-head">
        <span className="prob-card-title">Needs attention</span>
        <span className="prob-card-tally">{items.length > 0 ? healthTally(items) : "nothing"}</span>
        {items.length > 0 ? (
          <button type="button" className="ghost sm" onClick={dismissAllHealth}>
            Dismiss all
          </button>
        ) : null}
      </div>
      {groups.length === 0 ? <p className="prob-card-empty">Nothing needs attention.</p> : null}
      {groups.map((group) => (
        <div key={group.page} className="prob-card-group">
          <button type="button" className="prob-card-where" title={`Open ${group.label}`} onClick={() => onOpenPage(group.page)}>
            {group.label}
          </button>
          {group.items.map((item) => (
            <div key={item.id} className="prob-card-row">
              <Mark item={item} />
              <span className="prob-card-say" title={`${item.title}: ${item.detail}`}>
                <span className="prob-card-what">
                  {item.title}: {item.detail}
                </span>
                <span className="prob-card-since">{sinceWords(item)}</span>
              </span>
              <FixButton item={item} onFix={onFix} small />
              <button type="button" className="set-icon set-reset prob-x" title={dismissWords(item)} aria-label={dismissWords(item)} onClick={() => dismissHealth(item.id)}>
                ×
              </button>
            </div>
          ))}
        </div>
      ))}
    </>
  );
}
