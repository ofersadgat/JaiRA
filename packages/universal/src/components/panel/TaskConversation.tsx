import { useEffect, useState, type JSX } from "react";
import { View } from "@tamagui/core";
import type { ChatPlanView, PendingInteraction, TaskDetail } from "@jaira/shared/browser";
import { hasAsking } from "@jaira/ui/stateSurface";
import { invoke } from "@jaira/ui/store";
import { Uncopied } from "../../app/Uncopied";
import { InlineGate } from "./Gate";
import { RunActivity } from "./RunActivity";
import { OVER_SCROLLER } from "./SidePanel";
import { RunTranscript, type TranscriptSource } from "./RunTranscript";

/**
 * A task's conversation in the panel, universal (decision 0015): `panelFaces.tsx`'s `TaskConversation`
 * over `runViews.tsx`'s `RunConversation` — the transcript's scroller, what stands where the composer
 * would (`ChatComposer`: the activity strip for a run that holds no conversation of its own), and the
 * gate the task is parked on at the foot when the tree has no place for it.
 *
 *   .pv-convo          column, flex 1
 *   .run-convo-wrap    column, flex 1; .run-convo flex 1, scrolls
 */
export function TaskConversation({
  detail,
  project,
  source,
  gate,
  onGate,
  onRerun,
  onResume,
}: {
  detail: TaskDetail;
  project: string | undefined;
  source: TranscriptSource;
  gate: PendingInteraction | undefined;
  onGate: (value: unknown) => void;
  onRerun: (taskId: string) => void;
  onResume: (taskId: string) => void;
}): JSX.Element {
  const hosted = gate !== undefined && detail.instances.some((node) => hasAsking(node));
  // `.pv-convo > .inline-gate`'s `max-height: 55%` is of the conversation's height; the gate now stands
  // in the layer's box, so the height is measured and handed down.
  const [height, setHeight] = useState<number | undefined>(undefined);
  return (
    <View flex={1} minHeight={0} flexDirection="column" onLayout={(e) => setHeight(e.nativeEvent.layout.height)}>
      <RunTranscript detail={detail} source={source} {...(gate !== undefined ? { gate, onGate } : {})} />
      {/* What stands under the scroller — the composer's place and the gate — in the one layer the DOM
          squashes them into (see OVER_SCROLLER). The layout is `.run-convo-wrap`'s and `.pv-convo`'s: a
          column, the scroller taking the rest. */}
      <View flexShrink={0} flexDirection="column" {...OVER_SCROLLER}>
        <Composer detail={detail} project={project} asking={gate !== undefined} onRerun={onRerun} onResume={onResume} />
        {gate !== undefined && !hosted ? <InlineGate pending={gate} onGate={onGate} {...(height !== undefined ? { maxHeight: height * 0.55 } : {})} /> : null}
      </View>
    </View>
  );
}

/**
 * `ChatComposer`'s choice: over a run that holds no conversation of its own (`chat:plan` answers `null`)
 * the activity strip stands where the composer would. The composer itself is {@link Uncopied}.
 */
function Composer({ detail, project, asking, onRerun, onResume }: { detail: TaskDetail; project: string | undefined; asking: boolean; onRerun: (taskId: string) => void; onResume: (taskId: string) => void }): JSX.Element | null {
  const instanceId = detail.instances[0]?.instanceId;
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
  if (plan === null && instanceId !== undefined) return <RunActivity detail={detail} asking={asking} onStop={stop} onRerun={onRerun} onResume={onResume} />;
  if (plan === undefined) return null;
  return <Uncopied name="Composer" height={120} />;
}
