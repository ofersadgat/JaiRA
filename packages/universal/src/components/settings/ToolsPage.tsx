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
import { ToolMappingSection } from "./ToolMappingSection";
import { PlaceSetsSection } from "./PlaceSetsSection";
import { useView } from "@jaira/ui/useView";
import { standingLayersOf } from "@jaira/ui/permissionSetsHost";
import { useSettingsWhere } from "./layers";

/**
 * Settings → Tools: the permission sets, the tool mapping, the functions a run can call, the events and
 * the automations — `PermissionSetsSection`, `ToolMappingSection`, `FunctionsSections`, `EventsSection` and `AutomationsSection`, wired to
 * the shell here. The channels and the MCP servers' state are `settingsShell.ts`'s and `mcpData.ts`'s.
 */
export function ToolsPage(): JSX.Element {
  const { state, actions } = useShell();
  // The project Settings' path names (or the one the shell stands on): its files are what the
  // permission sets, events and automations here read and write — or a paired machine's, when the
  // path names one and no project.
  const { at, machine } = useSettingsWhere();
  const config = state.settingsConfig;
  const channel = useMemo(() => permissionSetsChannelOf(at, machine), [at, machine]);
  const automationsChannel = useMemo(() => automationsChannelOf(at, machine), [at, machine]);
  const mcp = useMcpData(true, config);
  const [data, setData] = useState<PermissionSetsData | null>(null);
  const standing = useMemo(() => standingLayersOf(config), [config]);
  const [focus, setFocus] = useState<{ id: string; nonce: number } | undefined>(undefined);
  const editable = config !== null;
  const eventsProject = eventsProjectOf(state.configLayer, at);
  // The machine's projects folder: the place sets' `root folder`.
  const machines = useView("machines:view", machine !== undefined ? { machine } : {}).value;
  // A paired machine the path names: its watcher's word, asked there (the engine forwards a request naming it).
  const eventStatus = useEventStatus(() => invoke("events:status", { project: eventsProject, ...(machine !== undefined ? { machine } : {}) }), `${machine ?? ""}:${eventsProject}`);
  return (
    <>
      <PermissionSetsSection key={`${machine ?? ""}:${at ?? "shared"}`} channel={channel} layer={state.configLayer} busy={state.busy} focus={focus} onData={setData} mcp={mcp.report?.servers} standing={standing} />
      <ToolMappingSection
        effective={config?.effective}
        layerDoc={config?.[state.configLayer] ?? null}
        locked={state.busy || !editable}
        onWrite={(writes) => {
          if (config === null) return;
          void actions.saveConfig(state.configLayer, withPaths(config[state.configLayer], writes), writes.map(([path]) => path));
        }}
      />
      <PlaceSetsSection
        effective={config?.effective}
        layerDoc={config?.[state.configLayer] ?? null}
        projectsFolder={machines?.self.projectsFolder}
        locked={state.busy || !editable}
        onWrite={(writes) => {
          if (config === null) return;
          void actions.saveConfig(state.configLayer, withPaths(config[state.configLayer], writes), writes.map(([path]) => path));
        }}
      />
      <FunctionsSections
        data={data}
        layer={state.configLayer}
        config={config}
        busy={state.busy || !editable}
        onSave={actions.saveConfig}
        agents={state.executors.map((e) => e.name)}
        rules={state.availability.tree?.function?.rules}
        onRules={(next) => {
          if (config === null) return;
          void actions.saveDefinition(...functionRulesOverlay(config, state.configLayer, next));
        }}
        onOpenSet={(id) => {
          setFocus({ id, nonce: Date.now() });
          goToPart("permission-sets");
        }}
      />
      <EventsSection
        status={eventStatus.status}
        events={eventsConfigOf(config)}
        layerDoc={config?.[state.configLayer] ?? null}
        locked={state.busy || config === null || !editable}
        now={eventStatus.now}
        onWrite={(writes) => {
          if (config === null) return;
          void actions.saveConfig(state.configLayer, withPaths(config[state.configLayer], writes), writes.map(([path]) => path));
        }}
        onOpenConnections={() => actions.setSection("connections")}
      />
      <AutomationsSection
        key={`${machine ?? ""}:${at ?? "shared"}`}
        channel={automationsChannel}
        layer={state.configLayer}
        hasProject={at !== null}
        busy={state.busy}
        events={eventsConfigOf(config)}
        status={eventStatus.status}
        workflows={state.workflows.map((entry) => ({ id: entry.rootId, label: entry.label }))}
        forms={state.workflowForms}
        onWorkflow={actions.pickWorkflow}
        projectName={at !== null ? (at.split(/[\\/]/).filter(Boolean).pop() ?? at) : "Shared"}
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
