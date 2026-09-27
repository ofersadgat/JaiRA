/**
 * Settings → About (decision 0011 §4–§6; the person's rulings on the update screens, 2026-09-26): the
 * build you are running, how it updates, the plugins it can download, and the open-source software it
 * is built from. It took Licenses' place at the foot of the list, and the notices are its last section.
 *
 * No layer switch. The one setting on it, the Update track, is the machine's own and lives in the
 * personal layer (`personal-settings.json`), whatever layer another page is on: the row shows the
 * track in effect, a change writes the personal layer, and ↺ takes it out again so the build's own
 * track (or Shared's) applies.
 *
 * Sections, top to bottom:
 *
 *  - **Needs attention** — this page's warnings, while there are any (`healthView.tsx`);
 *  - **Updates** — Version, Update track, Status. Status is where the updater stands, in words, with
 *    the one control that moves it on: Check now, the split Update (always here, even after the
 *    sidebar's notice was dismissed), Cancel while waiting, Restart now after Not now, the release page
 *    on a Mac that cannot install by itself; and the release notes as published;
 *  - **Plugins** — one row per family, each with its own Check; Local models lists the builds this
 *    machine can use under it. Plugins follow the app: there is no other version to pick;
 *  - **Third-party notices** — `licensesPane.tsx`.
 */
import { useState, type JSX, type ReactNode } from "react";
import { channelOfVersion, inheritedValue, statesPath, type ConfigView, type HealthItem, type UpdateChannel, type UpdateState } from "@jaira/shared/browser";
import { Disclosure, SettingsLayerContext } from "./controls";
import { NeedsAttention } from "./healthView";
import { SOURCE_WORDS } from "./layerLabels";
import { ThirdPartyNotices } from "./licensesPane";
import { ContextMenu, MENU_WIDTH, type MenuAnchor } from "./menu";
import { Segmented, SettingsRow, SettingsSection } from "./settingsLayout";
import {
  buildDownloadBytes,
  checkedAgo,
  pluginFamilies,
  publishedWords,
  sizeWords,
  waitedFor,
  type PluginFamily,
  type PluginRow,
} from "./updatesModel";
import { applyUpdate, checkForUpdate, checkPlugin, installPlugin, removePlugin, usePlugins, useUpdate, type UpdateView } from "./updatesStore";
import { UpdateSplit } from "./updatesView";

const TRACK_CHOICES: ReadonlyArray<readonly [string, UpdateChannel]> = [
  ["Stable", "stable"],
  ["Nightly", "nightly"],
];

const TRACK_PATH = "updates.channel";

const ver = (version: string): JSX.Element => <code className="upd-ver">{version}</code>;

/** A download's progress bar. */
function Bar({ percent, className }: { percent: number; className: string }): JSX.Element {
  return (
    <span className={`um-bar um-accent ${className}`}>
      <i style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />
    </span>
  );
}

/** "A development build does not update itself." — the updater's reason, as a sentence. */
const sentence = (text: string): string => {
  const trimmed = text.trim();
  const capital = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
};

