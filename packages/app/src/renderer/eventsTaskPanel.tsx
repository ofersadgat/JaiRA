/**
 * The events task's configuration, in its side panel: the same Automations editor Settings → Tools
 * draws (the person, 2026-09-25: "if you click on the events task, the context panel should have an
 * automations configuration panel … that mirrors the one you see in the settings page").
 *
 * The same component, not a second drawing of it — `AutomationsPane` over the events workflow's
 * copies — on the layer the task belongs to: a project's events task edits that project's
 * automations (Shared's lines shown under them, edited by copy as they are on a project's Settings
 * page), Shared's events task edits Shared's. The page's layer switch has no counterpart here: a
 * task is one layer's.
 *
 * It reads for itself what Settings reads from the store at the page's layer — the settings in
 * effect and the watcher's word on the remotes — because the panel can show a task of a project the
 * window is not standing on.
 */
import { useEffect, useMemo, useState, type JSX } from "react";
import { SHARED_SESSION, type ConfigView, type WorkflowLayer } from "@jaira/shared/browser";
import { AutomationsPane, type AutomationsChannel } from "./automationsPane";
import { eventsConfigOf } from "./eventsModel";
import { useEventStatus } from "./eventsPane";
import type { RunField } from "./runForm";
import { invoke } from "./store";

export interface EventsTaskAutomationsProps {
  /** The task's project directory, or `SHARED_SESSION` for Shared's events task. */
  project: string;
  /** What the automations' footer calls where they run — the project's name, or "Shared". */
  projectName: string;
  busy: boolean;
  workflows: ReadonlyArray<{ id: string; label?: string | undefined }>;
  forms: Readonly<Record<string, RunField[] | null>>;
  onWorkflow: (id: string) => void;
  /** The task's conversation — the tab beside this one, or the main view. */
  onOpenConversation: () => void;
  onEditFile: (layer: WorkflowLayer) => void;
  /** Settings → Tools → Events, where an event is switched on. */
  onOpenEvents: () => void;
  onOpenConnections: () => void;
}

export function EventsTaskAutomations(props: EventsTaskAutomationsProps): JSX.Element {
  const { project } = props;
  const shared = project === SHARED_SESSION;
  const [config, setConfig] = useState<ConfigView | null>(null);
  useEffect(() => {
    let live = true;
    invoke("config:read", { project }).then(
      (read) => live && setConfig(read),
      () => live && setConfig(null),
    );
    return () => void (live = false);
  }, [project]);
  const status = useEventStatus(() => invoke("events:status", { project }), project);
  const channel = useMemo<AutomationsChannel>(() => {
    const at = (layer: WorkflowLayer): { project?: string } => (layer === "base" || shared ? {} : { project });
    return {
      read: (layer, stateId) => invoke("workflow:read", { stateId, layer, ...at(layer) }),
      write: (layer, stateId, text) => invoke("workflow:write", { stateId, layer, text, ...at(layer) }),
      remove: (layer, stateId) => invoke("workflow:delete", { stateId, layer, force: true, ...at(layer) }),
    };
  }, [project, shared]);
  return (
    <AutomationsPane
      key={project}
      channel={channel}
      layer={shared ? "base" : "project"}
      hasProject={!shared}
      busy={props.busy}
      events={eventsConfigOf(config)}
      status={status.status}
      workflows={props.workflows}
      forms={props.forms}
      onWorkflow={props.onWorkflow}
      projectName={props.projectName}
      hasTask
      onOpenConversation={props.onOpenConversation}
      onEditFile={props.onEditFile}
      onOpenEvents={props.onOpenEvents}
      onOpenConnections={props.onOpenConnections}
    />
  );
}
