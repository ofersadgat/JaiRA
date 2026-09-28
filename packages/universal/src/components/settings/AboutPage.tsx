import { useState, type JSX, type ReactNode } from "react";
import { Linking, TextInput } from "react-native";
import { View } from "@tamagui/core";
import { formatLicenseBundles, thirdPartyLicenseEntryKey, withPaths, type JairaEngineConfig, type PluginId, type ThirdPartyLicenseEntry, type UpdateChannel } from "@jaira/shared/browser";
import {
  ANTHROPIC_TERMS,
  TRACK_CHOICES,
  buildTailOf,
  commandWords,
  downloadingThen,
  engineSwitchesOf,
  engineWhere,
  licenseCountWords,
  pluginControlOf,
  pluginDescriptionOf,
  sentence,
  updateTrackOf,
  useCliCommand,
  useEngineStatus,
  useLicenseManifest,
} from "@jaira/ui/aboutModel";
import { buildDownloadBytes, checkedAgo, pluginFamilies, publishedWords, sizeWords, waitedFor, type PluginFamily, type PluginRow } from "@jaira/ui/updatesModel";
import { applyUpdate, checkForUpdate, checkPlugin, installPlugin, removePlugin, usePlugins, useUpdate, type UpdateView } from "@jaira/ui/updatesStore";
import { useShell } from "../../app/shell";
import { Press, Txt, edge, font, lengthToken, placeholderColor, useHover } from "../../primitives";
import { useLook, useTokens } from "../../tokens";
import { ContextMenu, type MenuAt } from "../Menu";
import { Icon } from "../panel/Icon";
import { Disclosure } from "../form/Field";
import { Button } from "./Button";
import { Segmented, Switch } from "./controls";
import { SettingsLayerContext } from "./layers";
import { NeedsAttention } from "./NeedsAttention";
import { SettingsRow, SettingsSection } from "./SettingsPage";

/**
 * Settings → About (`aboutPane.tsx`, `licensesPane.tsx`), universal (decision 0015): the build running,
 * how it updates, its plugins, where the engine runs, the `jaira` command, and the third-party notices.
 * What each row says and which control it carries are `aboutModel.ts`'s and `updatesModel.ts`'s; the
 * reads and writes are `updatesStore.ts`'s, as the DOM's are. The rules it adds:
 *
 *   .upd-running         row, centred, gap 8; its code data 11.5/12 --text
 *   .upd-chan            app 11/12.5 on an 18px line, --dim, 1px --line, round, padding 0 8
 *   .upd-err             --bad
 *   .upd-under           10 above; the notes `pre` data 11/12 on a 1.6 line, padding 10 12, radius 8,
 *                        --panel-2
 *   .plg-ok              row, centred, gap 2, --ok, app 12/12.5, one line; its code --text data 11.5/12
 *                        (0.35em after the words)
 *   .plg-size            data 11/12 --dim
 *   .plg-old             --warn
 *   .plg-check           a `button.ghost.sm`: padding 2 8, radius --control-radius-sm, app 11/12.5
 *   .plg-more            a `button.quiet.sm` 24 square, app 14/12.5 on a line of 1
 *   .plg-prog            row, centred, gap 10; the bar 120 × 6 (`.um-bar`: --dim 16%, radius 3)
 *   .plg-err             6 above, --bad, app 12/12.5, line 1.45
 *   .plg-vars            14 in, 10 above; each build 7 0 with a --line above; its line a row,
 *                        space-between, wraps, gap 6 16, at least 26 tall
 *   .plg-tag             app 10.5/12.5 on 17px, padding 0 7, round, --accent on --tint-accent
 *   .lic-head            row, centred, gap 10: the count app 0.96× --dim, the search 13rem, padding 4 9,
 *                        1px --line, radius 7, --panel, app 0.96×
 *   .lic-row + .lic-row  a --line between; the line hovered --fill-ghost-hover; the toggle a row,
 *                        baseline, gap 8, padding 9 16: › 10 wide --dim (turned open), the name 550 one
 *                        line, the version data at 0.9× of the app size --dim, the meta at 0.94× --dim at
 *                        the end (at most 45%); ↗ 22 square, 12 in from the right, radius 5, --dim
 *   .lic-notice          padding 2 16 16 34, data at 0.9× of the app size on a 1.55 line, --text 82%
 *   .lic-empty           padding 18 16, --dim
 */
