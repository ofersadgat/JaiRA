import { useState, type JSX } from "react";
import type { PendingInteraction, TaskDetail } from "@jaira/shared/browser";
import { hasAsking } from "@jaira/ui/stateSurface";
import { RunConversation } from "../run/RunConversation";
import { InlineGate } from "./Gate";
import type { TranscriptSource } from "./RunTranscript";

/**
 * A task's conversation in the panel, universal (decision 0015): `panelFaces.tsx`'s `TaskConversation`
 * over `runViews.tsx`'s `RunConversation` (`components/run/RunConversation.tsx`) — the transcript's
 * scroller, what stands where the composer would, and the gate the task is parked on at the foot when
 * the tree has no place for it.
 *
 *   .pv-convo          column, flex 1
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
    <RunConversation
      detail={detail}
      parent={detail.instances[0]}
      source={source}
      project={project}
      {...(gate !== undefined ? { gate, onGate } : {})}
      asking={gate !== undefined}
      onRerun={onRerun}
      onResume={onResume}
      onLayout={setHeight}
      foot={gate !== undefined && !hosted ? <InlineGate pending={gate} onGate={onGate} {...(height !== undefined ? { maxHeight: height * 0.55 } : {})} /> : null}
    />
  );
}
