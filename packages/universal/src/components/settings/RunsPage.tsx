import { useEffect, useState, type JSX } from "react";
import { View } from "@tamagui/core";
import { projectNameOf, type PlacementView } from "@jaira/shared/browser";
import { configWriter } from "@jaira/ui/configWriter";
import { invoke, subscribe as subscribePush } from "@jaira/ui/store";
import { useShell } from "../../app/shell";
import { Txt } from "../../primitives";
import { useTokens } from "../../tokens";
import { NumInput } from "../form/inputs";
import { MachineChip } from "../MachineChip";
import { Button } from "./Button";
import { Artifacts, ConfigBlockSection, ExecEnvironment } from "./ConfigBlocks";
import { SettingsRow, SettingsSection } from "./SettingsPage";

/**
 * `settingsPages.tsx`'s two pages made only of blocks, universal (decision 0015): **Runs** (how a run
 * behaves while it is going) and **Data & history** (what a run leaves behind), with the sections they
 * hold that no other page draws — `placementSection.tsx`'s Where tasks run and `widgets.tsx`'s
 * `History`. What each writes goes through `configWriter.ts`, as the DOM's does. The rules they add:
 *
 *   .placement-order     18 wide, --dim, tabular
 *   .placement-cap       row, centred, gap 6, --dim; its box 56 wide
 *   .prune-controls      row, centred, gap 8, wraps; app 11/12.5 --dim; its label a row, gap 4; the
 *                        box 56 wide
 *   .set-num             data 1.02×, tabular, --text (after `.data-num`)
 */

/** What `App.tsx` hands a config page: the view, and whether this layer may be written. */
function usePageWriter() {
  const { state, actions } = useShell();
  const editable = state.configLayer !== "project" || state.at !== null;
  return state.config === null ? null : configWriter(state.config, state.configLayer, state.busy || !editable, actions.saveConfig);
}

/** `<p className="empty">`: the page could not be read. */
function Empty({ children }: { children: string }): JSX.Element {
  return (
    <Txt spec={{ voice: "app", scale: 13 / 12.5, color: "dim" }} paddingVertical={8}>
      {children}
    </Txt>
  );
}

export function RunsPage(): JSX.Element {
  const { state } = useShell();
  const writer = usePageWriter();
  if (writer === null) return <Empty>The configuration could not be read.</Empty>;
  return (
    <>
      <PlacementSection project={state.at} />
      <ExecEnvironment {...writer} />
      <ConfigBlockSection writer={writer} block="memo" />
      <ConfigBlockSection writer={writer} block="autopilot" />
      <ConfigBlockSection writer={writer} block="limits" />
      <ConfigBlockSection writer={writer} block="archive" />
      <ConfigBlockSection writer={writer} block="workflows" />
    </>
  );
}

export function DataPage(): JSX.Element {
  const { state } = useShell();
  const writer = usePageWriter();
  if (writer === null) return <Empty>The configuration could not be read.</Empty>;
  return (
    <>
      <Artifacts {...writer} />
      <ConfigBlockSection writer={writer} block="storage" />
      {state.at !== null ? <History /> : null}
    </>
  );
}

