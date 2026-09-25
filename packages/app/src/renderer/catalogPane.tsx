/**
 * Settings → Models → Catalog — what this machine's routes say they serve (decision 0009).
 *
 * The catalog refreshes itself: every source is asked after an availability check and hourly, and
 * asked again when its inputs change or its answer is a day old. This section is where a person sees
 * that happening — each source's last answer, when it is asked next, what went wrong and what to do
 * about it — and where Refresh asks every source now, for after installing a model or updating an
 * agent. Each row opens to list the models its source reported, with their reasoning levels: what to
 * look at when a level is missing from a picker.
 */
import { useEffect, useState, type JSX } from "react";
import type { CatalogSourceView, CatalogStatusView } from "@jaira/shared/browser";
import { StatusDot, type ProviderState } from "./controls";
import { BrandIcon, Icon } from "./icons";
import { Pill } from "./pill";
import { agoLabel } from "./remoteStrip";
import { SettingsSection } from "./settingsLayout";
import { invoke } from "./store";

/** The brand a source's row wears. */
const SOURCE_BRAND: Record<string, string> = {
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
function inLabel(at: number, now: number): string {
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

/** The Catalog section, over the page's {@link useCatalogStatus}. */
export function CatalogSection({ catalog }: { catalog: CatalogState }): JSX.Element {
  const { view, now, busy, refresh } = catalog;
  return (
    <SettingsSection
      id="catalog"
      title="Catalog"
      info="What this machine's routes say they serve — each model's levels, limits and price. Refreshed by itself after every availability check and hourly; press Refresh after installing a model or updating an agent."
      action={
        <span className="catalog-aside">
          {view?.lastAt !== undefined ? (
            <span className="app-secondary">
              last refreshed {agoLabel(view.lastAt, now)}
              {view.tookMs !== undefined ? ` · ${(view.tookMs / 1000).toFixed(1)} s` : ""}
            </span>
          ) : null}
          <button type="button" className="ghost" disabled={busy} onClick={refresh}>
            {busy ? "Refreshing…" : "Refresh"}
          </button>
        </span>
      }
    >
      {view === null ? (
        <p className="cfg-hint">Reading the catalog…</p>
      ) : (
        <ul className="cfg-rows">
          {view.sources.map((source) => (
            <CatalogRow key={source.name} source={source} now={now} />
          ))}
        </ul>
      )}
    </SettingsSection>
  );
}

/** One source: what it asked, how that went, when it is asked next — and, opened, the models it said. */
function CatalogRow({ source, now }: { source: CatalogSourceView; now: number }): JSX.Element {
  const [open, setOpen] = useState(false);
  const state: ProviderState = source.state === "ok" ? "available" : source.state === "failed" ? "unavailable" : "unconfigured";
  const next =
    source.nextAt === undefined
      ? undefined
      : source.state === "failed"
        ? `asks again ${inLabel(source.nextAt, now)}`
        : `asked again ${inLabel(source.nextAt, now)}${source.changesWith !== undefined ? `, or when ${source.changesWith}` : ""}`;
  return (
    <li className={`cfg-row ${state}`}>
      <div className="cfg-row-head">
        <span className="cfg-mark">
          <BrandIcon name={SOURCE_BRAND[source.name] ?? source.name} className="cfg-mark-svg" />
          <StatusDot state={state} />
        </span>
        <span className="cfg-row-title">{source.name}</span>
        {source.version !== undefined ? <code className="cfg-version">{source.version}</code> : null}
        <span className="grow" />
        {source.fetched !== undefined && source.state === "ok" ? <span className="data-secondary catalog-count">{source.fetched} rows</span> : null}
        {source.state === "failed" && source.models.length > 0 ? <span className="data-secondary catalog-count">{source.models.length} rows, kept</span> : null}
        {source.state === "ok" ? <Pill kind="success" word="ok" /> : source.state === "failed" ? <Pill kind="error" word="failed" /> : null}
        {source.models.length > 0 ? (
          <button
            type="button"
            className={`quiet cfg-chevron${open ? " open" : ""}`}
            aria-expanded={open}
            aria-label={open ? `hide ${source.name}'s models` : `show ${source.name}'s models`}
            title={open ? "Hide the models" : "Show the models"}
            onClick={() => setOpen((v) => !v)}
          >
            <Icon name="chevron" />
          </button>
        ) : null}
      </div>
      <p className="cfg-say">
        <span className="cfg-say-state">{source.state}</span>
        {source.state === "not configured" ? (
          <> — {source.error}</>
        ) : source.state === "not asked yet" ? (
          <> — asks {source.asks} after the next availability check</>
        ) : (
          <>
            {" — "}
            {source.state === "failed" ? `${source.error} · ` : `asked ${source.asks} · `}
            {source.at !== undefined ? agoLabel(source.at, now) : ""}
            {next !== undefined ? ` · ${next}` : ""}
          </>
        )}
        {source.fix !== undefined ? <span className="cfg-fix">→ {source.fix}</span> : null}
      </p>
      {open ? (
        <div className="cfg-row-body">
          <div className="catalog-models">
            {source.models.map((model) => (
              <div key={model.id} className="catalog-model">
                <code className="data-text">{model.id}</code>
                <span className="app-secondary">{model.alias ?? model.levels ?? ""}</span>
                <span>{model.hidden === true ? <span className="catalog-hidden">hidden</span> : null}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </li>
  );
}
