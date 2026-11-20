import { useContext, useEffect, useState, type JSX } from "react";
import { View } from "@tamagui/core";
import { GIT_CLI_NAMES, type GitCliName, type InstallWay, type ProbeResult } from "@jaira/shared/browser";
import { GIT_CLI_TITLES, agentLineOf, gitCliActionOf, gitCliPanelOf, gitCliPlaceOf, notInstalledOf, providerSayState, providerState, retryActionOf, retryWayOf, updateOf } from "@jaira/ui/connectionsModel";
import type { InstallLog } from "@jaira/ui/installLog";
import { Hint } from "../bits";
import { SettingsLayerContext } from "../layers";
import { SettingsGroup } from "../SettingsPage";
import { ActionSlot, CheckAgain, RowLine } from "./Closed";
import { InstallLogBox } from "./InstallLog";
import { InstallPanel, UpdateAfter } from "./ProviderRows";
import { Chevron, ConnRow, ConnRows, RowHead, Say, Version, Wide } from "./Row";
import { InstallButton, InstallTile, Shelf } from "./Shelf";

/**
 * Settings → Connections → Git: git, which JaiRA runs for worktrees, diffs and pushes, as a row that
 * is always there — and the forges' own CLIs, GitHub's `gh` and GitLab's `glab`, as rows once they are
 * on this machine and tiles on a shelf under the card while they are not. They are drawn as the agents
 * are (`AgentRows.tsx`), with nothing to switch off: a program is there or it is not. Which goes where,
 * and what its closed row says, is `connectionsModel.ts`'s (`gitCliPlaceOf`, `agentLineOf`,
 * `gitCliActionOf`). How it looks, where it is not the agents':
 *
 *   a row           as an agent's, with no switch and no chip: closed, its one line and the one button
 *                   that would make it work (Install, Reinstall); opened, the sentence whole, the version
 *                   line with how it was installed and Update, and the install panel
 *   the shelf       as the agents': "Forge CLIs", and what they are for in --dim at 11.5; a tile's ▾
 *                   lists the ways, and nothing to set — a program found where the PATH does not reach
 *                   is reached by the check itself
 *   installing      Install pressed — on a tile, or a row's — makes it a row of the card, opened, with
 *                   what the installer prints scrolling under it (`InstallLog.tsx`); it stays a row,
 *                   with the output, until Hide, however the install went
 */
export function GitRows({
  checks,
  installing,
  logs,
  busy,
  onInstall,
  onCancel,
  onHideLog,
  onRecheck,
  rechecking,
}: {
  /** The last check of each git program; absent before the first. */
  checks: ProbeResult[] | undefined;
  installing: ReadonlySet<GitCliName>;
  /** What each install pressed here printed, by program — until its Hide. */
  logs: Readonly<Partial<Record<GitCliName, InstallLog>>>;
  busy: boolean;
  onInstall: (name: GitCliName, way?: InstallWay) => void;
  onCancel: (name: GitCliName) => void;
  onHideLog: (name: GitCliName) => void;
  /** Check again — a program installed elsewhere, or after an install that failed. */
  onRecheck?: (() => void) | undefined;
  rechecking?: boolean | undefined;
}): JSX.Element | null {
  // A program on this machine is nothing a layer states: "What you changed" has none of it.
  const onlyStated = useContext(SettingsLayerContext)?.onlyStated === true;
  if (onlyStated) return null;
  const probeOf = (name: GitCliName): ProbeResult | undefined => checks?.find((check) => check.name === name);
  // One being installed, or whose install's output is still up, is a row whatever its check says.
  const placeOf = (name: GitCliName): "row" | "shelf" => (logs[name] !== undefined ? "row" : gitCliPlaceOf(name, probeOf(name)));
  const rows = GIT_CLI_NAMES.filter((name) => placeOf(name) === "row");
  const shelf = GIT_CLI_NAMES.filter((name) => placeOf(name) === "shelf");
  return (
    <>
      <SettingsGroup>
        <ConnRows>
          {rows.map((name, i) => (
            <GitCliRow
              key={name}
              first={i === 0}
              name={name}
              probe={probeOf(name)}
              running={installing.has(name)}
              log={logs[name]}
              busy={busy}
              onInstall={(method) => onInstall(name, method)}
              onCancel={() => onCancel(name)}
              onHideLog={() => onHideLog(name)}
              onRecheck={onRecheck}
              rechecking={rechecking === true}
            />
          ))}
        </ConnRows>
      </SettingsGroup>
      {shelf.length > 0 ? (
        <Shelf title="Forge CLIs" sub="not on this machine — for agents that call GitHub or GitLab from a shell">
          {shelf.map((name) => (
            <InstallTile
              key={name}
              brand={name}
              title={GIT_CLI_TITLES[name]}
              install={probeOf(name)?.install}
              running={installing.has(name)}
              busy={busy}
              chosen={false}
              onInstall={(method) => onInstall(name, method)}
              onCancel={() => onCancel(name)}
            />
          ))}
        </Shelf>
      ) : null}
    </>
  );
}

