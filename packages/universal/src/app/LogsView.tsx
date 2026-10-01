import type { JSX } from "react";
import { logUnseen } from "@jaira/ui/updatesModel";
import { dismissHealth, useHealth } from "@jaira/ui/updatesStore";
import { LogsPanel } from "../components/logs/LogsPanel";
import { useShell } from "./shell";

/**
 * The Logs room: `LogsPanel` on the store — the pages read so far, the policy, a process's output, the
 * ways out to a task, and the errors and warnings not seen yet.
 */
export function LogsView(): JSX.Element {
  const { state, actions } = useShell();
  const health = useHealth();
  const unseen = logUnseen(health);
  return (
    <LogsPanel
      entries={state.logs}
      hasOlder={state.logCursor !== undefined}
      loading={state.logsLoading}
      onSearch={actions.searchLogs}
      onOlder={actions.loadOlderLogs}
      policy={state.settings.logging}
      onPolicy={(logging) => void actions.setLogPolicy(logging)}
      output={state.jobOutput}
      onOpenJob={(jobId) => void actions.openJobOutput(jobId)}
      onOpenTask={(taskId) => {
        actions.setView("tasks");
        actions.select(taskId);
      }}
      onClearOutput={actions.closeJobOutput}
      unseen={unseen}
      onDismissUnseen={() => {
        for (const id of logUnseen(health)?.ids ?? []) dismissHealth(id);
      }}
    />
  );
}
