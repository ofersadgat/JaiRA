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
import { useState, type JSX } from "react";
import type { CatalogSourceView } from "@jaira/shared/browser";
import { SOURCE_BRAND, catalogLastLine, catalogRowOf, type CatalogState } from "./catalogModel";
import { StatusDot, type ProviderState } from "./controls";
import { BrandIcon, Icon } from "./icons";
import { Pill } from "./pill";
import { SettingsSection } from "./settingsLayout";

export { useCatalogStatus, type CatalogState } from "./catalogModel";

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
          {catalogLastLine(view, now) !== undefined ? <span className="app-secondary">{catalogLastLine(view, now)}</span> : null}
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
  const row = catalogRowOf(source, now);
  const state: ProviderState = row.state;
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
        {row.say}
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