/** One git program on this machine — or git, which is looked for whether or not it is. */
function GitCliRow({
  first,
  name,
  probe,
  running,
  log,
  busy,
  onInstall,
  onCancel,
  onHideLog,
  onRecheck,
  rechecking,
}: {
  first: boolean;
  name: GitCliName;
  probe: ProbeResult | undefined;
  running: boolean;
  log: InstallLog | undefined;
  busy: boolean;
  onInstall: (way?: InstallWay) => void;
  onCancel: () => void;
  onHideLog: () => void;
  onRecheck: (() => void) | undefined;
  rechecking: boolean;
}): JSX.Element {
  // Opened by an install — one pressed on the shelf's tile mounts it so — for its output to be seen.
  const [open, setOpen] = useState(running);
  useEffect(() => {
    if (running) setOpen(true);
  }, [running]);
  const title = GIT_CLI_TITLES[name];
  // Nothing turns a program off: it is checked, always.
  const state = providerState(true, probe);
  const install = probe?.install;
  const panel = gitCliPanelOf(install);
  const update = updateOf(install);
  const line = agentLineOf(probe, state, install);
  // Not installed: Install under the sentence — after one that failed, the same way again.
  const notInstalled = notInstalledOf(probe);
  const retry = notInstalled ? retryWayOf(log) : undefined;
  const action = retryActionOf(gitCliActionOf(probe), retry);
  const waiting = running ? { words: install?.install?.[0]?.method === "command-line-tools" ? "finish in Apple's installer" : "installing…", onCancel } : undefined;

  const slot = open || action === undefined ? null : <ActionSlot action={action} waiting={waiting} disabled={busy || running} onPress={() => onInstall(action.kind === "install" ? (action.choice ?? action.method) : undefined)} />;

  return (
    <ConnRow
      first={first}
      state={state}
      main={
        <>
          <RowHead brand={name} state={state} title={title} />
          {open ? (
            <>
              <Say
                state={state}
                word={providerSayState(probe, state)}
                detail={probe !== undefined && probe.detail !== "" ? probe.detail : undefined}
                // The install panel is the fix when it offers a way; when it offers none, the sentence says what to do.
                fix={probe?.fix !== undefined && (panel === undefined || panel.rows.length === 0) ? probe.fix : undefined}
              />
              {probe?.version ? (
                // The output's head says it is updating, with Cancel: here, Update waits.
                <Version after={update !== undefined ? <UpdateAfter via={update.via} title={update.title} running={false} disabled={busy || running} onUpdate={() => onInstall()} onCancel={onCancel} /> : undefined}>{probe.version}</Version>
              ) : null}
              {probe?.status === "failed" && !running ? (
                <View flexDirection="row" flexWrap="wrap" alignItems="center" gap={6} marginLeft={30} marginTop={4}>
                  {notInstalled ? <InstallButton title={title} install={install} retry={retry} busy={busy} onInstall={onInstall} /> : null}
                  {onRecheck !== undefined ? <CheckAgain checking={rechecking} disabled={busy} onPress={onRecheck} /> : null}
                </View>
              ) : null}
            </>
          ) : (
            <RowLine state={state} word={line.word} rest={line.rest} />
          )}
        </>
      }
      // An empty slot where there is nothing, so the chevron keeps one column down the card.
      boxes={[slot ?? <View key="none" />]}
      controls={<Chevron open={open} label={open ? `close ${title}` : `open ${title}`} tips={["Show more", "Show less"]} onPress={() => setOpen(!open)} />}
      wide={
        open
          ? [
              log !== undefined ? (
                <Wide key="log">
                  <InstallLogBox log={log} onCancel={onCancel} onHide={onHideLog} />
                </Wide>
              ) : null,
              // While it installs, the output is the panel: the ways come back if it did not work.
              panel !== undefined && !running && !notInstalled ? (
                <Wide key="install">
                  {panel.rows.length > 0 ? (
                    <InstallPanel panel={panel} running={running} busy={busy} locked={busy} onInstall={(method) => onInstall(method)} onCancel={onCancel} onUse={() => undefined} />
                  ) : (
                    <Hint>{panel.head}</Hint>
                  )}
                </Wide>
              ) : null,
            ]
          : []
      }
    />
  );
}
