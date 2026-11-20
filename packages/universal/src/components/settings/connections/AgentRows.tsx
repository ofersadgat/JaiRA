import { useContext, useEffect, useState, type JSX } from "react";
import { View } from "@tamagui/core";
import type { ProbeResult } from "@jaira/shared/browser";
import {
  agentActionOf,
  agentChecksAgain,
  agentChipOf,
  agentLineOf,
  agentPlaceOf,
  installPanelOf,
  keyTileOf,
  notInstalledOf,
  providerSayState,
  retryActionOf,
  retryWayOf,
  settingsGistOf,
  unreachedOf,
  updateOf,
  useProviderRow,
  type AgentAction,
} from "@jaira/ui/connectionsModel";
import type { ProviderSpec } from "@jaira/ui/providerSpecs";
import type { ProvidersPaneProps } from "@jaira/ui/providersPaneTypes";
import { Hint, Stack } from "../bits";
import { Switch } from "../controls";
import { SettingsLayerContext } from "../layers";
import { SettingsGroup } from "../SettingsPage";
import { ActionSlot, CheckAgain, LabelledBoxes, RowLine, RunsAs, SettingsFold } from "./Closed";
import { InstallLogBox } from "./InstallLog";
import { ShellChoice } from "./ShellChoice";
import { AddAgentForm, InstallPanel, KeyBoxes, KeyEntry, KeyShelfCard, KeyTile, LoginCards, ProviderForm, UpdateAfter, useShownSpecs } from "./ProviderRows";
import { Chevron, ConnRow, ConnRows, RowHead, Say, Version, Wide } from "./Row";
import { AnotherTile, InstallButton, InstallTile, Shelf, ShelfCard } from "./Shelf";

/**
 * Settings → Connections → Agents: the agents on this machine as rows that open in place, then the shelf
 * of the ones it does not have yet (the person, 2026-11-16: "I like 2, but the rows should be able to
 * expand as well"). Which agent goes where, and what a closed row says, is `connectionsModel.ts`'s
 * (`agentPlaceOf`, `agentLineOf`, `agentActionOf`, `agentChipOf`). How it looks:
 *
 *   the card             the section's card (`SettingsGroup`) of `ConnRow`s; not drawn with no row
 *   a closed row         its head (`RowHead`), its line (`RowLine`), and in the boxes' place the one
 *                        button that would make it work (`ActionSlot`) or the chip of who it runs as
 *                        (`RunsAs`) — signed out or not working, a ghost Check again before it
 *                        (`CheckAgain`, `agentChecksAgain`); then the switch and the chevron
 *   an opened row        the chip and the button go; the head's sentence whole, with its fix (none when
 *                        an install is the fix), the version line with Update, and under them, 6 apart,
 *                        Install (`InstallButton`: "Install again" after one that failed, ⌄ for the
 *                        other ways) while it is not installed, and Check again while it is signed out
 *                        or not working; then across it, 8 apart: the install's output; the panel of
 *                        what is left of an install, or the path it was found at; and — only once the
 *                        program can be reached — "Runs as" and the login and key boxes
 *                        (`LabelledBoxes`), the key's entry, Shell, and the folded Settings holding the
 *                        provider's form (`SettingsFold`)
 *   the shelf            "More agents" (`Shelf.tsx`): a tile per agent not installed (`InstallTile`),
 *                        a tile per agent that cannot run without a key it has not got (`Tile`:
 *                        "needs an API key", `Add a key`, which opens the key's entry across), and
 *                        "Another agent CLI" last; what a tile opened, across
 *   installing           Install or Update pressed — on a tile or a row — makes the agent a row of the
 *                        card, opened, with what the installer prints scrolling across it first
 *                        (`InstallLog.tsx`); it stays a row, with the output, until Hide, however the
 *                        install went
 */

/** Connections → Agents: the card of rows, and the shelf under it. */
export function AgentRows(props: ProvidersPaneProps & { specs: ProviderSpec[] }): JSX.Element {
  const { config, executorProbes, installLogs, layer, specs } = props;
  const shown = useShownSpecs(specs);
  // One being installed, or whose install's output is still up, is a row whatever its check says.
  const placeOf = (spec: ProviderSpec): "row" | "shelf" => (installLogs[spec.id] !== undefined ? "row" : agentPlaceOf(executorProbes[spec.id]));
  if (config === null) {
    return (
      <SettingsGroup>
        <Hint card>The configuration could not be read.</Hint>
      </SettingsGroup>
    );
  }
  const rows = shown.filter((spec) => placeOf(spec) === "row");
  const shelf = shown.filter((spec) => placeOf(spec) === "shelf");
  return (
    <>
      {rows.length > 0 ? (
        <SettingsGroup>
          <ConnRows>
            {rows.map((spec, i) => (
              <AgentRow key={`${layer}:${spec.id}`} {...props} first={i === 0} spec={spec} probe={executorProbes[spec.id]} layerDoc={config[layer]} effective={config.effective} />
            ))}
          </ConnRows>
        </SettingsGroup>
      ) : null}
      <AgentShelf {...props} specs={shelf} />
    </>
  );
}