export function AboutPage(): JSX.Element {
  const { state, actions } = useShell();
  const config = state.config;
  return (
    <SettingsLayerContext.Provider value={null}>
      <NeedsAttention page="about" />
      <UpdatesSection
        onTrack={(channel) => {
          if (config === null) return;
          void actions.saveConfig("you", withPaths(config.you, [["updates.channel", channel]]));
        }}
      />
      <PluginsSection />
      <EngineSection
        onEngine={(patch) => {
          if (config === null) return;
          void actions.saveConfig("you", withPaths(config.you, Object.entries(patch).map(([key, value]) => [`engine.${key}`, value] as [string, unknown])));
        }}
      />
      <CommandLineSection />
      <ThirdPartyNotices />
    </SettingsLayerContext.Provider>
  );
}

const DESC = { voice: "app", scale: 1.03, lineHeight: 1.45, color: "dim" } as const;

/** `code.upd-ver` in a row's sentence. */
function Ver({ children }: { children: string }): JSX.Element {
  return <Txt spec={{ voice: "data", scale: (11 / 12) * (13 / 12.875) * (12.875 / 13), lineHeight: 1.45, color: "dim" }}>{children}</Txt>;
}

/** A row's sentence, with a version in it. */
function Say({ children, bad = false }: { children: ReactNode; bad?: boolean }): JSX.Element {
  return <Txt spec={{ ...DESC, ...(bad ? { color: "bad" } : {}) }}>{children}</Txt>;
}

/** A progress bar (`.um-bar.um-accent`). */
function Bar({ percent, width }: { percent: number; width: number }): JSX.Element {
  const t = useTokens();
  return (
    <View width={width} height={6} borderRadius={3} overflow="hidden" backgroundColor={t.mix(t.v("dim"), 16, "transparent") as never}>
      <View height="100%" borderRadius={3} width={`${Math.max(0, Math.min(100, percent))}%`} backgroundColor={t.v("accent") as never} />
    </View>
  );
}

