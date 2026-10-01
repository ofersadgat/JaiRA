import { useMemo, useState, type JSX } from "react";
import type { PermissionSetsView as PermissionSetsData } from "@jaira/shared/browser";
import { useMcpData } from "@jaira/ui/mcpData";
import { withPaths } from "@jaira/shared/browser";
import { eventsConfigOf } from "@jaira/ui/eventsModel";
import { automationsChannelOf, eventsProjectOf, permissionSetsChannelOf, useEventStatus } from "@jaira/ui/settingsShell";
import { EVENTS_STATE_ID, eventsTaskOf } from "@jaira/ui/automationsModel";
import { invoke } from "@jaira/ui/store";
import { AutomationsSection } from "./AutomationsSection";
import { EventsSection } from "./EventsSection";
import { useShell } from "../../app/shell";
import { functionRulesOverlay } from "@jaira/ui/modelsPageModel";
import { FunctionsSections } from "./FunctionsSections";
import { goToPart } from "./parts";
import { PermissionSetsSection } from "./permissions/PermissionSets";

/**
 * Settings → Tools: the permission sets, the functions a run can call, the events and the automations
 * — `PermissionSetsSection`, `FunctionsSections`, `EventsSection` and `AutomationsSection`, wired to
 * the shell here. The channels and the MCP servers' state are `settingsShell.ts`'s and `mcpData.ts`'s.
 */
export function ToolsPage(): JSX.Element {
  const { state, actions } = useShell();
  const channel = useMemo(() => permissionSetsChannelOf(state.at), [state.at]);
  const automationsChannel = useMemo(() => automationsChannelOf(state.at), [state.at]);
  const mcp = useMcpData(true, state.config);
  const [data, setData] = useState<PermissionSetsData | null>(null);
  const [focus, setFocus] = useState<{ id: string; nonce: number } | undefined>(undefined);
  const editable = state.configLayer !== "project" || state.at !== null;
  const eventsProject = eventsProjectOf(state.configLayer, state.at);
  const eventStatus = useEventStatus(() => invoke("events:status", { project: eventsProject }), eventsProject);
  return (
    <>
      <PermissionSetsSection key={state.at ?? "shared"} channel={channel} layer={state.configLayer} busy={state.busy} focus={focus} onData={setData} mcp={mcp.report?.servers} />
      <FunctionsSections
        data={data}
        layer={state.configLayer}
        config={state.config}
        busy={state.busy || !editable}
        onSave={actions.saveConfig}
        agents={state.executors.map((e) => e.name)}
        rules={state.availability.tree?.function?.rules}
        onRules={(next) => {
          if (state.config === null) return;
          void actions.saveDefinition(...functionRulesOverlay(state.config, state.configLayer, next));
        }}
        onOpenSet={(id) => {
          setFocus({ id, nonce: Date.now() });
          goToPart("permission-sets");
        }}
      />
      <EventsSection
        status={eventStatus.status}
        events={eventsConfigOf(state.config)}
        layerDoc={state.config?.[state.configLayer] ?? null}
        locked={state.busy || state.config === null || !editable}
        now={eventStatus.now}
        onWrite={(writes) => {
          if (state.config === null) return;
          void actions.saveConfig(state.configLayer, withPaths(state.config[state.configLayer], writes), writes.map(([path]) => path));
        }}
        onOpenConnections={() => actions.setSection("connections")}
      />
      <AutomationsSection
        key={`${state.at ?? "shared"}`}
        channel={automationsChannel}
        layer={state.configLayer}
        hasProject={state.at !== null}
        busy={state.busy}
        events={eventsConfigOf(state.config)}
        status={eventStatus.status}
        workflows={state.workflows.map((entry) => ({ id: entry.rootId, label: entry.label }))}
        forms={state.workflowForms}
        onWorkflow={actions.pickWorkflow}
        projectName={state.at !== null ? (state.at.split(/[\\/]/).filter(Boolean).pop() ?? state.at) : "Shared"}
        hasTask={eventsTaskOf(state.tasks) !== undefined}
        onOpenConversation={() => {
          const task = eventsTaskOf(state.tasks);
          if (task === undefined) return;
          actions.setView("tasks");
          actions.select(task.taskId);
        }}
        onEditFile={(layer) => void actions.openWorkflow(EVENTS_STATE_ID, layer)}
        onOpenEvents={() => goToPart("events")}
        onOpenConnections={() => actions.setSection("connections")}
      />
    </>
  );
}
