/**
 * Where tasks run (decision 0013 §5; the approved mockup): a project's workspaces in the order a new task
 * or conversation is placed, each with an optional cap on runs at once and why it would be passed over
 * now. Until the person sets an order, it is the other machines' workspaces first and this machine's
 * last. The rules are the project's, the same on every machine (they sync).
 */
import { useEffect, useState, type JSX } from "react";
import { projectNameOf, type PlacementView } from "@jaira/shared/browser";
import { NumInput } from "./controls";
import { MachineChip } from "./machineChip";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { invoke, subscribe as subscribePush } from "./store";

export function PlacementSection({ project }: { project: string | null }): JSX.Element | null {
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
  return (
    <SettingsSection
      id="where"
      title="Where tasks run"
      info="A new task or conversation goes to the first workspace in this order that is online, has the tags its workflow requires, has room by its machine's CPU and memory, is under its cap, and has usage left. With none free it waits, and starts when one frees up."
      action={<span className="cfg-hint">{view.identity !== undefined ? `${projectNameOf(view.identity)} · ${view.identity}` : null}</span>}
    >
      {view.workspaces.map((w, i) => (
        <SettingsRow
          key={w.key}
          name={
            <>
              <span className="placement-order">{i + 1}</span>
              <MachineChip label={w.label} state={w.why === "offline" ? "off" : "on"} />
            </>
          }
          description={
            <>
              <code>{w.dir}</code>
              {w.self ? " · this machine" : ""}
              {w.why !== undefined ? <span className="cfg-hint"> · {w.why}</span> : <span className="cfg-hint"> · has room</span>}
            </>
          }
          control={
            <>
              <label className="placement-cap">
                Runs at once
                <NumInput value={w.cap} placeholder="auto" onChange={(n) => save(keys, { ...Object.fromEntries(Object.entries(caps).filter(([k]) => k !== w.key)), ...(n !== undefined && n >= 0 ? { [w.key]: Math.floor(n) } : {}) })} />
              </label>
              <button type="button" className="ghost" aria-label={`Move ${w.label} up`} disabled={i === 0} onClick={() => move(i, i - 1)}>
                ↑
              </button>
              <button type="button" className="ghost" aria-label={`Move ${w.label} down`} disabled={i === view.workspaces.length - 1} onClick={() => move(i, i + 1)}>
                ↓
              </button>
            </>
          }
        />
      ))}
      <SettingsRow
        name="When every workspace is busy"
        description={
          error !== undefined ? (
            <span className="upd-err">{error}</span>
          ) : (
            `${view.ordered ? "" : "This is the default order: other machines first, this one last. "}Tasks wait in a queue and start as soon as one frees up; a waiting task can be sent to a workspace by hand from its menu.`
          )
        }
        control={<span className="upd-running">Queue</span>}
      />
    </SettingsSection>
  );
}
