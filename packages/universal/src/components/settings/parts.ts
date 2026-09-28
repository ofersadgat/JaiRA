import { useSyncExternalStore } from "react";
import { AccessibilityInfo } from "react-native";
import { CLICK_HOLD_MS, PART_MARGIN, readingPartOf, type SettingsPart } from "@jaira/ui/settingsParts";

/**
 * The sections of the Settings page on screen, and which one is being read — `settingsParts.ts`'s
 * `useSettingsParts`, universal (decision 0015). What the sidebar's accordion lists under the open
 * page, lights as it is scrolled, and scrolls to when one is clicked.
 *
 * The DOM finds its sections by `data-part` in the page it drew. A native tree has no DOM to query, so
 * each `SettingsSection` copy says it is one here instead, with where it stands (`onLayout`), and the
 * page's `ScrollView` says how far it is scrolled. Which one is read is the same rule
 * (`readingPartOf`), and the list is in the order the sections stand, as the DOM's is in document
 * order. One Settings page per window, as one `App` has one: a module store, like `viewState.ts`.
 */
interface Entry {
  label: string;
  /** Top of the section in the page's content (the scroll box's content, padding included). */
  y: number;
}

const entries = new Map<string, Entry>();
const scroll = { top: 0, height: 0, contentHeight: 0 };
let scrollTo: ((y: number, animated: boolean) => void) | null = null;
let held: { id: string; until: number } | null = null;

let snapshot: { parts: SettingsPart[]; active: string | null } = { parts: [], active: null };
const listeners = new Set<() => void>();

function recompute(): void {
  const sorted = [...entries.entries()].sort((a, b) => a[1].y - b[1].y);
  const parts = sorted.map(([id, e]) => ({ id, label: e.label }));
  let active: string | null;
  if (held !== null && Date.now() < held.until) active = held.id;
  else {
    held = null;
    active = readingPartOf(
      sorted.map(([id, e]) => ({ id, top: e.y - scroll.top })),
      scroll,
    );
  }
  const same = snapshot.parts.length === parts.length && snapshot.parts.every((p, i) => p.id === parts[i]!.id && p.label === parts[i]!.label);
  if (same && snapshot.active === active) return;
  snapshot = { parts: same ? snapshot.parts : parts, active };
  for (const on of listeners) on();
}

/** A section is on the page (or moved): `id`, its label, and its top in the page's content. */
export function placePart(id: string, label: string, y: number): void {
  const had = entries.get(id);
  if (had !== undefined && had.label === label && had.y === y) return;
  entries.set(id, { label, y });
  recompute();
}

/** A section left the page. */
export function dropPart(id: string): void {
  if (entries.delete(id)) recompute();
}

/** The page's scroll box: how far it is scrolled, how tall it is, how tall its content, and how to move it. */
export function scrolled(next: Partial<typeof scroll>): void {
  Object.assign(scroll, next);
  recompute();
}

/** A new page: back at its top, with nothing held (the DOM's `body.scrollTop = 0` on a new key). */
export function newPage(to: ((y: number, animated: boolean) => void) | null): void {
  scrollTo = to;
  held = null;
  scroll.top = 0;
  recompute();
}

/** Scroll to a section, its heading `PART_MARGIN` below the top, and light it while the scroll runs. */
export function goToPart(id: string): void {
  const entry = entries.get(id);
  if (entry === undefined || scrollTo === null) return;
  held = { id, until: Date.now() + CLICK_HOLD_MS };
  recompute();
  const max = Math.max(0, scroll.contentHeight - scroll.height);
  const go = scrollTo;
  const y = Math.min(max, Math.max(0, entry.y - PART_MARGIN));
  void AccessibilityInfo.isReduceMotionEnabled()
    .catch(() => false)
    .then((still) => go(y, !still));
  // The hold ends by the clock, as the DOM's does on its next read.
  setTimeout(recompute, CLICK_HOLD_MS + 20);
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