function StatusRow({ view, notesOpen }: { view: UpdateView; notesOpen: boolean }): JSX.Element {
  const { update: state, busy, queued, restarting } = view;
  const row = (description: ReactNode, control?: ReactNode, children?: ReactNode): JSX.Element => (
    <SettingsRow name="Status" description={description} control={control}>
      {children}
    </SettingsRow>
  );
  if (state === null) return row("Reading where the updater stands…");
  const next = state.available;
  const t = useTokens();
  const notes =
    next?.notes !== undefined && next.notes.trim() !== "" ? (
      <View marginTop={10}>
        <Disclosure summary="Release notes" desc="as published" defaultOpen={notesOpen}>
          <Txt spec={{ voice: "data", scale: 11 / 12, lineHeight: 1.6 }} paddingVertical={10} paddingHorizontal={12} borderRadius={8} backgroundColor={t.v("panel-2") as never}>
            {next.notes}
          </Txt>
        </Disclosure>
      </View>
    ) : undefined;
  const checkNow = (label = "Check now"): JSX.Element => (
    <Button kind="ghost" onPress={checkForUpdate}>
      {label}
    </Button>
  );
  if (restarting) return row(<Say>{["Restarting to install ", next !== undefined ? <Ver key="v">{next.version}</Ver> : "the update", "…"]}</Say>);
  switch (state.status) {
    case "disabled":
      return row(<Say bad>{sentence(state.reason ?? "this build does not update itself")}</Say>);
    case "idle":
      return row("Not checked yet · JaiRA checks a little after it starts.", checkNow());
    case "checking":
      return row(
        "Checking for a newer version…",
        <Button kind="ghost" disabled>
          Checking…
        </Button>,
      );
    case "up-to-date":
      return row(`Up to date · ${checkedAgo(state.checkedAt)}`, checkNow());
    case "available": {
      if (next === undefined) return row(`Up to date · ${checkedAgo(state.checkedAt)}`, checkNow());
      const when = publishedWords(next.releaseDate);
      if (state.manual === true) {
        return row(
          <Say>
            <Ver>{next.version}</Ver> is available. This Mac build cannot install it by itself.
          </Say>,
          <Button kind="primary" onPress={() => void Linking.openURL(next.url)}>
            Open the release page ↗
          </Button>,
          notes,
        );
      }
      return row(
        <Say>
          <Ver>{next.version}</Ver>
          {` is available${when !== undefined ? ` · ${when}` : ""}${state.dismissed === next.version ? " · hidden from the sidebar" : ""}`}
        </Say>,
        <UpdateSplit label="Update" />,
        notes,
      );
    }
    case "downloading":
      return row(
        <Say>
          {"Downloading "}
          {next !== undefined ? <Ver>{next.version}</Ver> : "the update"}
          {` · ${state.percent ?? 0}%${downloadingThen(queued, busy)}`}
        </Say>,
        <>
          <Bar percent={state.percent ?? 0} width={180} />
          {queued === "later" || queued === "cancel" ? null : (
            <Button kind="ghost" title="Stops the restart. The download finishes, and the update waits for Restart to update (closing JaiRA also installs it)." onPress={() => applyUpdate("cancel")}>
              Cancel
            </Button>
          )}
        </>,
      );
    case "downloaded": {
      const named = next !== undefined ? <Ver>{next.version}</Ver> : "The update";
      if (state.pending === "waiting") {
        return row(
          <Say>
            {`Waiting for ${waitedFor(state.busy)} to finish, then restarting`}
            {next !== undefined ? (
              <>
                {" with "}
                <Ver>{next.version}</Ver>
              </>
            ) : null}
            .
          </Say>,
          <Button kind="ghost" onPress={() => applyUpdate("cancel")}>
            Cancel
          </Button>,
        );
      }
      if (state.pending === "on-quit") return row(<Say>{named} installs when JaiRA next closes.</Say>, <UpdateSplit label="Restart now" />);
      return row(<Say>{named} is ready. Restarting installs it.</Say>, <UpdateSplit label="Restart to update" />, notes);
    }
    case "error":
      return row(<Say bad>{sentence(next !== undefined ? `The update failed: ${state.error ?? "unknown error"}` : `The check failed: ${state.error ?? "unknown error"}`)}</Say>, checkNow("Check again"));
  }
}

/**
 * About's Update (`updatesView.tsx`'s `UpdateSplit`): the one click, and the chevron for the other
 * ways — whose menu (the approval card's) has no copy yet, so the chevron updates the same way.
 */
function UpdateSplit({ label }: { label: string }): JSX.Element {
  return (
    <View flexDirection="row">
      <Button kind="primary" onPress={() => applyUpdate("wait")} borderTopRightRadius={0} borderBottomRightRadius={0}>
        {label}
      </Button>
      <Button kind="primary" label="Other ways to update" onPress={() => applyUpdate("wait")} marginLeft={-1} paddingHorizontal={7} borderTopLeftRadius={0} borderBottomLeftRadius={0}>
        <Icon name="chevron" size={12} color="#fff" />
      </Button>
    </View>
  );
}

function UpdatesSection({ onTrack }: { onTrack: (channel: UpdateChannel | undefined) => void }): JSX.Element {
  const t = useTokens();
  const { state: shell } = useShell();
  const config = shell.config;
  const view = useUpdate();
  const state = view.update;
  const { version, own, channel, stated, back, words } = updateTrackOf(config, state);
  return (
    <SettingsSection id="updates" title="Updates" info="JaiRA checks 15 seconds after it starts and then every hour. Nothing downloads or installs until you click.">
      <SettingsRow
        name="Version"
        description="The build running now."
        control={
          <View flexDirection="row" alignItems="center" gap={8}>
            <Txt spec={{ voice: "data", scale: 11.5 / 12 }}>{version}</Txt>
            <Txt spec={{ voice: "app", scale: 11 / 12.5, lineHeight: { px: 18 }, color: "dim" }} paddingHorizontal={8} borderRadius={999} {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)}>
              {own}
            </Txt>
          </View>
        }
      />
      <SettingsRow
        name="Update track"
        description={words}
        info="Kept on this machine, in personal-settings.json. Going from Nightly to Stable installs the latest stable release once, even though its version is older."
        reset={stated ? { label: back, onReset: () => onTrack(undefined), disabled: config === null } : undefined}
        control={<Segmented label="Update track" value={channel} options={TRACK_CHOICES} disabled={config === null || state?.status === "disabled"} onChange={onTrack} />}
      />
      <StatusRow view={view} notesOpen={false} />
    </SettingsSection>
  );
}

