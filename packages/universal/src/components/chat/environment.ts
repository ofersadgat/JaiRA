import type { EnvironmentView, RunTarget } from "@jaira/shared/browser";
import type { ChatSurface } from "@jaira/ui/chatSurface";
import { stageOf, type EnvironmentStage } from "@jaira/ui/environmentModel";
import { useEnvironment } from "@jaira/ui/environmentStore";

/**
 * The open conversation's shell environment, for whatever shows it — the bar under the composer, the
 * chip beside the title, the start page's sentence: where it can run (`environmentStore.ts`), which
 * stage it is in (`stageOf`), and the verb that chooses where, while that is still the person's to say.
 */
export function useChatEnvironment(surface: Pick<ChatSurface, "taskId" | "project" | "queued" | "runOn" | "detail" | "onRunOn">): {
  view: EnvironmentView | undefined;
  stage: EnvironmentStage;
  onChoose: ((target: RunTarget | undefined) => void) | undefined;
} {
  const project = surface.project ?? undefined;
  const view = useEnvironment(project);
  const { stage, choosable } = stageOf({ taskId: surface.taskId, project, queued: surface.queued, runOn: surface.runOn, detail: surface.detail });
  return { view, stage, onChoose: choosable ? surface.onRunOn : undefined };
}