/** The Status row: where the updater stands, and the one control that moves it on. */
function StatusRow({ view, notesOpen }: { view: UpdateView; notesOpen: boolean }): JSX.Element {
  const { update: state, busy, queued, restarting } = view;
  const row = (description: ReactNode, control?: ReactNode, children?: ReactNode): JSX.Element => (
    <SettingsRow name="Status" description={description} control={control}>
      {children}
    </SettingsRow>
  );
  if (state === null) return row("Reading where the updater stands…");
  const next = state.available;
  const notes =
    next?.notes !== undefined && next.notes.trim() !== "" ? (
      <div className="upd-under">
        <Disclosure summary="Release notes" desc="as published" defaultOpen={notesOpen}>
          <pre className="upd-notes-pub">{next.notes}</pre>
        </Disclosure>
      </div>
    ) : undefined;
  const checkNow = (label = "Check now"): JSX.Element => (
    <button type="button" className="ghost" onClick={checkForUpdate}>
      {label}
    </button>
  );
  if (restarting) return row(<>Restarting to install {next !== undefined ? ver(next.version) : "the update"}…</>);
  switch (state.status) {
    case "disabled":
      return row(<span className="upd-err">{sentence(state.reason ?? "this build does not update itself")}</span>);
    case "idle":
      return row("Not checked yet · JaiRA checks a little after it starts.", checkNow());
    case "checking":
      return row(
        "Checking for a newer version…",
        <button type="button" className="ghost" disabled>
          Checking…
        </button>,
      );
    case "up-to-date":
      return row(`Up to date · ${checkedAgo(state.checkedAt)}`, checkNow());
    case "available": {
      if (next === undefined) return row(`Up to date · ${checkedAgo(state.checkedAt)}`, checkNow());
      const when = publishedWords(next.releaseDate);
      if (state.manual === true) {
        return row(
          <>{ver(next.version)} is available. This Mac build cannot install it by itself.</>,
          <button type="button" className="primary" onClick={() => window.open(next.url, "_blank", "noopener")}>
            Open the release page ↗
          </button>,
          notes,
        );
      }
      return row(
        <>
          {ver(next.version)} is available{when !== undefined ? ` · ${when}` : ""}
          {state.dismissed === next.version ? " · hidden from the sidebar" : ""}
        </>,
        <UpdateSplit label="Update" state={state} busy={busy} queued={queued} />,
        notes,
      );
    }
    case "downloading": {
      const then =
        queued === "later"
          ? " · then installs when JaiRA next closes"
          : queued === "cancel"
            ? " · then waits for you to restart"
            : queued === "pause"
              ? " · then pauses what is going and restarts"
              : busy !== undefined && busy.runs + busy.turns > 0
                ? ` · then restarts when ${waitedFor(busy)} finish`
                : " · then restarts";
      return row(
        <>
          Downloading {next !== undefined ? ver(next.version) : "the update"} · {state.percent ?? 0}%{then}
        </>,
        <>
          <Bar percent={state.percent ?? 0} className="upd-bar" />
          {queued === "later" || queued === "cancel" ? null : (
            <button
              type="button"
              className="ghost"
              title="Stops the restart. The download finishes, and the update waits for Restart to update (closing JaiRA also installs it)."
              onClick={() => applyUpdate("cancel")}
            >
              Cancel
            </button>
          )}
        </>,
      );
    }
    case "downloaded": {
      const named = next !== undefined ? ver(next.version) : "The update";
      if (state.pending === "waiting") {
        return row(
          <>
            Waiting for {waitedFor(state.busy)} to finish, then restarting{next !== undefined ? <> with {ver(next.version)}</> : null}.
          </>,
          <button type="button" className="ghost" onClick={() => applyUpdate("cancel")}>
            Cancel
          </button>,
        );
      }
      if (state.pending === "on-quit") return row(<>{named} installs when JaiRA next closes.</>, <UpdateSplit label="Restart now" state={state} busy={busy} queued={queued} />);
      return row(<>{named} is ready. Restarting installs it.</>, <UpdateSplit label="Restart to update" state={state} busy={busy} queued={queued} />, notes);
    }
    case "error":
      return row(<span className="upd-err">{sentence(next !== undefined ? `The update failed: ${state.error ?? "unknown error"}` : `The check failed: ${state.error ?? "unknown error"}`)}</span>, checkNow("Check again"));
  }
}

function UpdatesSection({ config, onTrack, notesOpen }: { config: ConfigView | null; onTrack: (channel: UpdateChannel | undefined) => void; notesOpen: boolean }): JSX.Element {
  const view = useUpdate();
  const state: UpdateState | null = view.update;
  const version = state?.version ?? "";
  const own = channelOfVersion(version);
  const effective = (config?.effective as { updates?: { channel?: UpdateChannel } } | undefined)?.updates?.channel;
  const channel = effective ?? state?.channel ?? own;
  // ↺ while the personal layer states the track: back to what Shared says, or this build's own.
  const stated = config !== null && statesPath(config.you, TRACK_PATH);
  const below = config !== null ? inheritedValue(config, TRACK_PATH, "you") : undefined;
  const back =
    below === undefined || below.value === undefined
      ? `Back to this build's own track, ${own}`
      : `Back to ${String(below.value)}, from ${SOURCE_WORDS[below.from]}`;
  return (
    <SettingsSection id="updates" title="Updates" info="JaiRA checks 15 seconds after it starts and then every hour. Nothing downloads or installs until you click.">
      <SettingsRow
        name="Version"
        description="The build running now."
        control={
          <span className="upd-running">
            <code>{version}</code>
            <span className="upd-chan">{own}</span>
          </span>
        }
      />
      <SettingsRow
        name="Update track"
        description={channel === "nightly" ? "Nightly: every day's build, a few a day at most." : "Stable: tested releases, a few a month."}
        info="Kept on this machine, in personal-settings.json. Going from Nightly to Stable installs the latest stable release once, even though its version is older."
        reset={stated ? { label: back, onReset: () => onTrack(undefined), disabled: config === null } : undefined}
        control={<Segmented label="Update track" value={channel} options={TRACK_CHOICES} disabled={config === null || state?.status === "disabled"} onChange={onTrack} />}
      />
      <StatusRow view={view} notesOpen={notesOpen} />
    </SettingsSection>
  );
}

// --- plugins ------------------------------------------------------------------------------------------

