/**
 * Settings → Models → Catalog's reading and words (`catalogPane.tsx`), as a hook and pure functions in
 * a module of their own so the universal copy (decision 0015) reads and says what the DOM's does.
 */
import { useEffect, useState } from "react";
import type { CatalogSourceView, CatalogStatusView } from "@jaira/shared/browser";
import { agoLabel } from "./remoteStrip";
import { invoke } from "./store";

/** The brand a source's row wears. */
export const SOURCE_BRAND: Record<string, string> = {
  "openrouter-models": "openrouter",
  "openrouter-native-mirrors": "openrouter",
  "anthropic-models": "anthropic",
  "claude-cli-models": "claude-cli",
  "claude-code-models": "claude-code",
  "codex-cli-models": "codex-cli",
  "local-models": "local",
  "embedded-models": "embedded",
};

/** `in 23 h`, `in 48 min` — when a source is asked next. */
export function inLabel(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((at - now) / 60_000));
  return minutes < 90 ? `in ${minutes} min` : `in ${Math.round(minutes / 60)} h`;
}

/** The catalog's status as the Models page holds it — read once, shared by its section and its suggestions. */
export interface CatalogState {
  view: CatalogStatusView | null;
  now: number;
  busy: boolean;
  refresh: () => void;
}

/**
 * Read the catalog's status. `stamp` is the last availability check's time: a refresh follows every
 * check, so the status is read again when that moves.
 */
export function useCatalogStatus(stamp: number): CatalogState {
  const [view, setView] = useState<CatalogStatusView | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // Read on mount and after every check — and, while a pass is running or a planned source has not
  // answered yet, again every second and a half until it settles: the refresh that follows a check
  // lands seconds AFTER it, and nothing else would tell this section it did.
  const [tick, setTick] = useState(0);
  const settling = view === null || view.refreshing || view.sources.some((s) => s.state === "not asked yet");
  useEffect(() => {
    let live = true;
    void invoke("catalog:status", undefined)
      .then((next) => live && setView(next))
      .catch(() => undefined);
    setNow(Date.now());
    return () => {
      live = false;
    };
  }, [stamp, tick]);
  useEffect(() => {
    if (!settling) return;
    const timer = setTimeout(() => setTick((n) => n + 1), 1500);
    return () => clearTimeout(timer);
  }, [settling, tick]);

  const refresh = (): void => {
    setRefreshing(true);
    void invoke("catalog:refresh", undefined)
      .then((next) => {
        setView(next);
        setNow(Date.now());
      })
      .catch(() => undefined)
      .finally(() => setRefreshing(false));
  };

  return { view, now, busy: refreshing || view?.refreshing === true, refresh };
}

/** The four states a catalog source's row can be in, as a provider row's (`ProviderState`). */
export type CatalogRowState = "available" | "unavailable" | "unconfigured";

/** What one source's row says: its state, the line after the state word, and when it is asked next. */
export function catalogRowOf(source: CatalogSourceView, now: number): { state: CatalogRowState; next: string | undefined; say: string } {
  const state: CatalogRowState = source.state === "ok" ? "available" : source.state === "failed" ? "unavailable" : "unconfigured";
  const next =
    source.nextAt === undefined
      ? undefined
      : source.state === "failed"
        ? `asks again ${inLabel(source.nextAt, now)}`
        : `asked again ${inLabel(source.nextAt, now)}${source.changesWith !== undefined ? `, or when ${source.changesWith}` : ""}`;
  const say =
    source.state === "not configured"
      ? ` — ${source.error}`
      : source.state === "not asked yet"
        ? ` — asks ${source.asks} after the next availability check`
        : `${" — "}${source.state === "failed" ? `${source.error} · ` : `asked ${source.asks} · `}${source.at !== undefined ? agoLabel(source.at, now) : ""}${next !== undefined ? ` · ${next}` : ""}`;
  return { state, next, say };
}

/** The heading's aside: when the catalog was last refreshed, and how long that took. */
export function catalogLastLine(view: CatalogStatusView | null, now: number): string | undefined {
  if (view?.lastAt === undefined) return undefined;
  return `last refreshed ${agoLabel(view.lastAt, now)}${view.tookMs !== undefined ? ` · ${(view.tookMs / 1000).toFixed(1)} s` : ""}`;
}
