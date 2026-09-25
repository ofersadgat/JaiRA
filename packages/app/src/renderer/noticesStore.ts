/**
 * The event notices, as this window holds them: the backlog read once (`notices:list`), then each
 * `notice:posted` main pushes. Published here and read with a hook, as `limitsStore.ts` does, so the
 * strip needs no prop threaded down to it. What is READ lives elsewhere — per viewer, in the ui state
 * (see `noticesModel.ts`).
 */
import { useEffect, useSyncExternalStore } from "react";
import type { EventsNotice } from "@jaira/shared/browser";
import { invoke, subscribe as subscribePush } from "./store";

/** Main keeps as many; a window holding more would show notices main no longer has. */
const KEPT = 100;

let notices: readonly EventsNotice[] = [];
const watchers = new Set<() => void>();
let started = false;

function notify(): void {
  for (const w of [...watchers]) w();
}

function subscribe(watch: () => void): () => void {
  watchers.add(watch);
  return () => {
    watchers.delete(watch);
  };
}

/**
 * Listen first, then read the backlog, and merge by id — a notice posted while the read was in flight
 * arrives by both routes and is kept once.
 */
function start(): void {
  if (started || typeof window === "undefined" || (window as { jaira?: unknown }).jaira === undefined) return;
  started = true;
  subscribePush((message) => {
    if (message.type === "notice:posted") addNotices([message.notice]);
  });
  void invoke("notices:list", undefined).then(
    (backlog) => addNotices(backlog),
    () => undefined,
  );
}

/** Fold notices in by id, oldest first, the last {@link KEPT} — from main, or from a test. */
export function addNotices(more: readonly EventsNotice[]): void {
  const byId = new Map(notices.map((n) => [n.id, n]));
  for (const n of more) byId.set(n.id, n);
  notices = [...byId.values()].sort((a, b) => a.at - b.at).slice(-KEPT);
  notify();
}

/** Every notice this window holds, oldest first. */
export function useNotices(): readonly EventsNotice[] {
  useEffect(start, []);
  return useSyncExternalStore(subscribe, () => notices, () => notices);
}