/** "✓ 0.3.282" or "✓ from this checkout 0.3.282": installed. */
function Ok({ words, version, title }: { words?: string; version?: string | undefined; title?: string }): JSX.Element {
  return (
    <View flexDirection="row" alignItems="center" gap={2} flexShrink={0} {...(title !== undefined ? ({ title } as object) : {})}>
      {/* Each its own item of the inline-flex row, as the DOM's `<span>✓ </span>` and the words are. */}
      <Txt spec={{ voice: "app", scale: 12 / 12.5, color: "ok" }} numberOfLines={1}>
        ✓
      </Txt>
      {words !== undefined ? (
        <Txt spec={{ voice: "app", scale: 12 / 12.5, color: "ok" }} numberOfLines={1}>
          {words}
        </Txt>
      ) : null}
      {version !== undefined ? (
        <Txt spec={{ voice: "data", scale: 11.5 / 12 }} {...(words !== undefined ? { marginLeft: "0.35em" } : {})}>
          {version}
        </Txt>
      ) : null}
    </View>
  );
}

function FromCheckout({ version }: { version: string | undefined }): JSX.Element {
  return <Ok words="from this checkout" version={version} title="This development checkout has the package in its node_modules, so nothing is downloaded, updated or removed here" />;
}

function Size({ bytes, plus }: { bytes: number | undefined; plus?: string }): JSX.Element | null {
  if (bytes === undefined) return null;
  return (
    <Txt spec={{ voice: "data", scale: 11 / 12, lineHeight: "normal" as never, color: "dim" }} numberOfLines={1}>
      {`${sizeWords(bytes)} download${plus ?? ""}`}
    </Txt>
  );
}

function Progress({ row }: { row: PluginRow }): JSX.Element {
  const progress = row.status.progress ?? { done: 0, total: 0 };
  return (
    <View flexDirection="row" alignItems="center" gap={10}>
      <Bar percent={progress.total === 0 ? 0 : (progress.done / progress.total) * 100} width={120} />
      <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }}>{progress.total === 0 ? "starting…" : `${progress.done} of ${progress.total} packages`}</Txt>
    </View>
  );
}

/** A `button.sm` (padding --control-pad-sm, radius --control-radius-sm, app 11/12.5). */
function Small({ kind = "plain", onPress, title, children, pad }: { kind?: "plain" | "ghost" | "primary"; onPress: () => void; title?: string; children: string; pad?: [number, number] }): JSX.Element {
  const t = useTokens();
  return (
    <Button kind={kind} onPress={onPress} {...(title !== undefined ? { title } : {})} font={{ scale: 11 / 12.5 }} borderRadius={lengthToken(t, "control-radius-sm", 5)} {...(pad !== undefined ? { paddingVertical: pad[0], paddingHorizontal: pad[1] } : {})}>
      {children}
    </Button>
  );
}

function Check({ row, checked }: { row: PluginRow; checked: number | undefined }): JSX.Element {
  return (
    <Small kind="ghost" pad={[2, 8]} title={`Compare what is installed with the version this build names · ${checkedAgo(checked)}`} onPress={() => checkPlugin(row.id)}>
      Check
    </Small>
  );
}