type RowProps = ProvidersPaneProps & { spec: ProviderSpec; probe: ProbeResult | undefined; layerDoc: unknown; effective: unknown };

/** One agent on this machine: a line, one button or chip, the switch and the chevron — and, opened, the rest. */
function AgentRow(props: RowProps & { first: boolean }): JSX.Element {
  const { first, spec, probe, busy, layer, secrets, config, onRemove, onSaveCredential, signingIn, onSignIn, onCancelSignIn, onSignOut, installing, installLogs, onInstall, onCancelInstall, onHideInstallLog, onUseCommand, onRecheck, rechecking } = props;
  const running = installing.has(spec.id);
  const log = installLogs[spec.id];
  // Opened by an install — one pressed on the shelf's tile mounts it so — for its output to be seen.
  const [open, setOpen] = useState(running);
  useEffect(() => {
    if (running) setOpen(true);
  }, [running]);
  // The key's store form, across the opened row — from its + box, or from the closed row's Add a key.
  const [keyOpen, setKeyOpen] = useState(false);
  const row = useProviderRow(props);
  const { merged, locked, enabled, state, write } = row;
  // How the agent got here and what installs or updates it — while it is on.
  const install = state !== "off" ? probe?.install : undefined;
  const signing = signingIn.has(spec.id);
  const panel = installPanelOf(install);
  const update = updateOf(install);
  const line = agentLineOf(probe, state, install);
  // Not reached — not installed, half removed, off the PATH: only what would make it work is shown.
  const unreached = state !== "off" && unreachedOf(probe);
  const notInstalled = state !== "off" && notInstalledOf(probe);
  // An install that failed is tried again the way it was asked for.
  const retry = notInstalled ? retryWayOf(log) : undefined;
  const action = retryActionOf(agentActionOf(spec, probe, state, install, merged), retry);
  const chip = agentChipOf(probe, state, merged);
  const agentLogins = probe?.accounts !== undefined && state !== "off";

  const act = (one: AgentAction): void => {
    if (one.kind === "install") {
      if (one.path !== undefined) onUseCommand(spec.id, one.path);
      else onInstall(spec.id, one.choice ?? one.method);
    } else if (one.kind === "sign-in") {
      onSignIn(spec.id);
    } else {
      setOpen(true);
      setKeyOpen(true);
    }
  };

  const credentials = [
    ...(agentLogins
      ? LoginCards({
          agent: spec.id,
          command: typeof merged["command"] === "string" ? merged["command"] : undefined,
          accounts: probe!.accounts!,
          signingIn: signing,
          busy,
          warn: state === "needs-sign-in",
          lapsed: state === "needs-sign-in" && probe!.lapsed === true,
          onSignIn: () => onSignIn(spec.id),
          onCancel: () => onCancelSignIn(spec.id),
          onSignOut: () => onSignOut(spec.id),
          ...(spec.credential !== "none" && !keyOpen ? { onAddKey: () => setKeyOpen(true) } : {}),
        })
      : []),
    ...KeyBoxes({ spec, probe, merged, busy: locked, open: keyOpen || agentLogins, warn: state === "needs-sign-in", onOpen: () => setKeyOpen(true) }),
  ];

  // Closed, the one thing beside the switch: what would make it work, or who it runs as. Opened, the
  // row's body has each of them whole.
  const waiting = action === undefined ? undefined : action.kind === "install" && running ? { words: "installing…", onCancel: () => onCancelInstall(spec.id) } : action.kind === "sign-in" && signing ? { words: "finish in your browser", onCancel: () => onCancelSignIn(spec.id) } : undefined;
  const slot = open ? null : action !== undefined ? (
    <ActionSlot key="action" action={action} waiting={waiting} disabled={action.kind === "install" ? (action.path !== undefined ? locked : busy || running) : action.kind === "sign-in" ? busy : locked} onPress={() => act(action)} />
  ) : chip !== undefined ? (
    <RunsAs key="chip" chip={chip} />
  ) : null;
  // Signed out or not working: Check again, before the fix — and not while the fix is waiting on something.
  const checkAgain =
    onRecheck !== undefined && agentChecksAgain(probe, state) && waiting === undefined && !running && !signing ? (
      <CheckAgain key="check" checking={rechecking === true} disabled={busy} onPress={onRecheck} />
    ) : null;

  const wide = open
    ? [
        log !== undefined ? (
          <Wide key="log">
            <InstallLogBox log={log} onCancel={() => onCancelInstall(spec.id)} onHide={() => onHideInstallLog(spec.id)} />
          </Wide>
        ) : null,
        // While it installs, the output is the panel. Not installed, Install under the sentence is the way.
        panel !== undefined && !running && !notInstalled ? (
          <Wide key="install">
            <InstallPanel panel={panel} running={running} busy={busy} locked={locked} onInstall={(method) => onInstall(spec.id, method)} onCancel={() => onCancelInstall(spec.id)} onUse={(path) => onUseCommand(spec.id, path)} />
          </Wide>
        ) : null,
        credentials.length > 0 && !unreached ? (
          <Wide key="as">
            <LabelledBoxes label="Runs as">{credentials}</LabelledBoxes>
          </Wide>
        ) : null,
        keyOpen && !unreached ? (
          <Wide key="key">
            <KeyEntry spec={spec} merged={merged} layer={layer} busy={locked} secrets={secrets} hasProject={config !== null && config.projectFile.length > 0} onSave={onSaveCredential} onClose={() => setKeyOpen(false)} />
          </Wide>
        ) : null,
        // The shell its commands run in (decision 0030): emulated, or a live zsh, bash or sh.
        unreached ? null : (
          <Wide key="shell">
            <LabelledBoxes label="Shell">
              {[<ShellChoice key="shell" here={row.here["shell"]} merged={merged["shell"]} locked={locked} onWrite={(shell) => write({ shell })} />]}
            </LabelledBoxes>
          </Wide>
        ),
        // The form is the provider's own, drawn whole once its fold is open.
        unreached ? null : (
          <SettingsFold key="form" gist={settingsGistOf(spec)}>
            <Stack>
              <ProviderForm spec={spec} row={row} layer={layer} onRemove={onRemove} />
            </Stack>
          </SettingsFold>
        ),
      ]
    : [];

  return (
    <ConnRow
      first={first}
      state={state}
      main={
        <>
          <RowHead brand={spec.id} state={state} title={spec.title} />
          {open ? (
            <>
              <Say
                state={state}
                word={providerSayState(probe, state)}
                detail={probe && state !== "off" && probe.detail ? probe.detail : undefined}
                // An install is the fix, with the command it runs: its sentence would only point at it — unless nothing here installs it.
                fix={probe && state !== "off" && probe.fix && (panel === undefined || panel.rows.length === 0) ? probe.fix : undefined}
              />
              {probe?.version ? (
                // The output's head says it is updating, with Cancel: here, Update waits.
                <Version after={update !== undefined ? <UpdateAfter via={update.via} title={update.title} running={false} disabled={busy || running} onUpdate={() => onInstall(spec.id)} onCancel={() => onCancelInstall(spec.id)} /> : undefined}>{probe.version}</Version>
              ) : null}
              {/* Opened, the fix is in the boxes across the row (a login's Sign in again, the + box's Sign in); Install and Check again stay under the sentence. */}
              {(notInstalled && !running) || checkAgain !== null ? (
                <View flexDirection="row" flexWrap="wrap" alignItems="center" gap={6} marginLeft={30} marginTop={4}>
                  {notInstalled && !running ? <InstallButton title={spec.title} install={install} retry={retry} busy={busy} onInstall={(way) => onInstall(spec.id, way)} /> : null}
                  {checkAgain}
                </View>
              ) : null}
            </>
          ) : (
            <RowLine state={state} word={line.word} rest={line.rest} />
          )}
        </>
      }
      // An empty slot where there is nothing: ConnRow pulls the controls 14 in without one, and an agent
      // row's switch keeps one column down the card, open or closed.
      boxes={open ? [<View key="none" />] : checkAgain !== null ? [checkAgain, slot ?? <View key="none" />] : [slot ?? <View key="none" />]}
      controls={
        <>
          <Switch
            on={enabled}
            label={enabled ? `stop using ${spec.title} in this project` : `use ${spec.title} again`}
            disabled={locked}
            // `undefined` REMOVES the key rather than writing `true`: on is the default.
            onChange={(next) => write({ enabled: next ? undefined : false })}
          />
          <Chevron
            open={open}
            label={open ? `close ${spec.title}` : `open ${spec.title}`}
            tips={["Show more", "Show less"]}
            onPress={() => {
              if (open) setKeyOpen(false);
              setOpen(!open);
            }}
          />
        </>
      }
      wide={wide}
    />
  );
}

