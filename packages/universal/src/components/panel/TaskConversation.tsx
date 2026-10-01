import { useState, type JSX } from "react";
import type { InstanceNode, PendingInteraction, TaskDetail } from "@jaira/shared/browser";
import { hasAsking } from "@jaira/ui/stateSurfaceModel";
import { RunConversation } from "../run/RunConversation";
import { InlineGate } from "./Gate";
import type { TranscriptSource } from "./RunTranscript";

/**
 * A task's conversation in the panel: `RunConversation` (`components/run/RunConversation.tsx`) — the
 * transcript's scroller and what stands where the composer would, a column taking the body's height —
 * with the gate the task is parked on at the foot when the tree has no place for it. A subagent's
 * doorway walks into its conversation on the panel's own stack (`onOpenSidechain`), not the trail.
 */
export function TaskConversation({
  detail,
  project,
  source,
  gate,
  onGate,
  onRerun,
  onResume,
  onOpenSidechain,
}: {
  detail: TaskDetail;
  project: string | undefined;
  source: TranscriptSource;
  gate: PendingInteraction | undefined;
  onGate: (value: unknown) => void;
  onRerun: (taskId: string) => void;
  onResume: (taskId: string) => void;
  onOpenSidechain?: ((node: InstanceNode, call: string, name: string) => void) | undefined;
}): JSX.Element {
  const hosted = gate !== undefined && detail.instances.some((node) => hasAsking(node));
  // The gate at the foot is at most 55% of the conversation's height. It stands in the box under the
  // scroller, where a percentage has nothing to resolve against, so the height is measured and handed down.
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
      onOpenSidechain={onOpenSidechain}
      onLayout={setHeight}
      foot={gate !== undefined && !hosted ? <InlineGate pending={gate} onGate={onGate} services={source.gateServices} {...(height !== undefined ? { maxHeight: height * 0.55 } : {})} /> : null}
    />
  );
}
