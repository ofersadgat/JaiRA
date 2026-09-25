/**
 * Settings → Licenses: every third-party notice JaiRA ships, after t3code's `OpenSourceLicenses.tsx`.
 *
 * The list is the build's (`packages/app/licenses/thirdPartyLicenses.ts` writes it beside the renderer,
 * main reads it on `licenses:read`), decoded here so a manifest from a different build is refused
 * whole with the reason rather than drawn in part. One section, one card: a row per package — name,
 * version, license and which part of the app carries it — that opens onto the notice's full text, and
 * a link to the project's source. A search at the section's head narrows by name, version, license or
 * bundle; the count beside it says how many of how many.
 *
 * Not layered: nothing here is a setting, so the page has no switch and no "Just you" view.
 */
import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import {
  decodeThirdPartyLicenseManifest,
  filterThirdPartyLicenseEntries,
  formatLicenseBundles,
  thirdPartyLicenseEntryKey,
  type ThirdPartyLicenseEntry,
  type ThirdPartyLicenseManifest,
} from "@jaira/shared/browser";
import { invoke } from "./store";
import { SettingsSection } from "./settingsLayout";

type ManifestState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly manifest: ThirdPartyLicenseManifest };

function LicenseRow({ entry, open, onOpen }: { entry: ThirdPartyLicenseEntry; open: boolean; onOpen: (open: boolean) => void }): JSX.Element {
  return (
    <article className={`lic-row${open ? " open" : ""}`}>
      <div className="lic-line">
        <button type="button" className="lic-toggle" aria-expanded={open} onClick={() => onOpen(!open)}>
          <span className="lic-chevron" aria-hidden="true">
            ›
          </span>
          <span className="lic-name">{entry.name}</span>
          {entry.version !== null ? <code className="lic-version">{entry.version}</code> : null}
          <span className="lic-meta">
            {entry.license} · {formatLicenseBundles(entry.bundles)}
          </span>
        </button>
        {entry.sourceUrl !== null ? (
          // `_blank` reaches the person's browser: main's window-open handler sends http(s) there.
          <a className="lic-source" href={entry.sourceUrl} target="_blank" rel="noreferrer noopener" title={`${entry.name}'s source — ${entry.sourceUrl}`} aria-label={`Project source for ${entry.name}`}>
            ↗
          </a>
        ) : null}
      </div>
      {/* The text only while open: 340 notices, some of them pages long, are not worth laying out unseen. */}
      {open ? <pre className="lic-notice">{entry.noticeText}</pre> : null}
    </article>
  );
}

function LicenseSearch({ query, onQuery, shown, total }: { query: string; onQuery: (query: string) => void; shown: number; total: number }): JSX.Element {
  return (
    <span className="lic-head">
      <span className="lic-count">{shown === total ? `${String(total)} notices` : `${String(shown)} of ${String(total)}`}</span>
      <input
        type="search"
        className="lic-search"
        placeholder="Search licenses"
        aria-label="Search open-source licenses"
        value={query}
        onChange={(event) => onQuery(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || query.length === 0) return;
          event.preventDefault();
          onQuery("");
        }}
      />
    </span>
  );
}

export function LicensesPane(): JSX.Element {
  const [state, setState] = useState<ManifestState>({ status: "loading" });
  const [query, setQuery] = useState("");
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setState({ status: "loading" });
    invoke("licenses:read", undefined).then(
      (raw) => {
        if (!live) return;
        try {
          setState({ status: "ready", manifest: decodeThirdPartyLicenseManifest(raw) });
        } catch (error) {
          setState({ status: "error", message: (error as Error).message });
        }
      },
      (error: unknown) => {
        if (live) setState({ status: "error", message: error instanceof Error ? error.message : "The license manifest could not be read." });
      },
    );
    return () => {
      live = false;
    };
  }, [attempt]);

  const entries = state.status === "ready" ? state.manifest.entries : [];
  const shown = useMemo(() => filterThirdPartyLicenseEntries(entries, query), [entries, query]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return (
    <div className="cfg-pane">
      <SettingsSection
        id="notices"
        title="Third-party notices"
        info="Every package the app bundles or loads, and the fonts, theme and runtime it ships with. Written by the build from each package's own LICENSE and NOTICE files."
        action={state.status === "ready" ? <LicenseSearch query={query} onQuery={setQuery} shown={shown.length} total={entries.length} /> : undefined}
      >
        {state.status === "ready" ? (
          shown.length > 0 ? (
            <div className="lic-list">
              {shown.map((entry) => {
                const key = thirdPartyLicenseEntryKey(entry);
                return <LicenseRow key={key} entry={entry} open={openKey === key} onOpen={(open) => setOpenKey(open ? key : null)} />;
              })}
            </div>
          ) : (
            <p className="lic-empty">No licenses match that search.</p>
          )
        ) : state.status === "error" ? (
          <div className="set-row">
            <div className="set-row-line">
              <div className="set-row-say">
                <div className="set-name" role="heading" aria-level={3}>
                  Open-source notices are unavailable
                </div>
                <p className="set-desc">{state.message}</p>
              </div>
              <div className="set-ctl">
                <button type="button" onClick={retry}>
                  Try again
                </button>
              </div>
            </div>
          </div>
        ) : (
          <p className="lic-empty">Loading open-source notices…</p>
        )}
      </SettingsSection>
    </div>
  );
}