// --- the shelf ----------------------------------------------------------------------------------

type Opened = { kind: "add" } | { kind: "settings"; id: string } | { kind: "key"; id: string } | null;

/** The agents this machine does not have yet, or that wait on a key, a tile each, and the tile that adds another CLI. */
function AgentShelf(props: ProvidersPaneProps & { specs: ProviderSpec[] }): JSX.Element | null {
  const { specs, config, executorProbes, busy, editable, layer, installing, onInstall, onCancelInstall, onAdd } = props;
  // Adding is setting something, which "What you changed" is not showing.
  const onlyStated = useContext(SettingsLayerContext)?.onlyStated === true;
  const [opened, setOpened] = useState<Opened>(null);
  if (specs.length === 0 && onlyStated) return null;
  const settingsOf = opened?.kind === "settings" ? specs.find((spec) => spec.id === opened.id) : undefined;
  // Stored, the check runs again and the agent leaves the shelf — and its entry with it.
  const keyOf = opened?.kind === "key" ? specs.find((spec) => spec.id === opened.id) : undefined;
  const waitsOnKey = specs.some((spec) => keyTileOf(executorProbes[spec.id]) !== undefined);
  return (
    <Shelf
      title="More agents"
      sub={specs.length === 0 ? undefined : waitsOnKey ? "not set up yet — none is used until it is installed or has its key" : "not on this machine yet — none is used until it is installed"}
      across={
        <>
          {opened?.kind === "add" ? (
            <ShelfCard title="Another agent CLI" onClose={() => setOpened(null)}>
              <AddAgentForm layer={layer} busy={busy || !editable} onAdd={onAdd} onClose={() => setOpened(null)} />
            </ShelfCard>
          ) : null}
          {settingsOf !== undefined && config !== null ? (
            <ShelfSettings key={`${layer}:${settingsOf.id}`} {...props} spec={settingsOf} probe={executorProbes[settingsOf.id]} layerDoc={config[layer]} effective={config.effective} onClose={() => setOpened(null)} />
          ) : null}
          {keyOf !== undefined ? <KeyShelfCard {...props} spec={keyOf} onClose={() => setOpened(null)} /> : null}
        </>
      }
    >
      {specs.map((spec) =>
        keyTileOf(executorProbes[spec.id]) !== undefined ? (
          <KeyTile key={`${layer}:${spec.id}`} spec={spec} probe={executorProbes[spec.id]} chosen={opened?.kind === "key" && opened.id === spec.id} disabled={busy || !editable} onPress={() => setOpened({ kind: "key", id: spec.id })} />
        ) : (
          <InstallTile
            key={`${layer}:${spec.id}`}
            brand={spec.id}
            title={spec.title}
            install={executorProbes[spec.id]?.install}
            running={installing.has(spec.id)}
            busy={busy}
            chosen={opened?.kind === "settings" && opened.id === spec.id}
            onInstall={(way) => onInstall(spec.id, way)}
            onCancel={() => onCancelInstall(spec.id)}
            onSettings={() => setOpened({ kind: "settings", id: spec.id })}
          />
        ),
      )}
      {onlyStated ? null : <AnotherTile title="Another agent CLI" sub="any other binary" open={opened?.kind === "add"} onPress={() => setOpened((was) => (was?.kind === "add" ? null : { kind: "add" }))} />}
    </Shelf>
  );
}

/** A shelf agent's own settings — its command above all, for one installed where nothing looked. */
function ShelfSettings(props: RowProps & { onClose: () => void }): JSX.Element {
  const { spec, layer, onRemove, onClose } = props;
  const row = useProviderRow(props);
  return (
    <ShelfCard title={`${spec.title} settings`} onClose={onClose}>
      <SettingsLayerContext.Provider value={null}>
        <ProviderForm spec={spec} row={row} layer={layer} onRemove={onRemove} />
      </SettingsLayerContext.Provider>
    </ShelfCard>
  );
}