/**
 * "✓ from this checkout 0.3.282": a development checkout's own copy, in its `node_modules` — present,
 * at whatever version the checkout has, and not the store's to download, update or remove.
 */
function FromCheckout({ version }: { version: string | undefined }): JSX.Element {
  return (
    <span className="plg-ok" title="This development checkout has the package in its node_modules, so nothing is downloaded, updated or removed here">
      <span aria-hidden="true">✓ </span>
      from this checkout{version !== undefined ? <> <code>{version}</code></> : null}
    </span>
  );
}

/** "✓ 0.3.282": installed, and the version this build names. */
function Current({ version }: { version: string }): JSX.Element {
  return (
    <span className="plg-ok">
      <span aria-hidden="true">✓ </span>
      <code>{version}</code>
    </span>
  );
}

function Size({ bytes, plus }: { bytes: number | undefined; plus?: string }): JSX.Element | null {
  if (bytes === undefined) return null;
  return (
    <span className="plg-size">
      {sizeWords(bytes)} download{plus ?? ""}
    </span>
  );
}

function Progress({ row }: { row: PluginRow }): JSX.Element {
  const progress = row.status.progress ?? { done: 0, total: 0 };
  return (
    <span className="plg-prog">
      <Bar percent={progress.total === 0 ? 0 : (progress.done / progress.total) * 100} className="plg-bar" />
      <span className="sub">{progress.total === 0 ? "starting…" : `${progress.done} of ${progress.total} packages`}</span>
    </span>
  );
}

/** A row's own Check: compare what is installed with what this build names. When it last did, on its tooltip. */
function Check({ row, checked }: { row: PluginRow; checked: number | undefined }): JSX.Element {
  return (
    <button
      type="button"
      className="ghost sm plg-check"
      title={`Compare what is installed with the version this build names · ${checkedAgo(checked)}`}
      onClick={() => checkPlugin(row.id)}
    >
      Check
    </button>
  );
}

