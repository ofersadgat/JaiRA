/**
 * Two Settings pages made only of blocks other files already draw (the person's reorganisation,
 * 2026-09-23): each is a list of sections, and the page's job is the ORDER and the grouping — which
 * question a block answers.
 *
 *  - **Runs** — how a run behaves while it is going: where its commands run, whether a model answer is
 *    remembered, how sure a fast-forward has to be, and where a workflow reference is looked up.
 *  - **Data & history** — what a run leaves behind: where its artifacts land, how its records are
 *    stored, and — for the project that is open — how much there is and what pruning would free.
 */
import type { JSX, ReactNode } from "react";
import type { ConfigLayer, ConfigView } from "@jaira/shared/browser";
import { Artifacts, ConfigBlockSection, ExecEnvironment, configWriter } from "./configPane";

interface PageProps {
  config: ConfigView | null;
  layer: ConfigLayer;
  busy: boolean;
  editable: boolean;
  onSave: (layer: ConfigLayer, doc: unknown) => void;
}

export function RunsPane({ config, layer, busy, editable, onSave }: PageProps): JSX.Element {
  if (config === null) return <p className="empty">The configuration could not be read.</p>;
  const writer = configWriter(config, layer, busy || !editable, onSave);
  return (
    <div className="cfg-pane">
      <ExecEnvironment {...writer} />
      <ConfigBlockSection writer={writer} block="memo" />
      {/* `autopilot` (decision 0005 §6): one number, and its description is the whole explanation —
          the threshold a fast-forward's answers are held to. */}
      <ConfigBlockSection writer={writer} block="autopilot" />
      {/* When usage runs out: whether "Try again at …" starts checked on a message or a run the
          provider refused because the account ran out (usage-readings contract). */}
      <ConfigBlockSection writer={writer} block="limits" />
      <ConfigBlockSection writer={writer} block="workflows" />
    </div>
  );
}

export function DataPane({
  config,
  layer,
  busy,
  editable,
  onSave,
  history,
}: PageProps & {
  /** The open project's stored history and pruning, or absent with nothing open. */
  history?: ReactNode;
}): JSX.Element {
  if (config === null) return <p className="empty">The configuration could not be read.</p>;
  const writer = configWriter(config, layer, busy || !editable, onSave);
  return (
    <div className="cfg-pane">
      <Artifacts {...writer} />
      <ConfigBlockSection writer={writer} block="storage" />
      {/* Its own two sections — what is stored, and what pruning would free. They are the open
          project's records whichever layer the switch is on, and History's lead says so. */}
      {history}
    </div>
  );
}
