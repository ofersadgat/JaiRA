/**
 * Settings → Models → Catalog's reading and words (`ModelsPage.tsx`), as a hook and pure functions.
 */
import { useEffect, useState } from "react";
import type { CatalogSourceView, CatalogStatusView } from "@jaira/shared/browser";
import { agoLabel } from "./remoteStrip";
import { invoke, syncCache } from "./store";
import { useView } from "./useView";

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
 * The catalog's status: a view of the window's cache (decision 0018, group 7), read again as the change
 * log says the configuration or availability moved. `stamp` is the last availability check's time:
 * a refresh follows every check, so it is read again when that moves.
 */
export function useCatalogStatus(stamp: number): CatalogState {
  const view = useView("catalog:status", undefined).value ?? null;
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // Read again after every check — and, while a pass is running or a planned source has not answered
  // yet, every second and a half until it settles: the refresh that follows a check lands seconds
  // AFTER it, and the engine says nothing when it does.
  const [tick, setTick] = useState(0);
  const settling = view === null || view.refreshing || view.sources.some((s) => s.state === "not asked yet");
  useEffect(() => {
    if (tick > 0 || stamp > 0) void syncCache().refresh("catalog:status", undefined);
    setNow(Date.now());
  }, [stamp, tick]);
  useEffect(() => {
    if (!settling) return;
    const timer = setTimeout(() => setTick((n) => n + 1), 1500);
    return () => clearTimeout(timer);
  }, [settling, tick]);

  const refresh = (): void => {
    setRefreshing(true);
    void invoke("catalog:refresh", undefined)
      .then(() => {
        setNow(Date.now());
        return syncCache().refresh("catalog:status", undefined);
      })
      .catch(() => undefined)
      .finally(() => setRefreshing(false));
  };

  return { view, now, busy: refreshing || view?.refreshing === true, refresh };
}

/** The three states a catalog source's row can be in, as a provider row's (`ProviderState`). */
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
