/**
 * What the events task's Automations panel reads for itself — the settings in effect at the task's
 * layer, the watcher's word on the remotes, and the channel the automations are read and written
 * through. The panel (`packages/universal/src/components/workflow/ConfigPanel.tsx`) hands the result to
 * Settings' `AutomationsSection`, so a task's automations are edited by the editor Settings has.
 *
 * It reads for itself what Settings reads from the store at the page's layer, because the panel can
 * show a task of a project the window is not standing on.
 */
import { useEffect, useMemo, useState } from "react";
import { SHARED_SESSION, type ConfigView, type WorkflowLayer } from "@jaira/shared/browser";
import type { AutomationsChannel, AutomationsPaneProps } from "./automationsHost";
import { eventsConfigOf } from "./eventsModel";
import { useEventStatus } from "./settingsShell";
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

/** The Automations editor's props, on the layer the task belongs to. */
export function useEventsTaskAutomations(props: EventsTaskAutomationsProps): AutomationsPaneProps {
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
  return {
    channel,
    layer: shared ? "base" : "project",
    hasProject: !shared,
    busy: props.busy,
    events: eventsConfigOf(config),
    status: status.status,
    workflows: props.workflows,
    forms: props.forms,
    onWorkflow: props.onWorkflow,
    projectName: props.projectName,
    hasTask: true,
    onOpenConversation: props.onOpenConversation,
    onEditFile: props.onEditFile,
    onOpenEvents: props.onOpenEvents,
    onOpenConnections: props.onOpenConnections,
  };
}
