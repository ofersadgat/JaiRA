/**
 * The limits board and the waiting list, as the renderer sees them (usage-readings contract).
 *
 * Machine-wide state read from deep inside components that know nothing else about it — a composer's
 * number, a message rail's badge, a sign-in card — so it is published here and read with a hook, the
 * same arrangement `renderChoice.ts` uses, rather than threaded through every prop list. Main pushes
 * each change (`limits:changed`, `waiting:changed`); the first reader fetches the current state.
 *
 * A meter on screen WATCHES ({@link useLimitsWatch}): while one does, main refreshes a reading that
 * has gone stale by itself. With nothing watching, nothing is fetched.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import type { LimitAccountView, LimitsView, WaitingItem } from "@jaira/shared/browser";
import { accountOfRoute } from "@jaira/shared/browser";
import { invoke, subscribe as subscribePush } from "./store";

let view: LimitsView = { accounts: [], routeAccounts: {} };
let waiting: WaitingItem[] = [];
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

/** Fetch once and listen — the first time anything asks. A server render (no bridge) never starts. */
function start(): void {
  if (started || typeof window === "undefined" || (window as { jaira?: unknown }).jaira === undefined) return;
  started = true;
  void invoke("limits:read", undefined).then(
    (next) => publishLimits(next),
    () => undefined,
  );
  void invoke("waiting:list", undefined).then(
    (next) => publishWaiting(next),
    () => undefined,
  );
  subscribePush((message) => {
    if (message.type === "limits:changed") publishLimits(message.view);
    else if (message.type === "waiting:changed") publishWaiting(message.items);
  });
}

/** Replace the board view — from main, or from a test drawing a still picture. */
export function publishLimits(next: LimitsView): void {
  view = next;
  notify();
}

/** Replace the waiting list — from main, or from a test. */
export function publishWaiting(next: WaitingItem[]): void {
  waiting = next;
  notify();
}

export function useLimits(): LimitsView {
  useEffect(start, []);
  return useSyncExternalStore(subscribe, () => view, () => view);
}

export function useWaiting(): WaitingItem[] {
  useEffect(start, []);
  return useSyncExternalStore(subscribe, () => waiting, () => waiting);
}

/** The account a route spends, from a view. */
export function accountFor(limits: LimitsView, route: string | undefined): LimitAccountView | undefined {
  if (route === undefined || route === "") return undefined;
  const key = limits.routeAccounts[route] ?? accountOfRoute(route);
  return limits.accounts.find((a) => a.key === key);
}

/** A meter is on screen: keep the board fresh while it is. */
export function useLimitsWatch(active = true): void {
  useEffect(() => {
    if (!active || typeof window === "undefined" || (window as { jaira?: unknown }).jaira === undefined) return;
    void invoke("limits:watch", { watching: true }).catch(() => undefined);
    return () => {
      void invoke("limits:watch", { watching: false }).catch(() => undefined);
    };
  }, [active]);
}

/** Press Refresh on an account. */
export function refreshAccount(key: string): void {
  void invoke("limits:refresh", { account: key }).then(
    (next) => publishLimits(next),
    () => undefined,
  );
}

/** Act on a waiting item: send it now anyway, delete it, or turn "Try again at …" on or off. */
export function actOnWaiting(id: string, action: "sendNow" | "drop" | "retry", retry?: boolean): void {
  void invoke("waiting:act", { id, action, ...(retry !== undefined ? { retry } : {}) }).then(
    (next) => publishWaiting(next),
    () => undefined,
  );
}

/** Now, re-read every `ms` — so "3 min ago" and "resets 14:05" stay true while a panel sits open. */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
