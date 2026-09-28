import { useSyncExternalStore } from "react";
import { AccessibilityInfo, type View } from "react-native";
import { CLICK_HOLD_MS, PART_MARGIN, readingPartOf, type SettingsPart } from "@jaira/ui/settingsParts";

/**
 * The sections of the Settings page on screen, and which one is being read — `settingsParts.ts`'s
 * `useSettingsParts`, universal (decision 0015). What the sidebar's accordion lists under the open
 * page, lights as it is scrolled, and scrolls to when one is clicked.
 *
 * The DOM finds its sections by `data-part` in the page it drew and measures them against the scroll
 * box. A native tree has no DOM to query, so each `SettingsSection` copy says it is one here, with its
 * view, and the page's `ScrollView` says when it scrolled; the sections are measured against the box
 * (`measureInWindow`, both of them, as the DOM subtracts one `getBoundingClientRect` from the other —
 * `onLayout` is no use for this: react-native-web reports it only when a box changes SIZE, so a section
 * pushed down by one above it would keep its old place). Which one is read is the same rule
 * (`readingPartOf`), and the list is in the order the sections stand. One Settings page per window, as
 * one `App` has one: a module store, like `viewState.ts`.
 */
interface Entry {
  label: string;
  view: View;
  /** Top of the section from the top of the scroll box, as last measured. */
  top: number | null;
}

const entries = new Map<string, Entry>();
const scroll = { top: 0, height: 0, contentHeight: 0 };
let box: View | null = null;
let scrollTo: ((y: number, animated: boolean) => void) | null = null;
let held: { id: string; until: number } | null = null;
let pending = false;

let snapshot: { parts: SettingsPart[]; active: string | null } = { parts: [], active: null };
const listeners = new Set<() => void>();

function recompute(): void {
  const placed = [...entries.entries()].filter(([, e]) => e.top !== null).sort((a, b) => a[1].top! - b[1].top!);
  const parts = placed.map(([id, e]) => ({ id, label: e.label }));
  let active: string | null;
  if (held !== null && Date.now() < held.until) active = held.id;
  else {
    held = null;
    active = readingPartOf(
      placed.map(([id, e]) => ({ id, top: e.top! })),
      scroll,
    );
  }
  const same = snapshot.parts.length === parts.length && snapshot.parts.every((p, i) => p.id === parts[i]!.id && p.label === parts[i]!.label);
  if (same && snapshot.active === active) return;
  snapshot = { parts: same ? snapshot.parts : parts, active };
  for (const on of listeners) on();
}

/** Measure every section against the scroll box, then say which is read — once per frame at most. */
function remeasure(): void {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    const from = box;
    if (from === null) return recompute();
    from.measureInWindow((_bx, by) => {
      const all = [...entries.values()];
      let left = all.length;
      if (left === 0) return recompute();
      for (const entry of all) {
        entry.view.measureInWindow((_x, y, _w, h) => {
          // A section drawn nowhere (`display: none`) measures as nothing: it is not on the page.
          entry.top = h > 0 ? y - by : null;
          if (--left === 0) recompute();
        });
      }
    });
  });
}

/** A section is on the page: `id`, its label, and its view. */
export function placePart(id: string, label: string, view: View): void {
  const had = entries.get(id);
  if (had !== undefined && had.label === label && had.view === view) return remeasure();
  entries.set(id, { label, view, top: had?.top ?? null });
  remeasure();
}

/** Something on the page moved or changed size: measure again. */
export const partsMoved = (): void => remeasure();

/** A section left the page. */
export function dropPart(id: string): void {
  if (entries.delete(id)) recompute();
}

/** The page's scroll box: how far it is scrolled, how tall it is, and how tall its content. */
export function scrolled(next: Partial<typeof scroll>): void {
  Object.assign(scroll, next);
  remeasure();
}

/** A new page: its scroll box and how to move it, back at its top (the DOM's `scrollTop = 0` on a new key). */
export function newPage(view: View | null, to: ((y: number, animated: boolean) => void) | null): void {
  box = view;
  scrollTo = to;
  held = null;
  scroll.top = 0;
  remeasure();
}

/** Scroll to a section, its heading `PART_MARGIN` below the top, and light it while the scroll runs. */
export function goToPart(id: string): void {
  const entry = entries.get(id);
  if (entry === undefined || entry.top === null || scrollTo === null) return;
  held = { id, until: Date.now() + CLICK_HOLD_MS };
  recompute();
  const max = Math.max(0, scroll.contentHeight - scroll.height);
  const go = scrollTo;
  const y = Math.min(max, Math.max(0, scroll.top + entry.top - PART_MARGIN));
  void AccessibilityInfo.isReduceMotionEnabled()
    .catch(() => false)
    .then((still) => go(y, !still));
  // The hold ends by the clock, as the DOM's does on its next read.
  setTimeout(remeasure, CLICK_HOLD_MS + 20);
}

const subscribe = (on: () => void): (() => void) => {
  listeners.add(on);
  return () => listeners.delete(on);
};

/** The parts, the one being read, and a way to go to one — what the sidebar's accordion draws. */
export function useSettingsParts(): { parts: SettingsPart[]; active: string | null; go: (id: string) => void } {
  const s = useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
  return { ...s, go: goToPart };
}