/** Where tasks run (decision 0013 §5): a project's workspaces in the order a new task is placed. */
function PlacementSection({ project }: { project: string | null }): JSX.Element | null {
  const t = useTokens();
  const [view, setView] = useState<PlacementView | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (project === null) return;
    const read = (): void => void invoke("placement:view", { project }).then(setView, () => undefined);
    read();
    return subscribePush((message) => {
      if (message.type === "machines:changed" || (message.type === "store:invalidate" && message.scope === "config")) read();
    });
  }, [project]);
  if (project === null || view === undefined || view.workspaces.length <= 1) return null;
  const save = (order: string[], caps: Record<string, number>): void => {
    setError(undefined);
    invoke("placement:setRules", { project, order, caps }).then(setView, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  const keys = view.workspaces.map((w) => w.key);
  const caps = Object.fromEntries(view.workspaces.flatMap((w) => (w.cap !== undefined ? [[w.key, w.cap] as const] : [])));
  const move = (from: number, to: number): void => {
    const next = [...keys];
    const [key] = next.splice(from, 1);
    next.splice(to, 0, key!);
    save(next, caps);
  };
  const hint = { voice: "app", scale: 11 / 12.5, lineHeight: 1.4, color: "dim" } as const;
  return (
    <SettingsSection
      id="where"
      title="Where tasks run"
      info="A new task or conversation goes to the first workspace in this order that is online, has the tags its workflow requires, has room by its machine's CPU and memory, is under its cap, and has usage left. With none free it waits, and starts when one frees up."
      action={<Txt spec={hint}>{view.identity !== undefined ? `${projectNameOf(view.identity)} · ${view.identity}` : ""}</Txt>}
    >
      {view.workspaces.map((w, i) => (
        <SettingsRow
          key={w.key}
          name={
            <View flexDirection="row" alignItems="center">
              <Txt spec={{ voice: "app", scale: 1.1, weight: 550, lineHeight: 1.3, color: "dim", tabular: true }} width={18}>
                {String(i + 1)}
              </Txt>
              <MachineChip label={w.label} state={w.why === "offline" ? "off" : "on"} voice={String(t.v("font-app"))} />
            </View>
          }
          description={
            <Txt spec={{ voice: "app", scale: 1.03, lineHeight: 1.45, color: "dim" }}>
              <Txt spec={{ voice: "data", scale: 11 / 12, color: "dim" }}>{w.dir}</Txt>
              {w.self ? " · this machine" : ""}
              <Txt spec={hint}>{w.why !== undefined ? ` · ${w.why}` : " · has room"}</Txt>
            </Txt>
          }
          control={
            <>
              <View flexDirection="row" alignItems="center" gap={6}>
                <Txt spec={{ voice: "app", scale: 13 / 12.5, color: "dim" }}>Runs at once</Txt>
                <View width={56}>
                  <NumInput
                    value={w.cap}
                    placeholder="auto"
                    onChange={(n) => save(keys, { ...Object.fromEntries(Object.entries(caps).filter(([k]) => k !== w.key)), ...(n !== undefined && n >= 0 ? { [w.key]: Math.floor(n) } : {}) })}
                  />
                </View>
              </View>
              <Button kind="ghost" label={`Move ${w.label} up`} disabled={i === 0} onPress={() => move(i, i - 1)}>
                ↑
              </Button>
              <Button kind="ghost" label={`Move ${w.label} down`} disabled={i === view.workspaces.length - 1} onPress={() => move(i, i + 1)}>
                ↓
              </Button>
            </>
          }
        />
      ))}
      <SettingsRow
        name="When every workspace is busy"
        description={
          error !== undefined ? (
            <Txt spec={{ voice: "app", scale: 1.03, lineHeight: 1.45, color: "bad" }}>{error}</Txt>
          ) : (
            `${view.ordered ? "" : "This is the default order: other machines first, this one last. "}Tasks wait in a queue and start as soon as one frees up; a waiting task can be sent to a workspace by hand from its menu.`
          )
        }
        control={<Txt spec={{ voice: "app", scale: 13 / 12.5 }}>Queue</Txt>}
      />
    </SettingsSection>
  );
}

/** History pruning (SPEC §13) — `widgets.tsx`'s `History`: what is stored, and a preview before anything goes. */
function History(): JSX.Element {
  const { state, actions } = useShell();
  const size = state.history;
  const report = state.prune;
  const busy = state.busy;
  const [days, setDays] = useState(30);
  if (!size) return <Empty>Open a project to see its history.</Empty>;
  const planned = report?.dryRun === true ? report : null;
  const num = (n: number): JSX.Element => <Txt spec={{ voice: "data", scale: 1.02, weight: 600, tabular: true }}>{String(n)}</Txt>;
  return (
    <>
      <SettingsSection id="stored" title="Stored history" lead="This project's own records — they are the open project's whichever layer the switch above is on.">
        <SettingsRow name="Tasks" description="Every task this project has kept a record of." control={num(size.tasks)} />
        <SettingsRow name="Events" description="What its runs recorded, step by step." control={num(size.events)} />
        <SettingsRow name="Commands" description="Every command an agent ran, and what it was told." control={num(size.commands)} />
      </SettingsSection>
      <SettingsSection id="prune" title="Pruning" info="An unfinished task is never pruned: it can still be resumed, so its history is kept whatever its age.">
        <SettingsRow
          name="Older than"
          description="Delete the history of finished tasks older than this. Preview first: nothing is deleted until you confirm."
          control={
            <View flexDirection="row" alignItems="center" gap={8} flexWrap="wrap">
              <View flexDirection="row" alignItems="center" gap={4}>
                <View width={56}>
                  <NumInput value={days} onChange={(n) => setDays(Math.max(0, n ?? 0))} />
                </View>
                <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }}>days</Txt>
              </View>
              <Button kind="ghost" onPress={() => actions.planPrune(days)} disabled={busy}>
                Preview
              </Button>
            </View>
          }
        />
        {report ? (
          <SettingsRow
            name={planned ? "Would delete" : "Deleted"}
            description={
              planned
                ? planned.tasks.length > 0
                  ? `The history of ${planned.tasks.length} task(s): ${planned.events} events, ${planned.commands} commands.`
                  : "Nothing matches — no task history is old enough."
                : `The history of ${report.tasks.length} task(s); ${report.remaining.events} events remain.`
            }
            {...(report.skippedTasks.length > 0 ? { info: `Kept ${report.skippedTasks.length} unfinished task(s): ${report.skippedTasks.map((t) => `${t.taskId} (${t.reason})`).join(", ")}` } : {})}
            control={
              <>
                {planned && planned.tasks.length > 0 ? (
                  <Button kind="danger" onPress={() => actions.applyPrune(days)} disabled={busy}>
                    Delete permanently
                  </Button>
                ) : null}
                <Button kind="ghost" onPress={actions.dismissPrune}>
                  Dismiss
                </Button>
              </>
            }
          />
        ) : null}
      </SettingsSection>
    </>
  );
}
