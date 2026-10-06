/**
 * The limits board and the waiting list, as the renderer sees them (usage-readings contract).
 *
 * Machine-wide state read from deep inside components that know nothing else about it — a composer's
 * number, a message rail's badge, a sign-in card — so it is read with a hook rather than threaded
 * through every prop list. Each is a view of the window's cache (decision 0018, group 7): read when a
 * component first holds it, and again when the change log says it moved (`limits`, `waiting`).
 *
 * A meter on screen WATCHES ({@link useLimitsWatch}): while one does, the engine refreshes a reading
 * that has gone stale by itself. With nothing watching, nothing is fetched.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import type { LimitAccountView, LimitsView, UsageFigures, WaitingItem } from "@jaira/shared/browser";
import { accountOfRoute } from "@jaira/shared/browser";
import { invoke, syncCache } from "./store";
import { useView } from "./useView";

const NO_LIMITS: LimitsView = { accounts: [], routeAccounts: {} };
const NOTHING_WAITS: WaitingItem[] = [];
const watchers = new Set<() => void>();

function notify(): void {
  for (const w of [...watchers]) w();
}

function subscribe(watch: () => void): () => void {
  watchers.add(watch);
  return () => {
    watchers.delete(watch);
  };
}

export function useLimits(): LimitsView {
  return useView("limits:read", undefined).value ?? NO_LIMITS;
}

export function useWaiting(): WaitingItem[] {
  return useView("waiting:list", undefined).value ?? NOTHING_WAITS;
}

/**
 * How an account's figure is drawn — `appearance.conversation.usageFigures`, the reader's own setting.
 * Published by the app shell whenever the look changes, and read by every figure it governs (after the
 * model chip, the sign-in and key cards), so none of them needs the look threaded down to it.
 */
let figures: UsageFigures = "number";

export function publishUsageFigures(next: UsageFigures): void {
  if (next === figures) return;
  figures = next;
  notify();
}

export function useUsageFigures(): UsageFigures {
  return useSyncExternalStore(subscribe, () => figures, () => figures);
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
    if (!active) return;
    void invoke("limits:watch", { watching: true }).catch(() => undefined);
    return () => {
      void invoke("limits:watch", { watching: false }).catch(() => undefined);
    };
  }, [active]);
}

/** Press Refresh on an account. */
export function refreshAccount(key: string): void {
  void invoke("limits:refresh", { account: key }).then(
    () => syncCache().refresh("limits:read", undefined),
    () => undefined,
  );
}

/** Act on a waiting item: send it now anyway, delete it, or turn "Try again at …" on or off. */
export function actOnWaiting(id: string, action: "sendNow" | "drop" | "retry", retry?: boolean): void {
  void invoke("waiting:act", { id, action, ...(retry !== undefined ? { retry } : {}) }).then(
    () => syncCache().refresh("waiting:list", undefined),
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
