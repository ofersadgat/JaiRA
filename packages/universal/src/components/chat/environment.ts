import type { EnvironmentView, RunTarget } from "@jaira/shared/browser";
import type { ChatSurface } from "@jaira/ui/chatSurface";
import { stageOf, type EnvironmentStage } from "@jaira/ui/environmentModel";
import { useEnvironment } from "@jaira/ui/environmentStore";

/**
 * The open conversation's shell environment, for whatever shows it — the bar under the composer, the
 * chip beside the title, the start page's sentence: where it can run (`environmentStore.ts`), which
 * stage it is in (`stageOf`), and the verb that chooses where — before it starts, while it waits, and
 * once it runs, by moving it.
 */
export function useChatEnvironment(surface: Pick<ChatSurface, "taskId" | "project" | "queued" | "runOn" | "detail" | "onRunOn" | "onMove">): {
  view: EnvironmentView | undefined;
  stage: EnvironmentStage;
  /** Choose where it runs: before it starts or while it waits, or — once it runs — move it there. */
  onChoose: ((target: RunTarget | undefined) => void) | undefined;
  /** Whether "Automatic" is a choice: not for a conversation that runs somewhere already. */
  automatic: boolean;
} {
  const project = surface.project ?? undefined;
  const view = useEnvironment(project);
  const { stage, choosable } = stageOf({ taskId: surface.taskId, project, queued: surface.queued, runOn: surface.runOn, detail: surface.detail });
  // A conversation that has started is MOVED (decision 0013 ruling 7, the person: "move it there").
  const { onMove, taskId } = surface;
  const move =
    stage.kind === "running" && taskId !== null && project !== undefined
      ? (target: RunTarget | undefined): void => {
          if (target !== undefined) onMove(taskId, project, target);
        }
      : undefined;
  return { view, stage, onChoose: choosable ? surface.onRunOn : move, automatic: stage.kind !== "running" };
}