/** ⋯ — Remove, behind a menu so it is not one stray click away. */
function More({ label, note, onRemove }: { label: string; note?: string | undefined; onRemove: () => void }): JSX.Element {
  const t = useTokens();
  const [menu, setMenu] = useState<MenuAt | null>(null);
  return (
    <>
      <Press
        onPress={(e) => {
          const { pageX, pageY } = e.nativeEvent;
          setMenu({ x: pageX - 200, y: pageY + 12, items: [{ label: "Remove", danger: true, ...(note !== undefined ? { note } : {}), onSelect: onRemove }] } as MenuAt);
        }}
        label={`More for ${label}`}
        title={`More for ${label}`}
        width={24}
        height={24}
        alignItems="center"
        justifyContent="center"
        borderRadius={lengthToken(t, "control-radius-sm", 5)}
        box={({ hovered }) => ({ backgroundColor: menu !== null ? t.v("fill-ghost-selected") : hovered ? t.v("fill-ghost-hover") : "transparent" })}
      >
        {({ hovered }) => (
          <Txt spec={{ voice: "app", scale: 14 / 12.5, lineHeight: 1, color: hovered || menu !== null ? "text" : "dim" }} textAlign="center">
            ⋯
          </Txt>
        )}
      </Press>
      {menu !== null ? <ContextMenu anchor={menu} onClose={() => setMenu(null)} /> : null}
    </>
  );
}

function Get({ row, bytes, verb, primary, small }: { row: PluginRow; bytes: number | undefined; verb: string; primary?: boolean; small?: boolean }): JSX.Element {
  return (
    <>
      <Size bytes={bytes} />
      {small === true ? (
        <Small kind={primary === true ? "primary" : "plain"} onPress={() => installPlugin(row.id as PluginId)}>
          {verb}
        </Small>
      ) : (
        <Button kind={primary === true ? "primary" : "plain"} onPress={() => installPlugin(row.id as PluginId)}>
          {verb}
        </Button>
      )}
    </>
  );
}

function PluginError({ text, top = 6 }: { text: string; top?: number }): JSX.Element {
  return (
    <Txt spec={{ voice: "app", scale: 12 / 12.5, lineHeight: 1.45, color: "bad" }} marginTop={top}>
      {sentence(text)}
    </Txt>
  );
}

function BaseRow({ family, checked }: { family: PluginFamily; checked: Partial<Record<string, number>> }): JSX.Element {
  const t = useTokens();
  const row = family.base;
  const local = family.builds.length > 0;
  const said = pluginDescriptionOf(family);
  const kind = pluginControlOf(row, local);
  const words: ReactNode = said.terms ? (
    <>
      {said.text}
      {" Downloaded from npm under "}
      <Txt spec={{ ...DESC, color: "accent" }} onPress={() => void Linking.openURL(ANTHROPIC_TERMS)} {...({ href: ANTHROPIC_TERMS } as object)}>
        Anthropic's legal agreements
      </Txt>
      .
    </>
  ) : (
    said.text
  );
  let control: ReactNode;
  if (kind === "progress") control = <Progress row={row} />;
  else if (kind === "checkout")
    control = (
      <>
        <FromCheckout version={row.status.installed} />
        <Check row={row} checked={checked[row.id]} />
      </>
    );
  else if (kind === "retry") control = <Button onPress={() => installPlugin(row.id as PluginId)}>Try again</Button>;
  else if (kind === "current")
    control = (
      <>
        <Ok version={row.status.version} />
        <Check row={row} checked={checked[row.id]} />
        <More label={row.name} onRemove={() => removePlugin(row.id as PluginId)} />
      </>
    );
  else if (kind === "outdated")
    control = (
      <>
        <Get row={row} bytes={row.status.downloadBytes} verb="Update" />
        <More label={row.name} onRemove={() => removePlugin(row.id as PluginId)} />
      </>
    );
  else if (kind === "pick") control = <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }}>{row.status.downloadBytes !== undefined ? `${sizeWords(row.status.downloadBytes)} download, plus a build` : "pick a build below"}</Txt>;
  else control = <Get row={row} bytes={row.status.downloadBytes} verb="Download" />;
  const description =
    row.outdated ? (
      <Txt spec={DESC}>
        {words}{" "}
        <Txt spec={{ ...DESC, color: "warn" }}>
          <Ver>{row.status.installed ?? ""}</Ver>
          {" is installed; this build uses "}
          <Ver>{row.status.version}</Ver>.
        </Txt>
      </Txt>
    ) : said.terms ? (
      <Txt spec={DESC}>{words}</Txt>
    ) : (
      said.text
    );
  return (
    <SettingsRow name={row.name} description={description} control={control}>
      {row.status.error !== undefined && !row.busy ? <PluginError text={row.status.error} /> : null}
      {local ? (
        <View marginTop={10} paddingLeft={14}>
          {family.builds.map((build) => (
            <View key={build.id} paddingVertical={7} {...(edge(t, { top: 1 }) as object)}>
              <BuildLine family={family} build={build} />
            </View>
          ))}
        </View>
      ) : null}
    </SettingsRow>
  );
}