/** ⋯ — Remove, behind a menu so it is not one stray click away. */
function More({ label, note, onRemove }: { label: string; note?: string | undefined; onRemove: () => void }): JSX.Element {
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  return (
    <>
      <button
        type="button"
        className={`quiet sm plg-more${menu !== null ? " on" : ""}`}
        title={`More for ${label}`}
        aria-label={`More for ${label}`}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        onClick={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          setMenu({ x: box.right - MENU_WIDTH, y: box.bottom + 4, origin: e.currentTarget, title: label, items: [] });
        }}
      >
        ⋯
      </button>
      {menu !== null ? (
        <ContextMenu
          anchor={{ ...menu, items: [{ label: "Remove", danger: true, ...(note !== undefined ? { note } : {}), onSelect: onRemove }] }}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </>
  );
}

/** Download, Update or Try again — whichever this row needs — with what it would download. */
function Get({ row, bytes, verb, primary, small }: { row: PluginRow; bytes: number | undefined; verb: string; primary?: boolean; small?: boolean }): JSX.Element {
  const cls = [small === true ? "sm" : "", primary === true ? "primary" : ""].filter(Boolean).join(" ");
  return (
    <>
      <Size bytes={bytes} />
      <button type="button" className={cls === "" ? undefined : cls} onClick={() => installPlugin(row.id)}>
        {verb}
      </button>
    </>
  );
}

function BaseRow({ family, checked }: { family: PluginFamily; checked: Partial<Record<string, number>> }): JSX.Element {
  const row = family.base;
  const local = family.builds.length > 0;
  const description = local
    ? row.status.installed !== undefined
      ? "Loads GGUF weights into JaiRA itself. Add another build beside the one you have."
      : "Loads GGUF weights into JaiRA itself. Pick the build for your hardware; the suggested one fits this machine."
    : row.id === "claude-agent-sdk"
      ? "Runs the Claude route on an API key, and reads the claude-cli route's usage."
      : row.note;
  let control: ReactNode;
  if (row.busy) control = <Progress row={row} />;
  else if (row.workspace)
    control = (
      <>
        <FromCheckout version={row.status.installed} />
        <Check row={row} checked={checked[row.id]} />
      </>
    );
  else if (row.status.error !== undefined) control = <button type="button" onClick={() => installPlugin(row.id)}>Try again</button>;
  else if (row.current)
    control = (
      <>
        <Current version={row.status.version} />
        <Check row={row} checked={checked[row.id]} />
        <More label={row.name} onRemove={() => removePlugin(row.id)} />
      </>
    );
  else if (row.outdated)
    control = (
      <>
        <Get row={row} bytes={row.status.downloadBytes} verb="Update" />
        <More label={row.name} onRemove={() => removePlugin(row.id)} />
      </>
    );
  else if (local) control = <span className="sub">{row.status.downloadBytes !== undefined ? `${sizeWords(row.status.downloadBytes)} download, plus a build` : "pick a build below"}</span>;
  else control = <Get row={row} bytes={row.status.downloadBytes} verb="Download" />;
  return (
    <SettingsRow
      name={row.name}
      description={
        row.outdated ? (
          <>
            {description}{" "}
            <span className="plg-old">
              <code>{row.status.installed}</code> is installed; this build uses <code>{row.status.version}</code>.
            </span>
          </>
        ) : (
          description
        )
      }
      control={control}
    >
      {row.status.error !== undefined && !row.busy ? <p className="plg-err">{sentence(row.status.error)}</p> : null}
      {local ? (
        <ul className="plg-vars">
          {family.builds.map((build) => (
            <BuildLine key={build.id} family={family} build={build} />
          ))}
        </ul>
      ) : null}
    </SettingsRow>
  );
}

/** One Local models build: installed, downloading, failed, or offered with what it would download. */
function BuildLine({ family, build }: { family: PluginFamily; build: PluginRow }): JSX.Element {
  const baseIn = family.base.status.installed !== undefined;
  const installedBuilds = family.builds.filter((b) => b.status.installed !== undefined).length;
  const label = `the ${build.name} build`;
  let tail: ReactNode;
  if (build.busy) tail = <Progress row={build} />;
  else if (build.workspace) tail = <FromCheckout version={build.status.installed} />;
  else if (build.status.error !== undefined)
    tail = (
      <button type="button" className="sm" onClick={() => installPlugin(build.id)}>
        Try again
      </button>
    );
  else if (build.current)
    tail = (
      <>
        <span className="plg-ok">✓ installed</span>
        <More label={label} note={installedBuilds === 1 ? "the only build" : undefined} onRemove={() => removePlugin(build.id)} />
      </>
    );
  else if (build.outdated)
    tail = (
      <>
        <Get row={build} bytes={build.status.downloadBytes} verb="Update" small />
        <More label={label} note={installedBuilds === 1 ? "the only build" : undefined} onRemove={() => removePlugin(build.id)} />
      </>
    );
  else tail = <Get row={build} bytes={buildDownloadBytes(family, build)} verb={baseIn ? "Add" : "Download"} primary={!baseIn && build.status.recommended === true} small />;
  return (
    <li className={`plg-var${build.status.installed !== undefined ? " on" : ""}`}>
      <div className="plg-var-line">
        <span className="plg-var-say">
          <span className="plg-var-name">{build.name}</span>
          {build.status.recommended === true ? <span className="plg-tag">suggested</span> : null}
          <span className="plg-var-note">{build.note}</span>
        </span>
        <span className="plg-var-ctl">{tail}</span>
      </div>
      {build.status.error !== undefined && !build.busy ? <p className="plg-err">{sentence(build.status.error)}</p> : null}
    </li>
  );
}

function PluginsSection(): JSX.Element {
  const { plugins, checked } = usePlugins();
  const families = pluginFamilies(plugins);
  return (
    <SettingsSection
      id="plugins"
      title="Plugins"
      info="Parts left out of the installer because they are big. Each is stored once, and shared by every project."
      lead="Plugins follow the app: this build uses exactly the versions shown, and updating JaiRA can make one out of date."
    >
      {families.length === 0 ? (
        <SettingsRow name="No plugins" description="This build carries no plugin manifest, so there is nothing to download." />
      ) : (
        families.map((family) => <BaseRow key={family.base.id} family={family} checked={checked} />)
      )}
    </SettingsSection>
  );
}

// --- the page -------------------------------------------------------------------------------------------

export function AboutPane({
  config,
  health,
  onFix,
  onTrack,
  notesOpen = false,
}: {
  /** Every layer's document: the Update track row reads the personal layer's, and what it inherits. */
  config: ConfigView | null;
  health: readonly HealthItem[];
  onFix: (item: HealthItem) => void;
  /** Write the track into the personal layer; `undefined` takes it out. */
  onTrack: (channel: UpdateChannel | undefined) => void;
  /** Open with the release notes showing — the sidebar menu's Release notes. */
  notesOpen?: boolean;
}): JSX.Element {
  return (
    // Not a layered page: no row here is judged by the layer another page is on.
    <SettingsLayerContext.Provider value={null}>
      <div className="cfg-pane">
        <NeedsAttention items={health} page="about" onFix={onFix} />
        <UpdatesSection config={config} onTrack={onTrack} notesOpen={notesOpen} />
        <PluginsSection />
        <ThirdPartyNotices />
      </div>
    </SettingsLayerContext.Provider>
  );
}
