import { useEffect, useState, type JSX, type ReactNode } from "react";
import { View, isWeb } from "@tamagui/core";
import type { ChatPlanView, InstanceNode, PendingInteraction, TaskDetail } from "@jaira/shared/browser";
import { invoke } from "@jaira/ui/store";
import { Uncopied } from "../../app/Uncopied";
import { RunActivity } from "../panel/RunActivity";
import { RunTranscript, type TranscriptSource } from "../panel/RunTranscript";
import { OVER_SCROLLER } from "../panel/SidePanel";

/**
 * `runViews.tsx`'s `RunConversation`, universal (decision 0015): one run's conversation — the transcript's
 * scroller (`RunTranscript`), and under it what stands where the composer would (`ChatComposer`). The
 * same component reads a task's run in the side panel (`TaskConversation`) and a run walked into in the
 * middle column (`RunView`); `foot` is what the panel adds under it (the gate the tree has no place for).
 *
 *   .run-convo-wrap    column, flex 1; .run-convo flex 1, scrolls
 */
export function RunConversation({
  detail,
  parent,
  source,
  project,
  gate,
  onGate,
  asking,
  onRerun,
  onResume,
  foot,
  onLayout,
  composited = false,
}: {
  detail: TaskDetail;
  /** The run being read. */
  parent: InstanceNode | undefined;
  source: TranscriptSource;
  project: string | undefined;
  gate?: PendingInteraction | undefined;
  onGate?: ((value: unknown) => void) | undefined;
  /** A gate is on offer — so the run is WAITING, whatever its row says. */
  asking: boolean;
  onRerun?: ((taskId: string) => void) | undefined;
  onResume?: ((taskId: string) => void) | undefined;
  foot?: ReactNode;
  onLayout?: ((height: number) => void) | undefined;
  /**
   * Give what stands under the scroller a layer of its own (web). In the middle column Chromium
   * composites the desktop's strip — its text is greyscale there — where `OVER_SCROLLER` alone leaves the
   * copy's subpixel; in the panel `OVER_SCROLLER` already does it.
   */
  composited?: boolean;
}): JSX.Element {
  return (
    <View flex={1} minHeight={0} flexDirection="column" {...(onLayout !== undefined ? { onLayout: (e: { nativeEvent: { layout: { height: number } } }) => onLayout(e.nativeEvent.layout.height) } : {})}>
      <RunTranscript detail={detail} parent={parent} source={source} {...(gate !== undefined && onGate !== undefined ? { gate, onGate } : {})} />
      {/* What stands under the scroller — the composer's place and the panel's foot — in the one layer
          the DOM squashes them into (see OVER_SCROLLER). */}
      <View flexShrink={0} flexDirection="column" {...OVER_SCROLLER} {...(composited && isWeb ? { willChange: "transform" } : {})}>
        <RunComposer detail={detail} instanceId={parent?.instanceId} project={project} asking={asking} onRerun={onRerun} onResume={onResume} />
        {foot}
      </View>
    </View>
  );
}

/**
 * `ChatComposer`'s choice: over a run that holds no conversation of its own (`chat:plan` answers `null`)
 * the activity strip stands where the composer would. The composer itself is {@link Uncopied}.
 */
export function RunComposer({
  detail,
  instanceId,
  project,
  asking,
  onRerun,
  onResume,
}: {
  detail: TaskDetail;
  instanceId: string | undefined;
  project: string | undefined;
  asking: boolean;
  onRerun?: ((taskId: string) => void) | undefined;
  onResume?: ((taskId: string) => void) | undefined;
}): JSX.Element | null {
  const taskId = detail.taskId;
  // Three states, as the DOM's: `undefined` not asked yet, `null` asked and there is no conversation.
  const [plan, setPlan] = useState<ChatPlanView | null | undefined>(undefined);
  useEffect(() => {
    if (instanceId === undefined) {
      setPlan(null);
      return;
    }
    setPlan(undefined);
    let live = true;
    void invoke("chat:plan", { taskId, instanceId, overrides: {}, ...(project !== undefined ? { project } : {}) })
      .then((next) => live && setPlan(next))
      .catch(() => live && setPlan(null));
    return () => {
      live = false;
    };
  }, [taskId, instanceId, project]);
  // The stop is the task's while it runs or asks (`ChatComposer`'s `stop`).
  const stop = (): void => {
    if (detail.status === "running" || asking) void invoke("task:cancel", { taskId, ...(project !== undefined ? { project } : {}) }).catch(() => undefined);
    else void invoke("chat:cancel", { taskId, ...(project !== undefined ? { project } : {}) }).catch(() => undefined);
  };
  // Skip, from the fast-forward strip (decision 0005 §4): enter the target now, what is between recorded `skipped`.
  const skip = (): void => void invoke("task:skip", { taskId, ...(project !== undefined ? { project } : {}) }).catch(() => undefined);
  if (plan === null && instanceId !== undefined) return <RunActivity detail={detail} asking={asking} onStop={stop} onSkip={skip} onRerun={onRerun} onResume={onResume} />;
  if (plan === undefined) return null;
  return (
    <>
      {detail.fastForward !== undefined ? <RunActivity detail={detail} asking={false} onStop={stop} onSkip={skip} /> : null}
      <Uncopied name="Composer" height={120} />
    </>
  );
}