function BuildLine({ family, build }: { family: PluginFamily; build: PluginRow }): JSX.Element {
  const t = useTokens();
  const baseIn = family.base.status.installed !== undefined;
  const installedBuilds = family.builds.filter((b) => b.status.installed !== undefined).length;
  const label = `the ${build.name} build`;
  const kind = buildTailOf(build);
  let tail: ReactNode;
  if (kind === "progress") tail = <Progress row={build} />;
  else if (kind === "checkout") tail = <FromCheckout version={build.status.installed} />;
  else if (kind === "retry")
    tail = (
      <Small onPress={() => installPlugin(build.id as PluginId)}>Try again</Small>
    );
  else if (kind === "current")
    tail = (
      <>
        <Ok words="installed" />
        <More label={label} note={installedBuilds === 1 ? "the only build" : undefined} onRemove={() => removePlugin(build.id as PluginId)} />
      </>
    );
  else if (kind === "outdated")
    tail = (
      <>
        <Get row={build} bytes={build.status.downloadBytes} verb="Update" small />
        <More label={label} note={installedBuilds === 1 ? "the only build" : undefined} onRemove={() => removePlugin(build.id as PluginId)} />
      </>
    );
  else tail = <Get row={build} bytes={buildDownloadBytes(family, build)} verb={baseIn ? "Add" : "Download"} primary={!baseIn && build.status.recommended === true} small />;
  return (
    <>
      <View flexDirection="row" alignItems="center" justifyContent="space-between" flexWrap="wrap" rowGap={6} columnGap={16} minHeight={26}>
        <View flexDirection="row" alignItems="baseline" gap={8} minWidth={0} flexWrap="wrap" flexShrink={1}>
          <Txt spec={{ voice: "app", scale: 13 / 12.5, weight: 550 }}>{build.name}</Txt>
          {build.status.recommended === true ? (
            <Txt spec={{ voice: "app", scale: 10.5 / 12.5, lineHeight: { px: 17 }, color: "accent" }} paddingHorizontal={7} borderRadius={999} backgroundColor={t.v("tint-accent") as never}>
              suggested
            </Txt>
          ) : null}
          <Txt spec={{ voice: "app", scale: 12 / 12.5, color: "dim" }}>{build.note ?? ""}</Txt>
        </View>
        <View flexDirection="row" alignItems="center" gap={8}>
          {tail}
        </View>
      </View>
      {build.status.error !== undefined && !build.busy ? <PluginError text={build.status.error} top={4} /> : null}
    </>
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

function CommandLineSection(): JSX.Element {
  const { status, busy, error, install } = useCliCommand();
  return (
    <SettingsSection id="command-line" title="Command line" info="The jaira command runs workflows, tasks and plugins from a terminal, on this app, its plugins and its version.">
      <SettingsRow
        name={<Txt spec={{ voice: "data", scale: 11 / 12, weight: 550, lineHeight: 1.3 }}>jaira</Txt>}
        description={error !== undefined ? <Say bad>{error}</Say> : status === undefined ? "Checking…" : commandWords(status)}
        control={
          status?.canInstall === true ? (
            <Button disabled={busy} onPress={install}>
              {status.state === "installed" ? "Install again" : "Install the jaira command"}
            </Button>
          ) : undefined
        }
      />
    </SettingsSection>
  );
}

function EngineSection({ onEngine }: { onEngine: (patch: Partial<Record<keyof JairaEngineConfig, boolean | undefined>>) => void }): JSX.Element {
  const { state } = useShell();
  const config = state.config;
  const status = useEngineStatus();
  const { separate, keep, resetLabel } = engineSwitchesOf(config);
  const reset = (path: "engine.separateServer" | "engine.keepServerRunning", key: keyof JairaEngineConfig): { label: string; onReset: () => void } | undefined => {
    const label = resetLabel(path);
    return label === undefined ? undefined : { label, onReset: () => onEngine({ [key]: undefined }) };
  };
  const where = status !== undefined ? engineWhere(status) : undefined;
  return (
    <SettingsSection id="engine" title="Engine" info="The engine runs workflows and keeps the projects' records. There is one per person on this machine: every JaiRA window and jaira command uses the one that is running.">
      <SettingsRow
        name="Runs in"
        description={
          where === undefined ? (
            "Checking…"
          ) : status?.note !== undefined ? (
            <Say>
              {where.description}
              <Txt spec={{ ...DESC, color: "bad" }}>{` ${sentence(status.note)}`}</Txt>
            </Say>
          ) : (
            where.description
          )
        }
        control={where !== undefined ? <Txt spec={{ voice: "app", scale: 13 / 12.5 }}>{where.name}</Txt> : undefined}
      />
      <SettingsRow
        name="Separate server"
        description={separate ? "At the next start, this window starts jaira serve and connects to it." : "At the next start, the engine runs in this window's process."}
        info="Kept on this machine, in personal-settings.json. Either way, a window that finds an engine already running uses that one."
        reset={reset("engine.separateServer", "separateServer")}
        control={<Switch on={separate} label="Separate server" disabled={config === null} onChange={(on) => onEngine({ separateServer: on })} />}
      />
      <SettingsRow
        name="Keep the server running"
        description={keep ? "The server this window starts keeps running after the window quits; jaira server stop ends it." : "The server this window starts stops when the window quits."}
        reset={reset("engine.keepServerRunning", "keepServerRunning")}
        control={<Switch on={keep} label="Keep the server running" disabled={config === null || !separate} onChange={(on) => onEngine({ keepServerRunning: on })} />}
      />
    </SettingsSection>
  );
}

/** `licensesPane.tsx`'s `ThirdPartyNotices`: every notice JaiRA ships, searchable, each opening onto its text. */
function ThirdPartyNotices(): JSX.Element {
  const [query, setQuery] = useState("");
  const [openKey, setOpenKey] = useState<string | null>(null);
  const { state, entries, shown, retry } = useLicenseManifest(query);
  const t = useTokens();
  return (
    <SettingsSection
      id="notices"
      title="Third-party notices"
      info="Every package the app bundles or loads, and the fonts, theme and runtime it ships with. Written by the build from each package's own LICENSE and NOTICE files."
      action={state.status === "ready" ? <LicenseSearch query={query} onQuery={setQuery} shown={shown.length} total={entries.length} /> : undefined}
    >
      {state.status === "ready" ? (
        shown.length > 0 ? (
          <View>
            {shown.map((entry, i) => {
              const key = thirdPartyLicenseEntryKey(entry);
              return (
                <View key={key} {...(i > 0 ? (edge(t, { top: 1 }) as object) : {})}>
                  <LicenseRow entry={entry} open={openKey === key} onOpen={(open) => setOpenKey(open ? key : null)} />
                </View>
              );
            })}
          </View>
        ) : (
          <Txt spec={{ voice: "app", scale: 13 / 12.5, color: "dim" }} paddingVertical={18} paddingHorizontal={16}>
            No licenses match that search.
          </Txt>
        )
      ) : state.status === "error" ? (
        <SettingsRow name="Open-source notices are unavailable" description={state.message} control={<Button onPress={retry}>Try again</Button>} />
      ) : (
        <Txt spec={{ voice: "app", scale: 13 / 12.5, color: "dim" }} paddingVertical={18} paddingHorizontal={16}>
          Loading open-source notices…
        </Txt>
      )}
    </SettingsSection>
  );
}

function LicenseSearch({ query, onQuery, shown, total }: { query: string; onQuery: (query: string) => void; shown: number; total: number }): JSX.Element {
  const t = useTokens();
  const look = useLook();
  const [focused, setFocused] = useState(false);
  const size = t.scaled("size-app", 0.96);
  return (
    <View flexDirection="row" alignItems="center" gap={10}>
      {/* In the heading, whose font they inherit (450, line 1.3, -0.005em). */}
      <Txt spec={{ voice: "app", scale: 0.96, weight: 450, lineHeight: 1.3, ls: -0.005, color: "dim", tabular: true }} numberOfLines={1}>
        {licenseCountWords(shown, total)}
      </Txt>
      <TextInput
        value={query}
        onChangeText={onQuery}
        placeholder="Search licenses"
        placeholderTextColor={placeholderColor("light") /* Chromium draws a placeholder #757575 under dark too, measured */}
        accessibilityLabel="Search open-source licenses"
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyPress={(e) => {
          if (e.nativeEvent.key === "Escape" && query.length > 0) onQuery("");
        }}
        {...({ type: "search" } as object)}
        style={
          {
            // `font: inherit` takes the heading's face, weight and line, not its tracking: an input's is `normal`.
            ...(font(t, { voice: "app", scale: 0.96, weight: 450, lineHeight: 1.3 }) as object),
            width: typeof size === "number" ? 13 * 16 : "13rem",
            paddingVertical: 4,
            paddingHorizontal: 9,
            borderWidth: 1,
            borderStyle: "solid",
            borderColor: t.v(focused ? "accent" : "line"),
            borderRadius: 7,
            backgroundColor: t.v("panel"),
            outlineWidth: 0,
          } as never
        }
      />
    </View>
  );
}

function LicenseRow({ entry, open, onOpen }: { entry: ThirdPartyLicenseEntry; open: boolean; onOpen: (open: boolean) => void }): JSX.Element {
  const t = useTokens();
  const [hovered, hover] = useHover();
  return (
    <View>
      <View flexDirection="row" alignItems="center" backgroundColor={hovered ? (t.v("fill-ghost-hover") as never) : "transparent"} {...hover}>
        <Press onPress={() => onOpen(!open)} {...({ "aria-expanded": open } as object)} flex={1} minWidth={0} flexDirection="row" alignItems="baseline" gap={8} paddingVertical={9} paddingHorizontal={16}>
          <Txt spec={{ voice: "app", scale: 13 / 12.5, color: "dim" }} width={10} flexShrink={0} transform={[{ rotate: open ? "90deg" : "0deg" }]}>
            ›
          </Txt>
          <Txt spec={{ voice: "app", scale: 13 / 12.5, weight: 550 }} numberOfLines={1} flexShrink={1}>
            {entry.name}
          </Txt>
          {entry.version !== null ? (
            <Txt spec={{ voice: "data", scale: (0.9 * 12.5) / 12, color: "dim" }} flexShrink={0}>
              {entry.version}
            </Txt>
          ) : null}
          <Txt spec={{ voice: "app", scale: 0.94, color: "dim" }} flexShrink={0} maxWidth="45%" marginLeft="auto" numberOfLines={1}>
            {`${entry.license} · ${formatLicenseBundles(entry.bundles)}`}
          </Txt>
        </Press>
        {entry.sourceUrl !== null ? (
          <Press
            onPress={() => void Linking.openURL(entry.sourceUrl!)}
            title={`${entry.name}'s source — ${entry.sourceUrl}`}
            label={`Project source for ${entry.name}`}
            width={22}
            height={22}
            marginRight={12}
            alignItems="center"
            justifyContent="center"
            borderRadius={5}
            box={({ hovered: over }) => ({ backgroundColor: over ? t.v("fill-ghost-hover") : "transparent" })}
          >
            {({ hovered: over }) => (
              <Txt spec={{ voice: "app", scale: 13 / 12.5, color: over ? "text" : "dim" }} textAlign="center">
                ↗
              </Txt>
            )}
          </Press>
        ) : null}
      </View>
      {open ? (
        <Txt spec={{ voice: "data", scale: (0.9 * 12.5) / 12, lineHeight: 1.55, color: t.mix(t.v("text"), 82, "transparent") }} paddingTop={2} paddingRight={16} paddingBottom={16} paddingLeft={34}>
          {entry.noticeText}
        </Txt>
      ) : null}
    </View>
  );
}
